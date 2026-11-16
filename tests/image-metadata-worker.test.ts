import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MetadataRequest } from '../src/main/images/metadata-messages'

const state = vi.hoisted(() => ({ workers: [] as MockWorker[] }))

class MockWorker extends EventEmitter {
  requests: MetadataRequest[] = []
  unref = vi.fn()
  terminate = vi.fn(async () => 0)
  postMessage = vi.fn((request: MetadataRequest) => this.requests.push(request))
}

vi.mock('worker_threads', () => ({
  Worker: class extends MockWorker {
    constructor() {
      super()
      state.workers.push(this)
    }
  }
}))
vi.mock('../src/main/images/metadata.worker?modulePath', () => ({ default: '/metadata.worker.js' }))

describe('image metadata worker lifecycle', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    state.workers = []
  })
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('routes concurrent responses by request id without transferring original buffers', async () => {
    const { readImageMetadata } = await import('../src/main/images/metadata')
    const original = Buffer.from('original image')
    const first = readImageMetadata({ image: original })
    const second = readImageMetadata({ image: 'base64' })
    expect(state.workers).toHaveLength(1)
    const worker = state.workers[0]
    const [a, b] = worker.requests
    worker.emit('message', { id: b.id, meta: { prompt: 'second' } })
    worker.emit('message', { id: a.id, meta: { prompt: 'first' } })
    await expect(first).resolves.toEqual({ prompt: 'first' })
    await expect(second).resolves.toEqual({ prompt: 'second' })
    expect(worker.postMessage.mock.calls[0]).toHaveLength(1)
    expect(original.toString()).toBe('original image')
  })

  it('keeps a busy worker and releases it only after the last request has been idle', async () => {
    const { readImageMetadata } = await import('../src/main/images/metadata')
    const first = readImageMetadata({ image: 'first' })
    const worker = state.workers[0]
    vi.advanceTimersByTime(120_000)
    expect(worker.terminate).not.toHaveBeenCalled()
    worker.emit('message', { id: worker.requests[0].id, meta: null })
    await first
    vi.advanceTimersByTime(59_000)
    const second = readImageMetadata({ image: 'second' })
    vi.advanceTimersByTime(2_000)
    expect(worker.terminate).not.toHaveBeenCalled()
    worker.emit('message', { id: worker.requests[1].id, meta: null })
    await second
    vi.advanceTimersByTime(60_000)
    expect(worker.terminate).toHaveBeenCalledOnce()
    const third = readImageMetadata({ image: 'third' })
    expect(state.workers).toHaveLength(2)
    // A late exit from the retired worker must not reject the new worker's requests.
    worker.emit('exit', 1)
    const replacement = state.workers[1]
    replacement.emit('message', { id: replacement.requests[0].id, meta: null })
    await expect(third).resolves.toBeNull()
  })

  it.each(['error', 'exit'])(
    'rejects pending requests on %s and restarts on demand',
    async (event) => {
      const { readImageMetadata } = await import('../src/main/images/metadata')
      const first = readImageMetadata({ image: 'first' })
      const second = readImageMetadata({ image: 'second' })
      const results = Promise.allSettled([first, second])
      state.workers[0].emit(event, event === 'error' ? new Error('worker failed') : 0)
      expect(await results).toEqual([
        expect.objectContaining({ status: 'rejected' }),
        expect.objectContaining({ status: 'rejected' })
      ])
      const next = readImageMetadata({ image: 'next' })
      const worker = state.workers[1]
      worker.emit('message', { id: worker.requests[0].id, meta: null })
      await expect(next).resolves.toBeNull()
    }
  )

  it('reports request errors without losing other requests', async () => {
    const { readImageMetadata } = await import('../src/main/images/metadata')
    const bad = readImageMetadata({ image: 'bad' })
    const good = readImageMetadata({ image: 'good' })
    const rejected = expect(bad).rejects.toThrow('cannot decode')
    const worker = state.workers[0]
    worker.emit('message', { id: worker.requests[0].id, error: 'cannot decode' })
    worker.emit('message', { id: worker.requests[1].id, meta: null })
    await rejected
    await expect(good).resolves.toBeNull()
  })
})
