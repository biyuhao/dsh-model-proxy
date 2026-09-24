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
 * - `session.modelCatalog` — same `{ groups }` shape, served by the
 *   Plugins-tab-native face, so it covers pages where the legacy bulk
 *   `llm.models` RPC never existed (preferred over the synthesis below)
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

/**
 * Host-computed directory mirror (`model-proxy.catalog` in our own settings
 * namespace). Same data as the Typert remotes, delivered through the card's
 * own settings scope — the one channel available on every page the card
 * renders on. Remote rows always win; mirror rows only fill gaps.
 */
export type MirrorModel = {
  id: string
  name?: string
}

export type MirrorProvider = {
  provider: string
  displayName?: string
  active?: boolean
}

export type DirectoryMirror = {
  providers: MirrorProvider[]
  models: Array<{ provider: string; models: MirrorModel[] }>
}

/**
 * Normalize mirror `models` entries into the card's provider→models map.
 * Malformed entries are skipped, duplicates collapse — total, never throws.
 */
export function mirrorModelsToMap(mirror: DirectoryMirror | undefined): Record<string, CatalogModel[]> {
  const map: Record<string, CatalogModel[]> = {}
  const entries = Array.isArray(mirror?.models) ? mirror.models : []
  for (const entry of entries) {
    const r = (entry ?? {}) as { provider?: unknown; models?: unknown }
    if (typeof r.provider !== 'string' || r.provider === '' || !Array.isArray(r.models)) continue
    const rows: CatalogModel[] = []
    for (const m of r.models) {
      const mr = (m ?? {}) as { id?: unknown; name?: unknown }
      if (typeof mr.id !== 'string' || mr.id === '') continue
      rows.push({ id: mr.id, ...(typeof mr.name === 'string' && mr.name !== '' ? { name: mr.name } : {}) })
    }
    if (rows.length === 0) continue
    const acc = map[r.provider] ?? []
    const seen = new Set(acc.map((x) => x.id))
    for (const row of rows) {
      if (!seen.has(row.id)) {
        acc.push(row)
        seen.add(row.id)
      }
    }
    map[r.provider] = acc
  }
  return map
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
  // Typert remotes (DSH 0.1.2): every method resolves to a RemoteResult
  // envelope ({ok:true,value} / {ok:false,error}) — always unwrap via
  // unwrapRemoteResult, never consume the payload positionally.
  llm?: {
    listProviders?(): Promise<unknown>
    listConfigurableProviders?(): Promise<unknown>
    discoverModels?(ns: string, req: unknown): Promise<unknown>
  }
  settings?: {
    describe?(): Promise<unknown>
  }
  /**
   * Session model catalog — the same `{ groups: [{ id, models }] }` shape as
   * the retired bulk `llm.models`, served by the face the built-in
   * Plugins-tab cards already consume (`remote.session.modelCatalog()`), so
   * it stays mounted wherever this card is rendered.
   */
  session?: {
    modelCatalog?(): Promise<unknown>
  }
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
 * Unwrap one Typert RemoteResult envelope (`{ ok: true, value }` /
 * `{ ok: false, error }`), throwing on a business rejection with its wire
 * message.
 *
 * Non-envelope payloads (a bare array, an already-unwrapped `{ providers }`
 * object) pass through untouched, so hosts that return payloads directly
 * keep working.
 */
export function unwrapRemoteResult(response: unknown): unknown {
  const envelope = asRecord(response)
  if (envelope === undefined || (envelope.ok !== true && envelope.ok !== false)) return response
  if (envelope.ok !== true) {
    const error = asRecord(envelope.error)
    throw new Error(typeof error?.message === 'string' && error.message !== '' ? error.message : 'remote request failed')
  }
  return envelope.value
}

/**
 * Extract selectable provider rows from an unwrapped `llm.providers` value.
 * Malformed rows are skipped, never fatal — the dropdown degrades to whatever
 * is parseable.
 *
 * A Typert RemoteResult envelope is tolerated here as well (unwrapped first),
 * so the function stays total no matter which layer forgot to unwrap.
 *
 * DSH 0.1.2 renamed `provider` → `id` on live routes (`remote.llm`
 * `listProviders()` returns `{ id, name }`) and serves the configurable
 * directory separately via `listConfigurableProviders()` (`{ provider,
 * displayName, settingsNs, settingsPath, declared? }`). Accept both shapes
 * and default `active` to true when the field is absent (new remote omits it
 * on live rows; joined directory rows carry their own derivation).
 */
export function pickProviders(value: unknown): CatalogProvider[] {
  const payload = unwrapRemoteResult(value)
  const root = asRecord(payload)
  const rows = Array.isArray(root?.providers)
    ? root.providers
    : Array.isArray(payload)
      ? (payload as unknown[])
      : []
  const out: CatalogProvider[] = []
  for (const row of rows) {
    const r = asRecord(row)
    if (r === undefined) continue
    const providerId =
      typeof r.provider === 'string' && r.provider !== ''
        ? r.provider
        : typeof r.id === 'string' && r.id !== ''
          ? r.id
          : ''
    if (providerId === '') continue
    const displayNameRaw =
      typeof r.displayName === 'string' && r.displayName !== ''
        ? r.displayName
        : typeof r.name === 'string' && r.name !== ''
          ? r.name
          : providerId
    const active = r.active === true ? true : r.active === false ? false : true
    const p: CatalogProvider = {
      provider: providerId,
      displayName: displayNameRaw,
      active,
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
 * Merge live routes with the configurable directory, mirroring the built-in
 * Models page (`joinProviderDirectory` in `dsh-client-ui-settings-models`):
 * declared directory rows first (in declaration order, `active` derived from
 * live membership), then live-only routes with no declaration appended.
 *
 * - `registered`: live routes from `remote.llm.listProviders()` (`{id,name}`).
 * - `directory`: configurable providers from
 *   `remote.llm.listConfigurableProviders()` (`{provider,displayName,
 *   settingsNs,settingsPath,declared?}`).
 *
 * Either side may be absent/empty (older hosts serve only one face); the join
 * degrades to whatever side is present instead of blanking the dropdown.
 * Returns rows in the `{providers:[...]}` row shape `pickProviders`
 * understands, so callers normalize through a single funnel.
 */
export function joinProviderDirectory(registered: unknown, directory: unknown): { providers: unknown[] } {
  const liveRows = Array.isArray(registered) ? registered : []
  const dirRows = Array.isArray(directory) ? directory : []
  const liveById = new Map<string, string>()
  for (const row of liveRows) {
    const r = asRecord(row)
    if (r === undefined) continue
    const id =
      typeof r.id === 'string' && r.id !== ''
        ? r.id
        : typeof r.provider === 'string' && r.provider !== ''
          ? r.provider
          : ''
    if (id === '' || liveById.has(id)) continue
    const name =
      typeof r.name === 'string' && r.name !== ''
        ? r.name
        : typeof r.displayName === 'string' && r.displayName !== ''
          ? r.displayName
          : id
    liveById.set(id, name)
  }
  const out: unknown[] = []
  const declaredIds = new Set<string>()
  for (const row of dirRows) {
    const r = asRecord(row)
    if (r === undefined) continue
    const provider =
      typeof r.provider === 'string' && r.provider !== ''
        ? r.provider
        : typeof r.id === 'string' && r.id !== ''
          ? r.id
          : ''
    if (provider === '' || declaredIds.has(provider)) continue
    declaredIds.add(provider)
    const displayName =
      typeof r.displayName === 'string' && r.displayName !== ''
        ? r.displayName
        : typeof r.name === 'string' && r.name !== ''
          ? r.name
          : provider
    const entry: Record<string, unknown> = {
      provider,
      displayName,
      active: liveById.has(provider),
    }
    if (typeof r.settingsNs === 'string' && r.settingsNs !== '') {
      entry.settingsNs = r.settingsNs
      entry.settingsPath = Array.isArray(r.settingsPath)
        ? r.settingsPath.filter((k): k is string => typeof k === 'string')
        : []
    }
    if (r.declared === true || r.declared === false) entry.declared = r.declared
    out.push(entry)
  }
  for (const [id, name] of liveById) {
    if (declaredIds.has(id)) continue
    out.push({ provider: id, displayName: name, active: true })
  }
  return { providers: out }
}

/**
 * Group an unwrapped `llm.models` value into provider id → model rows.
 * Failures entries are ignored (the dropdown simply offers nothing for a
 * provider whose catalog failed host-side).
 */
export function pickModelsByProvider(value: unknown): Record<string, CatalogModel[]> {
  const payload = unwrapRemoteResult(value)
  const root = asRecord(payload)
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
   *
   * DSH 0.1.2 moved `llm.providers` from `connection.api` (envelope RPC) to
   * `remote.llm` Typert remotes. Every Remote method resolves to a
   * RemoteResult envelope (`{ok:true,value}` / `{ok:false,error}`) — never a
   * bare payload — and the provider surface is split in two, mirroring the
   * built-in Models page: `listProviders()` (live routes) joined with
   * `listConfigurableProviders()` (configurable directory). Try the Typert
   * face first, fall back to the legacy envelope RPC for older hosts.
   */
  async load(): Promise<void> {
    const generation = ++this.generation
    if (this.snapshot.status === 'idle') this.set({ ...EMPTY, status: 'loading' })
    const settle = <T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> =>
      promise.then(
        (value) => ({ ok: true as const, value }),
        () => ({ ok: false as const }),
      )
    const remoteAny = this.remote as unknown as Record<string, unknown> | undefined
    // Reduced DSH remotes may throw while resolving namespaces or methods.
    const pickNs = (name: string): Record<string, unknown> | undefined => {
      try {
        const v = remoteAny?.[name] ?? undefined
        return (typeof v === 'object' && v !== null ? v : undefined) as Record<string, unknown> | undefined
      } catch {
        return undefined
      }
    }
    const remoteLlm = pickNs('llm')
    const remoteSettings = pickNs('settings')
    const remoteSession = pickNs('session')
    const pickMethod = (ns: Record<string, unknown> | undefined, name: string): (() => Promise<unknown>) | undefined => {
      try {
        const method = ns?.[name]
        return typeof method === 'function' ? (method as () => Promise<unknown>).bind(ns) : undefined
      } catch {
        return undefined
      }
    }
    const listProviders = pickMethod(remoteLlm, 'listProviders')
    const listConfigurableProviders = pickMethod(remoteLlm, 'listConfigurableProviders')
    const hasTypertProviders = listProviders !== undefined || listConfigurableProviders !== undefined

    const providersPromise = (async (): Promise<unknown> => {
      if (hasTypertProviders) {
        // Either face may be absent on a given host; fetch whichever exists.
        // A carrier rejection on one side degrades to the other side instead
        // of failing the whole load — the dropdown needs rows, not both.
        const [registeredOutcome, directoryOutcome] = await Promise.all([
          listProviders ? settle(listProviders()) : Promise.resolve({ ok: false as const }),
          listConfigurableProviders ? settle(listConfigurableProviders()) : Promise.resolve({ ok: false as const }),
        ])
        // A business rejection ({ok:false} envelope) throws here with the
        // wire message; a carrier rejection was already folded to {ok:false}
        // by settle and degrades to the surviving side.
        const registered = registeredOutcome.ok ? unwrapRemoteResult(registeredOutcome.value) : undefined
        const directory = directoryOutcome.ok ? unwrapRemoteResult(directoryOutcome.value) : undefined
        if (registered === undefined && directory === undefined) {
          throw new Error('provider directory unavailable')
        }
        return joinProviderDirectory(registered ?? [], directory ?? [])
      }
      // Legacy envelope path (older hosts)
      const legacyProviders = (this.api as CatalogApiFace | undefined)?.llm?.providers
      if (typeof legacyProviders !== 'function') throw new Error('no provider face')
      const raw = await legacyProviders.call((this.api as CatalogApiFace).llm, {})
      return unwrapRpc(raw)
    })()

    const modelsPromise = (async (): Promise<unknown> => {
      // Try legacy first — still served in many profiles
      try {
        const legacyModels = (this.api as CatalogApiFace | undefined)?.llm?.models
        if (typeof legacyModels !== 'function') throw new Error('no legacy models face')
        const raw = await legacyModels.call((this.api as CatalogApiFace).llm, {})
        return unwrapRpc(raw)
      } catch {}
      // Typert session catalog: same {groups} shape as the retired bulk
      // llm.models, served by the Plugins-tab-native face — reachable on
      // pages where the legacy RPC never existed.
      try {
        const modelCatalog = pickMethod(remoteSession, 'modelCatalog')
        if (!modelCatalog) throw new Error('no session catalog face')
        return unwrapRemoteResult(await modelCatalog())
      } catch {}
      // No Typert bulk models API (0.1.2 serves per-namespace discoverModels);
      // the settings.describe synthesis below covers the dropdown instead.
      return { groups: [] }
    })()

    const settingsPromise = (async (): Promise<unknown> => {
      const describe = pickMethod(remoteSettings, 'describe')
      if (describe) {
        // Typert face: RemoteResult envelope, unwrap before reading namespaces.
        return unwrapRemoteResult(await describe())
      }
      if (this.api.settings?.describe !== undefined) {
        const raw = await this.api.settings.describe({})
        return unwrapRpc(raw)
      }
      throw new Error('no settings face')
    })()

    const [providersOutcome, modelsOutcome, settingsOutcome] = await Promise.all([
      settle(providersPromise),
      settle(modelsPromise),
      settle(settingsPromise),
    ])
    if (generation !== this.generation) return
    let providers: CatalogProvider[]
    if (!providersOutcome.ok) {
      this.markUnavailable()
      return
    }
    try {
      providers = pickProviders(providersOutcome.value)
    } catch {
      this.markUnavailable()
      return
    }
    let modelsByProvider: Record<string, CatalogModel[]> = {}
    if (modelsOutcome.ok) {
      try {
        modelsByProvider = pickModelsByProvider(modelsOutcome.value)
      } catch {
        modelsByProvider = {}
      }
    }
    // Capture namespaces for both configured enrichment and model synthesis fallback
    let describedNamespaces: Array<{ ns?: unknown; value?: unknown }> = []
    if (settingsOutcome.ok) {
      try {
        const described = settingsOutcome.value as { namespaces?: unknown }
        const namespaces = Array.isArray(described?.namespaces) ? described.namespaces : []
        describedNamespaces = namespaces.map((n) => {
          const r = asRecord(n)
          return { ns: r?.ns, value: r?.value }
        })
        providers = attachConfigured(providers, describedNamespaces)
      } catch {
        // Keep configured undefined — flat list, no grouping.
      }
    }
    // Fallback: when bulk llm.models is unavailable (DSH 0.1.2+ removed it),
    // synthesize modelsByProvider from settings.describe values (e.g. llm-pi-ai.providers[].models)
    if (Object.keys(modelsByProvider).length === 0 && describedNamespaces.length > 0) {
      try {
        const synth: Record<string, CatalogModel[]> = {}
        for (const { value } of describedNamespaces) {
          const root = asRecord(value)
          if (root === undefined) continue
          // Most llm plugins expose { providers: [{ id|provider, models: [{id,name}]}] }
          const provs = Array.isArray(root.providers) ? root.providers : []
          for (const pr of provs) {
            const prRec = asRecord(pr)
            if (prRec === undefined) continue
            const pid =
              typeof prRec.provider === 'string' && prRec.provider !== ''
                ? prRec.provider
                : typeof prRec.id === 'string' && prRec.id !== ''
                  ? prRec.id
                  : ''
            if (pid === '') continue
            const rawModels = Array.isArray(prRec.models) ? prRec.models : []
            const parsed: CatalogModel[] = []
            for (const m of rawModels) {
              if (typeof m === 'string' && m !== '') {
                parsed.push({ id: m })
                continue
              }
              const mr = asRecord(m)
              if (mr === undefined || typeof mr.id !== 'string' || mr.id === '') continue
              parsed.push({ id: mr.id, ...(typeof mr.name === 'string' && mr.name !== '' ? { name: mr.name } : {}) })
            }
            if (parsed.length === 0) continue
            if (synth[pid] === undefined) synth[pid] = []
            const seen = new Set(synth[pid]!.map((x) => x.id))
            for (const pm of parsed) if (!seen.has(pm.id)) { synth[pid]!.push(pm); seen.add(pm.id) }
          }
        }
        if (Object.keys(synth).length > 0) modelsByProvider = synth
      } catch {
        // keep empty
      }
    }
    this.set({ status: 'ready', providers, modelsByProvider })
  }

  /**
   * Keep last good rows across a failed refresh; the card falls back to
   * free-text inputs only when the snapshot holds no providers at all.
   *
   * A provider-less failure is the user-visible breakage (every dropdown
   * degrades to a text box), so it warns loudly instead of failing silent
   * like the models/settings enrichments below it.
   */
  private markUnavailable(): void {
    if (this.snapshot.providers.length === 0) {
      console.warn('[model-proxy] provider catalog unavailable — dropdowns fall back to free-text inputs')
    }
    this.set({ ...this.snapshot, status: 'unavailable' })
  }

  private set(snapshot: CatalogSnapshot): void {
    this.snapshot = snapshot
    for (const listener of [...this.listeners]) listener()
  }
}
