/** Host settings schema and routing helpers. */

import z from '@deepseek-ai/schemastery'

export const ProxyHostSchema: any = z.object({
  id: z.string().required(),
  name: z.string().required(),
  proxyUrl: z.string().required(),
  credentialRef: z.string(),
})

export interface ProxyHost {
  id: string
  name: string
  proxyUrl: string
  /** Credentials-service entry ("user:password") for this proxy host. */
  credentialRef?: string
}

export const ProxyRuleSchema: any = z.object({
  // Do not use `.default(fn)`: this schemastery fork does not invoke it.
  id: z.string(),
  provider: z.string().required(),
  // exact id | prefix "vendor-*" (single trailing '*') | "*"
  model: z.string().required(),
  // Reference a reusable entry from proxyHosts. Empty/absent means direct.
  proxyHostId: z.string(),
  // Legacy inline URL; retained so hand-written configurations keep working.
  proxyUrl: z.string(),
  enabled: z.boolean().default(true),
  // optional purpose filter: unset matches every purpose; when set it must
  // equal GenerateOptions.purpose (e.g. 'compaction', 'session-title')
  purpose: z.string(),
  // optional name of a credentials-service entry holding "user:password";
  // when set (and resolvable) it overrides any inline userinfo in proxyUrl
  credentialRef: z.string(),
  // optional fixed extra HTTP headers injected for this rule, including direct
  // mode, e.g. { "x-opencode-session": "<fixed value>" } for opencode-go relays.
  headers: z.dict(z.string()),
  headerValueSources: z.dict(z.string()),
})

export type HeaderValueSource = 'fixed' | 'sessionId' | 'provider' | 'model' | 'purpose'

export interface ProxyRule {
  /** Optional card key for the UI; hand-written yaml rules may omit it. */
  id?: string
  provider: string
  model: string
  /** Reusable proxy host selected for this rule; absent means direct. */
  proxyHostId?: string
  /** Legacy inline proxy URL; used only when proxyHostId is absent. */
  proxyUrl?: string
  enabled: boolean
  /** When set, the rule only applies to LLM calls carrying this purpose. */
  purpose?: string
  /** Credentials-service entry ("user:password") overriding proxyUrl userinfo. */
  credentialRef?: string
  /**
   * Fixed extra HTTP headers injected for this rule, including direct mode.
   * Example: `{ "x-opencode-session": "<fixed value>" }` for opencode-go.
   */
  headers?: Record<string, string>
  /** Optional per-header source; values read from the current request context. */
  headerValueSources?: Record<string, HeaderValueSource>
}

/** Host-computed provider/model directory mirror; never contains secrets. */
export interface DirectoryModel {
  id: string
  name?: string
}

export interface DirectoryProvider {
  provider: string
  displayName?: string
  /** Live route membership; unknown/absent renders as dormant, never hidden. */
  active?: boolean
}

export interface DirectoryCatalog {
  providers: DirectoryProvider[]
  models: Array<{ provider: string; models: DirectoryModel[] }>
}

export const DirectoryModelSchema: any = z.object({
  id: z.string().required(),
  name: z.string(),
})

export const DirectoryProviderSchema: any = z.object({
  provider: z.string().required(),
  displayName: z.string(),
  active: z.boolean(),
})

export const DirectoryCatalogSchema: any = z.object({
  providers: z.array(DirectoryProviderSchema).default([]),
  models: z.array(z.object({
    provider: z.string().required(),
    models: z.array(DirectoryModelSchema).default([]),
  })).default([]),
})

export const ModelProxyConfigSchema: any = z.object({
  enabled: z.boolean().default(true).volatile(),
  proxyHosts: z.array(ProxyHostSchema).default([]).volatile(),
  rules: z.array(ProxyRuleSchema).default([]).volatile(),
  /** Host selected for the no-match fallback; absent/empty means direct. */
  defaultProxyHostId: z.string().default('').volatile(),
  /** Legacy inline fallback URL; empty when defaultProxyHostId is used. */
  defaultProxy: z.string().default('').volatile(),
  debug: z.boolean().default(false).volatile(),
  // Keep the mirror volatile so catalog refreshes do not remount the entry.
  catalog: DirectoryCatalogSchema.volatile(),
})

