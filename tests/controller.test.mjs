/**
 * Offline tests for the client controller's rules sanitizer.
 * Imports the plain-ESM side artifact emitted by scripts/build-client.mjs.
 * Run: npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ModelProxyController, ensureRuleIds, normalizeConfig, parseHeaderRows, parseHeadersText } from '../.test-build/controller.js'

const LEGACY_RULE = {
  id: 'r1',
  provider: 'opencode-meta',
  model: '*',
  proxyUrl: 'socks5://127.0.0.1:1080',
  enabled: true,
  note: 'route all opencode-meta models through socks5://127.0.0.1:1080', // removed from schema
  futureField: { nested: true }, // unknown to every schema version
}

test('sanitizeRules keeps known fields and drops legacy/unknown ones', () => {
  const [out] = sanitize(LEGACY_RULE)
  assert.deepEqual(out, {
    id: 'r1',
    provider: 'opencode-meta',
    model: '*',
    proxyUrl: 'socks5://127.0.0.1:1080',
    enabled: true,
  })
})

function sanitize(rule) {
  // sanitizeRules is exported; call through the module under test.
  return sanitizeRulesImpl([rule])
}

import { sanitizeRules as sanitizeRulesImpl } from '../.test-build/controller.js'

test('sanitizeRules omits unset optional fields instead of writing undefined', () => {
  const [out] = sanitizeRulesImpl([{ provider: 'p', model: 'm', proxyUrl: '' }])
  assert.deepEqual(out, { provider: 'p', model: 'm', proxyUrl: '' })
  assert.ok(!('purpose' in out), 'no undefined purpose key')
  assert.ok(!('credentialRef' in out), 'no undefined credentialRef key')
})

test('save() persists sanitized rules through the scope', async () => {
  const writes = []
  const scope = {
    getSnapshot: () => ({ status: 'ready', writable: true, value: { enabled: true, rules: [], defaultProxy: '', debug: false } }),
    subscribe: () => () => {},
    set: async (field, value) => {
      writes.push([field, value])
    },
  }
  const ctrl = new ModelProxyController(scope)
  const next = normalizeConfig({
    enabled: true,
    proxyHosts: [],
    debug: false,
    defaultProxy: '',
    rules: [LEGACY_RULE],
  })
  await ctrl.save(next)
  const hostsWrite = writes.find(([field]) => field === 'proxyHosts')
  const rulesWrite = writes.find(([field]) => field === 'rules')
  assert.ok(hostsWrite, 'proxy hosts write happened')
  assert.ok(rulesWrite, 'rules write happened')
  assert.equal(writes[0][0], 'proxyHosts', 'hosts are written before their references')
  assert.equal(hostsWrite[1].length, 1)
  assert.equal(rulesWrite[1][0].proxyHostId, hostsWrite[1][0].id)
  assert.equal(rulesWrite[1][0].proxyUrl, undefined)
  assert.deepEqual(rulesWrite[1][0], {
    id: 'r1',
    provider: 'opencode-meta',
    model: '*',
    proxyHostId: hostsWrite[1][0].id,
    enabled: true,
  })
  assert.equal(writes[2][0], 'defaultProxyHostId')
})

test('save() rejects a refused settings write', async () => {
  const scope = {
    getSnapshot: () => ({ status: 'ready', writable: true, value: { enabled: true, proxyHosts: [], rules: [], defaultProxy: '', debug: false } }),
    subscribe: () => () => {},
    set: async (field) => field !== 'proxyHosts',
  }
  const ctrl = new ModelProxyController(scope)
  await assert.rejects(
    ctrl.save({ enabled: true, proxyHosts: [], rules: [], defaultProxy: '', debug: false }),
    /settings write rejected for proxyHosts/,
  )
})

test('ensureRuleIds still fills missing ids on sanitized shapes', () => {
  const cfg = ensureRuleIds({ enabled: true, rules: [{ provider: 'p', model: 'm', proxyUrl: '' }], defaultProxy: '', debug: false })
  assert.ok(cfg.rules[0].id, 'id generated')
  const same = ensureRuleIds({ enabled: true, rules: [{ provider: 'p', model: 'm', proxyUrl: '' }], defaultProxy: '', debug: false })
  assert.equal(cfg.rules[0].id, same.rules[0].id)
})

test('parseHeadersText rejects proxy control headers and oversized values', () => {
  assert.ok(parseHeadersText('proxy-authenticate: x').error)
  assert.ok(parseHeadersText(`x-test: ${'x'.repeat(4097)}`).error)
})

test('parseHeaderRows switches a fixed Header to every dynamic source', () => {
  for (const source of ['sessionId', 'provider', 'model', 'purpose']) {
    assert.deepEqual(
      parseHeaderRows([{ key: 'header-1', name: 'x-request-context', value: 'stale-fixed-value', source }]),
      { headers: undefined, sources: { 'x-request-context': source } },
    )
  }
})

test('parseHeaderRows keeps fixed and dynamic Headers together', () => {
  assert.deepEqual(
    parseHeaderRows([
      { key: 'header-1', name: 'x-fixed', value: 'value', source: 'fixed' },
      { key: 'header-2', name: 'x-session', value: '', source: 'sessionId' },
    ]),
    {
      headers: { 'x-fixed': 'value' },
      sources: { 'x-session': 'sessionId' },
    },
  )
})

test('dropping unknown keys is loud: console.warn names each stripped field', async (t) => {
  const warnings = []
  const original = console.warn
  console.warn = (msg) => warnings.push(msg)
  t.after(() => { console.warn = original })
  sanitize(LEGACY_RULE)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /\[model-proxy\] dropping unknown rule field\(s\): note, futureField/)
})

test('clean rules produce no warning noise', async (t) => {
  const warnings = []
  const original = console.warn
  console.warn = (msg) => warnings.push(msg)
  t.after(() => { console.warn = original })
  sanitizeRulesImpl([{ provider: 'p', model: '*', proxyUrl: '' }])
  assert.deepEqual(warnings, [])
})

// ── batch creation & grouped view (pure helpers) ──
import { buildCreatorRules, groupByProvider, makeRuleId } from '../.test-build/controller.js'

test('buildCreatorRules fans one spec into N rules sharing connection fields', () => {
  const rules = buildCreatorRules({
    provider: 'opencode',
    models: ['muse-spark', 'muse-spark', ' muse-flow '],
    proxyUrl: ' socks5://127.0.0.1:1080 ',
    purpose: '',
    credentialRef: undefined,
  })
  assert.equal(rules.length, 2, 'duplicate and blank models collapse')
  assert.ok(rules.every((r) => r.provider === 'opencode'))
  assert.ok(rules.every((r) => r.proxyUrl === 'socks5://127.0.0.1:1080'), 'proxy trimmed')
  assert.ok(rules.every((r) => r.enabled === true))
  assert.ok(!('purpose' in rules[0]), 'empty purpose omitted')
  assert.ok(!('credentialRef' in rules[0]), 'unset credentialRef omitted')
  const ids = new Set(rules.map((r) => r.id))
  assert.equal(ids.size, 2, 'unique card ids')
})

test('buildCreatorRules returns empty for missing provider or models', () => {
  assert.deepEqual(buildCreatorRules({ provider: '', models: ['a'] , proxyUrl: ''}), [])
  assert.deepEqual(buildCreatorRules({ provider: 'p', models: ['  ', ''], proxyUrl: '' }), [])
  assert.deepEqual(buildCreatorRules({ provider: 'p', models: [], proxyUrl: '' }), [])
})

test('buildCreatorRules keeps checked models and wildcard patterns side by side', () => {
  // Creator contract: checkbox picks (exact ids, incl. bare `*`) merge with
  // the custom pattern input (`vendor-*`) into one batch.
  const rules = buildCreatorRules({ provider: 'p', models: ['m1', '*', 'muse-*'], proxyUrl: '' })
  assert.deepEqual(rules.map((r) => r.model), ['m1', '*', 'muse-*'])
})

test('makeRuleId yields non-empty distinct strings', () => {
  assert.notEqual(makeRuleId(), makeRuleId())
  assert.ok(makeRuleId().length > 0)
})

test('groupByProvider preserves first-appearance group order and intra-group order', () => {
  const rule = (provider, model) => ({ id: `${provider}-${model}`, provider, model, proxyUrl: '', enabled: true })
  const groups = groupByProvider([
    rule('b', 'b1'),
    rule('a', 'a1'),
    rule('b', 'b2'),
    rule('a', 'a2'),
    rule('c', 'c1'),
  ])
  assert.deepEqual(groups.map((g) => g.provider), ['b', 'a', 'c'])
  assert.deepEqual(groups[0].rules.map((r) => r.model), ['b1', 'b2'])
  assert.deepEqual(groups[1].rules.map((r) => r.model), ['a1', 'a2'])
  assert.deepEqual(groupByProvider([]), [])
})

test('normalizeConfig migrates inline URLs to reusable hosts and keeps direct rules direct', () => {
  const cfg = normalizeConfig({
    enabled: true,
    proxyHosts: [],
    rules: [
      { provider: 'p', model: 'a', proxyUrl: 'socks5://127.0.0.1:1080', enabled: true },
      { provider: 'p', model: 'b', proxyUrl: 'socks5://127.0.0.1:1080', enabled: true },
      { provider: 'p', model: 'c', proxyUrl: '', headers: { 'x-test': 'yes' }, enabled: true },
    ],
    defaultProxy: 'http://127.0.0.1:7890',
    debug: false,
  })
  assert.equal(cfg.proxyHosts.length, 2)
  assert.equal(cfg.proxyHosts[0].proxyUrl, 'socks5://127.0.0.1:1080')
  assert.equal(cfg.rules[0].proxyHostId, cfg.proxyHosts[0].id)
  assert.equal(cfg.rules[1].proxyHostId, cfg.proxyHosts[0].id)
  assert.equal(cfg.rules[2].proxyHostId, undefined)
  assert.equal(cfg.rules[2].proxyUrl, undefined)
  assert.deepEqual(cfg.rules[2].headers, { 'x-test': 'yes' })
  assert.equal(cfg.defaultProxyHostId, cfg.proxyHosts[1].id)
  assert.equal(cfg.defaultProxy, '')
  assert.deepEqual(normalizeConfig(cfg), cfg, 'normalization is idempotent')
})

test('normalizeConfig canonicalizes dynamic Header sources', () => {
  const cfg = normalizeConfig({
    enabled: true,
    proxyHosts: [],
    rules: [{
      provider: 'p',
      model: '*',
      proxyUrl: '',
      headers: { 'x-opencode-session': 'stale-fixed-value' },
      headerValueSources: { 'x-opencode-session': 'sessionId' },
      enabled: true,
    }],
    defaultProxy: '',
    debug: false,
  })
  assert.equal(cfg.rules[0].headers, undefined)
  assert.deepEqual(cfg.rules[0].headerValueSources, { 'x-opencode-session': 'sessionId' })
})
