/**
 * Offline tests for the client catalog module (provider/model dropdown data).
 * Imports the plain-ESM side artifact emitted by scripts/build-client.mjs.
 * Run: npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attachConfigured, getPath, pickModelsByProvider, pickProviders, ProviderCatalogStore, unwrapRpc } from '../.test-build/catalog.js'

const okEnvelope = (value) => ({ result: { ok: true, value } })
const errEnvelope = (message) => ({ result: { ok: false, error: { message } } })

/** Programmable fake of the two wire faces the store consumes. */
function fakeBackend({ providers, models, providersError, modelsError }) {
  const calls = []
  return {
    calls,
    api: {
      llm: {
        async providers() {
          calls.push('providers')
          if (providersError) throw new Error(providersError)
          return okEnvelope(providers)
        },
        async models() {
          calls.push('models')
          if (modelsError) throw new Error(modelsError)
          return okEnvelope(models)
        },
      },
    },
  }
}

/** Eventing fake of ctx.remote whose $on returns a real disposer. */
function fakeRemote() {
  const listeners = new Map()
  return {
    remote: {
      $on(event, listener) {
        if (!listeners.has(event)) listeners.set(event, new Set())
        listeners.get(event).add(listener)
        return () => listeners.get(event).delete(listener)
      },
    },
    emit(event) {
      for (const listener of listeners.get(event) ?? []) listener()
    },
    count(event) {
      return (listeners.get(event) ?? new Set()).size
    },
  }
}

/** Drain enough microtasks/macrotasks for a load() round-trip to settle. */
async function flush() {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

async function settledStore(backend, remote) {
  const store = new ProviderCatalogStore(backend.api, remote)
  store.bind()
  await flush()
  return store
}

test('unwrapRpc passes values through and raises wire error messages', () => {
  assert.equal(unwrapRpc(okEnvelope({ a: 1 })).a, 1)
  assert.throws(() => unwrapRpc(errEnvelope('nope')), /nope/)
  assert.throws(() => unwrapRpc({ result: 42 }), /malformed RPC envelope/)
  assert.throws(() => unwrapRpc(undefined), /malformed RPC envelope/)
})

test('pickProviders keeps parseable rows, settings address, active and declared', () => {
  const rows = pickProviders({
    providers: [
      { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: ['providers', 'deepseek-official'], active: true },
      { provider: 'openai', displayName: 'openai', active: false, declared: false },
      { provider: '', displayName: 'dropped' },
      { displayName: 'no id' },
      42,
    ],
  })
  assert.deepEqual(rows, [
    {
      provider: 'deepseek-official',
      displayName: 'DeepSeek',
      active: true,
      settingsNs: 'llm-deepseek',
      settingsPath: ['providers', 'deepseek-official'],
    },
    { provider: 'openai', displayName: 'openai', active: false, declared: false },
  ])
  assert.deepEqual(pickProviders(undefined), [])
  assert.deepEqual(pickProviders({ providers: 'nope' }), [])
})

test('getPath walks nested values and returns undefined past a missing hop', () => {
  const value = { llm: { providers: { opencode: { baseURL: 'https://x' } } } }
  assert.equal(getPath(value, ['llm', 'providers', 'opencode', 'baseURL']), 'https://x')
  assert.equal(getPath(value, ['llm', 'providers', 'missing']), undefined)
  assert.equal(getPath(value, ['llm', 'providers', 'opencode', 'baseURL', 'deeper']), undefined)
  assert.equal(getPath(undefined, ['a']), undefined)
})

test('attachConfigured mirrors ui-settings-models: namespace + profile presence', () => {
  const providers = pickProviders({
    providers: [
      { provider: 'user-added', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'user-added'], active: true },
      { provider: 'whole-section', settingsNs: 'deepseek', settingsPath: [], active: true },
      { provider: 'not-configured', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'ghost'], active: false },
      { provider: 'no-address', active: true }, // registered outside the directory
      { provider: 'unknown-ns', settingsNs: 'ghost-ns', settingsPath: [], active: true },
    ],
  })
  const described = attachConfigured(providers, [
    { ns: 'llm-pi-ai', value: { providers: { 'user-added': { baseURL: 'https://x' } } } },
    { ns: 'deepseek', value: {} },
  ])
  const byId = Object.fromEntries(described.map((p) => [p.provider, p.configured]))
  // profile object present in the merged namespace value
  assert.equal(byId['user-added'], true)
  // whole-section provider counts as configured once the namespace exists
  assert.equal(byId['whole-section'], true)
  // namespace exists but the route's profile is absent
  assert.equal(byId['not-configured'], false)
  // no settings address → unknown (undefined), never guessed as configured
  assert.equal(byId['no-address'], undefined)
  // namespace absent from the mirror → unknown
  assert.equal(byId['unknown-ns'], undefined)
})

