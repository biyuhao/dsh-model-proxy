/**
 * Host plugin: dsh-plugin-model-proxy
 *
 * - Registers `model-proxy` settings namespace (live, no restart)
 * - Wraps global fetch (reversible)
 * - Intercepts `llm/stream` waterfall to route per (provider, model, purpose)
 * - Composes credentialRef entries over rule proxyUrls (soft credentials dep)
 * - Probes newly configured proxies without consuming model quota
 *
 * Zero invasion: only uses public seams (ctx.settings, ctx.llm waterfall,
 * ctx.get('credentials'), global fetch dispatcher).
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { ModelProxyConfig, assertServiceable, resolveProxy, redactProxyUrl, type ModelProxyConfig as ConfigType, type ProxyRule } from './config.js'
import { catalogsEqual, computeDirectoryCatalog } from './directory.js'
import { als, installFetchWrapper, shouldWrapFetch } from './fetch-wrap.js'
import { clearDispatcherCache, socksDependencyAvailable } from './dispatcher.js'
import { composeProxyUrl, getCredentialsService, type CredentialLookup } from './credentials.js'
import { probeProxy } from './probe.js'

export const name = 'dsh-plugin-model-proxy'
export const inject = ['settings', 'llm']

const NS = 'model-proxy' as const

export function apply(ctx: Context, entry: ConfigType): void {
  // Normalize entry through schema defaults so bare {} works
  let normalizedEntry: ConfigType
  try {
    normalizedEntry = ModelProxyConfig(entry ?? ({} as unknown)) as ConfigType
    assertServiceable(normalizedEntry)
  } catch (err) {
    ctx.logger.warn(`[model-proxy] composition config invalid: ${String(err)}`)
    normalizedEntry = { enabled: true, rules: [], defaultProxy: '', debug: false } as ConfigType
  }

  // Authoritative config source: the composition entry until the settings
  // layer attaches, then the resolved scope. installSettingsSection calls
  // setSource before the matching onChange, so no polling or timers needed.
  let current: () => ConfigType = () => normalizedEntry

  // ── credentialRef resolution ────────────────────────────────────────────
  // The credentials service resolves ASYNC while the llm/stream listener must
  // stay SYNC. So refs are refreshed in the background on every config change
  // and cached here; the decision path only reads this map.
  type CredHit = { status: 'ok'; value: string } | { status: 'error'; message: string }
  const credCache = new Map<string, CredHit>()
  const warnedCredRefs = new Set<string>()

  function refreshCredential(lookup: CredentialLookup | undefined, ref: string): Promise<void> {
    if (!lookup) {
      credCache.set(ref, { status: 'error', message: 'credentials service not installed' })
      return Promise.resolve()
    }
    return lookup
      .resolve(ref)
      .then((hit) => {
        if (hit === undefined || typeof hit.value !== 'string' || hit.value.length === 0) {
          credCache.set(ref, { status: 'error', message: `credential "${ref}" not found` })
        } else if (!hit.value.includes(':')) {
          credCache.set(ref, { status: 'error', message: `credential "${ref}" must hold "user:password"` })
        } else {
          credCache.set(ref, { status: 'ok', value: hit.value })
        }
      })
      .catch((err: unknown) => {
        credCache.set(ref, { status: 'error', message: String(err) })
      })
  }

  /** Effective URL for a matched rule; sync — reads only the resolved cache. */
  const effectiveRuleUrl = (r: ProxyRule): string | undefined => {
    if (!r.proxyUrl) return undefined
    const ref = r.credentialRef?.trim() || undefined
    if (!ref) return r.proxyUrl
    const hit = credCache.get(ref)
    if (hit?.status !== 'ok') {
      if (!warnedCredRefs.has(ref)) {
        warnedCredRefs.add(ref)
        const why = hit?.status === 'error' ? hit.message : 'still resolving'
        ctx.logger.warn(
          `[model-proxy] credential ${ref} unavailable (${why}); routing ${r.provider}/${r.model} with inline proxyUrl until it resolves`,
        )
      }
      return r.proxyUrl
    }
    return composeProxyUrl(r.proxyUrl, hit.value) ?? r.proxyUrl
  }

  // ── dispatcher cache + socks warning lifecycle ──────────────────────────
  let activeProxyUrls = new Set<string>()
  const warnedUnusableSchemes = new Set<string>()

  // ── probe scheduling (P3-a): one pass per never-probed URL, serialized ──
  const probedUrls = new Set<string>()
  let probeChain: Promise<void> = Promise.resolve()
  const scheduleProbes = (urls: Iterable<string>): void => {
    for (const url of urls) {
      if (probedUrls.has(url)) continue
      const isSocks = url.startsWith('socks5') || url.startsWith('socks:')
      if (isSocks && !socksDependencyAvailable()) continue // warn already emitted
      probedUrls.add(url)
      probeChain = probeChain.then(async () => {
        const result = await probeProxy(url)
        const via = redactProxyUrl(url)
        if (result.ok) {
          ctx.logger.info(`[model-proxy] probe ${via} OK (${result.latencyMs}ms, ${result.detail})`)
        } else {
          ctx.logger.warn(`[model-proxy] probe ${via} FAILED (${result.latencyMs}ms): ${result.detail}`)
        }
      }).catch(() => {})
    }
  }

  // Reconcile is async (credential resolution), onChange is sync — serialize
  // runs and coalesce bursts of config writes into one trailing run.
  let reconciling = false
  let pendingReconcile = false
  const runReconcile = async (): Promise<void> => {
    if (reconciling) {
      pendingReconcile = true
      return
    }
    reconciling = true
    try {
      const cfg = current()

      // refresh every referenced credential before computing effective URLs
      const lookup = getCredentialsService(ctx)
      const refs = [...new Set(cfg.rules.map((r) => r.credentialRef?.trim()).filter((v): v is string => !!v))]
      await Promise.all(refs.map((ref) => refreshCredential(lookup, ref)))

      // eviction baseline must use EFFECTIVE urls: the dispatcher cache keys
      // on composed URLs, so a rotated credential must retire the old pool
      const next = new Set<string>()
      for (const r of cfg.rules) {
        const u = effectiveRuleUrl(r)
        if (u) next.add(u)
      }
      if (cfg.defaultProxy) next.add(cfg.defaultProxy)

      for (const url of activeProxyUrls) {
        if (!next.has(url)) clearDispatcherCache(url)
      }
      activeProxyUrls = next

      for (const url of activeProxyUrls) {
        if (!url.startsWith('socks5') && !url.startsWith('socks:')) continue
        if (socksDependencyAvailable() || warnedUnusableSchemes.has(url)) continue
        warnedUnusableSchemes.add(url)
        ctx.logger.warn(`[model-proxy] ${redactProxyUrl(url)} needs the optional dependency "socks" — run: pnpm add socks`)
      }

      scheduleProbes(activeProxyUrls)
    } finally {
      reconciling = false
      if (pendingReconcile) {
        pendingReconcile = false
        void runReconcile()
      }
    }
  }
  const reconcileConfigSideEffects = (): void => {
    void runReconcile()
  }

  // ── fetch wrapper lifecycle: installed only while routing is possible ──
  // Wrapping globalThis.fetch is a process-wide side effect, so the wrapper
  // exists exactly while shouldWrapFetch(config) holds: disabled or fully
  // direct configs keep the global untouched. Kept in sync from the entry
  // config and every settings change; the fiber disposer always unwinds.
  let uninstallFetch: (() => void) | undefined
  const fetchLogger = { error: (msg: string) => ctx.logger.error(msg) }
  const syncFetchWrapper = (): void => {
    if (shouldWrapFetch(current())) {
      if (!uninstallFetch) {
        uninstallFetch = installFetchWrapper(fetchLogger)
        ctx.logger.info('[model-proxy] fetch wrapper installed')
      }
    } else if (uninstallFetch) {
      try {
        uninstallFetch()
      } catch {}
      uninstallFetch = undefined
      ctx.logger.info('[model-proxy] fetch wrapper removed')
    }
  }

  ctx.effect(() => {
    syncFetchWrapper()
    return () => {
      try {
        uninstallFetch?.()
      } catch {}
      uninstallFetch = undefined
      ctx.logger.info('[model-proxy] fetch wrapper removed')
    }
  }, 'model-proxy: fetch wrapper')

  // Dispatcher pools must not outlive the plugin fiber: on unload/HMR reload
  // the reconcile loop stops running, so a full close-and-evict here is the
  // only guarantee the sockets are retired.
  ctx.effect(() => () => {
    const n = clearDispatcherCache()
    if (n > 0) ctx.logger.info(`[model-proxy] closed ${n} dispatcher pool(s)`)
  }, 'model-proxy: dispatcher cache')

  // 1) Settings namespace — live, validated, layered over entry.
  // Registered AFTER the wrapper/disposer effects above so a synchronous
  // first onChange cannot touch a not-yet-initialized binding.
  // Uses ctx.inject(['settings']) for dsh-settings >= 0.1.2
  const installSettings = (settingsService: SettingsProvider): void => {
    settingsService.installSection(
      ctx,
      NS,
      ModelProxyConfig as unknown as Parameters<typeof settingsService.installSection>[2],
      entry as unknown,
      {
        validate(value: unknown) {
          assertServiceable(value as ConfigType)
        },
        setSource(next: () => ConfigType) {
          current = next as () => ConfigType
        },
        onChange() {
          syncFetchWrapper()
          reconcileConfigSideEffects()
          const cfg = current()
          if (!cfg.debug) return
          const summary = cfg.rules
            .map((r) => `${r.provider}/${r.model}→${r.proxyUrl ? redactProxyUrl(r.proxyUrl) : 'direct'}${r.purpose ? `@${r.purpose}` : ''}`)
            .join(', ')
          ctx.logger.info(
            `[model-proxy] config applied: enabled=${cfg.enabled} rules=${cfg.rules.length}${summary ? ` [${summary}]` : ''} defaultProxy=${cfg.defaultProxy ? redactProxyUrl(cfg.defaultProxy) : 'direct'}`,
          )
        },
      }
    )
  }

  // Use ctx.inject to get the settings service when available
  // 2) Directory mirror — host-computed provider/model catalog persisted into
  // our own namespace so cards on pages without the cross-namespace Typert
  // remotes (`remote.llm` / `remote.session` / `remote.settings`, e.g.
  // non-loopback pages) still render dropdowns via their own settings scope.
  //
  // Loop safety: bursts collapse into one trailing write through mirrorChain,
  // and the deep-equal guard means an unchanged recompute never touches the
  // document. Our own write re-triggers `settings/document-updated`, but the
  // recompute then equals the mirror and skips — no write loop. The client
  // never writes `catalog`. Only ids/display names are mirrored, never
  // credentials or secrets (computeDirectoryCatalog extracts names only).
  let settingsSvc: SettingsProvider | undefined
  let mirrorChain: Promise<void> = Promise.resolve()
  const refreshDirectoryMirror = (): void => {
    mirrorChain = mirrorChain.then(async () => {
      if (!settingsSvc) return
      const face = settingsSvc as unknown as {
        describe?: () => Array<{ ns?: unknown; value?: unknown }>
        update?: (ns: string, patch: Record<string, unknown>) => Promise<unknown>
      }
      if (typeof face.describe !== 'function' || typeof face.update !== 'function') return
      let namespaces: Array<{ ns?: unknown; value?: unknown }> = []
      try {
        const described = face.describe()
        if (Array.isArray(described)) namespaces = described
      } catch { /* keep empty: next trigger recomputes */ }
      let llmFace: { listProviders?(): unknown; listConfigurableProviders?(): unknown } | undefined
      try {
        llmFace = (ctx as unknown as { llm?: { listProviders?(): unknown; listConfigurableProviders?(): unknown } }).llm
      } catch { llmFace = undefined }
      const next = computeDirectoryCatalog(llmFace, namespaces)
      if (catalogsEqual(current().catalog, next)) return
      try {
        await face.update(NS, { catalog: next })
      } catch (err) {
        ctx.logger.warn(`[model-proxy] directory mirror write failed: ${String(err)}`)
      }
    }).catch(() => {})
  }
  ctx.on('llm/adapters-updated', () => refreshDirectoryMirror())
  ctx.on('settings/document-updated', () => refreshDirectoryMirror())
  ctx.inject(['settings'], (settingsCtx: { settings: SettingsProvider }) => {
    settingsSvc = settingsCtx.settings
    installSettings(settingsCtx.settings)
    refreshDirectoryMirror()
  })

  // Kick initial reconciliation (entry-level config, credential cache warmup,
  // first probes). Fire-and-forget: failures are logged inside. The fetch
  // wrapper itself was already synced from the entry config by its effect.
  reconcileConfigSideEffects()

  // 3) llm/stream waterfall — per-request proxy decision
  //    We use waterfall mode: decide, stash in ALS, then delegate.
  //    The listener must be SYNC and return an AsyncIterable: cordis waterfall
  //    composition does not await listener results, and downstream listeners
  //    (e.g. session-checkpoint-policy) `yield* next()` — an `async` listener
  //    hands them a Promise and iteration throws "not async iterable".
  ctx.on('llm/stream', (opts: GenerateOptions, next: () => AsyncIterable<unknown>): AsyncIterable<unknown> => {
    const cfg = current()
    const proxyUrl = resolveProxy(cfg, opts.provider, opts.model, opts.purpose, effectiveRuleUrl)
    const label = `${opts.provider}/${opts.model}${opts.purpose ? `@${opts.purpose}` : ''}`

    // Routing decision is logged only when the user asked for debug output,
    // and always redacted.
    if (cfg.debug) {
      ctx.logger.info(`[model-proxy] ${label} → ${proxyUrl ? redactProxyUrl(proxyUrl) : 'direct'}`)
    }

    // Fast path: globally disabled, nothing configured, or no match — pass
    // through untouched without entering the ALS context.
    if (!proxyUrl) return next() as AsyncIterable<never>

    // AsyncLocalStorage does NOT propagate into a deferred async generator:
    // the consumer resumes it from its own context, so a store set here would
    // be gone by the time the adapter's fetch runs. Instead we re-enter the
    // store per protocol call (next/return/throw), which keeps it alive across
    // every await inside the adapter's stream.
    const ctxData = { proxyUrl, provider: opts.provider, model: opts.model }
    const iterator = (next() as AsyncIterable<unknown>)[Symbol.asyncIterator]()
    return {
      [Symbol.asyncIterator]() {
        return {
          next: () => als.run(ctxData, () => iterator.next()),
          return: (value?: unknown) => als.run(ctxData, () =>
            iterator.return ? iterator.return(value) : Promise.resolve({ done: true, value })),
          throw: (error?: unknown) => als.run(ctxData, () =>
            iterator.throw ? iterator.throw(error) : Promise.reject(error)),
        }
      },
    } as AsyncIterable<never>
  })
}
