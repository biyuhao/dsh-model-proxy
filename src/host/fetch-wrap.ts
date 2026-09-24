/** Reversible fetch wrapper for proxy dispatch and fixed headers. */

import { AsyncLocalStorage } from 'node:async_hooks'
import { fetch as undiciFetch, Request as UndiciRequest } from 'undici'
import { getOrCreateDispatcher } from './dispatcher.js'
import { redactProxyUrl } from './config.js'

export interface ProxyContext {
  proxyUrl?: string
  provider: string
  model: string
  /** Fixed extra headers of the matched rule; direct mode may send them too. */
  headers?: Readonly<Record<string, string>>
}

export const als = new AsyncLocalStorage<ProxyContext>()

type FetchFn = typeof fetch

/** Install the wrapper only when a route or fixed header may be applied. */
export function shouldWrapFetch(config: {
  enabled: boolean
  defaultProxy?: string
  defaultProxyHostId?: string
  proxyHosts?: ReadonlyArray<{ id: string; proxyUrl: string }>
  rules?: ReadonlyArray<{
    proxyUrl?: string
    proxyHostId?: string
    headers?: Readonly<Record<string, string>>
    headerValueSources?: Readonly<Record<string, string>>
    enabled?: boolean
  }>
}): boolean {
  if (!config.enabled) return false
  if (config.defaultProxy || config.defaultProxyHostId) return true
  if ((config.proxyHosts ?? []).some((host) => host.proxyUrl !== '')) return true
  return (config.rules ?? []).some((r) => {
    if (r.enabled === false) return false
    const hasInlineUrl = r.proxyUrl !== undefined && r.proxyUrl !== ''
    const hasHost = r.proxyHostId !== undefined && r.proxyHostId !== ''
    const hasHeaders =
      (r.headers !== undefined && Object.keys(r.headers).length > 0) ||
      (r.headerValueSources !== undefined && Object.keys(r.headerValueSources).length > 0)
    return hasInlineUrl || hasHost || hasHeaders
  })
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

/** Add configured headers only when the request does not already have them. */
export function applyExtraHeaders(
  base: Headers,
  extra: Readonly<Record<string, string>> | undefined,
): Headers {
  if (!extra) return base
  for (const [name, value] of Object.entries(extra)) {
    if (!base.has(name)) base.set(name, value)
  }
  return base
}

/** Collect headers from a RequestInit's `headers` field into a Headers instance. */
function collectInitHeaders(initHeaders: unknown): Headers {
  const out = new Headers()
  if (initHeaders === undefined || initHeaders === null) return out
  if (initHeaders instanceof Headers) {
    initHeaders.forEach((v, k) => out.set(k, v))
    return out
  }
  // Accept global, undici, array, and object header containers.
  if (Array.isArray(initHeaders)) {
    for (const pair of initHeaders as Array<[string, string]>) {
      if (Array.isArray(pair) && pair.length >= 2) out.set(String(pair[0]), String(pair[1]))
    }
    return out
  }
  if (typeof initHeaders === 'object' && typeof (initHeaders as Headers).forEach === 'function') {
    try {
      ;(initHeaders as Headers).forEach((v, k) => out.set(k, v))
    } catch {
      // Treat non-iterable foreign Headers as empty.
    }
    return out
  }
  if (typeof initHeaders === 'object') {
    for (const [k, v] of Object.entries(initHeaders as Record<string, unknown>)) {
      out.set(k, String(v))
    }
    return out
  }
  return out
}

/** Read headers from global, undici, or cross-realm Request-like inputs. */
function readInputHeaders(input: unknown): Headers | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const rec = input as Record<string, unknown>
  if (typeof rec.url !== 'string') return undefined
  const h = rec.headers
  if (h instanceof Headers) {
    const out = new Headers()
    h.forEach((v, k) => out.set(k, v))
    return out
  }
  if (h !== null && typeof h === 'object' && typeof (h as Headers).forEach === 'function') {
    const out = new Headers()
    try {
      ;(h as Headers).forEach((v, k) => out.set(k, v))
    } catch {
      return undefined
    }
    return out
  }
  return undefined
}

/** Wrap global fetch and return a disposer safe for overlapping HMR instances. */
export function installFetchWrapper(log: FetchWrapLogger = consoleLogger): () => void {
  const original = globalThis.fetch as FetchFn

  const wrapped: FetchFn = (async (input: RequestInfo | URL, init?: RequestInit & { dispatcher?: unknown }) => {
    const store = als.getStore()
    if (!store) {
      return (original as FetchFn)(input as unknown as Request, init as RequestInit)
    }
    const extra = store.headers
    const hasExtra = extra !== undefined && Object.keys(extra).length > 0

    if (!store.proxyUrl) {
      if (!hasExtra) return (original as FetchFn)(input as unknown as Request, init as RequestInit)
      // Direct mode still merges fixed headers into native fetch.
      const merged = new Headers()
      const inputHeaders = readInputHeaders(input)
      inputHeaders?.forEach((v, k) => merged.set(k, v))
      collectInitHeaders(init?.headers).forEach((v, k) => merged.set(k, v))
      applyExtraHeaders(merged, extra)
      return (original as FetchFn)(input as unknown as Request, { ...(init ?? {}), headers: merged } as RequestInit)
    }

    // ALS limits interception to the current LLM stream.
    try {
      const dispatcher = getOrCreateDispatcher(store.proxyUrl)

      // Rebuild cross-realm Requests for undici and preserve their headers.
      const isGlobalRequest = typeof Request !== 'undefined' && input instanceof Request
      let proxiedInput: unknown = input
      if (isGlobalRequest) {
        proxiedInput = new UndiciRequest((input as Request).url, input as unknown as UndiciRequest)
      }
      // Preserve headers from non-global Request-like inputs.
      const foreignInputHeaders = !isGlobalRequest ? readInputHeaders(input) : undefined

      // Proxied requests use undici's dispatcher-aware fetch.
      const nextInit = { ...(init ?? {}), dispatcher } as RequestInit & { dispatcher: unknown }
      if (hasExtra) {
        // Input and init headers win; configured headers only fill gaps.
        const merged = new Headers()
        if (isGlobalRequest) {
          const rebuilt = (proxiedInput as unknown as { headers: Headers }).headers
          rebuilt.forEach((v, k) => merged.set(k, v))
        } else if (foreignInputHeaders) {
          foreignInputHeaders.forEach((v, k) => merged.set(k, v))
        }
        const initMerged = collectInitHeaders(init?.headers)
        initMerged.forEach((v, k) => merged.set(k, v))
        applyExtraHeaders(merged, extra)
        if (isGlobalRequest && init?.headers === undefined) {
          // No init override: keep a single header set on the rebuilt Request.
          const rebuilt = (proxiedInput as unknown as { headers: Headers }).headers
          merged.forEach((v, k) => { if (!rebuilt.has(k)) rebuilt.set(k, v) })
        } else {
          ;(nextInit as unknown as Record<string, unknown>).headers = merged
        }
      }
      return await (undiciFetch as unknown as FetchFn)(
        proxiedInput as unknown as Request,
        nextInit as unknown as RequestInit,
      )
    } catch (err) {
      // Log synchronous setup failures with a redacted proxy URL.
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
    // Restore only when this wrapper is still outermost.
    if (globalThis.fetch === (wrapped as unknown as typeof globalThis.fetch)) {
      globalThis.fetch = original as unknown as typeof globalThis.fetch
    }
  }
}
