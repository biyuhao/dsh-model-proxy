/**
 * Dispatcher factory: proxyUrl -> undici Dispatcher.
 * One instance per proxyUrl (connection pooling), lazy-created.
 *
 * http(s) proxies use undici's native ProxyAgent.
 * socks5/socks5h proxies need a bespoke undici Dispatcher: undici's fetch
 * "dispatcher" option requires an undici Dispatcher (it only accepts
 * http:// and https:// URLs in ProxyAgent), but a Node http.Agent such as
 * socks-proxy-agent's SocksProxyAgent is NOT a valid undici Dispatcher
 * ("agent.dispatch is not a function" -> Connection error). We therefore
 * build an undici Agent whose `connect` tunnels the TCP socket through the
 * socks server and returns the final socket (TLS-wrapped for https).
 */

import { ProxyAgent, Agent } from 'undici'
import { createRequire } from 'node:module'
import net from 'node:net'
import tls from 'node:tls'
import { redactProxyUrl } from './config.js'

const cache = new Map<string, unknown>()

/** IANA-assigned default port for SOCKS when the proxy URL omits one. */
const DEFAULT_SOCKS_PORT = 1080

/**
 * Raised pool defaults for proxied LLM traffic, applied to both the native
 * `ProxyAgent` and the bespoke socks `Agent` below.
 *
 * undici ships `keepAliveTimeout: 4s` / `connections: 10` per origin. LLM
 * calls arrive in sparse bursts (chat turns minutes apart, subagents fanning
 * out), so the stock 4s idle timeout leaves the pool cold almost every time
 * and the first token of each burst pays a full socks-CONNECT + TLS
 * handshake through the proxy. 30s idle retention keeps the previous turn's
 * sockets warm for the next one at the cost of a few idle fds; 20
 * connections per origin absorbs parallel streaming fans without queueing.
 * `pipelining` stays at undici's default 1 — SSE streams must not pipeline.
 */
export const PROXY_POOL_DEFAULTS = {
  keepAliveTimeout: 30_000,
  connections: 20,
}

// The `connect` option undici passes to Agent is a buildConnector-like fn:
//   connect(opts: { host, hostname, protocol, port, servername }, cb)
// undici gives `port` as '' for default scheme ports, so we fill it in.
function defaultPortFor(protocol: string): number {
  if (protocol === 'http:') return 80
  if (protocol === 'https:') return 443
  return 443
}

/** Lazily require the optional `socks` dependency; throws with install guidance. */
function loadSocksClient(): { createConnection(opts: unknown): Promise<{ socket: import('net').Socket }> } {
  try {
    const require = createRequire(import.meta.url)
    const mod: unknown = require('socks')
    if (mod === null || typeof mod !== 'object') throw new Error('no exports')
    const SocksClient = (mod as { SocksClient?: unknown }).SocksClient as
      | { createConnection?: unknown }
      | undefined
    if (typeof SocksClient?.createConnection !== 'function') throw new Error('SocksClient.createConnection missing')
    return SocksClient as { createConnection(opts: unknown): Promise<{ socket: import('net').Socket }> }
  } catch (e) {
    // Deliberately no proxyUrl in this message: it may carry credentials.
    throw new Error(`socks proxy requires dependency "socks" (pnpm add socks). Original: ${String(e)}`)
  }
}

let socksProbe: boolean | undefined

/**
 * Cheap availability probe for the optional `socks` dependency, memoized.
 * Lets the host warn at configuration time instead of failing at first request.
 */
export function socksDependencyAvailable(): boolean {
  if (socksProbe === undefined) {
    try {
      loadSocksClient()
      socksProbe = true
    } catch {
      socksProbe = false
    }
  }
  return socksProbe
}

/**
 * Build an undici Dispatcher whose connections are tunnelled through a socks
 * proxy. `socks` is an optional dependency loaded lazily so http-only installs
 * still work.
 *
 * undici's custom `connect` connector is expected to return the FINAL socket
 * (including TLS for https destinations), so we wrap the raw socks socket in
 * TLS ourselves for https targets.
 */
