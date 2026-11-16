// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NOTIFICATION_SETTINGS_KEY, readNotificationPreferences } from '../src/shared/notifications'
import type { NaisApi } from '../src/preload/index'
import { useNotificationSettingsStore } from '../src/renderer/src/stores/notification-settings-store'
import { useToastStore } from '../src/renderer/src/stores/toast-store'
import { notify, notifyQueueDone } from '../src/renderer/src/lib/notifications'
import { bindUpdateEvents, useUpdateStore } from '../src/renderer/src/stores/update-store'

const { playChime } = vi.hoisted(() => ({ playChime: vi.fn() }))
vi.mock('../src/renderer/src/lib/notification-sound', () => ({ playChime }))
const invoke = vi.fn()
let clock = 10000

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime((clock += 10000))
  playChime.mockClear()
  invoke.mockReset().mockResolvedValue({ shown: false, value: null })
  window.nais = { invoke, on: () => () => {} } as NaisApi
  useNotificationSettingsStore.setState({
    preferences: readNotificationPreferences(null),
    loaded: true,
    error: false
  })
  useUpdateStore.setState({ status: 'idle', version: undefined, message: undefined, percent: 0 })
})

afterEach(() => {
  for (const toast of useToastStore.getState().toasts) useToastStore.getState().dismiss(toast.id)
  vi.useRealTimers()
})

const flush = (): Promise<void> => vi.advanceTimersByTimeAsync(0)

describe('notification preferences', () => {
  it('inherits existing completion preferences and validates new stored values', () => {
    expect(readNotificationPreferences(null, true, true).generation).toEqual({
      toast: true,
      sound: true,
      native: true
    })
    const preferences = readNotificationPreferences(
      '{"generation":{"sound":false},"error":{"toast":"0","native":true}}',
      true,
      true
    )
    expect(preferences.generation).toEqual({ toast: true, sound: false, native: true })
    expect(preferences.error).toEqual({ toast: true, sound: false, native: true })
    expect(readNotificationPreferences('broken', true).generation.sound).toBe(true)
  })

  it('loads legacy values once even for concurrent notifications', async () => {
    useNotificationSettingsStore.setState({ loaded: false })
    invoke.mockImplementation(async (_channel, req) => ({
      value: req.key === 'alert_sound' ? '1' : null
    }))
    notify('first load')
    notify('concurrent load')
    await flush()
    expect(invoke).toHaveBeenCalledTimes(3)
    expect(useNotificationSettingsStore.getState().preferences.generation.sound).toBe(true)
  })

  it('persists rapid edits in order and restores the last saved values on failure', async () => {
    useNotificationSettingsStore.setState({ loaded: false })
    await useNotificationSettingsStore.getState().hydrate()
    const store = useNotificationSettingsStore.getState()
    invoke.mockClear()
    store.setChannel('info', 'sound', true)
    store.setChannel('info', 'native', true)
    await flush()
    const saved = invoke.mock.calls.map(([, req]) => JSON.parse(req.value))
    expect(saved.map((p) => p.info)).toEqual([
      { toast: true, sound: true, native: false },
      { toast: true, sound: true, native: true }
    ])
    expect(invoke).toHaveBeenLastCalledWith(
      'settings:set',
      expect.objectContaining({ key: NOTIFICATION_SETTINGS_KEY })
    )
    invoke.mockRejectedValue(new Error('disk full'))
    store.setChannel('info', 'toast', false)
    store.setChannel('info', 'sound', false)
    await flush()
    expect(useNotificationSettingsStore.getState().preferences.info).toEqual({
      toast: true,
      sound: true,
      native: true
    })
    expect(useNotificationSettingsStore.getState().error).toBe(true)
  })
})

