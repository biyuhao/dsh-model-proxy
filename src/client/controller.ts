/**
 * Client controller for model-proxy settings card.
 * Binds to `model-proxy` namespace via ctx.settingsScope and exposes
 * a small observable store for the card.
 */

import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type { DirectoryMirror } from './catalog.js'

export type ProxyHost = {
  /** Stable key referenced by rules and the optional default host. */
  id: string
  name: string
  proxyUrl: string
  /** Credentials-service entry ("user:password") for this host. */
  credentialRef?: string
}

export type HeaderValueSource = 'fixed' | 'sessionId' | 'provider' | 'model' | 'purpose'
export type HeaderSources = Record<string, HeaderValueSource>
export type HeaderEditorRow = { key: string; name: string; value: string; source: HeaderValueSource }

export type ProxyRule = {
  /** Card key; may be absent on hand-written yaml rules until edited here. */
  id?: string
  provider: string
  model: string
  /** Reusable host selected from proxyHosts; absent means direct. */
  proxyHostId?: string
  /** Legacy inline URL; used only when proxyHostId is absent. */
  proxyUrl?: string
  enabled: boolean
  /** Only apply to calls with this GenerateOptions.purpose; empty = all. */
  purpose?: string
  /** Legacy per-rule credential override; new UI stores this on ProxyHost. */
  credentialRef?: string
  /** Extra headers injected for this rule, including direct mode. */
  headers?: Record<string, string>
  /** Header names whose values come from the request context. */
  headerValueSources?: Record<string, HeaderValueSource>
}

export type ModelProxyConfig = {
  enabled: boolean
  proxyHosts: ProxyHost[]
  rules: ProxyRule[]
  /** Host used when no rule matches; absent/empty means direct. */
  defaultProxyHostId?: string
  /** Legacy inline fallback URL; empty when defaultProxyHostId is used. */
  defaultProxy: string
  debug: boolean
  /** Host-computed directory mirror; never edited by the card. */
  catalog?: DirectoryMirror
}

export type ModelProxySnapshot = {
  status: 'loading' | 'ready' | 'unavailable'
  value?: ModelProxyConfig
  revision?: number
  writable: boolean
  error?: string
}

type Listener = () => void

/** Fields the host schema knows; everything else is a legacy/foreign key. */
const KNOWN_RULE_FIELDS = ['id', 'provider', 'model', 'proxyHostId', 'proxyUrl', 'enabled', 'purpose', 'credentialRef', 'headers', 'headerValueSources'] as const
const KNOWN_HOST_FIELDS = ['id', 'name', 'proxyUrl', 'credentialRef'] as const

/**
 * Strip unknown keys before persisting rules.
 * Dropped keys are logged so legacy fields do not disappear silently.
 */
export function sanitizeRules(rules: ProxyRule[]): ProxyRule[] {
  return rules.map((rule) => {
    const out: Record<string, unknown> = {}
    const dropped: string[] = []
    for (const [key, value] of Object.entries(rule)) {
      if (value !== undefined && (KNOWN_RULE_FIELDS as readonly string[]).includes(key)) out[key] = value
      else if (value !== undefined) dropped.push(key)
    }
    if (dropped.length > 0) {
      console.warn(`[model-proxy] dropping unknown rule field(s): ${dropped.join(', ')}`)
    }
    return out as ProxyRule
  })
}

/** Stable-enough client-side id for rule cards (React keys / list diffs). */
export function makeRuleId(): string {
  return Math.random().toString(36).slice(2, 9)
}

/** Stable-enough client-side id for reusable proxy hosts. */
export function makeProxyHostId(): string {
  return `host-${Math.random().toString(36).slice(2, 9)}`
}

/** Strip unknown keys from drafted proxy hosts before persisting. */
export function sanitizeHosts(hosts: ProxyHost[]): ProxyHost[] {
  return hosts.map((host) => {
    const out: Record<string, unknown> = {}
    const dropped: string[] = []
    for (const [key, value] of Object.entries(host)) {
      if (value !== undefined && (KNOWN_HOST_FIELDS as readonly string[]).includes(key)) out[key] = value
      else if (value !== undefined) dropped.push(key)
    }
    if (dropped.length > 0) {
      console.warn(`[model-proxy] dropping unknown proxy host field(s): ${dropped.join(', ')}`)
    }
    return out as ProxyHost
  })
}

