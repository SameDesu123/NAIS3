// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { QueueItem, QueueItemState, QueueStatus } from '../src/shared/types'

const { notifyQueueDone, notify } = vi.hoisted(() => ({
  notifyQueueDone: vi.fn(),
  notify: vi.fn()
}))
vi.mock('../src/renderer/src/lib/notifications', () => ({ notifyQueueDone, notify }))

const { bindGenerationEvents, useGenerationStore } =
  await import('../src/renderer/src/stores/generation-store')

function item(id: string, state: QueueItemState): QueueItem {
  return { id, state, request: {} as QueueItem['request'], filePath: `/${id}.png` }
}

function status(items: QueueItem[]): QueueStatus {
  return { items, running: items.some((i) => i.state === 'pending'), delayMs: 0 }
}

describe('bindGenerationEvents batch completion alert', () => {
  let emitQueue: (queue: QueueStatus) => void
  let unbind: () => void
  let handlers: Map<string, (payload: unknown) => void>

  beforeEach(() => {
    vi.useFakeTimers()
    notifyQueueDone.mockClear()
    notify.mockClear()
    handlers = new Map()
    Object.defineProperty(window, 'nais', {
      configurable: true,
      value: {
        invoke: vi.fn(async () => ({ items: [], total: 0 })),
        on: vi.fn((channel: string, handler: (payload: unknown) => void) => {
          handlers.set(channel, handler)
          if (channel === 'queue:changed') emitQueue = handler
          return () => {}
        })
      }
    })
    useGenerationStore.setState({ queue: status([item('old', 'done')]) })
    unbind = bindGenerationEvents()
  })

  afterEach(() => {
    unbind()
    vi.useRealTimers()
  })

  it("counts only this batch's done/failed items even after old finished items are pruned", () => {
    emitQueue(status([item('old', 'done'), item('a', 'pending'), item('b', 'pending')]))
    emitQueue(status([item('old', 'done'), item('a', 'generating'), item('b', 'pending')]))
    // Broadcast after main pruned 'old' — cumulative counting would go wrong here
    emitQueue(status([item('a', 'done'), item('b', 'pending')]))
    emitQueue(status([item('a', 'done'), item('b', 'generating')]))
    emitQueue(status([item('b', 'failed')]))

    expect(notifyQueueDone).toHaveBeenCalledTimes(1)
    expect(notifyQueueDone).toHaveBeenCalledWith(1, 1)
  })

  it('restarts the count from zero for the next batch', () => {
    emitQueue(status([item('a', 'pending')]))
    emitQueue(status([item('a', 'done')]))
    emitQueue(status([item('a', 'done'), item('b', 'pending')]))
    emitQueue(status([item('a', 'done'), item('b', 'done')]))

    expect(notifyQueueDone.mock.calls).toEqual([
      [1, 0],
      [1, 0]
    ])
  })
  it('emits one stopped event including the guard reason and remaining count', () => {
    emitQueue(status([item('a', 'pending'), item('b', 'pending')]))
    handlers.get('queue:halted')!({ reason: 'Daily cap', stopped: 1 })
    emitQueue(status([item('a', 'cancelled'), item('b', 'cancelled')]))
    expect(notifyQueueDone).toHaveBeenCalledOnce()
    expect(notifyQueueDone).toHaveBeenCalledWith(0, 0, expect.stringContaining('Daily cap'))
    expect(notify).not.toHaveBeenCalled()
  })

  it('does not report manual cancellation as successful completion', () => {
    emitQueue(status([item('a', 'pending')]))
    emitQueue(status([item('a', 'cancelled')]))
    expect(notifyQueueDone).not.toHaveBeenCalled()
  })

  it('groups simultaneous failures and announces retries only once per batch', () => {
    emitQueue(status([item('a', 'pending'), item('b', 'pending')]))
    emitQueue(status([{ ...item('a', 'generating'), retrying: true }, item('b', 'pending')]))
    emitQueue(status([{ ...item('a', 'generating'), retrying: true }, item('b', 'pending')]))
    expect(notify).toHaveBeenCalledOnce()
    emitQueue(
      status([
        { ...item('a', 'failed'), error: 'Network' },
        { ...item('b', 'failed'), error: 'Network' }
      ])
    )
    vi.advanceTimersByTime(500)
    expect(notify).toHaveBeenCalledTimes(2)
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining('Network'), 'error')
  })
})
