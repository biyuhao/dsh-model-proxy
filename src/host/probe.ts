/**
 * Connectivity probe for configured proxies: exercises the real dispatcher
 * (CONNECT tunnel / socks handshake) against a lightweight endpoint without
 * consuming any model quota.
 *
 * Default endpoint is Cloudflare's `cdn-cgi/trace`, whose body contains an
 * `ip=` line — proof the tunnel terminated at a working egress. Tests inject
 * `endpoint` + `fetchImpl` to stay fully offline.
 */

import { fetch as undiciFetch } from 'undici'
import { getOrCreateDispatcher } from './dispatcher.js'
import { redactProxyUrl } from './config.js'

export interface ProbeResult {
  ok: boolean
  latencyMs: number
  detail: string
}

export interface ProbeOptions {
  /** Trace-style endpoint; body must contain "ip=" on success. */
  endpoint?: string
  timeoutMs?: number
  /** Test seam: override undici's fetch. */
  fetchImpl?: (url: string, init?: Record<string, unknown>) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>
}

export const DEFAULT_PROBE_ENDPOINT = 'https://1.1.1.1/cdn-cgi/trace'

export async function probeProxy(proxyUrl: string, opts: ProbeOptions = {}): Promise<ProbeResult> {
  const endpoint = opts.endpoint ?? DEFAULT_PROBE_ENDPOINT
  const started = Date.now()
  try {
    // May throw synchronously for unsupported schemes — reported as failure.
    const dispatcher = getOrCreateDispatcher(proxyUrl)
    const fetchImpl = opts.fetchImpl ?? (undiciFetch as unknown as NonNullable<ProbeOptions['fetchImpl']>)
    const res = await fetchImpl(endpoint, {
      dispatcher,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
    })
    const latencyMs = Date.now() - started
    if (!res.ok) return { ok: false, latencyMs, detail: `HTTP ${res.status}` }
    const text = await res.text()
    if (!text.includes('ip=')) return { ok: false, latencyMs, detail: 'unexpected probe response body' }
    return { ok: true, latencyMs, detail: `HTTP ${res.status}` }
  } catch (err) {
    const cause = (err as { cause?: { message?: string } })?.cause?.message
    const detail = cause ?? (err as Error)?.message ?? String(err)
    return { ok: false, latencyMs: Date.now() - started, detail }
  }
}

/** Log-friendly label; never leaks credentials. */
export function describeProbeTarget(proxyUrl: string): string {
  return redactProxyUrl(proxyUrl)
}
