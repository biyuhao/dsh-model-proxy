/**
 * Browser half: registers `settings.plugin.item` card for `model-proxy`.
 * Non-invasive: only depends on the declared slot via type-only import.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { ProviderCatalogStore } from './catalog.js'
import { ModelProxyCard } from './ModelProxyCard.js'
import { ModelProxyController, type ModelProxyConfig } from './controller.js'
import { en, zh } from './locales.js'

export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope']

export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind('settings.modelProxy' as never)
  ctx.effect(() => ctx.locale.register('settings.modelProxy' as never, { en, zh } as never), 'model-proxy: locale')

  const scope = (ctx.settingsScope as any).bind({ namespace: 'model-proxy' })
  const ctrl = new ModelProxyController(scope as never)
  // Subscribe lifecycle tied to this plugin fiber
  ctx.effect(() => {
    ctrl.bind()
    return () => ctrl.dispose()
  }, 'model-proxy: scope bind')

  // Live provider/model catalog for the card dropdowns (llm.providers /
  // llm.models, refreshed on llm/adapters-updated + settings/document-updated).
  const cctx = ctx as never as { connection: { api: unknown }; remote: unknown }
  const catalog = new ProviderCatalogStore(
    cctx.connection.api as never,
    cctx.remote as never,
  )
  ctx.effect(() => {
    catalog.bind()
    return () => catalog.dispose()
  }, 'model-proxy: catalog')

  ctx.slots.inject('settings.plugin.item', () =>
    ctx.slots.register(
      {
        name: 'settings.plugin.item',
        key: 'model-proxy',
        locale: 'settings.modelProxy' as never,
        inject: () => ({ controller: ctrl, catalog }),
      } as never,
      ModelProxyCard as never,
    ),
  )

  // Also support direct section registration if user prefers a top-level section.
  // Uncomment to get a dedicated nav entry instead of Plugins tab card:
  // ctx.slots.inject('settings.section', () => ctx.slots.register({
  //   name: 'settings.section',
  //   id: 'model-proxy',
  //   order: 20,
  //   label: () => (t as (k:string)=>string)('nav'),
  //   locale: 'settings.modelProxy' as never,
  //   inject: () => ({ controller: ctrl }),
  // } as never, ModelProxyCard as never))
}
