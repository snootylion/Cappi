/** Browser half: per-session Live Voice button, overlay, transcript routing, and PCM playback. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { LiveVoiceControl, type LiveVoiceControlInjected } from './LiveVoiceControl.tsx'
import { DictateControl } from './DictateControl.tsx'
import { liveVoiceController } from './controller.ts'
import { dictateController } from './dictate.ts'
import { LiveVoiceSettingsSection } from './settings.tsx'
import { connectFloatingVoicePanelHost } from './native-host.ts'
import { installStyles } from './styles.ts'

export const name = 'dsh-live-voice-kokoro-client'
export const inject = ['slots', 'sessions']

function resolveVoiceSession(ctx: ClientContext, sessionId: SessionFace['sessionId']): LiveVoiceControlInjected {
  const session = ctx.sessions.binding(sessionId)?.session
  if (!session) throw new Error(`Kokoro Live Voice could not resolve session ${sessionId}.`)
  return { session: session as SessionFace }
}

export function apply(ctx: ClientContext): void {
  liveVoiceController.connect()
  dictateController.connect()
  ctx.effect(connectFloatingVoicePanelHost, 'dsh-live-voice-kokoro: floating desktop panel')
  ctx.effect(installStyles, 'dsh-live-voice-kokoro: browser styles')
  ctx.effect(() => {
    const handleNativeCommand = (event: Event) => {
      const command = (event as CustomEvent<unknown>).detail
      if (command === 'mute') void liveVoiceController.toggleMuted()
      if (command === 'end') void liveVoiceController.stop()
    }
    window.addEventListener('dsh-kokoro-native-command', handleNativeCommand)
    return () => window.removeEventListener('dsh-kokoro-native-command', handleNativeCommand)
  }, 'dsh-live-voice-kokoro: native overlay commands')
  // Live Voice lives ONLY in the session header (the top wave button that
  // opens the floating voice widget). It is intentionally absent from the
  // chat box: the composer carries the STT-only dictate mic instead.
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'kokoro-live-voice',
    order: 80,
    inject: (sessionId): LiveVoiceControlInjected => resolveVoiceSession(ctx, sessionId),
  }, LiveVoiceControl))
  // Dictate mic in the chat box (hero + active composer): built-in Mac STT
  // (Apple on-device Speech via the local input helper). STT-only: finals are
  // appended to the composer draft for manual editing, never auto-sent.
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'kokoro-dictate',
    order: 11,
  }, DictateControl))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'live-voice',
    order: 14,
    label: () => 'Live Voice',
  }, LiveVoiceSettingsSection))
}