export interface ModelProxyConfig {
  enabled: boolean
  proxyHosts: ProxyHost[]
  rules: ProxyRule[]
  defaultProxyHostId?: string
  /** Legacy inline fallback URL; empty when defaultProxyHostId is used. */
  defaultProxy: string
  debug: boolean
  /** Host-computed directory mirror; absent until the first mirror pass. */
  catalog?: DirectoryCatalog
}
export const ModelProxyConfig: any = ModelProxyConfigSchema
/** Loader-facing alias; tests and host internals keep the `ModelProxyConfig` name. */
export const Config: any = ModelProxyConfigSchema

/** A live config field handle; each read yields the current committed snapshot. */
export interface VolatileRef<T> {
  get(): T
}

/** `apply` receives one stable volatile reference per Config field. */
export interface ModelProxyConfigRef {
  enabled: VolatileRef<boolean>
  proxyHosts: VolatileRef<ProxyHost[]>
  rules: VolatileRef<ProxyRule[]>
  defaultProxyHostId: VolatileRef<string>
  defaultProxy: VolatileRef<string>
  debug: VolatileRef<boolean>
  catalog: VolatileRef<DirectoryCatalog | undefined>
}

const SUPPORTED_SCHEMES = new Set(['http:', 'https:', 'socks5:', 'socks5h:', 'socks:'])

/** HTTP token (RFC 9110) for header field names. */
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
/** Headers that must never be set via rules (auth / proxy control). */
const FORBIDDEN_HEADERS = new Set(['authorization', 'proxy-authorization', 'proxy-authenticate'])
const MAX_HEADERS_PER_RULE = 10
const MAX_HEADER_VALUE_LENGTH = 4096

/** Validate a rule's fixed `headers` map; throws with rule index context. */
function assertHeadersServiceable(headers: unknown, index: number): void {
  if (headers === undefined) return
  if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) {
    throw new Error(`model-proxy: rule #${index + 1} headers must be an object of "Name": "value"`)
  }
  const entries = Object.entries(headers as Record<string, unknown>)
  if (entries.length > MAX_HEADERS_PER_RULE) {
    throw new Error(`model-proxy: rule #${index + 1} headers holds too many entries (max ${MAX_HEADERS_PER_RULE})`)
  }
  const seen = new Set<string>()
  for (const [rawName, rawValue] of entries) {
    const name = rawName.trim()
    if (name !== rawName) {
      throw new Error(`model-proxy: rule #${index + 1} header name has leading/trailing whitespace: ${JSON.stringify(rawName)}`)
    }
    if (!HEADER_NAME_RE.test(name)) {
      throw new Error(`model-proxy: rule #${index + 1} header name is not a valid HTTP token: ${JSON.stringify(name)}`)
    }
    const lower = name.toLowerCase()
    if (FORBIDDEN_HEADERS.has(lower)) {
      throw new Error(`model-proxy: rule #${index + 1} header ${JSON.stringify(name)} is forbidden (managed by the adapter/transport)`)
    }
    if (seen.has(lower)) {
      throw new Error(`model-proxy: rule #${index + 1} duplicate header ${JSON.stringify(name)} (case-insensitive)`)
    }
    seen.add(lower)
    if (typeof rawValue !== 'string') {
      throw new Error(`model-proxy: rule #${index + 1} header ${JSON.stringify(name)} value must be a string`)
    }
    if (rawValue !== rawValue.trim() || rawValue === '') {
      throw new Error(`model-proxy: rule #${index + 1} header ${JSON.stringify(name)} value must be a non-empty string without surrounding whitespace`)
    }
    if (/[\r\n]/.test(rawValue)) {
      throw new Error(`model-proxy: rule #${index + 1} header ${JSON.stringify(name)} value must not contain CR/LF`)
    }
    if (rawValue.length > MAX_HEADER_VALUE_LENGTH) {
      throw new Error(`model-proxy: rule #${index + 1} header ${JSON.stringify(name)} value is too long (max ${MAX_HEADER_VALUE_LENGTH})`)
    }
  }
}

