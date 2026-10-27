import { decodeImageBase64 } from './decode-image'
import { pixelateSmall, type PixelBuffer, type PixelateOptions } from './pixelate'

/**
 * 도트화 미리보기 계산 워커 — 색 수가 많으면 k-means가 수억 번의 거리 계산까지 가므로
 * 렌더러 스레드에서 돌리면 계산 동안 화면·취소 버튼이 멈춘다.
 * 원본은 처음 한 번 base64로 받아 여기서 해독해 두고 (4K는 해독만으로 메인 스레드가 1초 가까이 멈춘다),
 * 이후 요청은 옵션만 주고받는다.
 */
export type PixelatePreviewOptions = Pick<PixelateOptions, 'dot' | 'colors' | 'dither' | 'tone'>

export type PixelateWorkerRequest =
  | { type: 'source'; base64: string; width: number; height: number }
  | { type: 'run'; key: string; opts: PixelatePreviewOptions }

export type PixelateWorkerResponse = { key: string; result: PixelBuffer } | { error: string }

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<PixelateWorkerRequest>) => void) | null
  postMessage: (message: PixelateWorkerResponse, transfer?: Transferable[]) => void
}

let source: Promise<PixelBuffer> | null = null

scope.onmessage = (e) => {
  const msg = e.data
  if (msg.type === 'source') {
    source = decodeImageBase64(msg.base64, msg.width, msg.height)
    return
  }
  if (!source) return
  source.then(
    (src) => {
      const result = pixelateSmall(src, msg.opts)
      scope.postMessage({ key: msg.key, result }, [result.data.buffer])
    },
    (err: unknown) => scope.postMessage({ error: String(err) })
  )
}