function stableId(prefix: string, source: string, seen: Map<string, number>): string {
  let hash = 2166136261
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  const base = `${prefix}-${(hash >>> 0).toString(36)}`
  const count = seen.get(source) ?? 0
  seen.set(source, count + 1)
  return count === 0 ? base : `${base}-${count}`
}

function proxyHostKey(proxyUrl: string, credentialRef?: string): string {
  return `${proxyUrl.trim()}\0${credentialRef?.trim() ?? ''}`
}

function deriveProxyHostName(proxyUrl: string, index: number): string {
  try {
    const u = new URL(proxyUrl)
    const port = u.port ? `:${u.port}` : ''
    return `${u.protocol.replace(':', '')}://${u.hostname}${port}`
  } catch {
    return `Proxy ${index + 1}`
  }
}

/** Migrate legacy inline URLs into reusable host entries. */
export function normalizeConfig(input: ModelProxyConfig): ModelProxyConfig {
  const hostIdCounts = new Map<string, number>()
  const hosts: ProxyHost[] = (input.proxyHosts ?? []).map((host) => {
    const proxyUrl = host.proxyUrl?.trim() ?? ''
    const credentialRef = host.credentialRef?.trim() || undefined
    const key = proxyHostKey(proxyUrl, credentialRef)
    return {
      ...host,
      id: host.id?.trim() || stableId('host', key, hostIdCounts),
      name: host.name ?? '',
      proxyUrl,
      ...(credentialRef ? { credentialRef } : {}),
    }
  })
  const byKey = new Map<string, string>()
  for (const host of hosts) byKey.set(proxyHostKey(host.proxyUrl, host.credentialRef), host.id)

  const ensureLegacyHost = (proxyUrl: string, credentialRef?: string): string => {
    const url = proxyUrl.trim()
    const ref = credentialRef?.trim() || undefined
    const key = proxyHostKey(url, ref)
    const existing = byKey.get(key)
    if (existing) return existing
    const host: ProxyHost = {
      id: makeProxyHostId(),
      name: deriveProxyHostName(url, hosts.length + 1),
      proxyUrl: url,
      ...(ref ? { credentialRef: ref } : {}),
    }
    hosts.push(host)
    byKey.set(key, host.id)
    return host.id
  }

  const rules = input.rules.map((rule) => {
    const out = { ...rule } as Record<string, unknown>
    const legacyUrl = typeof rule.proxyUrl === 'string' ? rule.proxyUrl.trim() : ''
    const hostId = rule.proxyHostId?.trim() || (legacyUrl !== '' ? ensureLegacyHost(legacyUrl, rule.credentialRef) : '')
    if (hostId) out.proxyHostId = hostId
    else delete out.proxyHostId
    // Inline URL/credential fields are legacy aliases; the host entry owns them.
    delete out.proxyUrl
    delete out.credentialRef
    if (rule.headerValueSources) {
      const sources = { ...rule.headerValueSources }
      const headers = { ...(rule.headers ?? {}) }
      for (const [name, source] of Object.entries(sources)) {
        if (source !== 'fixed') {
          for (const key of Object.keys(headers)) {
            if (key.toLowerCase() === name.toLowerCase()) delete headers[key]
          }
        } else {
          delete sources[name]
        }
      }
      if (Object.keys(headers).length > 0) out.headers = headers
      else delete out.headers
      if (Object.keys(sources).length > 0) out.headerValueSources = sources
      else delete out.headerValueSources
    }
    return out as ProxyRule
  })

  const legacyDefault = input.defaultProxy?.trim() ?? ''
  const defaultProxyHostId = input.defaultProxyHostId?.trim() || (legacyDefault !== '' ? ensureLegacyHost(legacyDefault) : '')
  const normalized = {
    ...input,
    proxyHosts: hosts,
    rules,
    defaultProxy: defaultProxyHostId ? '' : legacyDefault,
    ...(defaultProxyHostId ? { defaultProxyHostId } : {}),
  } as ModelProxyConfig
  if (!defaultProxyHostId) delete normalized.defaultProxyHostId
  return normalized
}

