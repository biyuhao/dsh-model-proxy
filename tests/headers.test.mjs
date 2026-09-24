/**
 * Offline tests for per-rule extra HTTP headers. Values may be fixed or come
 * from GenerateOptions.sessionId; headers apply in direct and proxied modes.
 * Run: npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { assertServiceable, resolveRoute, resolveProxy } from '../lib/host/config.js'
import { installFetchWrapper, als, applyExtraHeaders } from '../lib/host/fetch-wrap.js'
import { Request as UndiciRequest, Headers as UndiciHeaders } from 'undici'
import { parseHeadersText, formatHeadersText, buildCreatorRules, sanitizeRules } from '../.test-build/controller.js'

const baseConfig = () => ({ enabled: true, debug: false, defaultProxy: '', rules: [] })

// ── routing ────────────────────────────────────────────────────────────────

test('resolveRoute: matched rule yields proxyUrl + headers together', () => {
  const cfg = {
    ...baseConfig(),
    rules: [
      { provider: 'opencode-go', model: '*', proxyUrl: 'http://127.0.0.1:7890', headers: { 'x-opencode-session': 'fixed-1' } },
    ],
  }
  assert.deepEqual(resolveRoute(cfg, 'opencode-go', 'any-model'), {
    proxyUrl: 'http://127.0.0.1:7890',
    headers: { 'x-opencode-session': 'fixed-1' },
  })
  // resolveProxy stays a thin proxy-only view (backward compat)
  assert.equal(resolveProxy(cfg, 'opencode-go', 'any-model'), 'http://127.0.0.1:7890')
})

test('resolveRoute: direct exemption still carries rule headers', () => {
  const cfg = {
    ...baseConfig(),
    rules: [
      { provider: 'opencode-go', model: '*', proxyUrl: '', headers: { 'x-opencode-session': 'fixed-1' } },
    ],
  }
  assert.deepEqual(resolveRoute(cfg, 'opencode-go', 'm'), {
    headers: { 'x-opencode-session': 'fixed-1' },
  })
  assert.equal(resolveProxy(cfg, 'opencode-go', 'm'), undefined)
})

test('resolveRoute: headers respect exact/prefix specificity and purpose', () => {
  const cfg = {
    ...baseConfig(),
    rules: [
      { provider: 'p', model: 'muse-x', proxyUrl: 'http://e:1', headers: { 'x-a': 'exact' } },
      { provider: 'p', model: 'muse-*', proxyUrl: 'http://p:2', headers: { 'x-a': 'prefix' } },
      { provider: 'p', model: '*', proxyUrl: 'http://w:3' },
      { provider: 'p', model: 'chat', proxyUrl: 'http://c:4', purpose: 'compaction', headers: { 'x-a': 'c' } },
    ],
  }
  assert.equal(resolveRoute(cfg, 'p', 'muse-x').headers['x-a'], 'exact')
  assert.equal(resolveRoute(cfg, 'p', 'muse-other').headers['x-a'], 'prefix')
  assert.deepEqual(resolveRoute(cfg, 'p', 'unrelated').headers, undefined)
  assert.equal(resolveRoute(cfg, 'p', 'chat', 'compaction').headers['x-a'], 'c')
  // default fallback never carries headers
  assert.deepEqual(resolveRoute({ ...cfg, defaultProxy: 'http://d:5' }, 'nobody', 'x'), { proxyUrl: 'http://d:5' })
  // globally disabled routes nothing
  assert.deepEqual(resolveRoute({ ...cfg, enabled: false }, 'p', 'muse-x'), {})
})

test('resolveRoute: returned headers are a copy, not a live reference', () => {
  const cfg = {
    ...baseConfig(),
    rules: [{ provider: 'p', model: '*', proxyUrl: 'http://h:1', headers: { 'x-a': '1' } }],
  }
  const r = resolveRoute(cfg, 'p', 'm')
  r.headers['x-a'] = 'mutated'
  assert.equal(cfg.rules[0].headers['x-a'], '1')
})

test('resolveRoute: session source fills the current request Session ID', () => {
  const cfg = {
    ...baseConfig(),
    rules: [{
      provider: 'opencode-go',
      model: '*',
      proxyUrl: '',
      headerValueSources: { 'x-opencode-session': 'sessionId' },
      enabled: true,
    }],
  }
  assert.deepEqual(resolveRoute(cfg, 'opencode-go', 'm', undefined, undefined, 'session-42'), {
    headers: { 'x-opencode-session': 'session-42' },
  })
  assert.deepEqual(resolveRoute(cfg, 'opencode-go', 'm'), {})
  assert.deepEqual(resolveRoute(cfg, 'opencode-go', 'm', undefined, undefined, {
    provider: 'opencode-go', model: 'm', purpose: 'compaction',
  }), {})
  cfg.rules[0].headerValueSources = {
    'x-provider': 'provider',
    'x-model': 'model',
    'x-purpose': 'purpose',
  }
  assert.deepEqual(resolveRoute(cfg, 'opencode-go', 'm', undefined, undefined, {
    provider: 'opencode-go', model: 'm', purpose: 'compaction',
  }), { headers: { 'x-provider': 'opencode-go', 'x-model': 'm', 'x-purpose': 'compaction' } })
  assert.doesNotThrow(() => assertServiceable(cfg))
  assert.throws(
    () => assertServiceable({ ...cfg, rules: [{ ...cfg.rules[0], headers: { 'x-opencode-session': 'fixed' }, headerValueSources: { 'x-opencode-session': 'sessionId' } }] }),
    /must not also have a fixed value|dynamic header/,
  )
})



test('assertServiceable: accepts a valid fixed header', () => {
  assert.doesNotThrow(() => assertServiceable({
    ...baseConfig(),
    rules: [{ provider: 'opencode-go', model: '*', proxyUrl: 'http://127.0.0.1:7890', headers: { 'x-opencode-session': 'abc-123' } }],
  }))
})

test('assertServiceable: rejects bad header names/values', () => {
  const badHeaders = [
    { 'not a token!': 'v' },                 // invalid token chars / space
    { 'x-ok': '' },                           // empty value
    { 'x-ok': '  padded  ' },                 // surrounding whitespace
    { 'x-ok': 'a\r\nb: c' },                  // CR/LF injection
    { 'x-ok': 42 },                           // non-string
    { Authorization: 'Bearer x' },            // forbidden
    { 'Proxy-Authorization': 'Basic x' },     // forbidden (any case)
  ]
  for (const headers of badHeaders) {
    assert.throws(
      () => assertServiceable({ ...baseConfig(), rules: [{ provider: 'p', model: 'm', proxyUrl: '', headers }] }),
      /header/,
      `expected rejection for ${JSON.stringify(headers)}`,
    )
  }
})

test('assertServiceable: rejects duplicate headers case-insensitively and overflow', () => {
  assert.throws(
    () => assertServiceable({ ...baseConfig(), rules: [{ provider: 'p', model: 'm', proxyUrl: '', headers: { 'X-A': '1', 'x-a': '2' } }] }),
    /duplicate/,
  )
  const many = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`x-h-${i}`, 'v']))
  assert.throws(
    () => assertServiceable({ ...baseConfig(), rules: [{ provider: 'p', model: 'm', proxyUrl: '', headers: many }] }),
    /too many/,
  )
  assert.throws(
    () => assertServiceable({ ...baseConfig(), rules: [{ provider: 'p', model: 'm', proxyUrl: '', headers: ['x-a'] }] }),
    /must be an object/,
  )
})

// ── header merge unit ──────────────────────────────────────────────────────

test('applyExtraHeaders: fills gaps, never overwrites (case-insensitive)', () => {
  const base = new Headers({ 'X-Existing': 'keep', 'content-type': 'application/json' })
  applyExtraHeaders(base, { 'x-existing': 'rule', 'x-opencode-session': 'fixed-1' })
  assert.equal(base.get('x-existing'), 'keep')
  assert.equal(base.get('x-opencode-session'), 'fixed-1')
  assert.equal(base.get('content-type'), 'application/json')
})

// ── fetch-wrap integration ─────────────────────────────────────────────────

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server.address().port
}

function makeTunnelProxy() {
  const server = http.createServer(() => {})
  server.on('connect', (req, clientSock, head) => {
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
  return server
}

test('fetch wrapper: proxied and direct requests carry rule headers', async () => {
  const origin = http.createServer((q, s) => {
    s.setHeader('content-type', 'application/json')
    s.end(JSON.stringify({ session: q.headers['x-opencode-session'] ?? null, ua: q.headers['user-agent'] ?? null, auth: q.headers['authorization'] ?? null }))
  })
  const originPort = await listen(origin)
  const originUrl = `http://127.0.0.1:${originPort}/`
  const proxyServer = makeTunnelProxy()
  const proxyPort = await listen(proxyServer)
  const proxyUrl = `http://127.0.0.1:${proxyPort}`
  const dispose = installFetchWrapper()
  try {
    // proxied: rule header arrives
    await als.run({ proxyUrl, provider: 'opencode-go', model: 'm', headers: { 'x-opencode-session': 'fixed-1' } }, async () => {
      const res = await fetch(originUrl, { signal: AbortSignal.timeout(5000) })
      assert.equal((await res.json()).session, 'fixed-1')
    })
    // proxied: pre-existing header wins over the rule value
    await als.run({ proxyUrl, provider: 'opencode-go', model: 'm', headers: { 'x-opencode-session': 'fixed-1' } }, async () => {
      const res = await fetch(originUrl, {
        signal: AbortSignal.timeout(5000),
        headers: { 'x-opencode-session': 'caller-set' },
      })
      assert.equal((await res.json()).session, 'caller-set')
    })
    // proxied: Request-object input also carries the header
    await als.run({ proxyUrl, provider: 'opencode-go', model: 'm', headers: { 'x-opencode-session': 'fixed-1' } }, async () => {
      const res = await fetch(new Request(originUrl), { signal: AbortSignal.timeout(5000) })
      assert.equal((await res.json()).session, 'fixed-1')
    })
    // direct route (no dispatcher) still applies the rule's fixed header
    await als.run({ provider: 'opencode-go', model: 'm', headers: { 'x-opencode-session': 'direct-1' } }, async () => {
      const res = await fetch(originUrl, { signal: AbortSignal.timeout(5000) })
      assert.equal((await res.json()).session, 'direct-1')
    })
    await als.run({ provider: 'opencode-go', model: 'm', headers: { 'x-opencode-session': 'direct-request' } }, async () => {
      const res = await fetch(new Request(originUrl), { signal: AbortSignal.timeout(5000) })
      assert.equal((await res.json()).session, 'direct-request')
    })
    // no ALS store: no synthetic header
    {
      const res = await fetch(originUrl, { signal: AbortSignal.timeout(5000) })
      assert.equal((await res.json()).session, null)
    }
    // foreign-realm input (undici's own Request, fails global instanceof):
    // original Authorization survives and the rule header is added
    await als.run({ proxyUrl, provider: 'opencode-go', model: 'm', headers: { 'x-opencode-session': 'fixed-1' } }, async () => {
      const ureq = new UndiciRequest(originUrl, { headers: new UndiciHeaders({ authorization: 'Bearer kept' }) })
      const res = await fetch(ureq, { signal: AbortSignal.timeout(5000) })
      const body = await res.json()
      assert.equal(body.session, 'fixed-1')
      assert.equal(body.auth, 'Bearer kept')
    })
  } finally {
    dispose()
    proxyServer.close()
    origin.close()
  }
})

// ── client helpers ─────────────────────────────────────────────────────────

test('format/parse headers text round-trips; errors are human-readable', () => {
  assert.equal(formatHeadersText(undefined), '')
  assert.equal(formatHeadersText({}), '')
  assert.equal(formatHeadersText({ 'x-opencode-session': 'abc' }), 'x-opencode-session: abc')
  assert.deepEqual(parseHeadersText(''), { headers: {} })
  assert.deepEqual(parseHeadersText('x-opencode-session: abc\nX-B: 1').headers, { 'x-opencode-session': 'abc', 'X-B': '1' })
  assert.ok(parseHeadersText('no-colon-here').error?.includes('Name: value'))
  assert.ok(parseHeadersText('authorization: Bearer x').error?.includes('managed by the adapter'))
  assert.ok(parseHeadersText('x-a: 1\nx-a: 2').error?.includes('duplicate'))
})

test('buildCreatorRules propagates headers; sanitizeRules keeps them', () => {
  const [r] = buildCreatorRules({
    provider: 'opencode-go',
    models: ['*'],
    proxyUrl: 'http://127.0.0.1:7890',
    headers: { 'x-opencode-session': 'fixed-1' },
    headerValueSources: { 'x-request-id': 'sessionId' },
  })
  assert.deepEqual(r.headers, { 'x-opencode-session': 'fixed-1' })
  assert.deepEqual(r.headerValueSources, { 'x-request-id': 'sessionId' })
  const [s] = sanitizeRules([{ provider: 'p', model: 'm', proxyUrl: '', headers: { 'x-a': '1' }, headerValueSources: { 'x-session': 'sessionId' } }])
  assert.deepEqual(s.headerValueSources, { 'x-session': 'sessionId' })
})
