/**
 * Provider/model catalog feeding the settings card dropdowns.
 *
 * Data sources mirror the built-in Models page and the model-selection
 * surface:
 * - `llm.providers` — configurable provider directory merged with live routes
 *   (`{ providers: [{ provider, displayName, settingsNs, settingsPath,
 *   active, declared? }] }`)
 * - `llm.models` — advisory per-provider model catalog
 *   (`{ groups: [{ id, name, models: [{ id, name?, … }] }], failures }`)
 * - `settings.describe` — optional enrichment: cross-references each row's
 *   settings address to derive `configured`, so the card can group
 *   user-configured providers ahead of the bare directory (same semantics as
 *   the built-in Models page).
 *
 * Refresh triggers mirror ui-model-selection's convergence sources:
 * `llm/adapters-updated` (registry topology commits) and
 * `settings/document-updated` (configuration-owned catalogs).
 *
 * Everything here is advisory. The card always keeps a free-text escape
 * hatch, because proxy rules legitimately target things no catalog lists:
 * wildcard patterns (`vendor-*`, `*`) and providers whose adapter is not
 * installed (yet).
 */

/** One selectable provider row (shape of `llm.providers.providers`). */
export type CatalogProvider = {
  provider: string
  displayName: string
  active: boolean
  /** Settings namespace whose section configures this provider (absent = no settings address). */
  settingsNs?: string
  /** Path from that section's root to this provider's profile object. */
  settingsPath?: string[]
  /** Adapter knows this route only because configuration declared it. */
  declared?: boolean
  /**
   * Mirrors ui-settings-models' derivation: the provider's settings namespace
   * exists AND its profile object is present in the merged value. Undefined
   * when unknown (no settings address, or settings.describe unavailable).
   */
  configured?: boolean
}

/** One selectable model row (subset of an `llm.models` group entry). */
export type CatalogModel = {
  id: string
  name?: string
}

export type CatalogSnapshot = {
  status: 'idle' | 'loading' | 'ready' | 'unavailable'
  providers: CatalogProvider[]
  /** Provider id → catalog models; absent/empty means no known models. */
  modelsByProvider: Record<string, CatalogModel[]>
}

/** Structural wire face so tests can pass fakes without a transport. */
export type CatalogApiFace = {
  llm: {
    providers(payload: object): Promise<unknown>
    models(payload: object): Promise<unknown>
  }
  /**
   * Optional settings mirror used to derive each provider's `configured`
   * flag. Absent or failing keeps configured undefined — grouping degrades
   * to the flat directory list.
   */
  settings?: {
    describe(payload: object): Promise<unknown>
  }
}

/** Structural face of `ctx.remote` — `$on` returns its own disposer. */
export type CatalogRemoteFace = {
  $on(event: string, listener: (...args: never[]) => void): () => void
}

type Listener = () => void

const EMPTY: CatalogSnapshot = { status: 'idle', providers: [], modelsByProvider: {} }

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

/**
 * Unwrap one RPC envelope (`{ result: { ok, value | error } }`), throwing on
 * a business rejection with its wire message.
 */
export function unwrapRpc(response: unknown): unknown {
  const envelope = asRecord(response)
  const result = envelope === undefined ? undefined : asRecord(envelope.result)
  if (result === undefined) throw new Error('malformed RPC envelope')
  if (result.ok !== true) {
    const error = asRecord(result.error)
    throw new Error(typeof error?.message === 'string' && error.message !== '' ? error.message : 'RPC request failed')
  }
  return result.value
}

/**
 * Extract selectable provider rows from an unwrapped `llm.providers` value.
 * Malformed rows are skipped, never fatal — the dropdown degrades to whatever
 * is parseable.
 */
export function pickProviders(value: unknown): CatalogProvider[] {
  const root = asRecord(value)
  const rows = Array.isArray(root?.providers) ? root.providers : []
  const out: CatalogProvider[] = []
  for (const row of rows) {
    const r = asRecord(row)
    if (r === undefined || typeof r.provider !== 'string' || r.provider === '') continue
    const p: CatalogProvider = {
      provider: r.provider,
      displayName: typeof r.displayName === 'string' && r.displayName !== '' ? r.displayName : r.provider,
      active: r.active === true,
    }
    if (typeof r.settingsNs === 'string' && r.settingsNs !== '') {
      p.settingsNs = r.settingsNs
      if (Array.isArray(r.settingsPath)) {
        p.settingsPath = r.settingsPath.filter((k): k is string => typeof k === 'string')
      }
    }
    if (r.declared === true || r.declared === false) p.declared = r.declared
    out.push(p)
  }
  return out
}

/** Deep-get along a path; undefined as soon as any hop is missing. */
export function getPath(value: unknown, path: readonly string[]): unknown {
  let cur: unknown = value
  for (const key of path) {
    const rec = asRecord(cur)
    if (rec === undefined) return undefined
    cur = rec[key]
  }
  return cur
}

/**
 * Attach `configured` to provider rows, mirroring ui-settings-models'
 * derivation: the settings namespace exists in the mirror AND either the
 * provider configures via the whole section (`settingsPath` empty) or its
 * profile object is present in the merged value. Rows without a settings
 * address keep `configured` undefined (unknown, not false).
 */
