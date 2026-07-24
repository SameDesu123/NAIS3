import { describe, expect, it, vi } from 'vitest'
import type { GenerationRequest } from '../src/shared/types'
import { GenerationQueue } from '../src/main/queue/generation-queue'

/** NaiHttpError를 흉내낸 최소 오류 — 큐는 status 필드만 본다 */
class HttpErr extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs?: number
  ) {
    super(`http ${status}`)
    this.name = 'NaiHttpError'
  }
}

const REQ = {} as GenerationRequest // count=1이면 seed 접근 없음

describe('GenerationQueue 재시도', () => {
  it('전이성 오류(429)는 백오프 후 재시도해 성공한다', async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      const q = new GenerationQueue(async () => {
        calls++
        if (calls === 1) throw new HttpErr(429)
        return '/img.png'
      })
      // 방출 시점의 값을 즉시 읽어 기록 (items 객체는 재사용되므로 나중에 읽으면 뒤덮임)
      const retryingSeen: boolean[] = []
      q.on('changed', (s) => retryingSeen.push(!!s.items[0]?.retrying))
      q.enqueue(REQ, 1)
      await vi.runAllTimersAsync()

      expect(calls).toBe(2)
      expect(q.status().items[0].state).toBe('done')
      expect(q.status().items[0].filePath).toBe('/img.png')
      // 대기 중 retrying=true가 한 번은 방송됐다 (UI 안내용)
      expect(retryingSeen.some(Boolean)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('4xx 클라이언트 오류는 재시도하지 않고 즉시 실패한다', async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      const q = new GenerationQueue(async () => {
        calls++
        throw new HttpErr(400)
      })
      q.enqueue(REQ, 1)
      await vi.runAllTimersAsync()

      expect(calls).toBe(1)
      expect(q.status().items[0].state).toBe('failed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('전이성 오류가 계속되면 재시도를 소진하고 실패한다 (1 + 3회)', async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      const q = new GenerationQueue(async () => {
        calls++
        throw new HttpErr(503)
      })
      q.enqueue(REQ, 1)
      await vi.runAllTimersAsync()

      expect(calls).toBe(4)
      expect(q.status().items[0].state).toBe('failed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('백오프 대기 중 취소하면 즉시 취소되고 더는 호출하지 않는다', async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      const q = new GenerationQueue(async () => {
        calls++
        throw new HttpErr(429)
      })
      const [id] = q.enqueue(REQ, 1)
      // 첫 시도 실패 + 백오프 진입까지만 진행 (백오프 최소 2s라 타이머는 미만료)
      await vi.advanceTimersByTimeAsync(10)
      q.cancel([id])
      await vi.runAllTimersAsync()

      expect(calls).toBe(1)
      expect(q.status().items[0].state).toBe('cancelled')
    } finally {
      vi.useRealTimers()
    }
  })
})
