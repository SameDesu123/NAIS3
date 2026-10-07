// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { QueueItem, QueueItemState, QueueStatus } from '../src/shared/types'

const queueDoneAlert = vi.fn(async () => {})
vi.mock('../src/renderer/src/lib/completion-alert', () => ({ queueDoneAlert }))

const { bindGenerationEvents, useGenerationStore } =
  await import('../src/renderer/src/stores/generation-store')

function item(id: string, state: QueueItemState): QueueItem {
  return { id, state, request: {} as QueueItem['request'], filePath: `/${id}.png` }
}

function status(items: QueueItem[]): QueueStatus {
  return { items, running: items.some((i) => i.state === 'pending'), delayMs: 0 }
}

describe('bindGenerationEvents 배치 완료 알림', () => {
  let emitQueue: (queue: QueueStatus) => void
  let unbind: () => void

  beforeEach(() => {
    queueDoneAlert.mockClear()
    Object.defineProperty(window, 'nais', {
      configurable: true,
      value: {
        invoke: vi.fn(async () => ({ items: [], total: 0 })),
        on: vi.fn((channel: string, handler: (payload: unknown) => void) => {
          if (channel === 'queue:changed') emitQueue = handler
          return () => {}
        })
      }
    })
    useGenerationStore.setState({ queue: status([item('old', 'done')]) })
    unbind = bindGenerationEvents()
  })

  afterEach(() => unbind())

  it('오래된 종료 항목이 큐에서 지워져도 이번 배치의 완료·실패 수만 센다', () => {
    emitQueue(status([item('old', 'done'), item('a', 'pending'), item('b', 'pending')]))
    emitQueue(status([item('old', 'done'), item('a', 'generating'), item('b', 'pending')]))
    // 메인이 'old'를 정리한 뒤의 방송 — 누적 개수 방식이면 여기서 개수가 어긋난다
    emitQueue(status([item('a', 'done'), item('b', 'pending')]))
    emitQueue(status([item('a', 'done'), item('b', 'generating')]))
    emitQueue(status([item('b', 'failed')]))

    expect(queueDoneAlert).toHaveBeenCalledTimes(1)
    expect(queueDoneAlert).toHaveBeenCalledWith(1, 1)
  })

  it('다음 배치는 0부터 다시 센다', () => {
    emitQueue(status([item('a', 'pending')]))
    emitQueue(status([item('a', 'done')]))
    emitQueue(status([item('a', 'done'), item('b', 'pending')]))
    emitQueue(status([item('a', 'done'), item('b', 'done')]))

    expect(queueDoneAlert.mock.calls).toEqual([
      [1, 0],
      [1, 0]
    ])
  })
})
