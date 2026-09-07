import { useCallback, useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import type { CatalogProvider, CatalogSnapshot, DirectoryMirror } from './catalog.js'
import { ProviderCatalogStore, mirrorModelsToMap } from './catalog.js'
import type { ModelProxyController, ModelProxyConfig, ProxyRule } from './controller.js'
import { buildCreatorRules, ensureRuleIds, groupByProvider, makeRuleId } from './controller.js'
import { en } from './locales.js'

// ---------------------------------------------------------------------------
// Design-system alignment for DSH 0.1.2-alpha.3
// ---------------------------------------------------------------------------
// DSH switched from ad-hoc #ccc/#ddd borders to the DSW alias tokens
// (var(--dsw-alias-border-l2) etc). Native <select>/<input> without the
// token classes now looks "失效" — wrong background/border in dark mode and
// missing custom dropdown arrow. Mirror the token-based styling used by
// ui-settings-models (Be6O7G_input / Be6O7G_selectInput) and
// ui-settings-plugins (fields.module.css) so the card feels native.
//
// We inject a single <style> tag keyed by plugin id, like DSH's own
// css modules do (query by data-plugin-css to stay idempotent across HMR).
const MP_CSS = `
.mp_input,.mp_select{
  box-sizing:border-box;
  border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-layer-3);
  color:var(--dsw-alias-label-primary);
  border-radius:8px;
  height:32px;
  font:inherit;
  font-size:13px;
  line-height:1.5;
  padding:0 10px;
  width:100%;
}
.mp_select{
  appearance:none;
  cursor:pointer;
  padding-right:32px;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-position:right 10px center;
  background-repeat:no-repeat;
  background-size:12px 12px;
}
.mp_input:focus,.mp_select:focus{
  border-color:var(--dsw-alias-brand-primary);
  outline:none;
}
.mp_input:disabled,.mp_select:disabled{
  opacity:.6;
  cursor:default;
}
.mp_input::placeholder{
  color:var(--dsw-alias-label-dimmed);
}
.mp_inputInvalid{
  border-color:var(--dsw-alias-label-error) !important;
}
.mp_btnSecondary{
  box-sizing:border-box;
  height:28px;
  padding:0 10px;
  border-radius:8px;
  border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-layer-3);
  color:var(--dsw-alias-label-primary);
  font:inherit;
  font-size:12px;
  line-height:1.5;
  cursor:pointer;
  display:inline-flex;
  align-items:center;
  justify-content:center;
  gap:4px;
}
.mp_btnSecondary:hover:not(:disabled){
  background:var(--dsw-alias-interactive-bg-hover);
  border-color:var(--dsw-alias-label-dimmed);
}
.mp_btnSecondary:disabled{opacity:.4;cursor:default;}
.mp_btnSecondary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}
.mp_btnPrimary{
  box-sizing:border-box;
  height:32px;
  padding:0 14px;
  border-radius:8px;
  border:1px solid transparent;
  background:var(--dsw-alias-label-primary);
  color:var(--dsw-alias-bg-layer-3);
  font:inherit;
  font-size:13px;
  line-height:1.5;
  cursor:pointer;
  display:inline-flex;
  align-items:center;
  justify-content:center;
}
.mp_btnPrimary:disabled{opacity:.4;cursor:default;}
.mp_btnPrimary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}
.mp_card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:10px;display:flex;flex-direction:column;gap:8px;background:var(--dsw-alias-bg-layer-3);}
.mp_ruleCard{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px;display:grid;grid-template-columns:1fr 1fr;gap:8px;background:var(--dsw-alias-bg-layer-3);}
.mp_ruleCardDisabled{background:var(--dsw-alias-bg-module-platform);}
.mp_ruleCardInvalid{border-color:var(--dsw-alias-label-error);}
.mp_creator{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:8px;background:var(--dsw-alias-bg-module-platform);}
.mp_proxyWrap{position:relative;display:flex;align-items:center;padding:0 10px;overflow:hidden;}
.mp_proxyInput{flex:1;min-width:0;width:100%;border:none;background:transparent;color:inherit;font:inherit;font-size:13px;line-height:1.5;padding:0;height:100%;outline:none;}
.mp_proxyInput::placeholder{color:var(--dsw-alias-label-dimmed);}
.mp_proxyInput:disabled{opacity:.6;cursor:default;}
.mp_ghost{position:absolute;left:10px;top:0;bottom:0;display:flex;align-items:center;overflow:hidden;white-space:nowrap;pointer-events:none;font:inherit;font-size:13px;line-height:1.5;}
.mp_ghostHidden{visibility:hidden;}
.mp_ghostSuffix{color:var(--dsw-alias-label-dimmed);}
`
const MP_CSS_TAG_ID = 'dsh-plugin-model-proxy/card.css'
if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${MP_CSS_TAG_ID}"]`) === null) {
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-plugin-model-proxy'
  tag.dataset.pluginCss = MP_CSS_TAG_ID
  tag.textContent = MP_CSS
  document.head.appendChild(tag)
}

type Props = {
  controller: ModelProxyController
  /** Live provider/model catalog; absent or empty falls back to free text. */
  catalog?: ProviderCatalogStore
  t?: (k: keyof typeof en) => string
}

const NO_CATALOG: CatalogSnapshot = { status: 'idle', providers: [], modelsByProvider: {} }

