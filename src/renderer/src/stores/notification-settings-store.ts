import { create } from 'zustand'
import {
  NOTIFICATION_SETTINGS_KEY,
  readNotificationPreferences,
  type NotificationCategory,
  type NotificationChannel,
  type NotificationPreferences
} from '@shared/notifications'

interface NotificationSettingsState {
  preferences: NotificationPreferences
  loaded: boolean
  error: boolean
  hydrate: () => Promise<void>
  setChannel: (category: NotificationCategory, channel: NotificationChannel, value: boolean) => void
}

let hydration: Promise<void> | undefined
let writes = Promise.resolve()
let savedPreferences = readNotificationPreferences(null)

export const useNotificationSettingsStore = create<NotificationSettingsState>((set, get) => ({
  preferences: readNotificationPreferences(null),
  loaded: false,
  error: false,
  hydrate: () => {
    if (get().loaded) return Promise.resolve()
    if (hydration) return hydration
    hydration = Promise.all(
      [NOTIFICATION_SETTINGS_KEY, 'alert_sound', 'alert_native'].map((key) =>
        window.nais.invoke('settings:get', { key })
      )
    )
      .then(([saved, sound, native]) => {
        savedPreferences = readNotificationPreferences(
          saved.value,
          sound.value === '1',
          native.value === '1'
        )
        set({
          preferences: savedPreferences,
          loaded: true,
          error: false
        })
      })
      .finally(() => {
        hydration = undefined
      })
    return hydration
  },
  setChannel: (category, channel, value) => {
    if (!get().loaded) return
    const previous = get().preferences
    const preferences = {
      ...previous,
      [category]: { ...previous[category], [channel]: value }
    }
    set({ preferences, error: false })
    // Serialize writes so rapidly toggling several channels cannot persist stale preferences.
    writes = writes.then(async () => {
      try {
        await window.nais.invoke('settings:set', {
          key: NOTIFICATION_SETTINGS_KEY,
          value: JSON.stringify(preferences)
        })
        savedPreferences = preferences
        if (get().preferences === preferences) set({ error: false })
      } catch {
        // A later edit has its own pending save; only roll back the current edit.
        if (get().preferences === preferences) set({ preferences: savedPreferences })
        set({ error: true })
      }
    })
  }
}))