describe('central delivery', () => {
  it('uses in-app delivery while the native window is focused', async () => {
    const preferences = readNotificationPreferences(null)
    preferences.error = { toast: true, sound: true, native: true }
    useNotificationSettingsStore.setState({ preferences })
    notify('focused error', 'error')
    await flush()
    expect(invoke).toHaveBeenCalledWith('notifications:show', {
      title: 'NAIS3',
      body: 'focused error'
    })
    expect(useToastStore.getState().toasts[0].message).toBe('focused error')
    expect(playChime).toHaveBeenCalledOnce()
  })

  it('uses system delivery in the background without duplicating the toast', async () => {
    const preferences = readNotificationPreferences(null, true, true)
    useNotificationSettingsStore.setState({ preferences })
    invoke.mockResolvedValue({ shown: true })
    notifyQueueDone(4, 1, 'Daily cap')
    await flush()
    expect(useToastStore.getState().toasts).toHaveLength(0)
    expect(invoke).toHaveBeenCalledWith(
      'notifications:show',
      expect.objectContaining({ body: expect.stringContaining('Daily cap') })
    )
    expect(playChime).toHaveBeenCalledOnce()
  })

  it('deduplicates repeated events across all channels but keeps separate batch completions', async () => {
    const preferences = readNotificationPreferences(null, true)
    preferences.error.sound = true
    useNotificationSettingsStore.setState({ preferences })
    notify('same error', 'error')
    notify('same error', 'error')
    await flush()
    expect(playChime).toHaveBeenCalledOnce()
    expect(useToastStore.getState().toasts).toHaveLength(1)
    notifyQueueDone(1, 0)
    await flush()
    notifyQueueDone(1, 0)
    await flush()
    expect(playChime).toHaveBeenCalledTimes(3)
  })

  it('respects disabled channels and browser mode without requesting OS permissions', async () => {
    const preferences = readNotificationPreferences(null)
    preferences.success = { toast: false, sound: false, native: false }
    preferences.info.native = true
    useNotificationSettingsStore.setState({ preferences })
    window.nais.runtime = 'browser'
    notify('disabled success', 'success')
    notify('browser info')
    await flush()
    expect(invoke).not.toHaveBeenCalled()
    expect(playChime).not.toHaveBeenCalled()
    expect(useToastStore.getState().toasts.map((toast) => toast.message)).toEqual(['browser info'])
  })

  it('keeps visual delivery available after settings or native IPC failures', async () => {
    const preferences = readNotificationPreferences(null)
    preferences.error.native = true
    useNotificationSettingsStore.setState({ preferences })
    invoke.mockRejectedValue(new Error('unavailable'))
    notify('ipc failure', 'error')
    await flush()
    expect(useToastStore.getState().toasts[0].message).toBe('ipc failure')
    useNotificationSettingsStore.setState({ loaded: false })
    notify('settings failure', 'error')
    await flush()
    expect(useToastStore.getState().toasts).toHaveLength(2)
  })
})

describe('toast lifetime', () => {
  it('pauses auto-dismiss while interacting, including when a duplicate event arrives', async () => {
    const store = useToastStore.getState()
    store.push('read this', 'error')
    const id = useToastStore.getState().toasts[0].id
    store.pause(id)
    store.push('read this', 'error')
    await vi.advanceTimersByTimeAsync(10000)
    expect(useToastStore.getState().toasts).toHaveLength(1)
    store.resume(id)
    await vi.advanceTimersByTimeAsync(5000)
    expect(useToastStore.getState().toasts).toHaveLength(0)
  })

  it('bounds a burst of distinct messages without dismissing the focused message', () => {
    const store = useToastStore.getState()
    store.push('focused')
    const id = useToastStore.getState().toasts[0].id
    store.pause(id)
    for (let i = 0; i < 20; i++) store.push(`message ${i}`)
    expect(useToastStore.getState().toasts).toHaveLength(5)
    expect(useToastStore.getState().toasts.some((toast) => toast.id === id)).toBe(true)
  })
})

describe('update notifications', () => {
  it('notifies once per meaningful transition and keeps progress in the update store', async () => {
    let emit: (payload: unknown) => void = () => {}
    window.nais.on = vi.fn((_channel, handler) => {
      emit = handler
      return () => {}
    }) as NaisApi['on']
    const unbind = bindUpdateEvents()
    emit({ state: 'available', version: '2.0.0' })
    emit({ state: 'available', version: '2.0.0' })
    await flush()
    expect(useToastStore.getState().toasts).toHaveLength(1)
    emit({ state: 'downloading', percent: 20 })
    emit({ state: 'downloading', percent: 90 })
    await flush()
    expect(useToastStore.getState().toasts).toHaveLength(1)
    expect(useUpdateStore.getState().percent).toBe(90)
    emit({ state: 'error', message: 'Network' })
    await flush()
    expect(useUpdateStore.getState().message).toBe('Network')
    expect(useToastStore.getState().toasts.at(-1)?.message).toContain('Network')
    unbind()
  })
})
