import type { NotificationCategory } from '@shared/notifications'
import { useNotificationSettingsStore } from '../stores/notification-settings-store'
import { useToastStore, type ToastType } from '../stores/toast-store'
import { t } from './i18n'
import { playChime } from './notification-sound'

interface NotificationOptions {
  category?: NotificationCategory
  title?: string
  /** Explicit keys deduplicate an event, e.g. repeated update-available broadcasts. */
  dedupeKey?: string
  /** A batch completion has a unique identity even when its counts match the previous batch. */
  dedupe?: boolean
}

const recent = new Map<string, number>()

/** The only notification entry point. Producers describe an event; delivery follows preferences. */
export function notify(
  message: string,
  type: ToastType = 'info',
  options: NotificationOptions = {}
): void {
  const category = options.category ?? type
  const now = Date.now()
  for (const [key, time] of recent) {
    if (now - time >= 1500) recent.delete(key)
  }
  const key = options.dedupeKey ?? `${category}:${type}:${message}`
  if (options.dedupe !== false) {
    if (recent.has(key)) return
    recent.set(key, now)
  }
  void deliver().catch(() => {
    // Settings or native IPC failure must not make an error disappear.
    useToastStore.getState().push(message, type)
  })

  async function deliver(): Promise<void> {
    try {
      await useNotificationSettingsStore.getState().hydrate()
    } catch {
      // Keep the in-memory defaults and retry loading on the next notification.
    }
    const channels = useNotificationSettingsStore.getState().preferences[category]
    let shown = false
    if (channels.native && window.nais.runtime !== 'browser') {
      try {
        const result = await window.nais.invoke('notifications:show', {
          title: options.title ?? 'NAIS3',
          body: message
        })
        shown = result.shown
      } catch {
        // Fall back to the enabled in-app channel if native delivery fails.
      }
    }
    if (channels.toast && !shown) useToastStore.getState().push(message, type)
    if (channels.sound) playChime()
  }
}

export function notifyQueueDone(done: number, failed: number, stopped?: string): void {
  const counts =
    failed > 0 ? t('ui.valueImagesDoneValueFailed', done, failed) : t('ui.valueImagesDone', done)
  notify(stopped ? `${counts}\n${stopped}` : counts, stopped || failed > 0 ? 'error' : 'success', {
    category: stopped ? 'error' : 'generation',
    title: stopped ? t('ui.nais3GenerationStopped') : t('ui.nais3GenerationComplete'),
    dedupe: false
  })
}
