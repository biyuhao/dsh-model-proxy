import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import type { CatalogProvider, CatalogSnapshot, DirectoryMirror } from './catalog.js'
import { ProviderCatalogStore, mirrorModelsToMap } from './catalog.js'
import type { HeaderEditorRow, HeaderValueSource, HeaderSources, ModelProxyController, ModelProxyConfig, ProxyHost, ProxyRule } from './controller.js'
import { buildCreatorRules, ensureRuleIds, groupByProvider, makeProxyHostId, makeRuleId, normalizeConfig, parseHeaderRows } from './controller.js'
import { en } from './locales.js'

// DSH settings controls use DSW alias tokens; keep native inputs consistent.
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
/** Built-in direct route: no proxy dispatcher, but rule headers still apply. */
const DIRECT_PROXY_SENTINEL = '__direct__'

type FieldOption = { value: string; label: string }

/** Rendered shape of one <optgroup>; label undefined renders a flat list. */
type FieldGroup = { label?: string; options: FieldOption[] }

/** Catalog picker with a free-text escape hatch. */

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

/** Prefer configured URLs, then built-in presets. */
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

/** Proxy URL input with ghost completion and a datalist. */

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

function proxyHostLabel(host: ProxyHost): string {
  let shown = host.proxyUrl
  try {
    const u = new URL(host.proxyUrl)
    if (u.username || u.password) {
      u.username = '***'
      u.password = ''
    }
    u.search = ''
    u.hash = ''
    shown = u.toString()
  } catch {
    // Keep the user's raw value visible while they are editing an invalid URL.
  }
  return `${host.name || host.id} · ${shown}`
}

/** Select a reusable proxy host, with direct mode always available. */
function HostSelect(props: {
  value: string | undefined
  hosts: readonly ProxyHost[]
  onChange: (value: string) => void
  disabled: boolean
  t: (k: keyof typeof en) => string
}) {
  const { value, hosts, onChange, disabled, t } = props
  const selected = value && value !== DIRECT_PROXY_SENTINEL ? value : DIRECT_PROXY_SENTINEL
  const known = hosts.some((host) => host.id === selected)
  return (
    <select
      className="mp_select"
      value={selected}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
    >
      <option value={DIRECT_PROXY_SENTINEL}>{t('direct')}</option>
      {hosts.map((host) => <option key={host.id} value={host.id}>{proxyHostLabel(host)}</option>)}
      {!known && value !== undefined && value !== '' && value !== DIRECT_PROXY_SENTINEL && (
        <option value={value}>{t('missingHost')}</option>
      )}
    </select>
  )
}

/** Reusable proxy host rows. Rule cards only reference these ids. */
function ProxyHostsEditor(props: {
  hosts: readonly ProxyHost[]
  usedHostIds: ReadonlySet<string>
  suggestions: readonly string[]
  disabled: boolean
  t: (k: keyof typeof en) => string
  onAdd(): void
  onChange(id: string, patch: Partial<ProxyHost>): void
  onRemove(id: string): void
}) {
  const { hosts, usedHostIds, suggestions, disabled, t, onAdd, onChange, onRemove } = props
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {hosts.length === 0 && (
        <div style={{ opacity: 0.6, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>{t('hostsEmpty')}</div>
      )}
      {hosts.map((host) => (
        <div key={host.id} className="mp_card" style={{ padding: 8 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr 1fr auto', gap: 8, alignItems: 'end' }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 11, opacity: 0.7, color: 'var(--dsw-alias-label-secondary)' }}>{t('hostName')}</span>
              <input
                value={host.name}
                onChange={(e) => onChange(host.id, { name: e.target.value })}
                className="mp_input"
                disabled={disabled}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 11, opacity: 0.7, color: 'var(--dsw-alias-label-secondary)' }}>{t('proxyUrl')}</span>
              <ProxyUrlInput
                value={host.proxyUrl}
                onChange={(v) => onChange(host.id, { proxyUrl: v })}
                placeholder={t('proxyPlaceholder')}
                disabled={disabled}
                ghostHint={t('proxyGhostHint')}
                suggestions={suggestions}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 11, opacity: 0.7, color: 'var(--dsw-alias-label-secondary)' }}>{t('credRef')}</span>
              <input
                value={host.credentialRef ?? ''}
                onChange={(e) => onChange(host.id, { credentialRef: e.target.value })}
                className="mp_input"
                placeholder={t('credRefPlaceholder')}
                disabled={disabled}
              />
            </label>
            <button
              type="button"
              onClick={() => onRemove(host.id)}
              disabled={disabled || usedHostIds.has(host.id)}
              title={usedHostIds.has(host.id) ? t('hostInUse') : t('delete')}
              className="mp_btnSecondary"
            >
              ✕
            </button>
          </div>
        </div>
      ))}
      <div>
        <button type="button" onClick={onAdd} disabled={disabled} className="mp_btnSecondary">
          {t('addHost')}
        </button>
      </div>
    </div>
  )
}