/** Sentinel <option> that flips a field into free-text mode (never stored). */
const CUSTOM_SENTINEL = '__custom__'

type FieldOption = { value: string; label: string }

/** Rendered shape of one <optgroup>; label undefined renders a flat list. */
type FieldGroup = { label?: string; options: FieldOption[] }

/**
 * One rule field rendered as a dropdown over catalog options with a
 * "Custom…" escape hatch into free text.
 *
 * Mode is derived, not synced: an existing value absent from the options
 * (hand-written yaml rule, wildcard pattern) opens in custom mode; picking
 * the sentinel option enters custom mode without touching the value; the
 * ▾ button returns to the list. When no options exist at all (catalog
 * unloaded/unavailable/empty) only the text input renders.
 */
function CatalogField(props: {
  value: string
  groups: FieldGroup[]
  onChange: (value: string) => void
  disabled: boolean
  chooseLabel: string
  customLabel: string
  listTitle: string
  inputPlaceholder: string
}) {
  const { value, groups, onChange, disabled, chooseLabel, customLabel, listTitle, inputPlaceholder } = props
  const [customMode, setCustomMode] = useState(() => value !== '' && !groups.some((g) => g.options.some((o) => o.value === value)))
  const flat = groups.flatMap((g) => g.options)
  const showSelect = flat.length > 0 && !customMode
  // 目录异步到达后，若已有值在选项中则自动退回下拉，避免首帧空 groups 导致已存规则一直停留在输入框
  useEffect(() => {
    if (customMode && flat.some((o) => o.value === value)) setCustomMode(false)
  }, [flat, value, customMode])

  if (flat.length === 0) {
    return (
      <input
        value={value}
        placeholder={inputPlaceholder}
        onChange={(e) => onChange(e.target.value)}
        className="mp_input"
        style={{ width: '100%' }}
        disabled={disabled}
      />
    )
  }

  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
      {showSelect ? (
        <select
          value={flat.some((o) => o.value === value) ? value : ''}
          onChange={(e) => {
            if (e.target.value === CUSTOM_SENTINEL) {
              setCustomMode(true)
              return
            }
            onChange(e.target.value)
          }}
          className="mp_select"
          style={{ flex: 1, minWidth: 0 }}
          disabled={disabled}
        >
          {!flat.some((o) => o.value === value) && <option value="">{chooseLabel}</option>}
          {groups.map((g, gi) =>
            g.label === undefined ? (
              g.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)
            ) : (
              <optgroup key={`${gi}:${g.label}`} label={g.label}>
                {g.options.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </optgroup>
            ),
          )}
          <option value={CUSTOM_SENTINEL}>{customLabel}</option>
        </select>
      ) : (
        <>
          <input
            value={value}
            placeholder={inputPlaceholder}
            onChange={(e) => onChange(e.target.value)}
            className="mp_input"
            style={{ flex: 1, minWidth: 0 }}
            disabled={disabled}
          />
          <button
            type="button"
            title={listTitle}
            onClick={() => setCustomMode(false)}
            disabled={disabled}
            className="mp_btnSecondary"
            style={{ width: 32, padding: 0, flex: 'none' }}
          >
            ▾
          </button>
        </>
      )}
    </div>
  )
}

/** Keep in sync with SUPPORTED_SCHEMES in src/host/config.ts. */
const SUPPORTED_SCHEMES = ['http:', 'https:', 'socks5:', 'socks5h:', 'socks:']

/** One-click starting points so socks5/http prefixes are never typed by hand. */
const PROXY_PRESETS = [
  'socks5://127.0.0.1:1080',
  'socks5h://127.0.0.1:1080',
  'http://127.0.0.1:7890',
  'http://127.0.0.1:8080',
]

/**
 * Merge the user's own in-use URLs ahead of the built-in presets, deduped.
 * Own URLs first: the ghost prefers what this config already uses.
 */
function mergeProxySuggestions(used: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const u of [...used, ...PROXY_PRESETS]) {
    const v = u.trim()
    if (v === '' || seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out
}

/**
 * Proxy URL field with inline ghost completion.
 *
 * The grey example text no longer vanishes on first keystroke: while the
 * typed value is a (case-insensitive) prefix of a known candidate, the
 * remainder stays rendered in dimmed grey behind the caret. Tab (or → at
 * end of input) accepts it; a native datalist keeps every candidate
 * one click away.
 */
function ProxyUrlInput(props: {
  value: string
  onChange: (value: string) => void
  placeholder: string
  disabled: boolean
  invalid?: boolean
  ghostHint: string
  suggestions: readonly string[]
  wrapStyle?: CSSProperties
  onEnter?: (value: string) => void
}) {
  const { value, onChange, placeholder, disabled, invalid, ghostHint, suggestions, wrapStyle, onEnter } = props
  const listId = useId()
  const ghost = useMemo(() => {
    if (value === '') return ''
    const lower = value.toLowerCase()
    for (const cand of suggestions) {
      if (cand.length > value.length && cand.toLowerCase().startsWith(lower)) return cand.slice(value.length)
    }
    return ''
  }, [value, suggestions])

  return (
    <div className={`mp_input mp_proxyWrap ${invalid ? 'mp_inputInvalid' : ''}`} style={wrapStyle}>
      <div aria-hidden="true" className="mp_ghost">
        <span className="mp_ghostHidden">{value}</span>
        {ghost !== '' && <span className="mp_ghostSuffix">{ghost}</span>}
      </div>
      <input
        value={value}
        placeholder={placeholder}
        title={ghostHint}
        list={listId}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Tab' && ghost !== '' && !disabled) {
            e.preventDefault()
            onChange(value + ghost)
            return
          }
          if (e.key === 'ArrowRight' && ghost !== '' && !disabled) {
            const el = e.currentTarget
            if (el.selectionStart === value.length && el.selectionEnd === value.length) {
              e.preventDefault()
              onChange(value + ghost)
              return
            }
          }
          if (e.key === 'Enter' && onEnter !== undefined) onEnter(value.trim())
        }}
        className="mp_proxyInput"
        disabled={disabled}
      />
      <datalist id={listId}>
        {suggestions.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </div>
  )
}

