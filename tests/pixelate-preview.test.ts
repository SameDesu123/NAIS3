// @vitest-environment happy-dom
import { act, createElement as h, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PixelBuffer } from '../src/renderer/src/lib/pixelate'
import { pixelateSmall } from '../src/renderer/src/lib/pixelate'
import { usePixelatePreview } from '../src/renderer/src/lib/pixelate-preview'
import type {
  PixelatePreviewOptions,
  PixelateWorkerRequest
} from '../src/renderer/src/lib/pixelate.worker'

const SIZE = 16
const BASE64 = 'source-png'

function gradient(size: number): PixelBuffer {
  const data = new Uint8ClampedArray(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = (i * 7) & 255
    data[i * 4 + 1] = (i * 13) & 255
    data[i * 4 + 2] = (i * 29) & 255
    data[i * 4 + 3] = 255
  }
  return { data, width: size, height: size }
}

const SOURCE = gradient(SIZE)

// happy-dom은 이미지를 해독하지 못한다 — 메인 스레드 해독은 원본 버퍼를 돌려주는 것으로 대신한다
const decodedOnMainThread = vi.fn()
vi.mock('../src/renderer/src/lib/image-data', () => ({
  useImageData: (base64: string, _w: number, _h: number, enabled: boolean) => {
    if (enabled) decodedOnMainThread(base64)
    return enabled ? SOURCE : null
  }
}))

let root: Root
let container: HTMLDivElement
let latest: ReturnType<typeof usePixelatePreview>

function Probe({ enabled, opts }: { enabled: boolean; opts: PixelatePreviewOptions }): null {
  const result = usePixelatePreview(BASE64, SIZE, SIZE, enabled, opts)
  useEffect(() => {
    latest = result
  })
  return null
}

const render = (opts: PixelatePreviewOptions, enabled = true): Promise<void> =>
  act(async () => root.render(h(Probe, { enabled, opts })))

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  root = createRoot(container)
  decodedOnMainThread.mockClear()
})

afterEach(async () => {
  await act(async () => root.unmount())
  vi.unstubAllGlobals()
})