export function attachConfigured(
  providers: CatalogProvider[],
  namespaces: ReadonlyArray<{ ns?: unknown; value?: unknown }>,
): CatalogProvider[] {
  const byNs = new Map<string, unknown>()
  for (const n of namespaces) {
    if (typeof n.ns === 'string' && !(byNs.has(n.ns))) byNs.set(n.ns, n.value)
  }
  return providers.map((p) => {
    if (p.settingsNs === undefined || !byNs.has(p.settingsNs)) return p
    const value = byNs.get(p.settingsNs)
    const path = p.settingsPath ?? []
    const configured = path.length === 0 ? value !== undefined : getPath(value, path) !== undefined
    return { ...p, configured }
  })
}

/**
 * Group an unwrapped `llm.models` value into provider id → model rows.
 * Failures entries are ignored (the dropdown simply offers nothing for a
 * provider whose catalog failed host-side).
 */
export function pickModelsByProvider(value: unknown): Record<string, CatalogModel[]> {
  const root = asRecord(value)
  const groups = Array.isArray(root?.groups) ? root.groups : []
  const map: Record<string, CatalogModel[]> = {}
  for (const group of groups) {
    const g = asRecord(group)
    if (g === undefined || typeof g.id !== 'string' || g.id === '' || !Array.isArray(g.models)) continue
    const models: CatalogModel[] = []
    for (const row of g.models) {
      const m = asRecord(row)
      if (m === undefined || typeof m.id !== 'string' || m.id === '') continue
      models.push({ id: m.id, ...(typeof m.name === 'string' && m.name !== '' ? { name: m.name } : {}) })
    }
    map[g.id] = models
  }
  return map
}

/**
 * uSES-compatible store over the two catalog RPCs. Loads once on bind(),
 * reloads on forwarded topology/settings events, and keeps the last good
 * rows across a failed background refresh so an outage never blanks open
 * dropdowns.
 */
export class ProviderCatalogStore {
  private readonly listeners = new Set<Listener>()
  private snapshot: CatalogSnapshot = EMPTY
  private generation = 0
  private unsubs: Array<() => void> = []
  private bound = false

  constructor(
    private readonly api: CatalogApiFace,
    private readonly remote?: CatalogRemoteFace,
  ) {}

  /** Idempotent: start loading and subscribe to refresh events. */
  bind(): void {
    if (this.bound) return
    this.bound = true
    if (this.remote !== undefined) {
      this.unsubs.push(this.remote.$on('llm/adapters-updated', () => void this.load()))
      this.unsubs.push(this.remote.$on('settings/document-updated', () => void this.load()))
    }
    void this.load()
  }

  /** Stop listening; in-flight loads become no-ops via the generation guard. */
  dispose(): void {
    this.bound = false
    for (const off of this.unsubs.splice(0)) {
      try {
        off()
      } catch {
        // A disposer failing must not mask the remaining ones.
      }
    }
    this.generation++
    this.listeners.clear()
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot(): CatalogSnapshot {
    return this.snapshot
  }

  /**
   * Fetch both catalogs. Each call settles independently (`allSettled`
   * semantics via mapped thunks): a provider-catalog failure fails the whole
   * load, while a model-catalog failure degrades to an empty model map —
   * models are an enrichment, providers drive the primary dropdown.
   */
  async load(): Promise<void> {
    const generation = ++this.generation
    if (this.snapshot.status === 'idle') this.set({ ...EMPTY, status: 'loading' })
    const settle = <T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> =>
      promise.then(
        (value) => ({ ok: true as const, value }),
        () => ({ ok: false as const }),
      )
    const [providersOutcome, modelsOutcome, settingsOutcome] = await Promise.all([
      settle(this.api.llm.providers({})),
      settle(this.api.llm.models({})),
      // Enrichment only: a describe failure must not degrade the dropdowns.
      settle(this.api.settings?.describe({}) ?? Promise.reject(new Error('no settings face'))),
    ])
    if (generation !== this.generation) return
    let providers: CatalogProvider[]
    if (!providersOutcome.ok) {
      this.markUnavailable()
      return
    }
    try {
      // Also catches a business-rejection envelope (`result.ok === false`),
      // which resolves rather than rejects.
      providers = pickProviders(unwrapRpc(providersOutcome.value))
    } catch {
      this.markUnavailable()
      return
    }
    let modelsByProvider: Record<string, CatalogModel[]> = {}
    if (modelsOutcome.ok) {
      try {
        modelsByProvider = pickModelsByProvider(unwrapRpc(modelsOutcome.value))
      } catch {
        modelsByProvider = {}
      }
    }
    if (settingsOutcome.ok) {
      try {
        const described = unwrapRpc(settingsOutcome.value) as { namespaces?: unknown }
        const namespaces = Array.isArray(described?.namespaces) ? described.namespaces : []
        providers = attachConfigured(
          providers,
          namespaces.map((n) => {
            const r = asRecord(n)
            return { ns: r?.ns, value: r?.value }
          }),
        )
      } catch {
        // Keep configured undefined — flat list, no grouping.
      }
    }
    this.set({ status: 'ready', providers, modelsByProvider })
  }

  /**
   * Keep last good rows across a failed refresh; the card falls back to
   * free-text inputs only when the snapshot holds no providers at all.
   */
  private markUnavailable(): void {
    this.set({ ...this.snapshot, status: 'unavailable' })
  }

  private set(snapshot: CatalogSnapshot): void {
    this.snapshot = snapshot
    for (const listener of [...this.listeners]) listener()
  }
}
