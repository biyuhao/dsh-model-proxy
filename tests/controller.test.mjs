/**
 * Offline tests for the client controller's rules sanitizer.
 * Imports the plain-ESM side artifact emitted by scripts/build-client.mjs.
 * Run: npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ModelProxyController, ensureRuleIds } from '../.test-build/controller.js'

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
  await ctrl.save({
    enabled: true,
    debug: false,
    defaultProxy: '',
    rules: [LEGACY_RULE],
  })
  const rulesWrite = writes.find(([field]) => field === 'rules')
  assert.ok(rulesWrite, 'rules write happened first')
  assert.deepEqual(rulesWrite[1], [{
    id: 'r1',
    provider: 'opencode-meta',
    model: '*',
    proxyUrl: 'socks5://127.0.0.1:1080',
    enabled: true,
  }])
  assert.equal(writes[0][0], 'rules', 'rules is the first write (rejection-prone field first)')
})

test('ensureRuleIds still fills missing ids on sanitized shapes', () => {
  const cfg = ensureRuleIds({ enabled: true, rules: [{ provider: 'p', model: 'm', proxyUrl: '' }], defaultProxy: '', debug: false })
  assert.ok(cfg.rules[0].id, 'id generated')
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
