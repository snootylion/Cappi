/** Browser half: Watch pairing page inside DSH Settings (trusted Mac UI). */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { WatchSettingsSection } from './settings.tsx'
import { installStyles } from './styles.ts'

export const name = 'dsh-watch-client'
export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  ctx.effect(installStyles, 'dsh-watch: browser styles')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'watch',
    order: 15,
    label: () => 'Watch',
  }, WatchSettingsSection))
}