/** One "batch add" spec: shared fields + the model patterns to fan out over. */
export type CreatorSpec = {
  provider: string
  /** Model ids / wildcard patterns; one rule each. Duplicates collapse. */
  models: string[]
  /** New UI host reference; absent means direct. */
  proxyHostId?: string
  /** Legacy inline URL retained for hand-written/test callers. */
  proxyUrl?: string
  purpose?: string
  credentialRef?: string
  headers?: Record<string, string>
  headerValueSources?: Record<string, HeaderValueSource>
  enabled?: boolean
}

/**
 * Render a headers map as editable text: one `Name: value` per line.
 * Used by the card's per-rule and creator inputs.
 */
export function formatHeadersText(headers: Record<string, string> | undefined): string {
  if (!headers) return ''
  return Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\n')
}

const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const FORBIDDEN_HEADERS = new Set(['authorization', 'proxy-authorization', 'proxy-authenticate'])
const MAX_HEADERS = 10
const MAX_HEADER_VALUE_LENGTH = 4096

/** Parse `Name: value` lines; invalid input returns a displayable error. */
export function parseHeadersText(text: string): { headers?: Record<string, string>; error?: string } {
  const out: Record<string, string> = {}
  const seen = new Set<string>()
  const lines = text.split('\n')
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line === '') continue
    const sep = line.indexOf(':')
    if (sep <= 0) return { error: `bad header line (want "Name: value"): ${line.slice(0, 40)}` }
    const name = line.slice(0, sep).trim()
    const value = line.slice(sep + 1).trim()
    if (!HEADER_NAME_RE.test(name)) return { error: `bad header name: ${name.slice(0, 40)}` }
    if (value === '' || /[\r\n]/.test(value)) return { error: `bad value for header ${name}` }
    if (value.length > MAX_HEADER_VALUE_LENGTH) return { error: `header ${name} is too long` }
    const lower = name.toLowerCase()
    if (FORBIDDEN_HEADERS.has(lower)) {
      return { error: `${name} is managed by the adapter and cannot be set here` }
    }
    if (seen.has(lower)) return { error: `duplicate header: ${name}` }
    seen.add(lower)
    out[name] = value
  }
  if (Object.keys(out).length > MAX_HEADERS) return { error: `too many headers (max ${MAX_HEADERS})` }
  return { headers: out }
}

/** Convert editable Header rows into fixed and request-context values. */
export function parseHeaderRows(rows: readonly HeaderEditorRow[]): {
  headers?: Record<string, string>
  sources?: HeaderSources
  error?: string
} {
  const names = rows.map((row) => row.name.trim()).filter((name) => name !== '')
  if (new Set(names.map((name) => name.toLowerCase())).size > MAX_HEADERS) {
    return { error: `too many headers (max ${MAX_HEADERS})` }
  }
  const fixedText = rows
    .filter((row) => row.source === 'fixed' && row.name.trim() !== '')
    .map((row) => `${row.name.trim()}: ${row.value.trim()}`)
    .join('\n')
  const parsed = parseHeadersText(fixedText)
  if (parsed.error) return { error: parsed.error }
  const headers = parsed.headers ?? {}
  const sources: HeaderSources = {}
  const seen = new Set<string>()
  for (const row of rows) {
    const name = row.name.trim()
    if (name === '') continue
    if (!HEADER_NAME_RE.test(name)) return { error: `bad header name: ${name.slice(0, 40)}` }
    const lower = name.toLowerCase()
    if (FORBIDDEN_HEADERS.has(lower)) return { error: `${name} is managed by the adapter and cannot be set here` }
    if (seen.has(lower)) return { error: `duplicate header: ${name}` }
    seen.add(lower)
    if (row.source === 'fixed') {
      if (headers[name] === undefined) return { error: `bad value for header ${name}` }
    } else {
      delete headers[name]
      sources[name] = row.source
    }
  }
  return {
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    sources: Object.keys(sources).length > 0 ? sources : undefined,
  }
}