const SHOW_UNCONFIGURED_KEY = 'dsh-model-proxy:showUnconfigured'

function headersToRows(headers: Record<string, string> | undefined, sources: HeaderSources | undefined): HeaderEditorRow[] {
  const names = [...Object.keys(headers ?? {}), ...Object.keys(sources ?? {}).filter((name) => headers?.[name] === undefined)]
  return names.map((name) => ({
    key: makeRuleId(),
    name,
    value: headers?.[name] ?? '',
    source: sources?.[name] ?? 'fixed',
  }))
}

function headerSpecSignature(headers: Record<string, string> | undefined, sources: HeaderSources | undefined): string {
  return [...new Set([...Object.keys(headers ?? {}), ...Object.keys(sources ?? {})])]
    .map((name) => `${name}\0${sources?.[name] ?? 'fixed'}\0${headers?.[name] ?? ''}`)
    .join('\n')
}

function rowsSpecSignature(rows: readonly HeaderEditorRow[]): string {
  const headers = Object.fromEntries(
    rows.filter((row) => row.source === 'fixed' && row.name.trim() !== '').map((row) => [row.name.trim(), row.value.trim()]),
  )
  const sources = Object.fromEntries(
    rows.filter((row) => row.source !== 'fixed' && row.name.trim() !== '').map((row) => [row.name.trim(), row.source]),
  ) as HeaderSources
  return headerSpecSignature(headers, sources)
}