function assertHeaderSourcesServiceable(
  sources: unknown,
  headers: Record<string, string> | undefined,
  index: number,
): void {
  if (sources === undefined) return
  if (sources === null || typeof sources !== 'object' || Array.isArray(sources)) {
    throw new Error(`model-proxy: rule #${index + 1} headerValueSources must be an object`)
  }
  const entries = Object.entries(sources as Record<string, unknown>)
  if (entries.length > MAX_HEADERS_PER_RULE) {
    throw new Error(`model-proxy: rule #${index + 1} headerValueSources holds too many entries`)
  }
  for (const [rawName, source] of entries) {
    const name = rawName.trim()
    if (name !== rawName || !HEADER_NAME_RE.test(name)) {
      throw new Error(`model-proxy: rule #${index + 1} invalid header source name: ${JSON.stringify(rawName)}`)
    }
    if (FORBIDDEN_HEADERS.has(name.toLowerCase())) {
      throw new Error(`model-proxy: rule #${index + 1} header ${JSON.stringify(name)} is forbidden`)
    }
    if (source !== 'fixed' && source !== 'sessionId' && source !== 'provider' && source !== 'model' && source !== 'purpose') {
      throw new Error(`model-proxy: rule #${index + 1} unsupported header source for ${JSON.stringify(name)}`)
    }
    const fixedKey = Object.keys(headers ?? {}).find((key) => key.toLowerCase() === name.toLowerCase())
    if (source === 'fixed' && fixedKey === undefined) {
      throw new Error(`model-proxy: rule #${index + 1} fixed header ${JSON.stringify(name)} has no value`)
    }
    if (source !== 'fixed' && fixedKey !== undefined) {
      throw new Error(`model-proxy: rule #${index + 1} dynamic header ${JSON.stringify(name)} must not also have a fixed value`)
    }
  }
}

function assertCredentialRefServiceable(value: string | undefined, label: string): void {
  if (value === undefined || value === '') return
  if (value !== value.trim()) {
    throw new Error(`model-proxy: ${label} credentialRef has leading/trailing whitespace: ${JSON.stringify(value)}`)
  }
  if (/\s/.test(value)) {
    throw new Error(`model-proxy: ${label} credentialRef must not contain whitespace: ${JSON.stringify(value)}`)
  }
  if (value.includes('://')) {
    throw new Error(`model-proxy: ${label} credentialRef is an entry name, not a URL: ${JSON.stringify(value)}`)
  }
}

function assertProxyUrlServiceable(value: string | undefined, label: string): void {
  if (value === undefined || value === '') return
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`model-proxy: ${label} proxyUrl is not a valid URL`)
  }
  if (!SUPPORTED_SCHEMES.has(url.protocol)) {
    throw new Error(
      `model-proxy: ${label} proxyUrl scheme "${url.protocol}" unsupported; use http://, https://, socks5:// or socks5h://`,
    )
  }
  if (!url.hostname) throw new Error(`model-proxy: ${label} proxyUrl must have a hostname`)
}

/**
 * Cross-field validation that the schema alone cannot express.
 * Throws with a human-readable message listing the offending rule/host index.
 */
