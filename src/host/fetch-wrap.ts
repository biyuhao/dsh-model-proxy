/**
 * Reversible global fetch wrapper.
 * Only injects dispatcher when AsyncLocalStorage holds a proxyUrl.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { fetch as undiciFetch, Request as UndiciRequest } from 'undici'
import { getOrCreateDispatcher } from './dispatcher.js'
import { redactProxyUrl } from './config.js'

export interface ProxyContext {
  proxyUrl?: string
  provider: string
  model: string
}

export const als = new AsyncLocalStorage<ProxyContext>()

type FetchFn = typeof fetch

/**
 * Whether the config state justifies touching globalThis.fetch at all.
 *
 * The wrapper is a process-wide side effect, so it must only be installed
 * while some rule (or the default fallback) could actually route a request
 * through a proxy. Globally disabled or fully-empty configs keep the global
 * fetch untouched.
 */
export function shouldWrapFetch(config: {
  enabled: boolean
  defaultProxy?: string
  rules?: ReadonlyArray<{ proxyUrl: string; enabled?: boolean }>
}): boolean {
  if (!config.enabled) return false
  if (config.defaultProxy) return true
  return (config.rules ?? []).some((r) => r.enabled !== false && r.proxyUrl !== '')
}

/** Minimal logger face so the host can route diagnostics through ctx.logger. */
export interface FetchWrapLogger {
  error?(msg: string): void
}

/** Fallback when no host logger is wired in (standalone smoke tests). */
const consoleLogger: FetchWrapLogger = {
  // eslint-disable-next-line no-console
  error: (msg) => console.error(msg),
}

/**
 * Install the wrapper around globalThis.fetch and return its disposer.
 *
 * Installation always wraps whatever is currently installed, even if that is
 * already a model-proxy wrapper from another plugin instance. This matters for
 * cordis-plugin-hmr: `partialReload` re-applies a plugin BEFORE the old fiber's
 * disposers finish (they are started but not awaited), so a "detect and no-op"
 * policy would let the dying twin's restore run last and leave fetch unwrapped
 * entirely. Layered wrappers degrade gracefully instead: each layer only
 * restores itself if it is still the outermost function at dispose time, and a
 * superseded inner layer simply passes through (its ALS store is never set).
 */
export function installFetchWrapper(log: FetchWrapLogger = consoleLogger): () => void {
  const original = globalThis.fetch as FetchFn

  const wrapped: FetchFn = (async (input: RequestInfo | URL, init?: RequestInit & { dispatcher?: unknown }) => {
    const store = als.getStore()
    if (!store?.proxyUrl) {
      return (original as FetchFn)(input as unknown as Request, init as RequestInit)
    }

    // Only called inside llm/stream — safe to proxy all fetches in this context.
    // If needed, add URL allowlist (e.g. only https://example.com etc.), but
    // context-scoping already isolates from non-LLM fetches.
    try {
      const dispatcher = getOrCreateDispatcher(store.proxyUrl)

      // undici's fetch brand-checks ITS OWN Request class, so a Request built
      // by another realm (e.g. Node's global constructor) throws
      // "Failed to parse URL from [object Request]". Adapters currently pass
      // string URLs, but rebuild defensively so a future Request-passing
      // caller degrades to working proxying instead of an opaque TypeError.
      // Verified: `new undici.Request(foreignReq.url, foreignReq)` carries
      // method/headers/body across realms; init.signal below still overrides
      // per spec.
      let proxiedInput: unknown = input
      if (typeof Request !== 'undefined' && input instanceof Request) {
        proxiedInput = new UndiciRequest((input as Request).url, input as unknown as UndiciRequest)
      }

      // NOTE: Node's native (built-in) global fetch forwards `dispatcher` to
      // its internal undici copy, whose Dispatcher/handler protocol does not
      // match instances of the standalone undici package ("invalid onError
      // method"), so for proxied requests we delegate to undici's own fetch,
      // which fully supports `dispatcher` (including the socks Agent built in
      // dispatcher.ts). Direct (no-proxy) requests keep using the original
      // global fetch unchanged.
      const nextInit = { ...(init ?? {}), dispatcher } as RequestInit & { dispatcher: unknown }
      return await (undiciFetch as unknown as FetchFn)(
        proxiedInput as unknown as Request,
        nextInit as unknown as RequestInit,
      )
    } catch (err) {
      // Sync failures only (bad proxy URL scheme / missing socks dep);
      // async transport errors propagate to the adapter untouched.
      // Log the full cause chain so "Connection error" isn't opaque — with a
      // REDACTED proxyUrl: credentials must never reach logs.
      const causeChain: string[] = []
      let c: unknown = err
      while (c && causeChain.length < 6) {
        causeChain.push((c as Error)?.message ?? String(c))
        c = (c as { cause?: unknown })?.cause
      }
      log.error?.(
        `[model-proxy] proxied fetch failed (${store.provider}/${store.model} via ${redactProxyUrl(store.proxyUrl)}): ${causeChain.join(' → ')}`,
      )
      throw err
    }
  }) as unknown as FetchFn

  globalThis.fetch = wrapped as unknown as typeof globalThis.fetch

  return () => {
    // Only unwrap when we are still the outermost wrapper; otherwise another
    // (newer) wrapper sits on top and owns the restore.
    if (globalThis.fetch === (wrapped as unknown as typeof globalThis.fetch)) {
      globalThis.fetch = original as unknown as typeof globalThis.fetch
    }
  }
}
