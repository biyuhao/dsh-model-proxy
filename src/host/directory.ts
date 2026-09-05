/**
 * Host-side directory mirror: pure computation over the llm registry and the
 * settings document. Kept free of Cordis so `node --test` can exercise it
 * without a host. The caller (src/host/index.ts) supplies faces, subscribes
 * to `llm/adapters-updated` + `settings/document-updated`, and persists via
 * `settings.update` with a deep-equal guard (see catalogsEqual).
 *
 * Only ids and display names cross into the mirror — provider profiles may
 * carry secrets (api keys), which stay host-side. Malformed rows are skipped,
 * never fatal: the card degrades to whatever is parseable.
 */

import type { DirectoryCatalog, DirectoryModel, DirectoryProvider } from './config.js'

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

/** Minimal structural face of the host llm service used by the mirror. */
export type LlmDirectoryFace = {
  listProviders?(): unknown
  listConfigurableProviders?(): unknown
}

/**
 * Join live routes with the configurable directory, mirroring the built-in
 * Models page: declared directory rows first (in declaration order, `active`
 * derived from live membership), then live-only routes appended.
 *
 * - `registered`: live routes (`{ id, name }`).
 * - `directory`: configurable providers (`{ provider, displayName, … }`).
 *
 * Either side may be absent/malformed (older hosts, booting registries); the
 * join degrades to whatever side parses instead of blanking the dropdown.
 */
export function joinDirectoryProviders(registered: unknown, directory: unknown): DirectoryProvider[] {
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
  const out: DirectoryProvider[] = []
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
          : undefined
    const entry: DirectoryProvider = { provider, active: liveById.has(provider) }
    if (displayName !== undefined) entry.displayName = displayName
    out.push(entry)
  }
  for (const [id, name] of liveById) {
    if (declaredIds.has(id)) continue
    const liveOnly: DirectoryProvider = { provider: id, active: true }
    if (name !== id) liveOnly.displayName = name
    out.push(liveOnly)
  }
  return out
}

/**
 * Synthesize per-provider model rows from settings namespace values. Most
 * llm plugins expose `{ providers: [{ id|provider, models: [{id,name}|id] }] }`
 * inside their section value; string model entries are accepted as bare ids.
 * Providers with no parseable models are omitted (the card falls back to
 * free text / `*` for those).
 */
export function synthesizeDirectoryModels(namespaces: ReadonlyArray<{ value?: unknown }>): Array<{ provider: string; models: DirectoryModel[] }> {
  const synth = new Map<string, DirectoryModel[]>()
  for (const { value } of namespaces) {
    const root = asRecord(value)
    if (root === undefined) continue
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
      const parsed: DirectoryModel[] = []
      for (const m of rawModels) {
        if (typeof m === 'string' && m !== '') {
          parsed.push({ id: m })
          continue
        }
        const mr = asRecord(m)
        if (mr === undefined || typeof mr.id !== 'string' || mr.id === '') continue
        const entry: DirectoryModel = { id: mr.id }
        if (typeof mr.name === 'string' && mr.name !== '') entry.name = mr.name
        parsed.push(entry)
      }
      if (parsed.length === 0) continue
      const acc = synth.get(pid) ?? []
      const seen = new Set(acc.map((x) => x.id))
      for (const pm of parsed) {
        if (!seen.has(pm.id)) {
          acc.push(pm)
          seen.add(pm.id)
        }
      }
      synth.set(pid, acc)
    }
  }
  return [...synth].map(([provider, models]) => ({ provider, models }))
}

/**
 * Compute the full mirror snapshot. Every face is optional and every throw
 * degrades to empty: a booting registry or an undescribed document must never
 * fail the mirror pass — the next trigger recomputes.
 */
export function computeDirectoryCatalog(
  llm: LlmDirectoryFace | undefined,
  namespaces: ReadonlyArray<{ ns?: unknown; value?: unknown }>,
): DirectoryCatalog {
  let registered: unknown = []
  let directory: unknown = []
  try {
    const v = llm?.listProviders?.()
    if (v !== undefined) registered = v
  } catch { /* keep empty */ }
  try {
    const v = llm?.listConfigurableProviders?.()
    if (v !== undefined) directory = v
  } catch { /* keep empty */ }
  const providers = joinDirectoryProviders(registered, directory)
  let models: Array<{ provider: string; models: DirectoryModel[] }> = []
  try {
    models = synthesizeDirectoryModels(namespaces)
  } catch { /* keep empty */ }
  return { providers, models }
}

/** Deep-equal guard so mirror writes never loop: unchanged means no write. */
export function catalogsEqual(a: DirectoryCatalog | undefined, b: DirectoryCatalog | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}