export function assertServiceable(config: ModelProxyConfig): void {
  const hosts = config.proxyHosts ?? []
  const hostIds = new Set<string>()
  for (let i = 0; i < hosts.length; i++) {
    const host = hosts[i]!
    const label = `proxy host #${i + 1}`
    if (!host.id || host.id !== host.id.trim()) {
      throw new Error(`model-proxy: ${label} id must be non-empty without surrounding whitespace`)
    }
    if (host.id === '__direct__' || host.id === '__custom__') {
      throw new Error(`model-proxy: ${label} id is reserved by the settings UI`)
    }
    if (hostIds.has(host.id)) throw new Error(`model-proxy: duplicate proxy host id "${host.id}"`)
    hostIds.add(host.id)
    if (!host.name || host.name !== host.name.trim()) {
      throw new Error(`model-proxy: ${label} name must be non-empty without surrounding whitespace`)
    }
    assertProxyUrlServiceable(host.proxyUrl, label)
    if (!host.proxyUrl) throw new Error(`model-proxy: ${label} proxyUrl must be non-empty; use a rule's Direct option for no proxy`)
    assertCredentialRefServiceable(host.credentialRef, label)
  }

  if (config.defaultProxyHostId !== undefined && config.defaultProxyHostId !== config.defaultProxyHostId.trim()) {
    throw new Error('model-proxy: defaultProxyHostId has leading/trailing whitespace')
  }
  const defaultHostId = config.defaultProxyHostId?.trim()
  if (defaultHostId && !hostIds.has(defaultHostId)) {
    throw new Error(`model-proxy: defaultProxyHostId references unknown proxy host "${defaultHostId}"`)
  }
  if (defaultHostId && config.defaultProxy !== '') {
    throw new Error('model-proxy: defaultProxyHostId and legacy defaultProxy cannot both be set')
  }
  assertProxyUrlServiceable(config.defaultProxy, 'default')

  // per-rule checks
  const seen = new Set<string>()
  for (let i = 0; i < config.rules.length; i++) {
    const r = config.rules[i]!
    const label = `rule #${i + 1}`
    if (r.provider !== r.provider.trim()) {
      throw new Error(`model-proxy: ${label} provider has leading/trailing whitespace: ${JSON.stringify(r.provider)}`)
    }
    if (r.model !== r.model.trim()) {
      throw new Error(`model-proxy: ${label} model has leading/trailing whitespace: ${JSON.stringify(r.model)}`)
    }
    // Prefix patterns allow a single TRAILING '*' only ("vendor-*"); anything
    // else containing '*' would silently match literally, so reject it.
    const starCount = (r.model.match(/\*/g) ?? []).length
    const isBareWildcard = r.model === '*'
    if (!isBareWildcard && starCount > 0 && !(starCount === 1 && r.model.endsWith('*'))) {
      throw new Error(
        `model-proxy: ${label} model may use at most one trailing '*' as prefix wildcard (e.g. "vendor-*"), got ${JSON.stringify(r.model)}`,
      )
    }
    if (r.purpose !== undefined && r.purpose !== '' && r.purpose !== r.purpose.trim()) {
      throw new Error(`model-proxy: ${label} purpose has leading/trailing whitespace: ${JSON.stringify(r.purpose)}`)
    }
    if (r.proxyHostId !== undefined && r.proxyHostId !== r.proxyHostId.trim()) {
      throw new Error(`model-proxy: ${label} proxyHostId has leading/trailing whitespace: ${JSON.stringify(r.proxyHostId)}`)
    }
    const hostId = r.proxyHostId?.trim()
    if (hostId && !hostIds.has(hostId)) {
      throw new Error(`model-proxy: ${label} references unknown proxy host "${hostId}"`)
    }
    if (hostId && (r.proxyUrl ?? '') !== '') {
      throw new Error(`model-proxy: ${label} cannot set both proxyHostId and legacy proxyUrl`)
    }
    if (hostId && (r.credentialRef ?? '') !== '') {
      throw new Error(`model-proxy: ${label} cannot set both proxyHostId and legacy credentialRef`)
    }
    assertCredentialRefServiceable(r.credentialRef, label)
    const key = `${r.provider}\0${r.model}`
    if (!r.provider.trim()) throw new Error(`model-proxy: ${label} provider must be non-empty`)
    if (!r.model.trim()) throw new Error(`model-proxy: ${label} model must be non-empty`)
    if (seen.has(key)) throw new Error(`model-proxy: ${label} duplicates provider "${r.provider}" model "${r.model}"`)
    seen.add(key)
    assertHeadersServiceable((r as ProxyRule).headers, i)
    assertHeaderSourcesServiceable((r as ProxyRule).headerValueSources, (r as ProxyRule).headers, i)
    if (Object.keys(r.headers ?? {}).length + Object.keys(r.headerValueSources ?? {}).length > MAX_HEADERS_PER_RULE) {
      throw new Error(`model-proxy: ${label} holds too many headers (max ${MAX_HEADERS_PER_RULE})`)
    }
    assertProxyUrlServiceable(r.proxyUrl, label)
  }
}

