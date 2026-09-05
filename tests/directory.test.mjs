/**
 * Offline unit tests for the host directory mirror (pure computation).
 * Run: npm test   (builds lib/host first)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  catalogsEqual,
  computeDirectoryCatalog,
  joinDirectoryProviders,
  synthesizeDirectoryModels,
} from '../lib/host/directory.js'

test('joinDirectoryProviders mirrors the Models page join', () => {
  const rows = joinDirectoryProviders(
    [{ id: 'mine', name: 'Mine Live' }, { id: 'live-only', name: 'Live Only' }],
    [
      { provider: 'mine', displayName: 'Mine', settingsNs: 'ns', settingsPath: ['providers', 'mine'] },
      { provider: 'dormant', displayName: 'Dormant', settingsNs: 'ns', settingsPath: [] },
    ],
  )
  assert.deepEqual(rows, [
    { provider: 'mine', displayName: 'Mine', active: true },
    { provider: 'dormant', displayName: 'Dormant', active: false },
    { provider: 'live-only', displayName: 'Live Only', active: true },
  ])
})

test('joinDirectoryProviders degrades to either side and drops malformed rows', () => {
  assert.deepEqual(joinDirectoryProviders(undefined, undefined), [])
  assert.deepEqual(joinDirectoryProviders('nope', null), [])
  assert.deepEqual(
    joinDirectoryProviders([{ id: '', name: 'x' }, 42, { provider: 'p', displayName: 'P' }], [{ provider: '' }]),
    [{ provider: 'p', displayName: 'P', active: true }],
  )
  // displayName equal to the id is omitted (card renders the bare id)
  assert.deepEqual(joinDirectoryProviders([{ id: 'solo', name: 'solo' }], []), [
    { provider: 'solo', active: true },
  ])
})

test('synthesizeDirectoryModels reads provider profiles, strings and objects', () => {
  const out = synthesizeDirectoryModels([
    { ns: 'llm-pi-ai', value: { providers: [{ provider: 'a', models: ['m1', { id: 'm2', name: 'M Two' }] }] } },
    { ns: 'other', value: { providers: [{ id: 'a', models: [{ id: 'm1' }, { id: 'm3' }] }, { id: 'b', models: [] }] } },
    { ns: 'broken', value: null },
    { ns: 'empty', value: {} },
  ])
  assert.deepEqual(out, [
    { provider: 'a', models: [{ id: 'm1' }, { id: 'm2', name: 'M Two' }, { id: 'm3' }] },
  ])
})

test('computeDirectoryCatalog is total over throwing/absent faces', () => {
  assert.deepEqual(computeDirectoryCatalog(undefined, []), { providers: [], models: [] })
  const throwing = {
    listProviders() { throw new Error('booting') },
    listConfigurableProviders() { throw new Error('booting') },
  }
  assert.deepEqual(computeDirectoryCatalog(throwing, [{ value: null }]), { providers: [], models: [] })
  const llm = {
    listProviders: () => [{ id: 'p1', name: 'P One' }],
    listConfigurableProviders: () => [],
  }
  const snap = computeDirectoryCatalog(llm, [{ value: { providers: [{ provider: 'p1', models: ['m1'] }] } }])
  assert.deepEqual(snap, {
    providers: [{ provider: 'p1', displayName: 'P One', active: true }],
    models: [{ provider: 'p1', models: [{ id: 'm1' }] }],
  })
})

test('catalogsEqual guards mirror writes (no loop on unchanged recompute)', () => {
  const a = { providers: [{ provider: 'p', active: true }], models: [] }
  const b = { providers: [{ provider: 'p', active: true }], models: [] }
  assert.equal(catalogsEqual(a, b), true)
  assert.equal(catalogsEqual(a, { providers: [], models: [] }), false)
  assert.equal(catalogsEqual(undefined, undefined), true)
  assert.equal(catalogsEqual(undefined, a), false)
})