test('pickModelsByProvider groups by provider id and drops malformed rows', () => {
  const map = pickModelsByProvider({
    groups: [
      { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' }, { id: 'bare' }, {}] },
      { id: 'empty-route', name: 'x', models: [] },
      { id: '', name: 'dropped', models: [{ id: 'm' }] },
      { name: 'no models array' },
    ],
    failures: [{ id: 'broken', name: 'broken', message: 'boom' }],
  })
  assert.deepEqual(map, {
    'deepseek-official': [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' }, { id: 'bare' }],
    'empty-route': [],
  })
  assert.deepEqual(pickModelsByProvider(null), {})
})

test('store loads both catalogs on bind and exposes a ready snapshot', async () => {
  const backend = fakeBackend({
    providers: { providers: [{ provider: 'p1', displayName: 'P One', active: true }] },
    models: { groups: [{ id: 'p1', name: 'P One', models: [{ id: 'm1', name: 'M One' }] }], failures: [] },
  })
  const { remote } = fakeRemote()
  const store = await settledStore(backend, remote)
  assert.deepEqual(store.getSnapshot(), {
    status: 'ready',
    providers: [{ provider: 'p1', displayName: 'P One', active: true }],
    modelsByProvider: { p1: [{ id: 'm1', name: 'M One' }] },
  })
  assert.deepEqual(backend.calls, ['providers', 'models'])
  store.dispose()
})

test('models failure alone degrades to ready with empty model groups', async () => {
  const backend = fakeBackend(
    { providers: { providers: [{ provider: 'p1', displayName: 'p1', active: true }] }, modelsError: 'catalog down' },
  )
  const store = await settledStore(backend)
  assert.equal(store.getSnapshot().status, 'ready')
  assert.deepEqual(store.getSnapshot().providers.map((p) => p.provider), ['p1'])
  assert.deepEqual(store.getSnapshot().modelsByProvider, {})
  store.dispose()
})

test('first-load provider failure marks unavailable; card falls back by reading empty rows', async () => {
  const backend = fakeBackend({ providers: {}, providersError: 'rpc unavailable' })
  const store = await settledStore(backend)
  assert.equal(store.getSnapshot().status, 'unavailable')
  assert.deepEqual(store.getSnapshot().providers, [])
  store.dispose()
})

test('failed background refresh keeps last good rows', async () => {
  const good = fakeBackend({
    providers: { providers: [{ provider: 'p1', displayName: 'p1', active: true }] },
    models: { groups: [], failures: [] },
  })
  const store = await settledStore(good)
  // Swap to a failing backend behind the same face object.
  good.api.llm.providers = async () => errEnvelope('host restarted')
  await store.load()
  assert.equal(store.getSnapshot().status, 'unavailable')
  assert.deepEqual(store.getSnapshot().providers.map((p) => p.provider), ['p1'])
  store.dispose()
})

test('forwarded llm/adapters-updated triggers a reload with fresh data', async () => {
  const backend = fakeBackend({
    providers: { providers: [{ provider: 'a', displayName: 'a', active: true }] },
    models: { groups: [], failures: [] },
  })
  const events = fakeRemote()
  const store = await settledStore(backend, events.remote)
  backend.api.llm.models = async () => {
    backend.calls.push('models')
    return okEnvelope({ groups: [{ id: 'a', name: 'a', models: [{ id: 'm9' }] }], failures: [] })
  }
  backend.calls.length = 0
  events.emit('llm/adapters-updated')
  await flush()
  assert.deepEqual(backend.calls, ['providers', 'models'])
  assert.deepEqual(store.getSnapshot().modelsByProvider.a, [{ id: 'm9' }])
  store.dispose()
})

test('settings/document-updated also refreshes; dispose removes listeners and orphans in-flight loads', async () => {
  const backend = fakeBackend({
    providers: { providers: [{ provider: 'a', displayName: 'a', active: true }] },
    models: { groups: [], failures: [] },
  })
  const events = fakeRemote()
  const store = new ProviderCatalogStore(backend.api, events.remote)

  // Never-resolving first load: dispose must orphan it via generation guard.
  let release
  backend.api.llm.providers = () => new Promise((resolve) => { release = resolve })
  store.bind()
  assert.equal(events.count('llm/adapters-updated'), 1)
  assert.equal(events.count('settings/document-updated'), 1)

  store.dispose()
  release(okEnvelope({ providers: [{ provider: 'late', displayName: 'late', active: true }] }))
  await flush()
  // The late response lost the generation race: the snapshot is untouched
  // (it keeps whatever it held at dispose time — here, 'loading').
  assert.equal(store.getSnapshot().status, 'loading')

  // Listeners are gone after dispose.
  assert.equal(events.count('llm/adapters-updated'), 0)
  assert.equal(events.count('settings/document-updated'), 0)
})

test('bind is idempotent and subscribe fans out then stops after unsubscribe', async () => {
  const backend = fakeBackend({
    providers: { providers: [] },
    models: { groups: [], failures: [] },
  })
  const store = new ProviderCatalogStore(backend.api)
  let hits = 0
  const off = store.subscribe(() => hits++)
  store.bind()
  store.bind()
  await flush()
  assert.ok(hits >= 2, `expected loading+ready emits, got ${hits}`)
  off()
  const before = hits
  await store.load()
  assert.equal(hits, before, 'unsubscribed listener must not fire again')
  store.dispose()
})

test('settings.describe enrichment attaches configured flags for grouping', async () => {
  const backend = fakeBackend({
    providers: {
      providers: [
        { provider: 'mine', displayName: 'Mine', active: true, settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'mine'] },
        { provider: 'shipped', displayName: 'Shipped', active: true },
      ],
    },
    models: { groups: [], failures: [] },
  })
  backend.api.settings = {
    async describe() {
      backend.calls.push('describe')
      return okEnvelope({ writable: true, hasDocument: true, namespaces: [{ ns: 'llm-pi-ai', value: { providers: { mine: {} } } }] })
    },
  }
  const store = await settledStore(backend)
  assert.deepEqual(backend.calls, ['providers', 'models', 'describe'])
  const [mine, shipped] = store.getSnapshot().providers
  assert.equal(mine.configured, true)
  // no settings address → stays unknown; the card groups it under the directory
  assert.equal(shipped.configured, undefined)
  store.dispose()
})

test('describe failure or missing face degrades to configured-undefined rows', async () => {
  const base = {
    providers: { providers: [{ provider: 'p1', displayName: 'p1', active: true, settingsNs: 'ns', settingsPath: [] }] },
    models: { groups: [], failures: [] },
  }
  // rejecting describe
  const failing = fakeBackend(base)
  failing.api.settings = { async describe() { throw new Error('mirror down') } }
  const s1 = await settledStore(failing)
  assert.equal(s1.getSnapshot().providers[0].configured, undefined)
  s1.dispose()
  // no settings face at all (older host)
  const faceless = fakeBackend(base)
  const s2 = await settledStore(faceless)
  assert.deepEqual(faceless.calls, ['providers', 'models'], 'must not attempt describe without a face')
  assert.equal(s2.getSnapshot().providers[0].configured, undefined)
  s2.dispose()
})
