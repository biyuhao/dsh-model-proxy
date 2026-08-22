/**
 * Client controller for model-proxy settings card.
 * Binds to `model-proxy` namespace via ctx.settingsScope and exposes
 * a small observable store for the card.
 */

import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'

export type ProxyRule = {
  /** Card key; may be absent on hand-written yaml rules until edited here. */
  id?: string
  provider: string
  model: string
  proxyUrl: string
  enabled: boolean
  /** Only apply to calls with this GenerateOptions.purpose; empty = all. */
  purpose?: string
  /** Credentials-service entry ("user:password") overriding proxyUrl userinfo. */
  credentialRef?: string
}

export type ModelProxyConfig = {
  enabled: boolean
  rules: ProxyRule[]
  defaultProxy: string
  debug: boolean
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
const KNOWN_RULE_FIELDS = ['id', 'provider', 'model', 'proxyUrl', 'enabled', 'purpose', 'credentialRef'] as const

/**
 * Strip unknown keys from drafted rules before persisting. The wire layer
 * tolerates extra keys and passes them through materialization, so without
 * this a legacy field (e.g. the removed `note`) read from the stored document
 * would ride every save forever. Writing only known fields converges stored
 * documents to the schema shape.
 *
 * Dropping is loud, not silent: every stripped key is named on the console,
 * so a hand-written key vanishing on save is never a mystery.
 */
export function sanitizeRules(rules: ProxyRule[]): ProxyRule[] {
  return rules.map((rule) => {
    const out: Record<string, unknown> = {}
    const dropped: string[] = []
    for (const [key, value] of Object.entries(rule)) {
      if ((KNOWN_RULE_FIELDS as readonly string[]).includes(key)) out[key] = value
      else dropped.push(key)
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

/** One "batch add" spec: shared fields + the model patterns to fan out over. */
export type CreatorSpec = {
  provider: string
  /** Model ids / wildcard patterns; one rule each. Duplicates collapse. */
  models: string[]
  proxyUrl: string
  purpose?: string
  credentialRef?: string
  enabled?: boolean
}

/**
 * Fan one creator spec out into N prefilled rules sharing provider and
 * connection fields. Returns [] when provider or models are effectively
 * empty — callers gate the button on the same predicate for inline counts.
 */
export function buildCreatorRules(spec: CreatorSpec): ProxyRule[] {
  const provider = spec.provider.trim()
  if (provider === '') return []
  const models = [...new Set(spec.models.map((m) => m.trim()).filter((m) => m !== ''))]
  if (models.length === 0) return []
  const purpose = (spec.purpose ?? '').trim()
  const credentialRef = (spec.credentialRef ?? '').trim()
  return models.map((model) => ({
    id: makeRuleId(),
    provider,
    model,
    proxyUrl: spec.proxyUrl.trim(),
    enabled: spec.enabled ?? true,
    ...(purpose !== '' ? { purpose } : {}),
    ...(credentialRef !== '' ? { credentialRef } : {}),
  }))
}

/**
 * Group rules by provider for the card's grouped view: group order is first
 * appearance, intra-group order preserved. Matching semantics only care about
 * order WITHIN a provider (same-pass first-wins), so regrouping across
 * providers is display-safe by construction.
 */
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

/**
 * Fill missing rule ids so every card has a stable React key. Host-side code
 * never relies on `id` (the schema leaves it optional), so this is purely a
 * UI concern and does not dirty the saved document.
 */
export function ensureRuleIds(cfg: ModelProxyConfig): ModelProxyConfig {
  return { ...cfg, rules: cfg.rules.map((r) => (r.id ? r : { ...r, id: makeRuleId() })) }
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
   * Persist the config as four fenced field writes.
   *
   * The scope contract exposes per-field writes only, so full atomicity would
   * require collapsing the namespace to a single field (a breaking settings
   * shape change). Until then we order the writes so the field most likely to
   * be REJECTED by host validation (`rules`) goes FIRST: if it fails, nothing
   * else has been committed and the failure aborts cleanly instead of leaving
   * mixed old/new state. The remaining fields are booleans plus a URL that the
   * card pre-validates with the same checks the host applies, making their
   * rejection practically unreachable.
   */
  async save(next: ModelProxyConfig): Promise<void> {
    await this.scope.set('rules', sanitizeRules(next.rules))
    await this.scope.set('defaultProxy', next.defaultProxy)
    await this.scope.set('enabled', next.enabled)
    await this.scope.set('debug', next.debug)
  }

  async setEnabled(v: boolean): Promise<void> {
    await this.scope.set('enabled', v)
  }

  async setDebug(v: boolean): Promise<void> {
    await this.scope.set('debug', v)
  }
}
