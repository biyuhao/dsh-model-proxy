/** Host routing plugin: volatile settings, fetch wrapping, credentials, probes. */

import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { assertServiceable, resolveRoute, redactProxyUrl, type ModelProxyConfig as ConfigType, type ModelProxyConfigRef, type ProxyHost, type ProxyRule } from './config.js'
import { catalogsEqual, computeDirectoryCatalog } from './directory.js'
import { als, installFetchWrapper, shouldWrapFetch } from './fetch-wrap.js'
import { clearDispatcherCache, socksDependencyAvailable } from './dispatcher.js'
import { composeProxyUrl, getCredentialsService, type CredentialLookup } from './credentials.js'
import { probeProxy } from './probe.js'

export const name = 'dsh-plugin-model-proxy'
export const inject = ['settings', 'llm']
export { Config } from './config.js'

const NS = 'model-proxy' as const

export function apply(ctx: Context, config: ModelProxyConfigRef): void {
  // Loader volatile fields expose the latest committed snapshot.
  const current = (): ConfigType => ({
    enabled: config.enabled.get(),
    proxyHosts: config.proxyHosts.get(),
    rules: config.rules.get(),
    defaultProxyHostId: config.defaultProxyHostId.get(),
    defaultProxy: config.defaultProxy.get(),
    debug: config.debug.get(),
    catalog: config.catalog.get(),
  })

  const initialConfig = current()
  assertServiceable(initialConfig)
  let activeConfig: ConfigType = initialConfig

  // Credentials resolve asynchronously; routing reads the refreshed cache.
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

  /** Effective URL for a reusable host or a legacy inline rule; sync. */
  const effectiveHostUrl = (host: ProxyHost): string | undefined => {
    const url = host.proxyUrl.trim()
    if (!url) return undefined
    const ref = host.credentialRef?.trim() || undefined
    if (!ref) return url
    const hit = credCache.get(ref)
    if (hit?.status !== 'ok') {
      if (!warnedCredRefs.has(ref)) {
        warnedCredRefs.add(ref)
        const why = hit?.status === 'error' ? hit.message : 'still resolving'
        ctx.logger.warn(
          `[model-proxy] credential ${ref} unavailable (${why}); proxy host ${host.name} uses its inline URL until it resolves`,
        )
      }
      return url
    }
    return composeProxyUrl(url, hit.value) ?? url
  }

  const effectiveRuleUrl = (r: ProxyRule, cfg: ConfigType = activeConfig): string | undefined => {
    const hostId = r.proxyHostId?.trim()
    if (hostId) {
      const host = cfg.proxyHosts.find((candidate) => candidate.id === hostId)
      if (!host) {
        ctx.logger.warn(`[model-proxy] rule ${r.provider}/${r.model} references missing proxy host "${hostId}"; using direct mode`)
        return undefined
      }
      return effectiveHostUrl(host)
    }
    const url = r.proxyUrl?.trim() ?? ''
    if (!url) return undefined
    const ref = r.credentialRef?.trim() || undefined
    if (!ref) return url
    const hit = credCache.get(ref)
    if (hit?.status !== 'ok') {
      if (!warnedCredRefs.has(ref)) {
        warnedCredRefs.add(ref)
        const why = hit?.status === 'error' ? hit.message : 'still resolving'
        ctx.logger.warn(
          `[model-proxy] credential ${ref} unavailable (${why}); routing ${r.provider}/${r.model} with inline proxyUrl until it resolves`,
        )
      }
      return url
    }
    return composeProxyUrl(url, hit.value) ?? url
  }

  const effectiveDefaultUrl = (cfg: ConfigType = activeConfig): string | undefined => {
    const hostId = cfg.defaultProxyHostId?.trim()
    if (hostId) {
      const host = cfg.proxyHosts.find((candidate) => candidate.id === hostId)
      if (!host) {
        ctx.logger.warn(`[model-proxy] default proxy references missing proxy host "${hostId}"; using direct fallback`)
        return undefined
      }
      return effectiveHostUrl(host)
    }
    return cfg.defaultProxy?.trim() || undefined
  }

  // Dispatcher cache and SOCKS dependency warnings.
  let activeProxyUrls = new Set<string>()
  const warnedUnusableSchemes = new Set<string>()

  // Probe each effective URL once, serially.
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

  // Coalesce async reconciliation bursts.
  let reconciling = false
  let pendingReconcile = false
  const runReconcile = async (): Promise<void> => {
    if (reconciling) {
      pendingReconcile = true
      return
    }
    reconciling = true
    try {
      const cfg = activeConfig

      // Refresh credentials for routes that can actually be selected.
      const enabledRules = cfg.rules.filter((rule) => rule.enabled !== false)
      const reachableHostIds = new Set(
        enabledRules.map((rule) => rule.proxyHostId?.trim()).filter((id): id is string => !!id),
      )
      const defaultHostId = cfg.defaultProxyHostId?.trim()
      if (defaultHostId) reachableHostIds.add(defaultHostId)
      const lookup = getCredentialsService(ctx)
      const refs = [
        ...cfg.proxyHosts.filter((host) => reachableHostIds.has(host.id)).map((host) => host.credentialRef?.trim()),
        ...enabledRules.map((rule) => rule.credentialRef?.trim()),
      ].filter((v): v is string => !!v)
      await Promise.all([...new Set(refs)].map((ref) => refreshCredential(lookup, ref)))

      // Cache and probe only enabled, reachable routes.
      const next = new Set<string>()
      for (const host of cfg.proxyHosts) {
        if (!reachableHostIds.has(host.id)) continue
        const url = effectiveHostUrl(host)
        if (url) next.add(url)
      }
      for (const rule of enabledRules) {
        const url = effectiveRuleUrl(rule, cfg)
        if (url) next.add(url)
      }
      const fallback = effectiveDefaultUrl(cfg)
      if (fallback) next.add(fallback)

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

  // Keep the global fetch wrapper in sync with the active config.
  let uninstallFetch: (() => void) | undefined
  const fetchLogger = { error: (msg: string) => ctx.logger.error(msg) }
  const syncFetchWrapper = (): void => {
    if (shouldWrapFetch(activeConfig)) {
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

  // Close dispatcher pools when the plugin fiber unloads.
  ctx.effect(() => () => {
    const n = clearDispatcherCache()
    if (n > 0) ctx.logger.info(`[model-proxy] closed ${n} dispatcher pool(s)`)
  }, 'model-proxy: dispatcher cache')

  // Apply validated volatile config updates.
  ctx.on('loader/volatile-update', () => {
    const next = current()
    try {
      assertServiceable(next)
      activeConfig = next
    } catch (err) {
      activeConfig = {
        ...next,
        enabled: false,
        proxyHosts: [],
        rules: [],
        defaultProxyHostId: '',
        defaultProxy: '',
        debug: false,
      }
      ctx.logger.warn(err)
    }
    syncFetchWrapper()
    reconcileConfigSideEffects()
    const cfg = activeConfig
    if (!cfg.debug) return
    const summary = cfg.rules
      .map((r) => {
        const names = r.headers ? Object.keys(r.headers).join(',') : ''
        const target = r.proxyHostId
          ? `host:${r.proxyHostId}`
          : r.proxyUrl
            ? redactProxyUrl(r.proxyUrl)
            : 'direct'
        return `${r.provider}/${r.model}→${target}${r.purpose ? `@${r.purpose}` : ''}${names ? ` headers:[${names}]` : ''}`
      })
      .join(', ')
    const fallback = effectiveDefaultUrl(cfg)
    ctx.logger.info(
      `[model-proxy] config applied: enabled=${cfg.enabled} rules=${cfg.rules.length}${summary ? ` [${summary}]` : ''} defaultProxy=${fallback ? redactProxyUrl(fallback) : 'direct'}`,
    )
  })

  // Mirror provider/model metadata for pages without Typert remotes.
  type SettingsFace = {
    describe?: () => Array<{ ns?: unknown; value?: unknown }>
    update?: (ns: string, patch: Record<string, unknown>) => Promise<unknown>
  }
  let settingsSvc: SettingsFace | undefined
  let mirrorChain: Promise<void> = Promise.resolve()
  const refreshDirectoryMirror = (): void => {
    mirrorChain = mirrorChain.then(async () => {
      if (!settingsSvc) return
      const face = settingsSvc
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
  ctx.inject(['settings'], (settingsCtx: { settings: SettingsFace }) => {
    settingsSvc = settingsCtx.settings
    refreshDirectoryMirror()
  })

  // Warm credentials and schedule initial probes.
  reconcileConfigSideEffects()

  // llm/stream must stay synchronous and return an AsyncIterable.
  ctx.on('llm/stream', (opts: GenerateOptions, next: () => AsyncIterable<unknown>): AsyncIterable<unknown> => {
    const cfg = activeConfig
    const fallback = effectiveDefaultUrl(cfg)
    const route = resolveRoute(
      { ...cfg, defaultProxy: fallback ?? '' },
      opts.provider,
      opts.model,
      opts.purpose,
      (rule) => effectiveRuleUrl(rule, cfg),
      {
        sessionId: opts.sessionId,
        provider: opts.provider,
        model: opts.model,
        purpose: opts.purpose,
      },
    )
    const proxyUrl = route.proxyUrl
    const headers = route.headers
    const label = `${opts.provider}/${opts.model}${opts.purpose ? `@${opts.purpose}` : ''}`

    // Routing decision is logged only when the user asked for debug output,
    // and always redacted: proxy passwords never appear, header VALUES never
    // appear (names only — values may carry session secrets).
    if (cfg.debug) {
      const headerNames = headers ? Object.keys(headers).join(',') : ''
      ctx.logger.info(`[model-proxy] ${label} → ${proxyUrl ? redactProxyUrl(proxyUrl) : 'direct'}${headerNames ? ` headers:[${headerNames}]` : ''}`)
    }

    // Fast path: globally disabled, nothing configured, or no match without
    // headers — pass through untouched without entering the ALS context. A
    // direct rule WITH headers still enters it so the fetch wrapper can merge
    // those headers into the ordinary global fetch.
    if (!proxyUrl && !headers) return next() as AsyncIterable<never>

    // Re-enter ALS for each iterator operation; async generators resume outside
    // the listener's original context.
    const ctxData = {
      ...(proxyUrl ? { proxyUrl } : {}),
      provider: opts.provider,
      model: opts.model,
      ...(headers ? { headers } : {}),
    }
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
