import { decodeImageBase64 } from './decode-image'

/** 이미지 해독 워커 — 결과 버퍼는 복사 없이 넘긴다 */
export interface ImageDecodeRequest {
  base64: string
  width: number
  height: number
}

export type ImageDecodeResponse = { data: Uint8ClampedArray<ArrayBuffer> } | { error: string }

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<ImageDecodeRequest>) => void) | null
  postMessage: (message: ImageDecodeResponse, transfer?: Transferable[]) => void
}

scope.onmessage = (e) => {
  const { base64, width, height } = e.data
  decodeImageBase64(base64, width, height).then(
    ({ data }) => scope.postMessage({ data }, [data.buffer]),
    (err: unknown) => scope.postMessage({ error: String(err) })
  )
}
