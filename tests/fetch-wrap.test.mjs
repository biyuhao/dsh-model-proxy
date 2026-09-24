/**
 * Offline end-to-end tests for the reversible fetch wrapper.
 * Spins up a local origin plus a CONNECT-capable forward proxy (mirroring how
 * undici's ProxyAgent tunnels), so no network or real proxy is needed.
 * Run: npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { installFetchWrapper, als, shouldWrapFetch } from '../lib/host/fetch-wrap.js'

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server.address().port
}

function makeTunnelProxy() {
  const state = { hits: 0 }
  const server = http.createServer(() => {})
  server.on('connect', (req, clientSock, head) => {
    state.hits++
    const { port, hostname } = new URL('http://' + req.url)
    const up = net.connect(Number(port) || 80, hostname, () => {
      clientSock.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head?.length) up.write(head)
      clientSock.pipe(up)
      up.pipe(clientSock)
    })
    up.on('error', () => clientSock.destroy())
    clientSock.on('error', () => up.destroy())
  })
  return { server, state }
}

test('fetch wrapper: passthrough, proxied tunnel, cross-realm Request, redaction, unwind', async () => {
  const origin = http.createServer((q, s) => {
    let body = ''
    q.on('data', (c) => (body += c))
    q.on('end', () => s.end('OK:' + body))
  })
  const originPort = await listen(origin)
  const originUrl = `http://127.0.0.1:${originPort}/`

  const { server: proxyServer, state: proxyState } = makeTunnelProxy()
  const proxyPort = await listen(proxyServer)
  const proxyUrl = `http://127.0.0.1:${proxyPort}`

  const logs = []
  const nativeFetch = globalThis.fetch

  // Two chained installs model the cordis-plugin-hmr reload race.
  const disposeA = installFetchWrapper({ error: (m) => logs.push(m) })
  const disposeB = installFetchWrapper({ error: (m) => logs.push(m) })

  try {
    // direct path passes both wrappers untouched
    assert.equal(await (await fetch(originUrl)).text(), 'OK:')

    // proxied GET rides a CONNECT tunnel through the forward proxy
    await als.run({ proxyUrl, provider: 'p', model: 'm' }, async () => {
      const res = await fetch(originUrl, { signal: AbortSignal.timeout(5000) })
      assert.equal(await res.text(), 'OK:')
    })
    assert.ok(proxyState.hits >= 1, 'CONNECT tunnel must have been used')

    // a Request built by the GLOBAL constructor must be rebuilt for undici,
    // not die with "Failed to parse URL from [object Request]"
    await als.run({ proxyUrl, provider: 'p', model: 'm' }, async () => {
      const req = new Request(originUrl, { method: 'POST', body: 'payload' })
      const res = await fetch(req, { signal: AbortSignal.timeout(5000) })
      assert.equal(await res.text(), 'OK:payload')
    })

    // sync dispatcher failure logs a REDACTED url (no plaintext credentials)
    await als.run({ proxyUrl: 'http2://user:secretpw@h:1', provider: 'p', model: 'm' }, async () => {
      await assert.rejects(() => fetch(originUrl, { signal: AbortSignal.timeout(3000) }))
    })
    const joined = logs.join('|')
    assert.ok(joined.includes('***'), 'error log must redact credentials')
    assert.ok(!joined.includes('secretpw'), 'error log must not contain the plaintext password')
  } finally {
    // reverse-order unwind must restore the pristine native fetch exactly
    disposeB()
    disposeA()
    assert.equal(globalThis.fetch, nativeFetch)
    proxyServer.close()
    origin.close()
  }
})

test('superseded inner wrapper keeps working after outer dispose', async () => {
  const origin = http.createServer((q, s) => s.end('OK'))
  const originPort = await listen(origin)

  const disposeA = installFetchWrapper()
  const disposeB = installFetchWrapper()

  try {
    disposeA() // inner layer dies while outer still installed
    assert.equal(await (await fetch(`http://127.0.0.1:${originPort}/`)).text(), 'OK')
  } finally {
    disposeB()
    proxyCleanup()
  }

  function proxyCleanup() {
    origin.close()
  }
})

test('shouldWrapFetch: global fetch is only wrapped while routing is possible', () => {
  // disabled wins over everything
  assert.equal(shouldWrapFetch({ enabled: false, defaultProxy: 'http://h:1', rules: [{ proxyUrl: 'socks5://h' }] }), false)
  // nothing configured
  assert.equal(shouldWrapFetch({ enabled: true, rules: [] }), false)
  assert.equal(shouldWrapFetch({ enabled: true, rules: [{ proxyUrl: '' }] }), false)
  // default fallback alone justifies the wrap
  assert.equal(shouldWrapFetch({ enabled: true, defaultProxy: 'http://127.0.0.1:7890', rules: [] }), true)
  // any live rule with a URL
  assert.equal(shouldWrapFetch({ enabled: true, rules: [{ proxyUrl: 'socks5://127.0.0.1:1080' }] }), true)
  // direct rules with headers still need the wrapper
  assert.equal(shouldWrapFetch({ enabled: true, rules: [{ proxyUrl: '', headers: { 'x-test': '1' } }] }), true)
  // dynamic session headers also justify the wrapper
  assert.equal(shouldWrapFetch({ enabled: true, rules: [{ proxyUrl: '', headerValueSources: { 'x-session': 'sessionId' } }] }), true)
  // reusable host references also justify the wrapper
  assert.equal(shouldWrapFetch({ enabled: true, proxyHosts: [{ id: 'h', proxyUrl: 'socks5://h:1080' }], rules: [{ proxyHostId: 'h' }] }), true)
  // disabled rules do not count
  assert.equal(shouldWrapFetch({ enabled: true, rules: [{ proxyUrl: 'http://h:1', enabled: false }] }), false)
})