const SHOW_UNCONFIGURED_KEY = 'dsh-model-proxy:showUnconfigured'

/** One provider row with the two signals driving dropdown visibility. */
type ProviderRow = {
  option: FieldOption
  /** Live route right now; false renders with the dormant suffix. */
  active: boolean
  /** Explicitly user-configured via settings; undefined when unknown. */
  configured?: boolean
}

/** A row stays visible when it is live or explicitly configured. */
function isProviderRowVisible(r: ProviderRow): boolean {
  return r.active || r.configured === true
}

/**
 * Normalize catalog providers (mirror fallback included) into wire-order
 * rows. `grouped` reports whether the configured enrichment is known.
 */
function collectProviderRows(
  providers: CatalogProvider[],
  mirror: DirectoryMirror | undefined,
  t: (k: keyof typeof en) => string,
): { grouped: boolean; rows: ProviderRow[] } {
  if (providers.length > 0) {
    return {
      grouped: providers.some((p) => p.configured !== undefined),
      rows: providers.map((p) => ({
        option: {
          value: p.provider,
          label: p.displayName === p.provider ? p.provider : `${p.displayName} (${p.provider})${p.active ? '' : ` · ${t('dormant')}`}`,
        },
        active: p.active,
        configured: p.configured,
      })),
    }
  }
  const rows: ProviderRow[] = (mirror?.providers ?? [])
    .filter((p) => typeof p.provider === 'string' && p.provider !== '')
    .map((p) => {
      const base = p.displayName !== undefined && p.displayName !== '' && p.displayName !== p.provider
        ? `${p.displayName} (${p.provider})`
        : p.provider
      const active = p.active !== false
      return { option: { value: p.provider, label: active ? base : `${base} · ${t('dormant')}` }, active }
    })
  return { grouped: false, rows }
}

function toFieldGroup(label: string, rows: ProviderRow[]): FieldGroup[] {
  return rows.length > 0 ? [{ label, options: rows.map((r) => r.option) }] : []
}

/**
 * Derive the dropdown groups in one pass. Rows that are neither live nor
 * explicitly configured hide by default — exactly the rows carrying the
 * dormant suffix. Either signal keeps a row visible: live routes work right
 * now, configured rows belong to the user. Hiding degrades to show-all when
 * it would empty the list. A selected-but-hidden value always renders, so
 * the select never drops back to the placeholder and reads as a lost
 * choice. Custom… covers anything not listed at all.
 */
function resolveProviderGroups(
  rows: ProviderRow[],
  grouped: boolean,
  selected: string,
  showUnconfigured: boolean,
  t: (k: keyof typeof en) => string,
): { groups: FieldGroup[]; hiddenCount: number; canHide: boolean } {
  const hiddenCount = rows.filter((r) => !isProviderRowVisible(r)).length
  const canHide = hiddenCount > 0 && hiddenCount < rows.length
  const scope = !canHide || showUnconfigured
    ? rows
    : rows.filter((r) => isProviderRowVisible(r) || (selected !== '' && r.option.value === selected))
  const groups = grouped
    ? [
        ...toFieldGroup(t('groupConfigured'), scope.filter((r) => r.configured === true)),
        ...toFieldGroup(t('groupDirectory'), scope.filter((r) => r.configured !== true)),
      ]
    : [{ options: scope.map((r) => r.option) }]
  return { groups, hiddenCount, canHide }
}

/** Draft state of the batch-add panel: one spec fanned out over N models. */
type CreatorState = {
  provider: string
  checked: string[]
  customPattern: string
  proxyUrl: string
  purpose: string
  credentialRef: string
}

const EMPTY_CREATOR: CreatorState = {
  provider: '',
  checked: [],
  customPattern: '',
  proxyUrl: '',
  purpose: '',
  credentialRef: '',
}

function validateUrl(urlStr: string): string | undefined {
  try {
    const u = new URL(urlStr)
    if (!SUPPORTED_SCHEMES.includes(u.protocol)) return 'unsupported scheme'
    if (!u.hostname) return 'missing host'
    return undefined
  } catch {
    return 'invalid URL'
  }
}

