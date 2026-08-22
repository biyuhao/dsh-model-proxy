/**
 * Packaging contract tests: the client bundle must keep the lazy-CJS factory
 * shape the DSH web loader requires (see scripts/build-client.mjs).
 * Run: npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, access } from 'node:fs/promises'

test('client bundle exists and registers via window.__ModuleLoader__', async () => {
  const bundle = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.ok(bundle.startsWith('window.__ModuleLoader__.load({'), 'bundle must open with the loader handoff')
  assert.ok(/return module\.exports; \} \}\);/.test(bundle), 'bundle must close the factory and return exports')
})

test('bundle externalizes only seed-table specifiers', async () => {
  const bundle = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const requires = [...bundle.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1])
  const SEED = new Set([
    'react',
    'react/jsx-runtime',
    'react-dom',
    'react-dom/client',
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-ui-primitives',
    // answered for every web composition as a preloaded graph row
    '@deepseek-ai/dsh-client-runtime/client',
  ])
  for (const spec of requires) {
    assert.ok(SEED.has(spec), `unexpected require("${spec}") — not answerable by the client loader`)
  }
})

test('published files declared in package.json exist after build', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  for (const entry of Object.values(pkg.exports)) {
    const targets = typeof entry === 'string' ? [entry] : Object.values(entry)
    for (const t of targets) {
      if (String(t).includes('*')) continue
      await access(new URL('../' + String(t).replace('./', ''), import.meta.url))
    }
  }
})

test('dsh.bundle layer: manifest exists, declares one host row by name', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const patchPath = pkg.dsh?.bundle?.patch
  assert.ok(patchPath, 'package.json must declare dsh.bundle.patch')
  await access(new URL('../' + String(patchPath).replace('./', ''), import.meta.url))
  const raw = await readFile(new URL('../' + String(patchPath).replace('./', ''), import.meta.url), 'utf8')
  // Assert against content only — comments are documentation, not contract.
  const content = raw.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')
  assert.match(content, /^- insert:/m, 'bundle patch must nest rows under insert:')
  assert.match(content, /name: dsh-plugin-model-proxy\s*$/m, 'rows must reference the package by `name:`')
  assert.doesNotMatch(content, /module:/, 'the legacy `module:` field must never appear')
  assert.doesNotMatch(content, /model-proxy\/client/, 'client half is auto-discovered; no loader row for it')
})
