/**
 * Offline unit tests for config schema, validation and routing.
 * Run: npm test   (builds lib/host first)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ModelProxyConfig, assertServiceable, resolveProxy, resolveRoute, redactProxyUrl } from '../lib/host/config.js'

const baseConfig = () => ({ enabled: true, debug: false, defaultProxy: '', rules: [] })

test('schema resolves hand-written yaml rules without id (no function-default trap)', () => {
  const cfg = ModelProxyConfig({ rules: [{ provider: 'opencode', model: 'muse-spark', proxyUrl: '' }] })
  // Volatile fields resolve to live references; the snapshot carries the values.
  assert.equal(cfg.enabled.get(), true)
  assert.equal(cfg.rules.get()[0].enabled, true)
})

test('schema round-trips reusable proxy hosts and default host selection', () => {
  const cfg = ModelProxyConfig({
    proxyHosts: [{ id: 'office', name: 'Office', proxyUrl: 'socks5://127.0.0.1:1080' }],
    defaultProxyHostId: 'office',
    rules: [{ provider: 'p', model: '*', proxyHostId: 'office', headerValueSources: { 'x-session': 'sessionId' } }],
  })
  assert.deepEqual(cfg.proxyHosts.get(), [{ id: 'office', name: 'Office', proxyUrl: 'socks5://127.0.0.1:1080' }])
  assert.equal(cfg.defaultProxyHostId.get(), 'office')
  assert.equal(cfg.rules.get()[0].proxyHostId, 'office')
  assert.deepEqual(cfg.rules.get()[0].headerValueSources, { 'x-session': 'sessionId' })
})

test('schema materializes defaults for bare entry', () => {
  const cfg = ModelProxyConfig({})
  assert.deepEqual({
    enabled: cfg.enabled.get(),
    proxyHosts: cfg.proxyHosts.get(),
    rules: cfg.rules.get(),
    defaultProxyHostId: cfg.defaultProxyHostId.get(),
    defaultProxy: cfg.defaultProxy.get(),
    debug: cfg.debug.get(),
    catalog: cfg.catalog.get(),
  }, { enabled: true, proxyHosts: [], rules: [], defaultProxyHostId: '', defaultProxy: '', debug: false, catalog: { providers: [], models: [] } })
})

test('rejects whitespace-padded provider / model', () => {
  assert.throws(
    () => assertServiceable({ ...baseConfig(), rules: [{ provider: ' opencode', model: 'm', proxyUrl: '' }] }),
    /whitespace/,
  )
  assert.throws(
    () => assertServiceable({ ...baseConfig(), rules: [{ provider: 'p', model: ' m ', proxyUrl: '' }] }),
    /whitespace/,
  )
})

test('rejects duplicate provider+model rules', () => {
  const rule = { provider: 'p', model: 'm', proxyUrl: '', enabled: true }
  assert.throws(() => assertServiceable({ ...baseConfig(), rules: [rule, { ...rule }] }), /duplicat/)
})

test('defaultProxy validation: bad URL / empty hostname / unsupported scheme', () => {
  for (const bad of ['http://', 'socks5:', 'ftp://h', 'http://:8080']) {
    assert.throws(() => assertServiceable({ ...baseConfig(), defaultProxy: bad }))
  }
  // good values pass
  assert.doesNotThrow(() => assertServiceable({ ...baseConfig(), defaultProxy: 'http://127.0.0.1:7890' }))
  assert.doesNotThrow(() => assertServiceable({ ...baseConfig(), defaultProxy: 'socks5h://u:p@h:1080' }))
})

test('proxy host references validate and resolve through the host profile', () => {
  const cfg = {
    enabled: true,
    debug: false,
    proxyHosts: [{ id: 'office', name: 'Office', proxyUrl: 'socks5://127.0.0.1:1080' }],
    defaultProxyHostId: '',
    defaultProxy: '',
    rules: [{ provider: 'p', model: '*', proxyHostId: 'office', enabled: true }],
  }
  assert.doesNotThrow(() => assertServiceable(cfg))
  assert.deepEqual(resolveRoute(cfg, 'p', 'm', undefined, (rule) => cfg.proxyHosts.find((h) => h.id === rule.proxyHostId)?.proxyUrl), {
    proxyUrl: 'socks5://127.0.0.1:1080',
  })
  assert.throws(
    () => assertServiceable({ ...cfg, rules: [{ ...cfg.rules[0], proxyHostId: 'missing' }] }),
    /unknown proxy host/,
  )
  assert.throws(
    () => assertServiceable({ ...cfg, rules: [{ ...cfg.rules[0], proxyUrl: 'http://other:1' }] }),
    /cannot set both/,
  )
})

test('routing: exact beats wildcard; "" exempts; disabled rules skipped; fallback applies', () => {
  const cfg = {
    enabled: true,
    debug: false,
    defaultProxy: '',
    rules: [
      { provider: 'opencode', model: 'muse-spark', proxyUrl: 'socks5://a:1080' },
      { provider: 'opencode', model: '*', proxyUrl: '' },
      { provider: 'acme', model: '*', proxyUrl: 'http://b:7890', enabled: false },
    ],
  }
  assert.equal(resolveProxy(cfg, 'opencode', 'muse-spark'), 'socks5://a:1080')
  // wildcard with empty proxyUrl => direct exemption (undefined after normalization)
  assert.equal(resolveProxy(cfg, 'opencode', 'other'), undefined)
  // disabled wildcard falls through to default
  assert.equal(resolveProxy({ ...cfg, defaultProxy: 'http://c:1' }, 'acme', 'x'), 'http://c:1')
  // no match anywhere -> undefined
  assert.equal(resolveProxy(cfg, 'nobody', 'x'), undefined)
})

test('routing: prefix "muse-*" sits between exact and "*"', () => {
  const cfg = {
    enabled: true,
    debug: false,
    defaultProxy: '',
    rules: [
      { provider: 'p', model: 'muse-spark-9', proxyUrl: 'socks5://exact:1' },
      { provider: 'p', model: 'muse-*', proxyUrl: 'http://prefix:2' },
      { provider: 'p', model: '*', proxyUrl: '' },
    ],
  }
  assert.equal(resolveProxy(cfg, 'p', 'muse-spark-9'), 'socks5://exact:1')
  assert.equal(resolveProxy(cfg, 'p', 'muse-other'), 'http://prefix:2')
  assert.equal(resolveProxy(cfg, 'p', 'unrelated'), undefined) // "*" with "" -> direct
})

test('routing: purpose filter — qualified rules only hit matching calls', () => {
  const cfg = {
    enabled: true,
    debug: false,
    defaultProxy: '',
    // purpose-qualified exemption MUST precede the general rule: matching is
    // first-wins inside each specificity pass
    rules: [
      { provider: 'p', model: '*', proxyUrl: '', purpose: 'compaction' },
      { provider: 'p', model: '*', proxyUrl: 'http://chat:1' },
    ],
  }
  // plain call skips the compaction-only rule and hits the general one
  assert.equal(resolveProxy(cfg, 'p', 'm'), 'http://chat:1')
  assert.equal(resolveProxy(cfg, 'p', 'm', 'compaction'), undefined)
  assert.equal(resolveProxy(cfg, 'p', 'm', 'session-title'), 'http://chat:1')
})

test('rejects misplaced "*" in model patterns', () => {
  for (const bad of ['mu*se', 'muse**', '**']) {
    assert.throws(
      () => assertServiceable({ enabled: true, debug: false, defaultProxy: '', rules: [{ provider: 'p', model: bad, proxyUrl: '' }] }),
      /trailing '\*'/,
      `expected rejection for ${bad}`,
    )
  }
  assert.doesNotThrow(() =>
    assertServiceable({ enabled: true, debug: false, defaultProxy: '', rules: [{ provider: 'p', model: 'muse-*', proxyUrl: '' }] }),
  )
  assert.doesNotThrow(() =>
    assertServiceable({ enabled: true, debug: false, defaultProxy: '', rules: [{ provider: 'p', model: '*', proxyUrl: '' }] }),
  )
})

test('rejects whitespace-padded purpose / credentialRef', () => {
  assert.throws(
    () => assertServiceable({ enabled: true, debug: false, defaultProxy: '', rules: [{ provider: 'p', model: 'm', proxyUrl: '', purpose: ' x' }] }),
    /purpose/,
  )
  assert.throws(
    () => assertServiceable({ enabled: true, debug: false, defaultProxy: '', rules: [{ provider: 'p', model: 'm', proxyUrl: '', credentialRef: 'x ' }] }),
    /credentialRef/,
  )
})

test('globally disabled config routes nothing', () => {
  const cfg = {
    enabled: false,
    debug: false,
    defaultProxy: 'http://c:1',
    rules: [{ provider: 'p', model: '*', proxyUrl: 'socks5://a:1', enabled: true }],
  }
  assert.equal(resolveProxy(cfg, 'p', 'anything'), undefined)
})

test('redactProxyUrl hides credentials and URL data', () => {
  const out = redactProxyUrl('socks5://user:secretpw@host:1080')
  assert.equal(out, 'socks5://***@host:1080')
  assert.equal(redactProxyUrl('socks5://token@host:1080?key=secret#fragment'), 'socks5://***@host:1080')
  assert.equal(redactProxyUrl('not a url'), '[invalid proxy URL]')
})

test('catalog mirror field is optional, validates, and never affects routing', () => {
  // Bare documents materialize an empty mirror (nested defaults); the card
  // treats an empty mirror exactly like an absent one.
  const bare = ModelProxyConfig({})
  assert.deepEqual(bare.catalog.get(), { providers: [], models: [] })
  // A host-written mirror round-trips through the schema.
  const mirror = {
    providers: [
      { provider: 'mine', displayName: 'Mine', active: true },
      { provider: 'dormant', active: false },
    ],
    models: [{ provider: 'mine', models: [{ id: 'm1', name: 'M One' }, { id: 'm2' }] }],
  }
  const cfg = ModelProxyConfig({ ...baseConfig(), catalog: mirror })
  assert.deepEqual(cfg.catalog.get(), mirror)
  // Validation and routing ignore the mirror entirely.
  assert.doesNotThrow(() => assertServiceable({ ...baseConfig(), catalog: mirror }))
  assert.equal(resolveProxy({ ...baseConfig(), catalog: mirror }, 'mine', 'm1'), undefined)
})
