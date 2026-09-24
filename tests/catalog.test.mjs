/**
 * Offline tests for the client catalog module (provider/model dropdown data).
 * Imports the plain-ESM side artifact emitted by scripts/build-client.mjs.
 * Run: npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attachConfigured, getPath, joinProviderDirectory, pickModelsByProvider, pickProviders, ProviderCatalogStore, unwrapRemoteResult, unwrapRpc } from '../.test-build/catalog.js'

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

/** Typert RemoteResult envelope helpers (DSH 0.1.2 remote face). */
const remoteOk = (value) => ({ ok: true, value })
const remoteErr = (message) => ({ ok: false, error: { message } })

/** Fake ctx.remote with Typert llm/settings faces resolving RemoteResults. */
function fakeTypertRemote({ registered, directory, registeredError, registeredReject, directoryError, directoryReject, omitDirectoryFace, describe, sessionCatalog, sessionCatalogReject }) {
  const listeners = new Map()
  const calls = []
  const on = (event, listener) => {
    if (!listeners.has(event)) listeners.set(event, new Set())
    listeners.get(event).add(listener)
    return () => listeners.get(event).delete(listener)
  }
  const remote = {
    $on: on,
    llm: {
      async listProviders() {
        calls.push('typert:listProviders')
        if (registeredReject) throw new Error(registeredReject)
        if (registeredError) return remoteErr(registeredError)
        return remoteOk(registered ?? [])
      },
    },
    settings: describe === undefined
      ? undefined
      : {
          async describe() {
            calls.push('typert:describe')
            return describe
          },
        },
  }
  if (!omitDirectoryFace) {
    remote.llm.listConfigurableProviders = async () => {
      calls.push('typert:listConfigurableProviders')
      if (directoryReject) throw new Error(directoryReject)
      if (directoryError) return remoteErr(directoryError)
      return remoteOk(directory ?? [])
    }
  }
  if (sessionCatalog !== undefined || sessionCatalogReject !== undefined) {
    remote.session = {
      async modelCatalog() {
        calls.push('typert:modelCatalog')
        if (sessionCatalogReject) throw new Error(sessionCatalogReject)
        return sessionCatalog
      },
    }
  }
  return {
    calls,
    remote,
    emit(event) {
      for (const listener of listeners.get(event) ?? []) listener()
    },
  }
}

test('unwrapRemoteResult unwraps Typert envelopes and passes payloads through', () => {
  assert.deepEqual(unwrapRemoteResult(remoteOk([{ id: 'a' }])), [{ id: 'a' }])
  assert.deepEqual(unwrapRemoteResult([{ id: 'a' }]), [{ id: 'a' }])
  assert.deepEqual(unwrapRemoteResult({ providers: [] }), { providers: [] })
  assert.throws(() => unwrapRemoteResult(remoteErr('boom')), /boom/)
  assert.throws(() => unwrapRemoteResult({ ok: false, error: {} }), /remote request failed/)
})

test('joinProviderDirectory mirrors the Models page: declared first, live-only appended', () => {
  const joined = joinProviderDirectory(
    [{ id: 'mine', name: 'Mine Live' }, { id: 'live-only', name: 'Live Only' }],
    [
      { provider: 'mine', displayName: 'Mine', settingsNs: 'ns', settingsPath: ['providers', 'mine'], declared: false },
      { provider: 'dormant', displayName: 'Dormant', settingsNs: 'ns', settingsPath: [] },
    ],
  )
  const rows = pickProviders(joined)
  assert.deepEqual(rows, [
    {
      provider: 'mine',
      displayName: 'Mine',
      active: true,
      settingsNs: 'ns',
      settingsPath: ['providers', 'mine'],
      declared: false,
    },
    { provider: 'dormant', displayName: 'Dormant', active: false, settingsNs: 'ns', settingsPath: [] },
    { provider: 'live-only', displayName: 'Live Only', active: true },
  ])
  assert.deepEqual(pickProviders(joinProviderDirectory([], [])), [])
})

test('store prefers the Typert face and joins live routes with the directory', async () => {
  // Regression: the Typert path used to feed the {ok,value} envelope straight
  // into pickProviders, yielding [] and a silent input-only fallback.
  const backend = fakeBackend({ models: { groups: [], failures: [] } })
  backend.api.llm.providers = async () => {
    backend.calls.push('legacy:providers')
    return okEnvelope({ providers: [] })
  }
  const ty = fakeTypertRemote({
    registered: [{ id: 'mine', name: 'Mine Live' }, { id: 'live-only', name: 'Live Only' }],
    directory: [
      { provider: 'mine', displayName: 'Mine', settingsNs: 'ns', settingsPath: ['providers', 'mine'] },
      { provider: 'dormant', displayName: 'Dormant', settingsNs: 'ns', settingsPath: [] },
    ],
    describe: remoteOk({
      namespaces: [
        { ns: 'ns', value: { providers: { mine: {}, dormant: {} } } },
        { ns: 'other', value: { providers: [{ provider: 'synth', models: ['sm1', { id: 'sm2', name: 'S2' }] }] } },
      ],
    }),
  })
  const store = await settledStore(backend, ty.remote)
  const snap = store.getSnapshot()
  assert.equal(snap.status, 'ready')
  assert.ok(!backend.calls.includes('legacy:providers'), 'Typert face must win over legacy providers')
  assert.deepEqual(snap.providers.map((p) => [p.provider, p.active, p.configured]), [
    ['mine', true, true],
    ['dormant', false, true],
    ['live-only', true, undefined],
  ])
  // models synthesized from the settings.describe mirror (no bulk llm.models on 0.1.2)
  assert.deepEqual(snap.modelsByProvider.synth, [{ id: 'sm1' }, { id: 'sm2', name: 'S2' }])
  store.dispose()
})