describe('pixel art preview', () => {
  it('computes on the main thread when workers are unavailable', async () => {
    vi.stubGlobal('Worker', undefined)
    await render({ dot: 4, colors: 8, dither: false })
    expect(latest.fresh).toBe(true)
    expect(latest.preview?.small.width).toBe(4)
    expect(latest.preview?.opts.dot).toBe(4)
  })

  it('decodes and computes in a worker, keeps the stale result while busy and only computes the latest options', async () => {
    const workers: FakeWorker[] = []
    class FakeWorker {
      onmessage: ((e: { data: unknown }) => void) | null = null
      onerror: (() => void) | null = null
      source: string | null = null
      runs: PixelateWorkerRequest[] = []
      constructor() {
        workers.push(this)
      }
      postMessage(msg: PixelateWorkerRequest): void {
        if (msg.type === 'source') this.source = msg.base64
        else this.runs.push(msg)
      }
      terminated = false
      terminate(): void {
        this.terminated = true
      }
      /** 대기 중인 요청 하나를 계산해 돌려준다 */
      async finish(): Promise<void> {
        const msg = this.runs.shift()
        if (msg?.type !== 'run') throw new Error('no run pending')
        const result = pixelateSmall(SOURCE, msg.opts)
        await act(async () => this.onmessage?.({ data: { key: msg.key, result } }))
      }
    }
    vi.stubGlobal('Worker', FakeWorker)

    // 페이지 넘김 중엔 시작하지 않는다
    await render({ dot: 4, colors: 8, dither: false }, false)
    expect(workers).toHaveLength(0)

    await render({ dot: 4, colors: 8, dither: false })
    const worker = workers.at(-1)!
    // 원본은 base64 그대로 넘겨 워커가 해독한다 — 메인 스레드는 해독하지 않는다
    expect(worker.source).toBe(BASE64)
    expect(decodedOnMainThread).not.toHaveBeenCalled()
    expect(latest.preview).toBeNull()
    await worker.finish()
    expect(latest.fresh).toBe(true)

    // 계산 중에 옵션이 여러 번 바뀌면 이전 결과를 보여 주며 마지막 값만 이어서 계산한다
    await render({ dot: 2, colors: 8, dither: false })
    await render({ dot: 3, colors: 8, dither: false })
    await render({ dot: 8, colors: 16, dither: true })
    expect(latest.fresh).toBe(false)
    expect(latest.preview?.opts.dot).toBe(4)
    await worker.finish()
    expect(latest.preview?.opts.dot).toBe(2)
    expect(latest.fresh).toBe(false)
    expect(worker.runs).toHaveLength(1)
    await worker.finish()
    expect(latest.preview?.opts).toEqual({ dot: 8, colors: 16, dither: true })
    expect(latest.fresh).toBe(true)
    expect(worker.runs).toHaveLength(0)
  })

  it('reports a failed computation and keeps computing later options', async () => {
    const workers: {
      onmessage: ((e: { data: unknown }) => void) | null
      runs: PixelateWorkerRequest[]
    }[] = []
    vi.stubGlobal(
      'Worker',
      class {
        onmessage: ((e: { data: unknown }) => void) | null = null
        onerror: (() => void) | null = null
        runs: PixelateWorkerRequest[] = []
        constructor() {
          workers.push(this)
        }
        postMessage(msg: PixelateWorkerRequest): void {
          if (msg.type === 'run') this.runs.push(msg)
        }
        terminate(): void {
          this.onmessage = null
        }
      }
    )
    await render({ dot: 1, colors: 1024, dither: true })
    const worker = workers.at(-1)!
    // 계산 중에 바꾼 옵션은 실패 뒤에도 이어서 계산한다
    await render({ dot: 4, colors: 8, dither: false })
    const failedRun = worker.runs.shift()!
    if (failedRun.type !== 'run') throw new Error('expected a run')
    await act(async () => worker.onmessage?.({ data: { key: failedRun.key, error: 'RangeError' } }))
    expect(decodedOnMainThread).not.toHaveBeenCalled()
    expect(latest.failed).toBe(false)
    expect(worker.runs).toHaveLength(1)

    // 지금 옵션이 실패하면 failed — 계산 중 표시를 멈추고 다음 변경은 다시 보낸다
    const second = worker.runs.shift()!
    if (second.type !== 'run') throw new Error('expected a run')
    await act(async () => worker.onmessage?.({ data: { key: second.key, error: 'RangeError' } }))
    expect(latest.failed).toBe(true)
    expect(latest.fresh).toBe(false)
    await render({ dot: 8, colors: 8, dither: false })
    expect(worker.runs).toHaveLength(1)
    expect(latest.failed).toBe(false)
  })

  it.each([
    ['fires onerror', (w: FakeFailingWorker) => w.onerror?.()],
    ['cannot decode the image', (w: FakeFailingWorker) => w.onmessage?.({ data: { error: 'x' } })]
  ])('falls back to the main thread when the worker %s', async (_, fail) => {
    let created: FakeFailingWorker | null = null
    vi.stubGlobal(
      'Worker',
      class implements FakeFailingWorker {
        onerror: (() => void) | null = null
        onmessage: ((e: { data: unknown }) => void) | null = null
        constructor() {
          // eslint-disable-next-line @typescript-eslint/no-this-alias
          created = this
        }
        posted = 0
        postMessage(): void {
          this.posted++
        }
        terminate(): void {
          this.onerror = null
        }
      }
    )
    await render({ dot: 4, colors: 8, dither: false })
    expect(latest.preview).toBeNull()
    await act(async () => fail(created!))
    expect(decodedOnMainThread).toHaveBeenCalledWith(BASE64)
    expect(latest.fresh).toBe(true)
  })
})

interface FakeFailingWorker {
  onerror: (() => void) | null
  onmessage: ((e: { data: unknown }) => void) | null
}
