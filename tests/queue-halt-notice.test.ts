// @vitest-environment happy-dom
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GenerationQueue } from '../src/main/queue/generation-queue'
import { QueueHaltNotice } from '../src/renderer/src/components/queue-halt-notice'
import { Toaster } from '../src/renderer/src/components/toaster'
import {
  bindGenerationEvents,
  useGenerationStore
} from '../src/renderer/src/stores/generation-store'
import { useNotificationSettingsStore } from '../src/renderer/src/stores/notification-settings-store'
import { useToastStore } from '../src/renderer/src/stores/toast-store'
import { readNotificationPreferences } from '../src/shared/notifications'
import type { NaisApi } from '../src/preload/index'

let root: Root
let container: HTMLDivElement
let unbind: () => void
let queue: GenerationQueue

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  queue = new GenerationQueue(async () => {
    throw Object.assign(new Error('Daily Anlas cap reached'), { haltQueue: true })
  })
  queue.setDelayMs(0)
  window.nais = {
    invoke: vi.fn(async () => ({ value: null })),
    on: (channel, handler) => {
      const event =
        channel === 'queue:changed' ? 'changed' : channel === 'queue:halted' ? 'halted' : channel
      queue.on(event, handler)
      return () => {
        queue.off(event, handler)
      }
    }
  } as NaisApi
  const preferences = readNotificationPreferences(null)
  for (const channels of Object.values(preferences))
    Object.assign(channels, { toast: false, sound: false, native: false })
  useNotificationSettingsStore.setState({ preferences, loaded: true })
  useGenerationStore.setState({ queue: queue.status(), queueHaltReason: null })
  unbind = bindGenerationEvents()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  unbind()
  await act(async () => root.unmount())
  for (const toast of useToastStore.getState().toasts) useToastStore.getState().dismiss(toast.id)
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('shows the real queue guard stop after the queue drains, even with every channel disabled', async () => {
  const order: string[] = []
  queue.on('halted', () => order.push('halted'))
  queue.on('changed', (status) => {
    if (status.items.every((item) => item.state === 'cancelled')) order.push('drained')
  })
  await act(async () => root.render(h('div', null, h(QueueHaltNotice), h(Toaster))))
  await act(async () => {
    queue.enqueue(useGenerationStore.getState().request, 2)
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(order[0]).toBe('halted')
  expect(order.slice(1)).toContain('drained')
  expect(container.querySelector('[role="status"]')?.textContent).toContain(
    'Daily Anlas cap reached'
  )
  expect(useGenerationStore.getState().queueHaltReason).toContain('1')
  expect(useToastStore.getState().toasts).toHaveLength(0)
  await act(async () => vi.advanceTimersByTimeAsync(60000))
  expect(container.textContent).toContain('Daily Anlas cap reached')
  await act(async () => container.querySelector('button')!.click())
  expect(useGenerationStore.getState().queueHaltReason).toBeNull()
  expect(container.textContent).not.toContain('Daily Anlas cap reached')
})