function HeadersEditor(props: {
  editorKey: string
  headers: Record<string, string> | undefined
  sources: HeaderSources | undefined
  disabled: boolean
  t: (k: keyof typeof en) => string
  onChange: (headers: Record<string, string> | undefined, sources: HeaderSources | undefined) => void
  onValidityChange?: (valid: boolean) => void
}) {
  const { editorKey, headers, sources, disabled, t, onChange, onValidityChange } = props
  const external = headerSpecSignature(headers, sources)
  const [rows, setRows] = useState<HeaderEditorRow[]>(() => headersToRows(headers, sources))
  const [lastKey, setLastKey] = useState(editorKey)
  // External updates replace a clean draft, but never pending typing.
  const [committed, setCommitted] = useState(external)
  if (editorKey !== lastKey) {
    setLastKey(editorKey)
    setCommitted(external)
    setRows(headersToRows(headers, sources))
  } else if (external !== committed && rowsSpecSignature(rows) === committed) {
    setCommitted(external)
    setRows(headersToRows(headers, sources))
  }

  const commit = (next: HeaderEditorRow[]): void => {
    setRows(next)
    const parsed = parseHeaderRows(next)
    if (parsed.error) {
      onValidityChange?.(false)
      return
    }
    setCommitted(headerSpecSignature(parsed.headers, parsed.sources))
    onValidityChange?.(true)
    onChange(parsed.headers, parsed.sources)
  }

  const liveError = parseHeaderRows(rows).error
  const hasSessionPreset = rows.some((r) => r.name.trim().toLowerCase() === 'x-opencode-session')
  const patchRow = (key: string, patch: Partial<HeaderEditorRow>): void => {
    commit(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {rows.map((r) => (
        <div key={r.key} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            value={r.name}
            placeholder={t('headersName')}
            onChange={(e) => patchRow(r.key, { name: e.target.value })}
            className="mp_input"
            style={{ flex: '0 1 180px', minWidth: 0 }}
            disabled={disabled}
            spellCheck={false}
          />
          <select
            value={r.source}
            onChange={(e) => {
              const source = e.target.value as HeaderValueSource
              patchRow(r.key, source === 'fixed' ? { source } : { source, value: '' })
            }}
            className="mp_select"
            style={{ flex: '0 0 150px' }}
            disabled={disabled}
            aria-label={t('headerSource')}
          >
            <option value="fixed">{t('headerSourceFixed')}</option>
            <option value="sessionId">{t('headerSourceSession')}</option>
            <option value="provider">{t('headerSourceProvider')}</option>
            <option value="model">{t('headerSourceModel')}</option>
            <option value="purpose">{t('headerSourcePurpose')}</option>
          </select>
          <input
            value={r.value}
            placeholder={r.source === 'fixed' ? t('headersValue') : t('headerValueDynamic')}
            onChange={(e) => patchRow(r.key, { value: e.target.value })}
            className="mp_input"
            style={{ flex: '1 1 auto', minWidth: 0 }}
            disabled={disabled || r.source !== 'fixed'}
            spellCheck={false}
          />
          <button
            type="button"
            onClick={() => commit(rows.filter((x) => x.key !== r.key))}
            disabled={disabled}
            className="mp_btnSecondary"
            title={t('delete')}
            style={{ flex: '0 0 auto' }}
          >
            ✕
          </button>
        </div>
      ))}
      {liveError !== undefined
        ? <span style={{ color: 'var(--dsw-alias-state-error-primary)', fontSize: 11 }}>{liveError}</span>
        : <span style={{ fontSize: 11, opacity: 0.6, color: 'var(--dsw-alias-label-tertiary)' }}>{t('headersHint')}</span>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={() => commit([...rows, { key: makeRuleId(), name: '', value: '', source: 'fixed' }])}
          disabled={disabled}
          className="mp_btnSecondary"
        >
          {t('headersAdd')}
        </button>
        {!hasSessionPreset && (
          <button
            type="button"
            onClick={() => commit([...rows, { key: makeRuleId(), name: 'x-opencode-session', value: '', source: 'sessionId' }])}
            disabled={disabled}
            className="mp_btnSecondary"
          >
            {t('headersPreset')}
          </button>
        )}
      </div>
    </div>
  )
}

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

/** Normalize catalog providers into display rows. */

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

/** Keep live/configured providers visible; Custom… covers other values. */

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
  proxyHostId: string
  purpose: string
  /** Header source choices shared by the batch. */
  headerValueSources: Record<string, HeaderValueSource> | undefined
  headers: Record<string, string> | undefined
}

const EMPTY_CREATOR: CreatorState = {
  provider: '',
  checked: [],
  customPattern: '',
  proxyHostId: DIRECT_PROXY_SENTINEL,
  purpose: '',
  headerValueSources: undefined,
  headers: undefined,
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
  if (r.proxyUrl !== undefined && r.proxyUrl !== '') {
    const err = validateUrl(r.proxyUrl)
    if (err) return err
  }
  if (r.proxyHostId !== undefined && r.proxyHostId !== '' && r.proxyUrl !== undefined && r.proxyUrl !== '') {
    return 'host reference and legacy proxy URL cannot both be set'
  }
  const headerError = parseHeaderRows(headersToRows(r.headers, r.headerValueSources)).error
  if (headerError) return headerError
  const dup = all.filter(x => x.provider === r.provider && x.model === r.model).length > 1
  if (dup) return 'duplicate'
  return undefined
}

/** Mirrors host assertServiceable for a reusable proxy host. */
export function validateProxyHost(host: ProxyHost): string | undefined {
  if (!host.id.trim() || host.id !== host.id.trim()) return 'host id required'
  if (host.id === DIRECT_PROXY_SENTINEL || host.id === CUSTOM_SENTINEL) return 'host id is reserved'
  if (!host.name.trim() || host.name !== host.name.trim()) return 'host name required'
  if (!host.proxyUrl.trim()) return 'proxy URL required'
  const err = validateUrl(host.proxyUrl.trim())
  if (err) return err
  if (host.credentialRef !== undefined && host.credentialRef !== '') {
    if (host.credentialRef !== host.credentialRef.trim()) return 'whitespace around credential ref'
    if (/\s/.test(host.credentialRef)) return 'whitespace in credential ref'
    if (host.credentialRef.includes('://')) return 'credential ref is not a URL'
  }
  return undefined
}

/** Mirrors host assertServiceable for defaultProxy so bad values never reach the wire. */
export function validateDefaultProxy(defaultProxy: string): string | undefined {
  if (defaultProxy === '') return undefined
  return validateUrl(defaultProxy)
}

/** Provider group header with bulk host, enable, and delete actions. */

function GroupHeader(props: {
  provider: string
  displayName: string
  count: number
  allEnabled: boolean
  disabled: boolean
  t: (k: keyof typeof en) => string
  hosts: readonly ProxyHost[]
  hostValue: string | undefined
  onApplyHost(value: string): void
  onSetEnabled(enabled: boolean): void
  onDelete(): void
}) {
  const { provider, displayName, count, allEnabled, disabled, t, hosts, hostValue, onApplyHost, onSetEnabled, onDelete } = props
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
      <div style={{ width: 240, flex: 'none' }}>
        <HostSelect
          value={hostValue}
          hosts={hosts}
          onChange={onApplyHost}
          disabled={disabled}
          t={t}
        />
      </div>
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
    // Strip the host-computed mirror before creating editable state.
    const raw = snap.value ?? {
      enabled: true,
      proxyHosts: [],
      rules: [],
      defaultProxyHostId: '',
      defaultProxy: '',
      debug: false,
    }
    const { catalog: _mirror, ...editable } = raw
    return ensureRuleIds(normalizeConfig(editable))
  }, [snap.value])

  // Use the host mirror when remote Typert rows are unavailable.
  const mirror = snap.value?.catalog
  const mirrorModelMap = useMemo(() => mirrorModelsToMap(mirror), [mirror])

  const draftInitialized = useRef(false)
  const [draft, setDraft] = useState<ModelProxyConfig>(cfg)
  const [invalidHeaderKeys, setInvalidHeaderKeys] = useState<Set<string>>(() => new Set())
  const [creatorHeadersInvalid, setCreatorHeadersInvalid] = useState(false)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | undefined>()

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(cfg), [draft, cfg])
  const hasInvalidHeaders = creatorHeadersInvalid || draft.rules.some((rule) => invalidHeaderKeys.has(rule.id ?? ''))
  const setHeaderValidity = useCallback((id: string, valid: boolean) => {
    setInvalidHeaderKeys((previous) => {
      const next = new Set(previous)
      const changed = valid ? next.delete(id) : next.add(id)
      return changed ? next : previous
    })
  }, [])

  // Adopt the first non-loading snapshot even if the placeholder differed.
  useEffect(() => {
    if (snap.status === 'loading') return
    if (!draftInitialized.current) {
      draftInitialized.current = true
      setDraft(cfg)
    } else if (!dirty) {
      setDraft(cfg)
    }
  }, [cfg, dirty, snap.status])

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
  // Known purposes use a dropdown; Custom… preserves hand-written values.
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
    if (hasInvalidHeaders) {
      setMsg(t('invalid'))
      return
    }
    // Validate locally before writing.
    const hostIds = new Set<string>()
    for (const host of draft.proxyHosts) {
      if (validateProxyHost(host) || hostIds.has(host.id)) {
        setMsg(t('invalid'))
        return
      }
      hostIds.add(host.id)
    }
    for (const r of draft.rules) {
      const err = validateRule(r, draft.rules)
      if (err || (r.proxyHostId !== undefined && r.proxyHostId !== '' && !hostIds.has(r.proxyHostId))) {
        setMsg(t('invalid'))
        return
      }
    }
    if (
      defaultProxyError ||
      (draft.defaultProxyHostId !== undefined && draft.defaultProxyHostId !== '' && !hostIds.has(draft.defaultProxyHostId)) ||
      (draft.defaultProxyHostId !== undefined && draft.defaultProxyHostId !== '' && draft.defaultProxy !== '')
    ) {
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
  }, [draft, controller, t, defaultProxyError, hasInvalidHeaders])

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

  // Ghost-completion candidates for reusable host URL fields: configured hosts
  // first, then built-in presets.
  const proxySuggestions = useMemo(
    () => mergeProxySuggestions([...draft.proxyHosts.map((h) => h.proxyUrl), draft.defaultProxy]),
    [draft.proxyHosts, draft.defaultProxy],
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
      proxyHostId: creator.proxyHostId === DIRECT_PROXY_SENTINEL ? undefined : creator.proxyHostId,
      purpose: creator.purpose,
      headers: creator.headers,
      headerValueSources: creator.headerValueSources,
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
    setCreatorHeadersInvalid(false)
    setCreatorError(undefined)
    setCreatorOpen(false)
  }, [creator, draft.rules, t])

  const applyGroupHost = useCallback((provider: string, value: string) => {
    setDraft((d) => ({
      ...d,
      rules: d.rules.map((r) => {
        if (r.provider !== provider) return r
        const next = { ...r } as Record<string, unknown>
        if (value === DIRECT_PROXY_SENTINEL) {
          delete next.proxyHostId
          delete next.proxyUrl
          delete next.credentialRef
        } else {
          next.proxyHostId = value
          delete next.proxyUrl
          delete next.credentialRef
        }
        return next as ProxyRule
      }),
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

  const addHost = useCallback(() => {
    setDraft((d) => ({
      ...d,
      proxyHosts: [...d.proxyHosts, { id: makeProxyHostId(), name: t('newHostName'), proxyUrl: '' }],
    }))
  }, [t])

  const updateHost = useCallback((id: string, patch: Partial<ProxyHost>) => {
    setDraft((d) => ({
      ...d,
      proxyHosts: d.proxyHosts.map((host) => (host.id === id ? { ...host, ...patch } : host)),
    }))
  }, [])

  const usedHostIds = useMemo(() => {
    const ids = draft.rules
      .map((r) => r.proxyHostId)
      .filter((id): id is string => !!id)
    if (draft.defaultProxyHostId) ids.push(draft.defaultProxyHostId)
    return new Set(ids)
  }, [draft.rules, draft.defaultProxyHostId])

  const removeHost = useCallback((id: string) => {
    if (usedHostIds.has(id)) {
      setMsg(t('hostInUse'))
      return
    }
    setDraft((d) => ({
      ...d,
      proxyHosts: d.proxyHosts.filter((host) => host.id !== id),
      ...(d.defaultProxyHostId === id ? { defaultProxyHostId: '' } : {}),
    }))
  }, [t, usedHostIds])

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
            const next = !creatorOpen
            setCreatorOpen(next)
            if (!next) {
              setCreator(EMPTY_CREATOR)
              setCreatorHeadersInvalid(false)
            }
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
              <span style={{ fontSize: 11, opacity: 0.7, color: 'var(--dsw-alias-label-secondary)' }}>{t('proxyHost')}</span>
              <HostSelect
                value={creator.proxyHostId}
                hosts={draft.proxyHosts}
                onChange={(v) => setCreatorField({ proxyHostId: v })}
                disabled={!snap.writable}
                t={t}
              />
            </label>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11, opacity: 0.7, color: 'var(--dsw-alias-label-secondary)' }}>{t('creatorModels')}</span>
            {modelOptionsFor(creator.provider).length === 0 ? (
              <>
                <span style={{ opacity: 0.6, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>{t('noneCatalogued')}</span>
                {(() => {
                  // Keep `*` available when the catalog has no models.
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
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11, opacity: 0.7, color: 'var(--dsw-alias-label-secondary)' }}>{t('headers')}</span>
            <HeadersEditor
              editorKey="creator"
              headers={creator.headers}
              sources={creator.headerValueSources}
              disabled={!snap.writable}
              t={t}
              onChange={(headers, headerValueSources) => setCreatorField({ headers, headerValueSources })}
              onValidityChange={setCreatorHeadersInvalid}
            />
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, alignItems: 'center' }}>
            {creatorError && <span style={{ color: 'var(--dsw-alias-state-error-primary)', fontSize: 11 }}>{creatorError}</span>}
            <button
              onClick={() => {
                setCreatorOpen(false)
                setCreator(EMPTY_CREATOR)
                setCreatorHeadersInvalid(false)
                setCreatorError(undefined)
              }}
              className="mp_btnSecondary"
            >
              {t('cancel')}
            </button>
            <button
              onClick={createRules}
              disabled={!snap.writable || creatorHeadersInvalid || creator.provider.trim() === '' || creatorModelCount === 0}
              className="mp_btnPrimary"
              style={{ opacity: (!snap.writable || creatorHeadersInvalid || creator.provider.trim() === '' || creatorModelCount === 0) ? 0.4 : 1 }}
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
              hosts={draft.proxyHosts}
              hostValue={group.rules.find((rule) => rule.proxyHostId)?.proxyHostId}
              onApplyHost={(value) => applyGroupHost(group.provider, value)}
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
                      <span style={{ fontSize: 11, opacity: 0.7, color: 'var(--dsw-alias-label-secondary)' }}>{t('proxyHost')}</span>
                      <HostSelect
                        value={r.proxyHostId ?? DIRECT_PROXY_SENTINEL}
                        hosts={draft.proxyHosts}
                        onChange={(v) => {
                          const next = { ...r } as Record<string, unknown>
                          if (v === DIRECT_PROXY_SENTINEL) {
                            delete next.proxyHostId
                            delete next.proxyUrl
                            delete next.credentialRef
                          } else {
                            next.proxyHostId = v
                            delete next.proxyUrl
                            delete next.credentialRef
                          }
                          updateRule(r.id, next as Partial<ProxyRule>)
                        }}
                        disabled={!snap.writable}
                        t={t}
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
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, gridColumn: '1 / -1' }}>
                      <span style={{ fontSize: 11, opacity: 0.7, color: 'var(--dsw-alias-label-secondary)' }}>{t('headers')}</span>
                      <HeadersEditor
                        editorKey={r.id}
                        headers={r.headers}
                        sources={r.headerValueSources}
                        disabled={!snap.writable}
                        t={t}
                        onChange={(headers, headerValueSources) => {
                          const next = { ...r } as Partial<ProxyRule> & Record<string, unknown>
                          if (headers === undefined) delete (next as Record<string, unknown>).headers
                          else (next as Record<string, unknown>).headers = headers
                          if (headerValueSources === undefined) delete (next as Record<string, unknown>).headerValueSources
                          else (next as Record<string, unknown>).headerValueSources = headerValueSources
                          updateRule(r.id, next as Partial<ProxyRule>)
                        }}
                        onValidityChange={(valid) => setHeaderValidity(r.id, valid)}
                      />
                    </div>
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

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 4, borderTop: '1px solid var(--dsw-alias-border-l2)' }}>
        <div>
          <div style={{ fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }}>{t('proxyHosts')}</div>
          <div style={{ opacity: 0.65, fontSize: 11, marginTop: 3, color: 'var(--dsw-alias-label-tertiary)' }}>{t('proxyHostsHint')}</div>
        </div>
        <ProxyHostsEditor
          hosts={draft.proxyHosts}
          usedHostIds={usedHostIds}
          suggestions={proxySuggestions}
          disabled={!snap.writable}
          t={t}
          onAdd={addHost}
          onChange={updateHost}
          onRemove={removeHost}
        />
      </div>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }}>{t('defaultProxy')}</span>
        <HostSelect
          value={draft.defaultProxyHostId ?? DIRECT_PROXY_SENTINEL}
          hosts={draft.proxyHosts}
          onChange={(v) => setField({ defaultProxyHostId: v === DIRECT_PROXY_SENTINEL ? '' : v, defaultProxy: '' })}
          disabled={!snap.writable}
          t={t}
        />
      </label>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          onClick={onSave}
          disabled={!snap.writable || !dirty || saving || hasInvalidHeaders}
          className="mp_btnPrimary"
          style={{ opacity: (!snap.writable || !dirty || saving || hasInvalidHeaders) ? 0.4 : 1 }}
        >
          {saving ? t('saving') : t('save')}
        </button>
        {msg && <span style={{ fontSize: 12, opacity: 0.8, color: 'var(--dsw-alias-label-primary)' }}>{msg}</span>}
      </div>
    </div>
  )
}
