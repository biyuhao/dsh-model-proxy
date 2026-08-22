import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import type { CatalogSnapshot } from './catalog.js'
import { ProviderCatalogStore } from './catalog.js'
import type { ModelProxyController, ModelProxyConfig, ProxyRule } from './controller.js'
import { buildCreatorRules, ensureRuleIds, groupByProvider, makeRuleId } from './controller.js'
import { en } from './locales.js'

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

  if (flat.length === 0) {
    return (
      <input
        value={value}
        placeholder={inputPlaceholder}
        onChange={(e) => onChange(e.target.value)}
        style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid #ccc', width: '100%', boxSizing: 'border-box' }}
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
          style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid #ccc', flex: 1, minWidth: 0 }}
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
            style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid #ccc', flex: 1, minWidth: 0 }}
            disabled={disabled}
          />
          <button
            type="button"
            title={listTitle}
            onClick={() => setCustomMode(false)}
            disabled={disabled}
            style={{
              padding: '4px 8px',
              borderRadius: 6,
              border: '1px solid #ddd',
              background: '#fff',
              cursor: 'pointer',
              lineHeight: 1,
            }}
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
  if (r.credentialRef !== undefined && r.credentialRef !== '' && r.credentialRef !== r.credentialRef.trim()) return 'whitespace around credential ref'
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
  onApplyProxy(url: string): void
  onSetEnabled(enabled: boolean): void
  onDelete(): void
}) {
  const { provider, displayName, count, allEnabled, disabled, t, onApplyProxy, onSetEnabled, onDelete } = props
  const [proxy, setProxy] = useState('')
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    if (!confirming) return
    const timer = setTimeout(() => setConfirming(false), 3000)
    return () => clearTimeout(timer)
  }, [confirming])

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
      <span style={{ fontWeight: 700 }}>
        {displayName === provider ? provider : `${displayName} · ${provider}`}
        <span style={{ fontWeight: 400, opacity: 0.6, marginLeft: 6 }}>{count}</span>
      </span>
      <span style={{ flex: 1 }} />
      <input
        value={proxy}
        placeholder={t('groupApplyProxy')}
        onChange={(e) => setProxy(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onApplyProxy(proxy.trim())
        }}
        style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid #ddd', width: 200 }}
        disabled={disabled}
      />
      <button type="button" onClick={() => onApplyProxy(proxy.trim())} disabled={disabled || proxy.trim() === ''}
        style={smallButtonStyle}>
        {t('groupApply')}
      </button>
      <button type="button" onClick={() => onSetEnabled(!allEnabled)} disabled={disabled} style={smallButtonStyle}>
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
        style={{
          ...smallButtonStyle,
          borderColor: confirming ? '#d66' : '#ddd',
          color: confirming ? '#d66' : undefined,
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
    return ensureRuleIds(
      snap.value ?? {
        enabled: true,
        rules: [],
        defaultProxy: '',
        debug: false,
      },
    )
  }, [snap.value])

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

  // Dropdown options from the live provider/model catalogs. Wire order is
  // preserved (registration order host-side); dormant routes are still
  // selectable because rules may pre-date their adapter.
  //
  // When settings.describe enriched rows with `configured`, providers split
  // into two groups — user-configured first, bare directory second — so the
  // common case is one click away without hiding pre-provisioning targets.
  const providerGroups: FieldGroup[] = useMemo(() => {
    const opts: FieldOption[] = cat.providers.map((p) => ({
      value: p.provider,
      label: p.displayName === p.provider ? p.provider : `${p.displayName} (${p.provider})${p.active ? '' : ` · ${t('dormant')}`}`,
    }))
    if (!cat.providers.some((p) => p.configured !== undefined)) return [{ options: opts }]
    const configured: FieldOption[] = []
    const directory: FieldOption[] = []
    for (let i = 0; i < cat.providers.length; i++) {
      const p = cat.providers[i]!
      ;(p.configured === true ? configured : directory).push(opts[i]!)
    }
    return [
      ...(configured.length > 0 ? [{ label: t('groupConfigured'), options: configured }] : []),
      ...(directory.length > 0 ? [{ label: t('groupDirectory'), options: directory }] : []),
    ]
  }, [cat, t])
  const modelOptionsFor = useCallback(
    (provider: string): FieldOption[] => {
      const models = cat.modelsByProvider[provider] ?? []
      if (models.length === 0) return []
      const wildcard: FieldOption = { value: '*', label: `* (${t('wildcardAll')})` }
      return [
        ...(models.some((m) => m.id === '*') ? [] : [wildcard]),
        ...models.map((m) => ({ value: m.id, label: m.name && m.name !== m.id ? `${m.name} (${m.id})` : m.id })),
      ]
    },
    [cat, t],
  )
  const catalogMissing =
    catalog !== undefined && cat.status === 'unavailable' && cat.providers.length === 0

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

  if (snap.status === 'loading') return <div style={{ padding: 12, opacity: 0.7 }}>{t('reading')}</div>
  if (snap.status === 'unavailable') return <div style={{ padding: 12 }}>{t('unavailable')}</div>

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>
        <div style={{ fontWeight: 700, fontSize: 16 }}>{t('title')}</div>
        <div style={{ opacity: 0.7, fontSize: 12, marginTop: 4 }}>{t('desc')}</div>
        {!snap.writable && <div style={{ color: '#a66', fontSize: 12, marginTop: 6 }}>{t('readOnly')}</div>}
        {catalogMissing && <div style={{ opacity: 0.6, fontSize: 12, marginTop: 6 }}>{t('catalogUnavailable')}</div>}
      </div>

      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="checkbox" checked={draft.enabled} onChange={(e) => setField({ enabled: e.target.checked })} disabled={!snap.writable} />
        <span>{t('enabled')}</span>
      </label>

      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="checkbox" checked={draft.debug} onChange={(e) => setField({ debug: e.target.checked })} disabled={!snap.writable} />
        <span>{t('debug')}</span>
      </label>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontWeight: 600 }}>{t('rules')}</div>
        <button
          onClick={() => {
            setCreatorOpen((o) => !o)
            setCreatorError(undefined)
          }}
          disabled={!snap.writable}
          style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #ccc', background: '#fff', cursor: 'pointer' }}
        >
          ＋ {t('addRule')}
        </button>
      </div>

      {draft.rules.length === 0 && !creatorOpen && <div style={{ opacity: 0.6, fontSize: 12 }}>{t('empty')}</div>}

      {creatorOpen && (
        <div style={{ border: '1px solid #bbb', borderRadius: 10, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontWeight: 600 }}>{t('creatorTitle')}</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 11, opacity: 0.7 }}>{t('provider')}</span>
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
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 11, opacity: 0.7 }}>{t('proxyUrl')}</span>
              <input
                value={creator.proxyUrl}
                placeholder={t('proxyPlaceholder')}
                onChange={(e) => setCreatorField({ proxyUrl: e.target.value })}
                style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid #ccc' }}
                disabled={!snap.writable}
              />
            </label>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11, opacity: 0.7 }}>{t('creatorModels')}</span>
            {modelOptionsFor(creator.provider).length === 0 ? (
              <span style={{ opacity: 0.6, fontSize: 12 }}>{t('noneCatalogued')}</span>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                {modelOptionsFor(creator.provider).map((o) => {
                  const exists = ruleExists(creator.provider, o.value)
                  const checked = creator.checked.includes(o.value)
                  return (
                    <label key={o.value} style={{ display: 'flex', gap: 6, alignItems: 'center', opacity: exists ? 0.45 : 1 }}>
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
              style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid #ccc' }}
              disabled={!snap.writable}
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 11, opacity: 0.7 }}>{t('purpose')}</span>
              <input
                value={creator.purpose}
                placeholder={t('purposePlaceholder')}
                onChange={(e) => setCreatorField({ purpose: e.target.value })}
                style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid #ccc' }}
                disabled={!snap.writable}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 11, opacity: 0.7 }}>{t('credRef')}</span>
              <input
                value={creator.credentialRef}
                placeholder={t('credRefPlaceholder')}
                onChange={(e) => setCreatorField({ credentialRef: e.target.value })}
                style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid #ccc' }}
                disabled={!snap.writable}
              />
            </label>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, alignItems: 'center' }}>
            {creatorError && <span style={{ color: '#b33', fontSize: 11 }}>{creatorError}</span>}
            <button
              onClick={() => {
                setCreatorOpen(false)
                setCreator(EMPTY_CREATOR)
                setCreatorError(undefined)
              }}
              style={smallButtonStyle}
            >
              {t('cancel')}
            </button>
            <button
              onClick={createRules}
              disabled={!snap.writable || creator.provider.trim() === '' || creatorModelCount === 0}
              style={{
                ...smallButtonStyle,
                borderColor: '#222',
                background: creatorModelCount > 0 ? '#222' : '#999',
                color: '#fff',
                cursor: creatorModelCount > 0 ? 'pointer' : 'not-allowed',
              }}
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
          <div key={group.provider} style={{ border: '1px solid #e8e8e8', borderRadius: 10, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <GroupHeader
              provider={group.provider}
              displayName={displayName}
              count={group.rules.length}
              allEnabled={allEnabled}
              disabled={!snap.writable}
              t={t}
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
                    style={{
                      border: `1px solid ${err ? '#d66' : '#ddd'}`,
                      borderRadius: 8,
                      padding: 8,
                      display: 'grid',
                      gridTemplateColumns: '1fr 1fr',
                      gap: 8,
                      background: r.enabled ? '#fff' : '#f7f7f7',
                    }}
                  >
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <span style={{ fontSize: 11, opacity: 0.7 }}>{t('model')}</span>
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
                      <span style={{ fontSize: 11, opacity: 0.7 }}>{t('proxyUrl')}</span>
                      <input
                        value={r.proxyUrl}
                        placeholder={t('proxyPlaceholder')}
                        onChange={(e) => updateRule(r.id, { proxyUrl: e.target.value })}
                        style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid #ccc' }}
                        disabled={!snap.writable}
                      />
                      {err && <span style={{ color: '#b33', fontSize: 11 }}>{err === 'duplicate' ? t('duplicate') : err}</span>}
                    </label>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <span style={{ fontSize: 11, opacity: 0.7 }}>{t('purpose')}</span>
                      <input
                        value={r.purpose ?? ''}
                        placeholder={t('purposePlaceholder')}
                        onChange={(e) => updateRule(r.id, { purpose: e.target.value })}
                        style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid #ccc' }}
                        disabled={!snap.writable}
                      />
                    </label>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <span style={{ fontSize: 11, opacity: 0.7 }}>{t('credRef')}</span>
                      <input
                        value={r.credentialRef ?? ''}
                        placeholder={t('credRefPlaceholder')}
                        onChange={(e) => updateRule(r.id, { credentialRef: e.target.value })}
                        style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid #ccc' }}
                        disabled={!snap.writable}
                      />
                    </label>
                    <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <input type="checkbox" checked={r.enabled} onChange={(e) => updateRule(r.id, { enabled: e.target.checked })} disabled={!snap.writable} />
                      <span style={{ fontSize: 12 }}>{t('enabledShort')}</span>
                    </label>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                      <button
                        onClick={() => removeRule(r.id)}
                        disabled={!snap.writable}
                        style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid #ddd', background: '#fff', cursor: 'pointer' }}
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
        <span style={{ fontSize: 12, fontWeight: 600 }}>{t('defaultProxy')}</span>
        <input
          value={draft.defaultProxy}
          placeholder={t('defaultPlaceholder')}
          onChange={(e) => setField({ defaultProxy: e.target.value })}
          style={{ padding: '6px 8px', borderRadius: 6, border: `1px solid ${defaultProxyError ? '#d66' : '#ccc'}` }}
          disabled={!snap.writable}
        />
        {defaultProxyError && <span style={{ color: '#b33', fontSize: 11 }}>{defaultProxyError}</span>}
      </label>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          onClick={onSave}
          disabled={!snap.writable || !dirty || saving}
          style={{
            padding: '8px 14px',
            borderRadius: 8,
            border: '1px solid #222',
            background: dirty ? '#222' : '#999',
            color: '#fff',
            cursor: dirty ? 'pointer' : 'not-allowed',
          }}
        >
          {saving ? t('saving') : t('save')}
        </button>
        {msg && <span style={{ fontSize: 12, opacity: 0.8 }}>{msg}</span>}
      </div>
    </div>
  )
}
