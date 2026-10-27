import { useEffect, useMemo, useRef, useState } from 'react'
import { useImageData } from './image-data'
import { pixelateSmall, type PixelBuffer } from './pixelate'
import type {
  PixelatePreviewOptions,
  PixelateWorkerRequest,
  PixelateWorkerResponse
} from './pixelate.worker'

export interface PixelatePreview {
  /** 도트 1개 = 1픽셀인 축소·팔레트 결과 */
  small: PixelBuffer
  /** 이 결과를 만든 옵션 — 옵션을 바꾼 직후엔 이전 결과를 계속 보여 주므로 도트 크기는 여기서 읽는다 */
  opts: PixelatePreviewOptions
}

const keyOf = (o: PixelatePreviewOptions): string =>
  `${o.dot}/${o.colors}/${o.dither ? 1 : 0}/${o.tone ? `${o.tone.ramp.join(',')}@${o.tone.strength}` : ''}`

/**
 * 도트화 미리보기를 워커에서 계산한다 — 색 수가 많으면 계산이 수백 ms를 넘어 렌더러에서 돌리면 화면이 멈춘다.
 * 원본 해독도 워커가 한다. enabled가 꺼져 있으면 시작하지 않는다 (페이지 넘김 중).
 * 계산 중에 옵션이 여러 번 바뀌면 마지막 값만 이어서 계산한다.
 * fresh는 결과가 지금 옵션과 일치하는지 — 아니면 이전 결과를 보여 주는 중이다.
 * 워커를 쓸 수 없는 환경(테스트 등)이나 워커가 실패하면 메인 스레드에서 계산한다.
 */
export function usePixelatePreview(
  base64: string,
  width: number,
  height: number,
  enabled: boolean,
  opts: PixelatePreviewOptions
): { preview: PixelatePreview | null; fresh: boolean } {
  const [preview, setPreview] = useState<PixelatePreview | null>(null)
  const [useWorker, setUseWorker] = useState(() => typeof Worker !== 'undefined')
  const send = useRef<((o: PixelatePreviewOptions) => void) | null>(null)
  const key = keyOf(opts)

  useEffect(() => {
    if (!enabled || !useWorker) return
    let worker: Worker
    try {
      worker = new Worker(new URL('./pixelate.worker.ts', import.meta.url), { type: 'module' })
    } catch {
      queueMicrotask(() => setUseWorker(false))
      return
    }
    const requested = new Map<string, PixelatePreviewOptions>()
    let busy = false
    let pending: PixelatePreviewOptions | null = null
    const post = (o: PixelatePreviewOptions): void => {
      busy = true
      requested.set(keyOf(o), o)
      worker.postMessage({ type: 'run', key: keyOf(o), opts: o } satisfies PixelateWorkerRequest)
    }
    send.current = (o) => {
      if (busy) pending = o
      else post(o)
    }
    worker.onmessage = (e: MessageEvent<PixelateWorkerResponse>) => {
      if ('error' in e.data) {
        setUseWorker(false)
        return
      }
      const o = requested.get(e.data.key)
      requested.delete(e.data.key)
      if (o) setPreview({ small: e.data.result, opts: o })
      busy = false
      const next = pending
      pending = null
      if (next) post(next)
    }
    worker.onerror = () => setUseWorker(false)

    worker.postMessage({ type: 'source', base64, width, height } satisfies PixelateWorkerRequest)
    return () => {
      send.current = null
      worker.terminate()
    }
  }, [base64, width, height, enabled, useWorker])

  // tone은 객체라 호출하는 쪽에서 useMemo로 고정해 넘긴다 — 렌더마다 새로 만들면 매번 다시 계산한다
  const { dot, colors, dither, tone } = opts
  useEffect(() => {
    send.current?.({ dot, colors, dither, tone })
  }, [base64, width, height, enabled, useWorker, dot, colors, dither, tone])

  // 워커 없이 계산하는 경우 — 원본을 이쪽에서 해독해 렌더 중에 바로 만든다
  const source = useImageData(base64, width, height, enabled && !useWorker)
  const fallback = useMemo<PixelatePreview | null>(() => {
    if (useWorker || !source) return null
    const o = { dot, colors, dither, tone }
    return { small: pixelateSmall(source, o), opts: o }
  }, [useWorker, source, dot, colors, dither, tone])

  const shown = fallback ?? preview
  return { preview: shown, fresh: shown != null && keyOf(shown.opts) === key }
}
