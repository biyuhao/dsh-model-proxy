/**
 * Settings schema for dsh-plugin-model-proxy (Host).
 *
 * Exported as `Config`: the Loader entry's Cordis Config — the settings UI
 * projects its volatile fields as the `model-proxy` section (the entry id).
 * Single source of truth for validation — used by Host reads and mirrored
 * in Client for fast local feedback.
 */

import z from '@deepseek-ai/schemastery'

export const ProxyRuleSchema: any = z.object({
  // NOTE: no `.default(fn)` here — this schemastery fork stores function
  // defaults un-invoked and then type-checks them against the field type,
  // so a rule without an explicit id would throw at resolution time and
  // silently discard the whole hand-written settings section. The client
  // generates ids for cards; host-side code never relies on them.
  id: z.string(),
  provider: z.string().required(),
  // exact id | prefix "vendor-*" (single trailing '*') | "*"
  model: z.string().required(),
  proxyUrl: z.string().required(), // "" = direct, otherwise URL
  enabled: z.boolean().default(true),
  // optional purpose filter: unset matches every purpose; when set it must
  // equal GenerateOptions.purpose (e.g. 'compaction', 'session-title')
  purpose: z.string(),
  // optional name of a credentials-service entry holding "user:password";
  // when set (and resolvable) it overrides any inline userinfo in proxyUrl
  credentialRef: z.string(),
})

export interface ProxyRule {
  /** Optional card key for the UI; hand-written yaml rules may omit it. */
  id?: string
  provider: string
  model: string
  proxyUrl: string
  enabled: boolean
  /** When set, the rule only applies to LLM calls carrying this purpose. */
  purpose?: string
  /** Credentials-service entry ("user:password") overriding proxyUrl userinfo. */
  credentialRef?: string
}

/**
 * Host-computed provider/model directory mirrored into this namespace so
 * settings surfaces that cannot reach the cross-namespace Typert remotes
 * (`remote.llm` / `remote.session` / `remote.settings` — e.g. non-loopback
 * pages) still render dropdowns. Read through the card's own settings scope,
 * which is available wherever the card itself renders.
 *
 * COMPUTED, NEVER EDIT: the host rewrites it on `llm/adapters-updated` and
 * `settings/document-updated` (deep-equal guarded, so no write loop); the
 * client never writes it and strips it from drafts/dirty checks. Only ids
 * and display names are mirrored — never credentials or secrets.
 */
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
  rules: z.array(ProxyRuleSchema).default([]).volatile(),
  defaultProxy: z.string().default('').volatile(),
  debug: z.boolean().default(false).volatile(),
  // No .default() on `catalog` itself — nested defaults still materialize an
  // empty mirror on bare documents. Volatile so the host mirror write commits
  // without remounting the entry.
  catalog: DirectoryCatalogSchema.volatile(),
})

export interface ModelProxyConfig {
  enabled: boolean
  rules: ProxyRule[]
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
  rules: VolatileRef<ProxyRule[]>
  defaultProxy: VolatileRef<string>
  debug: VolatileRef<boolean>
  catalog: VolatileRef<DirectoryCatalog | undefined>
}

const SUPPORTED_SCHEMES = new Set(['http:', 'https:', 'socks5:', 'socks5h:', 'socks:'])

/**
 * Cross-field validation that the schema alone cannot express.
 * Throws with a human-readable message listing the offending rule index.
 */