/** Fan one creator spec out into one rule per model. */
export function buildCreatorRules(spec: CreatorSpec): ProxyRule[] {
  const provider = spec.provider.trim()
  if (provider === '') return []
  const models = [...new Set(spec.models.map((m) => m.trim()).filter((m) => m !== ''))]
  if (models.length === 0) return []
  const purpose = (spec.purpose ?? '').trim()
  const credentialRef = (spec.credentialRef ?? '').trim()
  const proxyHostId = (spec.proxyHostId ?? '').trim()
  const proxyUrl = (spec.proxyUrl ?? '').trim()
  return models.map((model) => ({
    id: makeRuleId(),
    provider,
    model,
    ...(proxyHostId !== '' ? { proxyHostId } : {}),
    ...(proxyUrl !== '' ? { proxyUrl } : {}),
    enabled: spec.enabled ?? true,
    ...(purpose !== '' ? { purpose } : {}),
    ...(credentialRef !== '' ? { credentialRef } : {}),
    ...(spec.headers && Object.keys(spec.headers).length > 0 ? { headers: { ...spec.headers } } : {}),
    ...(spec.headerValueSources && Object.keys(spec.headerValueSources).length > 0
      ? { headerValueSources: { ...spec.headerValueSources } }
      : {}),
  }))
}

/** Group rules by provider, preserving input order within each group. */
export function groupByProvider(rules: ProxyRule[]): Array<{ provider: string; rules: ProxyRule[] }> {
  const groups: Array<{ provider: string; rules: ProxyRule[] }> = []
  const index = new Map<string, number>()
  for (const rule of rules) {
    let gi = index.get(rule.provider)
    if (gi === undefined) {
      gi = groups.length
      index.set(rule.provider, gi)
      groups.push({ provider: rule.provider, rules: [] })
    }
    groups[gi]!.rules.push(rule)
  }
  return groups
}

function stableRuleId(rule: ProxyRule, seen: Map<string, number>): string {
  return stableId('rule', `${rule.provider}\0${rule.model}\0${rule.purpose ?? ''}`, seen)
}

/** Add stable UI-only ids to rules that came from hand-written config. */
export function ensureRuleIds(cfg: ModelProxyConfig): ModelProxyConfig {
  const seen = new Map<string, number>()
  return {
    ...cfg,
    rules: cfg.rules.map((rule) => rule.id ? rule : { ...rule, id: stableRuleId(rule, seen) }),
  }
}

export class ModelProxyController {
  private listeners = new Set<Listener>()
  private snapshot: ModelProxySnapshot = { status: 'loading', writable: false }
  private unsub?: () => void

  constructor(private readonly scope: SettingsScope<ModelProxyConfig>) {}

  bind(): void {
    this.unsub = this.scope.subscribe(() => this.pull())
    this.pull()
  }

  dispose(): void {
    this.unsub?.()
    this.listeners.clear()
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  getSnapshot(): ModelProxySnapshot {
    return this.snapshot
  }

  private pull(): void {
    const s = this.scope.getSnapshot() as unknown as {
      status: string
      value?: ModelProxyConfig
      revision?: number
      writable: boolean
    }
    // status mapping: SettingsScope snapshot uses 'loading' | 'ready' | 'unavailable'
    this.snapshot = {
      status: (s.status as ModelProxySnapshot['status']) ?? 'loading',
      value: s.value,
      revision: s.revision,
      writable: s.writable,
    }
    this.emit()
  }

  private emit(): void {
    for (const l of [...this.listeners]) l()
  }

  /**
   * Persist reusable hosts before rules so references are serviceable as soon
   * as the rule write lands. The remaining scalar fields are written after the
   * two collection fields; the settings scope intentionally exposes per-field
   * writes rather than one atomic document replacement.
   */
  async save(next: ModelProxyConfig): Promise<void> {
    const normalized = normalizeConfig(next)
    const write = async (field: string, value: unknown): Promise<void> => {
      const result = await this.scope.set(field, value)
      if (result === false) throw new Error(`model-proxy: settings write rejected for ${field}`)
    }
    await write('proxyHosts', sanitizeHosts(normalized.proxyHosts))
    await write('rules', sanitizeRules(normalized.rules))
    await write('defaultProxyHostId', normalized.defaultProxyHostId ?? '')
    await write('defaultProxy', normalized.defaultProxy)
    await write('enabled', normalized.enabled)
    await write('debug', normalized.debug)
  }

  async setEnabled(v: boolean): Promise<void> {
    await this.scope.set('enabled', v)
  }

  async setDebug(v: boolean): Promise<void> {
    await this.scope.set('debug', v)
  }
}