function validateRule(r: ProxyRule, all: ProxyRule[]): string | undefined {
  if (r.provider !== r.provider.trim()) return 'whitespace around provider'
  if (r.model !== r.model.trim()) return 'whitespace around model'
  if (r.purpose !== undefined && r.purpose !== '' && r.purpose !== r.purpose.trim()) return 'whitespace around purpose'
  if (r.credentialRef !== undefined && r.credentialRef !== '') {
    // A ref is a bare entry name: no whitespace anywhere, and never a URL.
    if (r.credentialRef !== r.credentialRef.trim()) return 'whitespace around credential ref'
    if (/\s/.test(r.credentialRef)) return 'whitespace in credential ref'
    if (r.credentialRef.includes('://')) return 'credential ref is not a URL'
  }
  if (!r.provider.trim()) return 'provider required'
  if (!r.model.trim()) return 'model required'
  // prefix patterns allow a single trailing '*' only (mirror host assertServiceable)
  const starCount = (r.model.match(/\*/g) ?? []).length
  const isBareWildcard = r.model === '*'
  if (!isBareWildcard && starCount > 0 && !(starCount === 1 && r.model.endsWith('*'))) {
    return 'at most one trailing * (e.g. "vendor-*")'
  }
  if (r.proxyUrl !== '') {
    const err = validateUrl(r.proxyUrl)
    if (err) return err
  }
  const dup = all.filter(x => x.provider === r.provider && x.model === r.model).length > 1
  if (dup) return 'duplicate'
  return undefined
}

/** Mirrors host assertServiceable for defaultProxy so bad values never reach the wire. */
export function validateDefaultProxy(defaultProxy: string): string | undefined {
  if (defaultProxy === '') return undefined
  return validateUrl(defaultProxy)
}

/**
 * Header of one provider group: identity, shared-fields bulk actions, and a
 * two-step destructive delete. The proxy input applies to every member rule;
 * matching semantics are untouched because cross-provider reordering never
 * influences resolution.
 */
function GroupHeader(props: {
  provider: string
  displayName: string
  count: number
  allEnabled: boolean
  disabled: boolean
  t: (k: keyof typeof en) => string
  proxySuggestions: readonly string[]
  onApplyProxy(url: string): void
  onSetEnabled(enabled: boolean): void
  onDelete(): void
}) {
  const { provider, displayName, count, allEnabled, disabled, t, proxySuggestions, onApplyProxy, onSetEnabled, onDelete } = props
  const [proxy, setProxy] = useState('')
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    if (!confirming) return
    const timer = setTimeout(() => setConfirming(false), 3000)
    return () => clearTimeout(timer)
  }, [confirming])

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
      <span style={{ fontWeight: 700, color: 'var(--dsw-alias-label-primary)' }}>
        {displayName === provider ? provider : `${displayName} · ${provider}`}
        <span style={{ fontWeight: 400, opacity: 0.6, marginLeft: 6 }}>{count}</span>
      </span>
      <span style={{ flex: 1 }} />
      <ProxyUrlInput
        value={proxy}
        onChange={setProxy}
        placeholder={t('groupApplyProxy')}
        disabled={disabled}
        ghostHint={t('proxyGhostHint')}
        suggestions={proxySuggestions}
        wrapStyle={{ width: 220, flex: 'none' }}
        onEnter={(v) => onApplyProxy(v)}
      />
      <button type="button" onClick={() => onApplyProxy(proxy.trim())} disabled={disabled || proxy.trim() === ''}
        className="mp_btnSecondary">
        {t('groupApply')}
      </button>
      <button type="button" onClick={() => onSetEnabled(!allEnabled)} disabled={disabled} className="mp_btnSecondary">
        {allEnabled ? t('groupDisableAll') : t('groupEnableAll')}
      </button>
      <button
        type="button"
        onClick={() => {
          if (confirming) {
            setConfirming(false)
            onDelete()
          } else {
            setConfirming(true)
          }
        }}
        disabled={disabled}
        className="mp_btnSecondary"
        style={{
          borderColor: confirming ? 'var(--dsw-alias-state-error-primary)' : undefined,
          color: confirming ? 'var(--dsw-alias-state-error-primary)' : undefined,
        }}
      >
        {confirming ? t('groupConfirmDelete') : t('groupDelete')}
      </button>
    </div>
  )
}

const smallButtonStyle: CSSProperties = {
  padding: '4px 8px',
  borderRadius: 6,
  border: '1px solid #ddd',
  background: '#fff',
  cursor: 'pointer',
  lineHeight: 1,
}