export function assertServiceable(config: ModelProxyConfig): void {
  // per-rule checks
  const seen = new Set<string>()
  for (let i = 0; i < config.rules.length; i++) {
    const r = config.rules[i]!
    if (r.provider !== r.provider.trim()) {
      throw new Error(`model-proxy: rule #${i + 1} provider has leading/trailing whitespace: ${JSON.stringify(r.provider)}`)
    }
    if (r.model !== r.model.trim()) {
      throw new Error(`model-proxy: rule #${i + 1} model has leading/trailing whitespace: ${JSON.stringify(r.model)}`)
    }
    // Prefix patterns allow a single TRAILING '*' only ("vendor-*"); anything
    // else containing '*' would silently match literally, so reject it.
    const starCount = (r.model.match(/\*/g) ?? []).length
    const isBareWildcard = r.model === '*'
    if (!isBareWildcard && starCount > 0 && !(starCount === 1 && r.model.endsWith('*'))) {
      throw new Error(
        `model-proxy: rule #${i + 1} model may use at most one trailing '*' as prefix wildcard (e.g. "vendor-*"), got ${JSON.stringify(r.model)}`,
      )
    }
    if (r.purpose !== undefined && r.purpose !== '' && r.purpose !== r.purpose.trim()) {
      throw new Error(`model-proxy: rule #${i + 1} purpose has leading/trailing whitespace: ${JSON.stringify(r.purpose)}`)
    }
    if (r.credentialRef !== undefined && r.credentialRef !== '') {
      if (r.credentialRef !== r.credentialRef.trim()) {
        throw new Error(`model-proxy: rule #${i + 1} credentialRef has leading/trailing whitespace: ${JSON.stringify(r.credentialRef)}`)
      }
      if (/\s/.test(r.credentialRef)) {
        throw new Error(`model-proxy: rule #${i + 1} credentialRef must not contain whitespace: ${JSON.stringify(r.credentialRef)}`)
      }
      if (r.credentialRef.includes('://')) {
        throw new Error(`model-proxy: rule #${i + 1} credentialRef is an entry name, not a URL: ${JSON.stringify(r.credentialRef)}`)
      }
    }
    const key = `${r.provider}\0${r.model}`
    if (!r.provider.trim()) throw new Error(`model-proxy: rule #${i + 1} provider must be non-empty`)
    if (!r.model.trim()) throw new Error(`model-proxy: rule #${i + 1} model must be non-empty`)
    if (seen.has(key)) throw new Error(`model-proxy: rule #${i + 1} duplicates provider "${r.provider}" model "${r.model}"`)
    seen.add(key)

    if (r.proxyUrl !== '') {
      let url: URL
      try {
        url = new URL(r.proxyUrl)
      } catch {
        throw new Error(`model-proxy: rule #${i + 1} proxyUrl is not a valid URL: ${JSON.stringify(r.proxyUrl.slice(0, 32))}…(truncated)`)
      }
      if (!SUPPORTED_SCHEMES.has(url.protocol)) {
        throw new Error(
          `model-proxy: rule #${i + 1} proxyUrl scheme "${url.protocol}" unsupported; use http://, https://, socks5:// or socks5h://`,
        )
      }
      if (!url.hostname) throw new Error(`model-proxy: rule #${i + 1} proxyUrl must have a hostname`)
    }
  }

  if (config.defaultProxy !== '') {
    let url: URL
    try {
      url = new URL(config.defaultProxy)
    } catch {
      throw new Error(`model-proxy: defaultProxy is not a valid URL: ${JSON.stringify(config.defaultProxy.slice(0, 32))}…(truncated)`)
    }
    if (!SUPPORTED_SCHEMES.has(url.protocol)) {
      throw new Error(`model-proxy: defaultProxy scheme "${url.protocol}" unsupported`)
    }
    if (!url.hostname) throw new Error('model-proxy: defaultProxy must have a hostname')
  }
}

/**
 * Resolve which proxyUrl (if any) applies to a given call.
 * Model specificity: exact match > prefix "vendor-*" > wildcard "*", each pass
 * first-wins in array order. Disabled rules are skipped. A rule with `purpose`
 * set only matches calls carrying the same purpose; rules without one match all.
 *
 * `composeUrl` lets the caller transform the matched rule into an effective
 * URL (e.g. credentialRef composition) — its empty/undefined result means
 * direct exemption, same as `""`.
 */
export function resolveProxy(
  config: ModelProxyConfig,
  provider: string,
  model: string,
  purpose?: string,
  composeUrl?: (rule: ProxyRule) => string | undefined,
): string | undefined {
  if (!config.enabled) return undefined

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
      // "" / undefined mean direct exemption
      return url || undefined
    }
  }
  return config.defaultProxy || undefined
}

/** Redact password for logging: socks5://user:pass@host -> socks5://user:***@host */
export function redactProxyUrl(url: string): string {
  try {
    const u = new URL(url)
    if (u.password) u.password = '***'
    return u.toString()
  } catch {
    return url
  }
}
