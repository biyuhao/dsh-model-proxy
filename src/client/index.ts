/**
 * Browser half: registers the `plugins.bundle.config` card for `model-proxy`.
 * Non-invasive: only depends on the declared slot via type-only import.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { ProviderCatalogStore } from './catalog.js'
import { ModelProxyCard } from './ModelProxyCard.js'
import { ModelProxyController, type ModelProxyConfig } from './controller.js'
import { en, zh } from './locales.js'

export const inject = ['slots', 'locale', 'connection', 'remote', 'configForms']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register('settings.modelProxy' as never, { en, zh } as never), 'model-proxy: locale')

  const scope = ctx.configForms.get('model-proxy')
  const ctrl = new ModelProxyController(scope as never)
  // Subscribe lifecycle tied to this plugin fiber
  ctx.effect(() => {
    ctrl.bind()
    return () => ctrl.dispose()
  }, 'model-proxy: scope bind')

  // Live provider/model catalog; the store degrades when Typert remotes are absent.
  const cctx = ctx as never as { connection: { api: unknown }; remote: unknown }
  const catalog = new ProviderCatalogStore(
    cctx.connection.api as never,
    cctx.remote as never,
  )
  ctx.effect(() => {
    catalog.bind()
    return () => catalog.dispose()
  }, 'model-proxy: catalog')
  // Reconnect parity with the built-in settings surfaces: a page that
  // connects after first paint (or survives a generation reset) must repull
  // instead of keeping the empty first-load snapshot forever.
  ctx.effect(() => {
    const maybeOn = (ctx as never as { on?: unknown }).on
    if (typeof maybeOn !== 'function') return () => {}
    const off = (maybeOn as (event: string, listener: () => void) => unknown).call(
      ctx,
      'connection/reset',
      () => void catalog.load(),
    )
    if (typeof off === 'function') return () => (off as () => void)()
    return () => {}
  }, 'model-proxy: reconnect reload')

  ctx.effect(() => ctx.configForms.whileServed(['model-proxy'], () => ctx.slots.inject('plugins.bundle.config', () =>
    ctx.slots.register(
      {
        name: 'plugins.bundle.config',
        key: 'dsh-plugin-model-proxy',
        locale: 'settings.modelProxy' as never,
        inject: () => ({ controller: ctrl, catalog }),
      } as never,
      ModelProxyCard as never,
    ),
  )), 'model-proxy: config page')

}
