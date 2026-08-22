/**
 * Client bundle build: emits the loader's lazy-CJS factory artifact that
 * @deepseek-ai/dsh-client-modules serves at /plugins/<id>/client.js.
 *
 * The dsh harness web boot requires every `dsh.client` package's `./client`
 * export to be a single file that calls window.__ModuleLoader__.load({id,
 * factory}) and resolves module-table words (react, @deepseek-ai/*) through
 * the loader-injected require — see docs/cookbook/adding-a-settings-card.md
 * ("The bundle must be the loader's lazy-CJS factory artifact"). Plain tsc
 * emits raw ESM modules that never register, which the host reports as
 * "bundle ... loaded without registering".
 *
 * This mirrors the in-repo `clientBundle` preset output: bundle the client
 * source to one CJS file, keep the platform module-table specifiers external
 * (they become require() calls the loader answers), and wrap the body in the
 * registration handoff.
 */
import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

/** Module-table words the loader answers; baseline from packages/client/web/src/platform.ts. */
const MODULE_TABLE_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
]

await build({
  entryPoints: ['src/client/index.ts'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  jsx: 'automatic',
  sourcemap: true,
  external: MODULE_TABLE_EXTERNALS,
  define: {
    // React (inlined nothing here, but mirror the harness substitution so a
    // future inline dep cannot throw ReferenceError on the seed path).
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;`,
  },
  footer: {
    js: '\nreturn module.exports; } });',
  },
})

// Test-only side artifacts: plain ESM transforms of dependency-free client
// modules so `node --test` can exercise them without a DOM or the loader
// bundle. Live OUTSIDE lib/ on purpose — `files: ["lib/"]` publishes
// everything under there verbatim.
await build({
  entryPoints: ['src/client/catalog.ts', 'src/client/controller.ts'],
  outdir: '.test-build',
  bundle: false,
  format: 'esm',
  target: 'es2024',
})