test('throwing reduced remote namespaces fall back to legacy faces', async () => {
  const backend = fakeBackend({
    providers: { providers: [{ id: 'legacy', name: 'Legacy' }] },
    models: { groups: [], failures: [] },
  })
  const remote = {
    $on: () => () => {},
    get llm() { throw new Error('not injected') },
    get settings() { throw new Error('not injected') },
    get session() { throw new Error('not injected') },
  }
  const store = await settledStore(backend, remote)
  assert.equal(store.getSnapshot().status, 'ready')
  assert.deepEqual(store.getSnapshot().providers.map((p) => p.provider), ['legacy'])
  store.dispose()
})

test('Typert business rejection on both faces marks unavailable, legacy untouched', async () => {
  const backend = fakeBackend({ models: { groups: [], failures: [] } })
  const ty = fakeTypertRemote({ registeredError: 'llm down', directoryError: 'llm down' })
  const store = await settledStore(backend, ty.remote)
  assert.equal(store.getSnapshot().status, 'unavailable')
  assert.deepEqual(store.getSnapshot().providers, [])
  assert.ok(!backend.calls.includes('providers'), 'must not fall back to legacy once Typert answered')
  store.dispose()
})

test('one surviving Typert side still yields a dropdown', async () => {
  const backend = fakeBackend({ models: { groups: [], failures: [] } })
  const ty = fakeTypertRemote({
    registeredReject: 'carrier fault',
    directory: [{ provider: 'dir-only', displayName: 'Dir Only', settingsNs: 'ns', settingsPath: [] }],
  })
  const store = await settledStore(backend, ty.remote)
  assert.equal(store.getSnapshot().status, 'ready')
  assert.deepEqual(store.getSnapshot().providers, [
    { provider: 'dir-only', displayName: 'Dir Only', active: false, settingsNs: 'ns', settingsPath: [] },
  ])
  store.dispose()
})

test('hosts returning bare arrays keep working (no-envelope passthrough)', async () => {
  const backend = fakeBackend({ models: { groups: [], failures: [] } })
  const events = fakeTypertRemote({ registered: [], directory: [] })
  events.remote.llm.listProviders = async () => {
    events.calls.push('typert:listProviders')
    return [{ id: 'bare', name: 'Bare' }]
  }
  const store = await settledStore(backend, events.remote)
  assert.equal(store.getSnapshot().status, 'ready')
  assert.deepEqual(store.getSnapshot().providers.map((p) => p.provider), ['bare'])
  store.dispose()
})

test('session.modelCatalog feeds models when legacy bulk models are gone', async () => {
  // Modern hosts removed the bulk llm.models RPC; the Plugins-tab-native
  // session catalog carries the same {groups} shape.
  const backend = fakeBackend({
    providers: { providers: [{ provider: 'p1', displayName: 'p1', active: true }] },
    models: { groups: [], failures: [] },
  })
  delete backend.api.llm.models
  const ty = fakeTypertRemote({
    registered: [{ id: 'p1', name: 'P One' }],
    directory: [],
    sessionCatalog: remoteOk({
      default: { provider: 'p1', model: 'm1' },
      routableProviders: ['p1'],
      groups: [{ id: 'p1', name: 'P One', models: [{ id: 'm1', name: 'M One' }, { id: 'm2' }] }],
    }),
  })
  const store = await settledStore(backend, ty.remote)
  const snap = store.getSnapshot()
  assert.equal(snap.status, 'ready')
  assert.deepEqual(snap.modelsByProvider, { p1: [{ id: 'm1', name: 'M One' }, { id: 'm2' }] })
  assert.ok(ty.calls.includes('typert:modelCatalog'))
  store.dispose()
})

test('legacy bulk models still win when both faces answer', async () => {
  const backend = fakeBackend({
    providers: { providers: [{ provider: 'p1', displayName: 'p1', active: true }] },
    models: { groups: [{ id: 'p1', name: 'p1', models: [{ id: 'legacy-m' }] }], failures: [] },
  })
  const ty = fakeTypertRemote({
    sessionCatalog: remoteOk({ groups: [{ id: 'p1', name: 'p1', models: [{ id: 'session-m' }] }] }),
  })
  const store = await settledStore(backend, ty.remote)
  assert.deepEqual(store.getSnapshot().modelsByProvider, { p1: [{ id: 'legacy-m' }] })
  assert.ok(!ty.calls.includes('typert:modelCatalog'), 'must not call session catalog while legacy answers')
  store.dispose()
})

test('session catalog failure degrades to empty models without failing providers', async () => {
  const backend = fakeBackend({
    providers: { providers: [{ provider: 'p1', displayName: 'p1', active: true }] },
    models: { groups: [], failures: [] },
  })
  delete backend.api.llm.models
  const ty = fakeTypertRemote({
    registered: [{ id: 'p1', name: 'P One' }],
    directory: [],
    sessionCatalog: remoteErr('session down'),
  })
  const store = await settledStore(backend, ty.remote)
  assert.equal(store.getSnapshot().status, 'ready')
  assert.deepEqual(store.getSnapshot().providers.map((p) => p.provider), ['p1'])
  assert.deepEqual(store.getSnapshot().modelsByProvider, {})
  store.dispose()
})

test('first-load provider failure warns about the text-input fallback', async () => {
  const warnings = []
  const orig = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    const backend = fakeBackend({ providers: {}, providersError: 'rpc unavailable' })
    const store = await settledStore(backend)
    assert.equal(store.getSnapshot().status, 'unavailable')
    assert.ok(warnings.some((m) => m.includes('free-text inputs')), `expected fallback warning, got ${JSON.stringify(warnings)}`)
    store.dispose()
  } finally {
    console.warn = orig
  }
})
