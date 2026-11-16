import { useEffect } from 'react'
import { NOTIFICATION_CATEGORIES, type NotificationCategory } from '@shared/notifications'
import type { MessageId } from '@shared/i18n'
import { useT } from '../lib/i18n'
import { playChime } from '../lib/notification-sound'
import { useNotificationSettingsStore } from '../stores/notification-settings-store'
import { Button } from './ui/button'
import { Switch } from './ui/switch'

const LABELS: Record<NotificationCategory, MessageId> = {
  generation: 'ui.notificationGeneration',
  error: 'ui.notificationErrors',
  info: 'ui.notificationInfo',
  success: 'ui.notificationSuccess',
  update: 'ui.notificationUpdates'
}

export function NotificationSettings(): React.JSX.Element {
  const t = useT()
  const preferences = useNotificationSettingsStore((s) => s.preferences)
  const loaded = useNotificationSettingsStore((s) => s.loaded)
  const error = useNotificationSettingsStore((s) => s.error)
  const setChannel = useNotificationSettingsStore((s) => s.setChannel)
  const hydrate = useNotificationSettingsStore((s) => s.hydrate)
  const browser = window.nais.runtime === 'browser'

  useEffect(() => {
    void hydrate().catch(() => useNotificationSettingsStore.setState({ error: true }))
  }, [hydrate])

  return (
    <div className="min-w-0 space-y-4">
      <p className="text-[11.5px] leading-relaxed text-muted">{t('ui.notificationDeliveryHint')}</p>
      {browser && (
        <p className="text-[11.5px] text-faint">{t('ui.notificationNativeDesktopOnly')}</p>
      )}
      <div className="divide-y divide-line">
        {NOTIFICATION_CATEGORIES.map((category) => (
          <fieldset key={category} className="min-w-0 py-3 first:pt-0">
            <legend className="text-[13px] font-medium text-ink">{t(LABELS[category])}</legend>
            <div className="mt-2 flex flex-wrap gap-x-5 gap-y-3">
              {(['toast', 'sound', 'native'] as const).map((channel) => {
                const label = t(
                  channel === 'toast'
                    ? 'ui.notificationToast'
                    : channel === 'sound'
                      ? 'ui.notificationSound'
                      : 'ui.notificationNative'
                )
                const id = `notification-${category}-${channel}`
                return (
                  <label
                    key={channel}
                    htmlFor={id}
                    className="flex items-center gap-2 text-[11.5px] text-muted"
                  >
                    <Switch
                      id={id}
                      aria-label={t('ui.notificationChannelLabel', t(LABELS[category]), label)}
                      checked={preferences[category][channel]}
                      disabled={!loaded || (browser && channel === 'native')}
                      onCheckedChange={(value) => setChannel(category, channel, value)}
                    />
                    {label}
                  </label>
                )
              })}
            </div>
          </fieldset>
        ))}
      </div>
      <Button onClick={playChime}>{t('ui.notificationPreviewSound')}</Button>
      {error && (
        <p role="alert" className="text-[11.5px] text-danger-ink">
          {t('ui.notificationSettingsError')}
        </p>
      )}
    </div>
  )
}
