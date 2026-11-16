export const NOTIFICATION_CATEGORIES = ['generation', 'error', 'info', 'success', 'update'] as const
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number]
export type NotificationChannel = 'toast' | 'sound' | 'native'
export type NotificationChannels = Record<NotificationChannel, boolean>
export type NotificationPreferences = Record<NotificationCategory, NotificationChannels>

export const NOTIFICATION_SETTINGS_KEY = 'notification_preferences'

/** Read old completion preferences without rewriting or deleting their stable storage keys. */
export function readNotificationPreferences(
  raw: string | null,
  legacySound = false,
  legacyNative = false
): NotificationPreferences {
  const preferences: NotificationPreferences = {
    generation: { toast: false, sound: legacySound, native: legacyNative },
    error: { toast: true, sound: false, native: false },
    info: { toast: true, sound: false, native: false },
    success: { toast: true, sound: false, native: false },
    update: { toast: true, sound: false, native: false }
  }
  let saved: unknown
  try {
    saved = raw ? JSON.parse(raw) : null
  } catch {
    return preferences
  }
  if (!saved || typeof saved !== 'object') return preferences
  for (const category of NOTIFICATION_CATEGORIES) {
    const channels = (saved as Record<string, unknown>)[category]
    if (!channels || typeof channels !== 'object') continue
    for (const channel of ['toast', 'sound', 'native'] as const) {
      const value = (channels as Record<string, unknown>)[channel]
      if (typeof value === 'boolean') preferences[category][channel] = value
    }
  }
  return preferences
}