export interface HeaderRequestContext {
  sessionId?: string
  provider?: string
  model?: string
  purpose?: string
}

/** Resolved transport route and fixed extra headers. */
export interface ResolvedRoute {
  proxyUrl?: string
  headers?: Record<string, string>
}

function resolveHeaderValues(rule: ProxyRule, request: HeaderRequestContext = {}): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(rule.headers ?? {})) {
    const source = rule.headerValueSources?.[name]
    if (source === undefined || source === 'fixed') out[name] = value
  }
  for (const [name, source] of Object.entries(rule.headerValueSources ?? {})) {
    const value = source === 'sessionId' ? request.sessionId
      : source === 'provider' ? request.provider
        : source === 'model' ? request.model
          : source === 'purpose' ? request.purpose
            : undefined
    if (value) out[name] = value
  }
  return out
}

/** Resolve exact, prefix, then wildcard rules; disabled rules are skipped. */
export function resolveRoute(
  config: ModelProxyConfig,
  provider: string,
  model: string,
  purpose?: string,
  composeUrl?: (rule: ProxyRule) => string | undefined,
  request: HeaderRequestContext | string = {},
): ResolvedRoute {
  if (!config.enabled) return {}
  const requestContext: HeaderRequestContext = typeof request === 'string' ? { sessionId: request } : request
  const empty: ResolvedRoute = {}

  const purposeMatches = (r: ProxyRule): boolean =>
    r.purpose === undefined || r.purpose === '' || r.purpose === purpose

  for (const pass of ['exact', 'prefix', 'wildcard'] as const) {
    for (const r of config.rules) {
      if (r.enabled === false) continue
      if (r.provider !== provider) continue
      if (!purposeMatches(r)) continue
      if (pass === 'exact' && r.model !== model) continue
      if (pass === 'wildcard' && r.model !== '*') continue
      if (pass === 'prefix') {
        if (!r.model.endsWith('*') || r.model === '*') continue
        if (!model.startsWith(r.model.slice(0, -1))) continue
      }
      const url = composeUrl ? composeUrl(r) : r.proxyUrl
      const out: ResolvedRoute = url ? { proxyUrl: url } : {}
      const headers = resolveHeaderValues(r, requestContext)
      if (Object.keys(headers).length > 0) out.headers = headers
      return out
    }
  }
  if (config.defaultProxy) return { proxyUrl: config.defaultProxy }
  return empty
}

export function resolveProxy(
  config: ModelProxyConfig,
  provider: string,
  model: string,
  purpose?: string,
  composeUrl?: (rule: ProxyRule) => string | undefined,
): string | undefined {
  return resolveRoute(config, provider, model, purpose, composeUrl).proxyUrl
}

/** Redact proxy credentials and query/fragment data for logging. */
export function redactProxyUrl(url: string): string {
  try {
    const u = new URL(url)
    if (u.username || u.password) {
      u.username = '***'
      u.password = ''
    }
    u.search = ''
    u.hash = ''
    return u.toString()
  } catch {
    return '[invalid proxy URL]'
  }
}
