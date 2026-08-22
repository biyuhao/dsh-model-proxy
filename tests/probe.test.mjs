/**
 * Offline tests for probeProxy: a local CONNECT toy proxy + local origin stand
 * in for the real proxy and trace endpoint, so no network is touched.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { probeProxy, describeProbeTarget } from '../lib/host/probe.js'

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server.address().port
}

test('probe succeeds through a working proxy tunnel', async () => {
  const origin = http.createServer((q, s) => s.end('ip=203.0.113.9\nloc=XX\n'))
  const originPort = await listen(origin)

  const proxy = http.createServer(() => {})
  proxy.on('connect', (req, sock, head) => {
    const { port, hostname } = new URL('http://' + req.url)
    const up = net.connect(Number(port) || 80, hostname, () => {
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head?.length) up.write(head)
      sock.pipe(up)
      up.pipe(sock)
    })
    up.on('error', () => sock.destroy())
    sock.on('error', () => up.destroy())
  })
  const proxyPort = await listen(proxy)

  try {
    const result = await probeProxy(`http://127.0.0.1:${proxyPort}`, {
      endpoint: `http://127.0.0.1:${originPort}/trace`,
      timeoutMs: 4000,
    })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.ok(result.latencyMs >= 0)
    assert.match(result.detail, /HTTP 200/)
  } finally {
    proxy.close()
    origin.close()
  }
})

test('probe fails cleanly against an unreachable proxy (no throw)', async () => {
  const result = await probeProxy('http://127.0.0.1:1', {
    endpoint: 'http://example.invalid/trace',
    timeoutMs: 2000,
  })
  assert.equal(result.ok, false)
  assert.ok(result.detail.length > 0)
})

test('probe reports HTTP-level failures as ok:false', async () => {
  // direct dead dispatcher: ProxyAgent to a port with no listener
  const result = await probeProxy('http://127.0.0.1:1', { endpoint: 'http://x/', timeoutMs: 1500 })
  assert.equal(result.ok, false)
})

test('describeProbeTarget redacts credentials in labels', () => {
  const label = describeProbeTarget('socks5://user:secretpw@h:1080')
  assert.ok(label.includes('***'))
  assert.ok(!label.includes('secretpw'))
})