export function ModelProxyCard({ controller, catalog, t: tProp }: Props) {
  const t = tProp ?? ((k: keyof typeof en) => en[k])
  const snap = useSyncExternalStore(
    (cb) => controller.subscribe(cb),
    () => controller.getSnapshot(),
    () => controller.getSnapshot(),
  )
  const cat = useSyncExternalStore(
    useCallback((cb: () => void) => (catalog ? catalog.subscribe(cb) : () => undefined), [catalog]),
    useCallback(() => catalog?.getSnapshot() ?? NO_CATALOG, [catalog]),
    useCallback(() => catalog?.getSnapshot() ?? NO_CATALOG, [catalog]),
  )

  const cfg: ModelProxyConfig = useMemo(() => {
    // The host-computed directory mirror rides the same snapshot but is NOT
    // editable state: strip it before ensureRuleIds/draft/dirty/save so
    // mirror refreshes never fake a local edit or ride a save.
    const raw = snap.value ?? {
      enabled: true,
      rules: [],
      defaultProxy: '',
      debug: false,
    }
    const { catalog: _mirror, ...editable } = raw
    return ensureRuleIds(editable)
  }, [snap.value])

  // Directory mirror fallback for pages without the cross-namespace Typert
  // remotes. Remote rows always win; mirror rows only fill gaps.
  const mirror = snap.value?.catalog
  const mirrorModelMap = useMemo(() => mirrorModelsToMap(mirror), [mirror])

  const [draft, setDraft] = useState<ModelProxyConfig>(cfg)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | undefined>()

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(cfg), [draft, cfg])

  // Sync remote → draft only while the user has NO local edits. Re-syncing on
  // every cfg change (e.g. the intermediate snapshots produced while a save's
  // field writes settle) would clobber in-progress editing mid-save.
  useEffect(() => {
    if (!dirty) setDraft(cfg)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg])

  // Auto-clear "saved" feedback; clear pending timer on unmount/save restart.
  useEffect(() => {
    if (!msg || msg !== t('saved')) return
    const timer = setTimeout(() => setMsg(undefined), 1500)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msg])

  const defaultProxyError = useMemo(() => validateDefaultProxy(draft.defaultProxy), [draft.defaultProxy])

  // Unconfigured rows hide by default so the dropdown stays one click.
  // The choice persists in localStorage.
  const [showUnconfigured, setShowUnconfigured] = useState(() => {
    try {
      return typeof localStorage !== 'undefined' && localStorage.getItem(SHOW_UNCONFIGURED_KEY) === '1'
    } catch {
      return false
    }
  })

  // Dropdown rows from the live provider catalog (mirror fallback included),
  // in wire order. Dormant routes stay reachable because rules may pre-date
  // their adapter.
  const providerRows = useMemo(() => collectProviderRows(cat.providers, mirror, t), [cat, t, mirror])
  // Purpose filter options. `GenerateOptions.purpose` is a closed union in
  // dsh-llm (`'compaction' | 'session-title'`; ordinary chats leave it
  // unset), so a dropdown replaces hand-typing. Empty string = match all and
  // is itself a selectable option; Custom… keeps forward-compat with future
  // purposes and hand-written yaml rules carrying unknown values.
  const purposeGroups: FieldGroup[] = useMemo(
    () => [
      {
        options: [
          { value: '', label: t('purposeAll') },
          { value: 'compaction', label: 'compaction' },
          { value: 'session-title', label: 'session-title' },
        ],
      },
    ],
    [t],
  )
  const modelOptionsFor = useCallback(
    (provider: string): FieldOption[] => {
      const remote = cat.modelsByProvider[provider] ?? []
      const models = remote.length > 0 ? remote : (mirrorModelMap[provider] ?? [])
      if (models.length === 0) return []
      const wildcard: FieldOption = { value: '*', label: `* (${t('wildcardAll')})` }
      return [
        ...(models.some((m) => m.id === '*') ? [] : [wildcard]),
        ...models.map((m) => ({ value: m.id, label: m.name && m.name !== m.id ? `${m.name} (${m.id})` : m.id })),
      ]
    },
    [cat, t, mirrorModelMap],
  )
  const mirrorProviderCount = (mirror?.providers ?? []).filter((p) => typeof p?.provider === 'string' && p.provider !== '').length
  const catalogMissing =
    catalog !== undefined && cat.status === 'unavailable' && cat.providers.length === 0 && mirrorProviderCount === 0
  // Providers loaded but no model rows anywhere: every Model field is a text
  // box by design, so say so instead of looking like a broken dropdown.
  const modelsMissing =
    catalog !== undefined && cat.status === 'ready' && cat.providers.length + mirrorProviderCount > 0 &&
    Object.keys(cat.modelsByProvider).length === 0 && Object.keys(mirrorModelMap).length === 0

  const onSave = useCallback(async () => {
    // local validation before write — mirror the host's assertServiceable so
    // rejections surface inline instead of as partial commits
    for (const r of draft.rules) {
      const err = validateRule(r, draft.rules)
      if (err) {
        setMsg(t('invalid'))
        return
      }
    }
    if (defaultProxyError) {
      setMsg(t('invalid'))
      return
    }
    setSaving(true)
    setMsg(undefined)
    try {
      await controller.save(draft)
      setMsg(t('saved'))
    } catch (e) {
      setMsg(String(e))
    } finally {
      setSaving(false)
    }
  }, [draft, controller, t, defaultProxyError])

  const setField = useCallback(
    (patch: Partial<ModelProxyConfig>) => setDraft((d) => ({ ...d, ...patch })),
    [],
  )

  const [creatorOpen, setCreatorOpen] = useState(false)
  const [creator, setCreator] = useState<CreatorState>(EMPTY_CREATOR)
  const [creatorError, setCreatorError] = useState<string | undefined>()

  // Final dropdown groups: visibility, toggle counts, and selected-value
  // retention resolve together in one pass.
  const {
    groups: providerGroups,
    hiddenCount,
    canHide: canHideUnconfigured,
  } = useMemo(
    () => resolveProviderGroups(providerRows.rows, providerRows.grouped, creator.provider, showUnconfigured, t),
    [providerRows, creator.provider, showUnconfigured, t],
  )

  // Ghost-completion candidates for every proxy URL field: URLs already used
  // across this draft first, then the built-in presets.
  const proxySuggestions = useMemo(
    () => mergeProxySuggestions([...draft.rules.map((r) => r.proxyUrl), draft.defaultProxy]),
    [draft.rules, draft.defaultProxy],
  )

  const setCreatorField = useCallback(
    (patch: Partial<CreatorState>) => setCreator((c) => ({ ...c, ...patch })),
    [],
  )

  // Whether draft.rules already covers provider+model — such checkboxes are
  // disabled so batch creation can never produce a duplicate-rule rejection.
  const ruleExists = useCallback(
    (provider: string, model: string) => draft.rules.some((r) => r.provider === provider && r.model === model),
    [draft.rules],
  )

  const creatorModelCount = useMemo(() => {
    if (creator.provider.trim() === '') return 0
    const custom = creator.customPattern.trim()
    return creator.checked.length + (custom !== '' ? 1 : 0)
  }, [creator])

  const createRules = useCallback(() => {
    const models = [...creator.checked]
    const custom = creator.customPattern.trim()
    if (custom !== '') models.push(custom)
    const newRules = buildCreatorRules({
      provider: creator.provider,
      models,
      proxyUrl: creator.proxyUrl,
      purpose: creator.purpose,
      credentialRef: creator.credentialRef,
      enabled: true,
    })
    const combined = [...newRules, ...draft.rules]
    for (const r of newRules) {
      const err = validateRule(r, combined)
      if (err) {
        setCreatorError(err === 'duplicate' ? t('duplicate') : err)
        return
      }
    }
    setDraft((d) => ({ ...d, rules: [...newRules, ...d.rules] }))
    setCreator(EMPTY_CREATOR)
    setCreatorError(undefined)
    setCreatorOpen(false)
  }, [creator, draft.rules, t])

  const applyGroupProxy = useCallback((provider: string, url: string) => {
    setDraft((d) => ({
      ...d,
      rules: d.rules.map((r) => (r.provider === provider ? { ...r, proxyUrl: url } : r)),
    }))
  }, [])

  const setGroupEnabled = useCallback((provider: string, enabled: boolean) => {
    setDraft((d) => ({
      ...d,
      rules: d.rules.map((r) => (r.provider === provider ? { ...r, enabled } : r)),
    }))
  }, [])

  const removeGroup = useCallback((provider: string) => {
    setDraft((d) => ({ ...d, rules: d.rules.filter((r) => r.provider !== provider) }))
  }, [])

  const updateRule = useCallback((id: string, patch: Partial<ProxyRule>) => {
    setDraft((d) => ({
      ...d,
      rules: d.rules.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    }))
  }, [])

  const removeRule = useCallback((id: string) => {
    setDraft((d) => ({ ...d, rules: d.rules.filter((r) => r.id !== id) }))
  }, [])

  if (snap.status === 'loading') return <div style={{ padding: 12, opacity: 0.7, color: 'var(--dsw-alias-label-primary)' }}>{t('reading')}</div>
  if (snap.status === 'unavailable') return <div style={{ padding: 12, color: 'var(--dsw-alias-label-primary)' }}>{t('unavailable')}</div>

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12, color: 'var(--dsw-alias-label-primary)' }}>
      <div>
        <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--dsw-alias-label-primary)' }}>{t('title')}</div>
        <div style={{ opacity: 0.7, fontSize: 12, marginTop: 4, color: 'var(--dsw-alias-label-tertiary)' }}>{t('desc')}</div>
        {!snap.writable && <div style={{ color: 'var(--dsw-alias-state-warn-label)', fontSize: 12, marginTop: 6 }}>{t('readOnly')}</div>}
        {catalogMissing && <div style={{ opacity: 0.6, fontSize: 12, marginTop: 6, color: 'var(--dsw-alias-label-tertiary)' }}>{t('catalogUnavailable')}</div>}
        {modelsMissing && <div style={{ opacity: 0.6, fontSize: 12, marginTop: 6, color: 'var(--dsw-alias-label-tertiary)' }}>{t('modelsUnavailable')}</div>}
      </div>

      <label style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--dsw-alias-label-primary)' }}>
        <input type="checkbox" checked={draft.enabled} onChange={(e) => setField({ enabled: e.target.checked })} disabled={!snap.writable} />
        <span>{t('enabled')}</span>
      </label>

      <label style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--dsw-alias-label-primary)' }}>
        <input type="checkbox" checked={draft.debug} onChange={(e) => setField({ debug: e.target.checked })} disabled={!snap.writable} />
        <span>{t('debug')}</span>
      </label>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }}>{t('rules')}</div>
        <button
          onClick={() => {
            setCreatorOpen((o) => !o)
            setCreatorError(undefined)
          }}
          disabled={!snap.writable}
          className="mp_btnSecondary"
        >
          ＋ {t('addRule')}
        </button>
      </div>

      {draft.rules.length === 0 && !creatorOpen && <div style={{ opacity: 0.6, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>{t('empty')}</div>}

      {creatorOpen && (
        <div className="mp_creator">
          <div style={{ fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }}>{t('creatorTitle')}</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 11, opacity: 0.7, color: 'var(--dsw-alias-label-secondary)' }}>{t('provider')}</span>
              <CatalogField
                value={creator.provider}
                groups={providerGroups}
                onChange={(v) => setCreatorField({ provider: v })}
                disabled={!snap.writable}
                chooseLabel={t('choose')}
                customLabel={t('customOption')}
                listTitle={t('backToList')}
                inputPlaceholder={t('providerPlaceholder')}
              />
              {canHideUnconfigured && (
                <label style={{ display: 'flex', gap: 6, alignItems: 'center', color: 'var(--dsw-alias-label-primary)' }}>
                  <input
                    type="checkbox"
                    checked={showUnconfigured}
                    onChange={(e) => {
                      setShowUnconfigured(e.target.checked)
                      try {
                        if (typeof localStorage !== 'undefined') {
                          localStorage.setItem(SHOW_UNCONFIGURED_KEY, e.target.checked ? '1' : '0')
                        }
                      } catch {
                        // Persistence is best-effort; the toggle still works for this session.
                      }
                    }}
                    disabled={!snap.writable}
                  />
                  <span style={{ fontSize: 12 }}>{t('showUnconfigured').replace('{n}', String(hiddenCount))}</span>
                </label>
              )}
            </div>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 11, opacity: 0.7, color: 'var(--dsw-alias-label-secondary)' }}>{t('proxyUrl')}</span>
              <ProxyUrlInput
                value={creator.proxyUrl}
                onChange={(v) => setCreatorField({ proxyUrl: v })}
                placeholder={t('proxyPlaceholder')}
                disabled={!snap.writable}
                ghostHint={t('proxyGhostHint')}
                suggestions={proxySuggestions}
              />
            </label>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11, opacity: 0.7, color: 'var(--dsw-alias-label-secondary)' }}>{t('creatorModels')}</span>
            {modelOptionsFor(creator.provider).length === 0 ? (
              <>
                <span style={{ opacity: 0.6, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>{t('noneCatalogued')}</span>
                {(() => {
                  // No catalog rows (e.g. remote faces unreachable and no
                  // profile declares models): still offer the bare `*`
                  // wildcard as a one-click checkbox, so "check models" stays
                  // true and `vendor-*` patterns keep the input below.
                  const starExists = ruleExists(creator.provider, '*')
                  const starChecked = creator.checked.includes('*')
                  return (
                    <label style={{ display: 'flex', gap: 6, alignItems: 'center', opacity: starExists ? 0.45 : 1, color: 'var(--dsw-alias-label-primary)' }}>
                      <input
                        type="checkbox"
                        checked={starChecked}
                        disabled={!snap.writable || starExists}
                        onChange={() =>
                          setCreatorField({
                            checked: starChecked ? creator.checked.filter((m) => m !== '*') : [...creator.checked, '*'],
                          })
                        }
                      />
                      <span style={{ fontSize: 12 }}>* ({t('wildcardAll')}){starExists ? ` · ${t('alreadyRuled')}` : ''}</span>
                    </label>
                  )
                })()}
              </>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                {modelOptionsFor(creator.provider).map((o) => {
                  const exists = ruleExists(creator.provider, o.value)
                  const checked = creator.checked.includes(o.value)
                  return (
                    <label key={o.value} style={{ display: 'flex', gap: 6, alignItems: 'center', opacity: exists ? 0.45 : 1, color: 'var(--dsw-alias-label-primary)' }}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!snap.writable || exists}
                        onChange={() =>
                          setCreatorField({
                            checked: checked ? creator.checked.filter((m) => m !== o.value) : [...creator.checked, o.value],
                          })
                        }
                      />
                      <span style={{ fontSize: 12 }}>{o.label}{exists ? ` · ${t('alreadyRuled')}` : ''}</span>
                    </label>
                  )
                })}
              </div>
            )}
            <input
              value={creator.customPattern}
              placeholder={t('creatorPatternHint')}
              onChange={(e) => setCreatorField({ customPattern: e.target.value })}
              className="mp_input"
              disabled={!snap.writable}
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 11, opacity: 0.7, color: 'var(--dsw-alias-label-secondary)' }}>{t('purpose')}</span>
              <CatalogField
                value={creator.purpose}
                groups={purposeGroups}
                onChange={(v) => setCreatorField({ purpose: v })}
                disabled={!snap.writable}
                chooseLabel={t('choose')}
                customLabel={t('customOption')}
                listTitle={t('backToList')}
                inputPlaceholder={t('purposePlaceholder')}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 11, opacity: 0.7, color: 'var(--dsw-alias-label-secondary)' }}>{t('credRef')}</span>
              <input
                value={creator.credentialRef}
                placeholder={t('credRefPlaceholder')}
                onChange={(e) => setCreatorField({ credentialRef: e.target.value })}
                className="mp_input"
                disabled={!snap.writable}
              />
            </label>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, alignItems: 'center' }}>
            {creatorError && <span style={{ color: 'var(--dsw-alias-state-error-primary)', fontSize: 11 }}>{creatorError}</span>}
            <button
              onClick={() => {
                setCreatorOpen(false)
                setCreator(EMPTY_CREATOR)
                setCreatorError(undefined)
              }}
              className="mp_btnSecondary"
            >
              {t('cancel')}
            </button>
            <button
              onClick={createRules}
              disabled={!snap.writable || creator.provider.trim() === '' || creatorModelCount === 0}
              className="mp_btnPrimary"
              style={{ opacity: (!snap.writable || creator.provider.trim() === '' || creatorModelCount === 0) ? 0.4 : 1 }}
            >
              {t('createN').replace('{n}', String(creatorModelCount))}
            </button>
          </div>
        </div>
      )}

      {groupByProvider(draft.rules).map((group) => {
        const allEnabled = group.rules.every((r) => r.enabled)
        const entry = cat.providers.find((p) => p.provider === group.provider)
        const displayName = entry?.displayName !== undefined && entry.displayName !== group.provider
          ? `${entry.displayName}`
          : group.provider
        return (
          <div key={group.provider} className="mp_card">
            <GroupHeader
              provider={group.provider}
              displayName={displayName}
              count={group.rules.length}
              allEnabled={allEnabled}
              disabled={!snap.writable}
              t={t}
              proxySuggestions={proxySuggestions}
              onApplyProxy={(url) => applyGroupProxy(group.provider, url)}
              onSetEnabled={(enabled) => setGroupEnabled(group.provider, enabled)}
              onDelete={() => removeGroup(group.provider)}
            />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {group.rules.map((raw) => {
                // ensureRuleIds guarantees every rendered rule carries an id.
                const r = raw as ProxyRule & { id: string }
                const err = validateRule(r, draft.rules)
                return (
                  <div
                    key={r.id}
                    className={`mp_ruleCard ${err ? 'mp_ruleCardInvalid' : ''} ${!r.enabled ? 'mp_ruleCardDisabled' : ''}`}
                  >
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <span style={{ fontSize: 11, opacity: 0.7, color: 'var(--dsw-alias-label-secondary)' }}>{t('model')}</span>
                      <CatalogField
                        value={r.model}
                        groups={[{ options: modelOptionsFor(r.provider) }]}
                        onChange={(v) => updateRule(r.id, { model: v })}
                        disabled={!snap.writable}
                        chooseLabel={t('choose')}
                        customLabel={t('customOption')}
                        listTitle={t('backToList')}
                        inputPlaceholder={t('modelPlaceholder')}
                      />
                    </label>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <span style={{ fontSize: 11, opacity: 0.7, color: 'var(--dsw-alias-label-secondary)' }}>{t('proxyUrl')}</span>
                      <ProxyUrlInput
                        value={r.proxyUrl}
                        onChange={(v) => updateRule(r.id, { proxyUrl: v })}
                        placeholder={t('proxyPlaceholder')}
                        disabled={!snap.writable}
                        invalid={err !== undefined}
                        ghostHint={t('proxyGhostHint')}
                        suggestions={proxySuggestions}
                      />
                      {err && <span style={{ color: 'var(--dsw-alias-state-error-primary)', fontSize: 11 }}>{err === 'duplicate' ? t('duplicate') : err}</span>}
                    </label>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <span style={{ fontSize: 11, opacity: 0.7, color: 'var(--dsw-alias-label-secondary)' }}>{t('purpose')}</span>
                      <CatalogField
                        value={r.purpose ?? ''}
                        groups={purposeGroups}
                        onChange={(v) => updateRule(r.id, { purpose: v })}
                        disabled={!snap.writable}
                        chooseLabel={t('choose')}
                        customLabel={t('customOption')}
                        listTitle={t('backToList')}
                        inputPlaceholder={t('purposePlaceholder')}
                      />
                    </label>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <span style={{ fontSize: 11, opacity: 0.7, color: 'var(--dsw-alias-label-secondary)' }}>{t('credRef')}</span>
                      <input
                        value={r.credentialRef ?? ''}
                        placeholder={t('credRefPlaceholder')}
                        onChange={(e) => updateRule(r.id, { credentialRef: e.target.value })}
                        className="mp_input"
                        disabled={!snap.writable}
                      />
                    </label>
                    <label style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--dsw-alias-label-primary)' }}>
                      <input type="checkbox" checked={r.enabled} onChange={(e) => updateRule(r.id, { enabled: e.target.checked })} disabled={!snap.writable} />
                      <span style={{ fontSize: 12 }}>{t('enabledShort')}</span>
                    </label>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                      <button
                        onClick={() => removeRule(r.id)}
                        disabled={!snap.writable}
                        className="mp_btnSecondary"
                      >
                        {t('delete')}
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}

      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }}>{t('defaultProxy')}</span>
        <ProxyUrlInput
          value={draft.defaultProxy}
          onChange={(v) => setField({ defaultProxy: v })}
          placeholder={t('defaultPlaceholder')}
          disabled={!snap.writable}
          invalid={defaultProxyError !== undefined}
          ghostHint={t('proxyGhostHint')}
          suggestions={proxySuggestions}
        />
        {defaultProxyError && <span style={{ color: 'var(--dsw-alias-state-error-primary)', fontSize: 11 }}>{defaultProxyError}</span>}
      </label>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          onClick={onSave}
          disabled={!snap.writable || !dirty || saving}
          className="mp_btnPrimary"
          style={{ opacity: (!snap.writable || !dirty || saving) ? 0.4 : 1 }}
        >
          {saving ? t('saving') : t('save')}
        </button>
        {msg && <span style={{ fontSize: 12, opacity: 0.8, color: 'var(--dsw-alias-label-primary)' }}>{msg}</span>}
      </div>
    </div>
  )
}