function createSocksDispatcher(proxyUrl: string): unknown {
  const SocksClient = loadSocksClient()

  const u = new URL(proxyUrl)
  const proxyHost = u.hostname
  // A URL like `socks5://127.0.0.1` yields port '' -> Number('') === 0, which
  // would dial port 0. Fall back to the IANA SOCKS default instead.
  const proxyPort = Number(u.port) || DEFAULT_SOCKS_PORT

  // Returns a socket (TLS-wrapped for https) already connected to the target
  // through the socks proxy.
  const connectThroughSocks: (
    opts: { hostname?: string; host?: string; protocol?: string; port?: string; servername?: string | null },
    callback: (err: Error | null, socket?: import('net').Socket) => void,
  ) => void = (opts, callback) => {
    const host = opts.hostname ?? opts.host ?? ''
    const port = opts.port ? Number(opts.port) : defaultPortFor(opts.protocol ?? 'https:')
    if (!host) {
      callback(new Error('socks connect: missing destination host'))
      return
    }

    const finishRaw = (raw: import('net').Socket) => {
      if (opts.protocol === 'https:' || port === 443) {
        // RFC 6066 forbids an IP address as the TLS SNI ServerName; Node emits
        // DEP0123 when one is set. Only forward a servername when it is a real
        // hostname — for IP targets SNI is omitted, which is the correct behavior.
        const servername = opts.servername ?? host
        const tlsOpts: tls.ConnectionOptions = { socket: raw, host, port }
        if (servername && !net.isIP(servername)) tlsOpts.servername = servername
        const secure = tls.connect(tlsOpts)
        secure.once('secureConnect', () => callback(null, secure))
        secure.once('error', (err) => callback(err))
      } else {
        callback(null, raw)
      }
    }

    SocksClient.createConnection({
      proxy: { host: proxyHost, port: proxyPort, type: 5 },
      command: 'connect',
      destination: { host, port },
    })
      .then((info) => finishRaw(info.socket))
      .catch((err: Error) => callback(err))
  }

  return new Agent({ ...PROXY_POOL_DEFAULTS, connect: connectThroughSocks as never })
}

/** A proxy URL may be reused by many rules; cache one Dispatcher per URL. */
export function getOrCreateDispatcher(proxyUrl: string): unknown {
  const cached = cache.get(proxyUrl)
  if (cached) return cached

  let u: URL
  try {
    u = new URL(proxyUrl)
  } catch {
    throw new Error('invalid proxyUrl')
  }

  let d: unknown
  if (u.protocol === 'http:' || u.protocol === 'https:') {
    d = new ProxyAgent({ uri: proxyUrl, ...PROXY_POOL_DEFAULTS })
  } else if (u.protocol === 'socks5:' || u.protocol === 'socks5h:' || u.protocol === 'socks:') {
    d = createSocksDispatcher(proxyUrl)
  } else {
    throw new Error(`unsupported proxy protocol "${u.protocol}" for ${redactProxyUrl(proxyUrl)}`)
  }

  cache.set(proxyUrl, d)
  return d
}

/**
 * Retire dispatchers: remove them from the cache and close their pooled
 * sockets. `close()` is graceful — undici finishes in-flight requests before
 * tearing down, so evicting a URL mid-config-change never kills an active
 * stream. Best-effort: dispatcher instances without `close` are just dropped.
 *
 * Returns how many entries were removed (test seam).
 */
export function clearDispatcherCache(proxyUrl?: string): number {
  const keys = proxyUrl !== undefined ? [proxyUrl] : [...cache.keys()]
  let removed = 0
  for (const key of keys) {
    const d = cache.get(key)
    if (!cache.delete(key)) continue
    removed++
    const closer = (d as { close?: () => Promise<unknown> } | undefined)?.close
    if (typeof closer === 'function') {
      // Fire-and-forget: teardown must stay synchronous; failures at pool
      // retirement are irrelevant (sockets die with the process anyway).
      void closer.call(d).catch(() => {})
    }
  }
  return removed
}
