import { decode as msgpackDecode } from '@msgpack/msgpack'

/**
 * generate-image-stream 응답 파서.
 * 포맷: [4바이트 길이(빅엔디언)][msgpack 메시지] 반복.
 * 이벤트: intermediate(step_ix, image) → 진행 미리보기, final(image) → 완성본.
 * (NAIS2 novelai-api.ts의 검증된 파싱 로직을 Node 환경으로 이식)
 */
export interface StreamHandlers {
  onProgress?: (stepIx: number, previewPng?: Buffer) => void
  signal?: AbortSignal
}

export async function readImageStream(
  body: ReadableStream<Uint8Array>,
  handlers: StreamHandlers = {}
): Promise<Buffer> {
  const reader = body.getReader()
  let buffer = new Uint8Array(0)
  let finalImage: Buffer | null = null
  let apiError: string | null = null

  try {
    while (true) {
      if (handlers.signal?.aborted) {
        await reader.cancel()
        throw new DOMException('Aborted', 'AbortError')
      }
      const { done, value } = await reader.read()
      if (value) {
        const merged = new Uint8Array(buffer.length + value.length)
        merged.set(buffer)
        merged.set(value, buffer.length)
        buffer = merged

        while (buffer.length >= 4) {
          const length = (buffer[0] << 24) | (buffer[1] << 16) | (buffer[2] << 8) | buffer[3]
          if (length <= 0 || length > 50_000_000) {
            throw new Error(`잘못된 스트림 메시지 길이: ${length}`)
          }
          if (buffer.length < 4 + length) break

          const message = buffer.slice(4, 4 + length)
          buffer = buffer.slice(4 + length)

          const decoded = msgpackDecode(message) as Record<string, unknown>
          const eventType = decoded.event_type ?? decoded.event

          if (decoded.error || decoded.message) {
            apiError = String(decoded.error ?? decoded.message)
            await reader.cancel()
            throw new Error(`NAI 스트림 오류: ${apiError}`)
          }

          const image = decoded.image
          if (eventType === 'intermediate' && typeof decoded.step_ix === 'number') {
            handlers.onProgress?.(
              decoded.step_ix,
              image instanceof Uint8Array ? Buffer.from(image) : undefined
            )
          } else if (eventType === 'final' && image instanceof Uint8Array) {
            finalImage = Buffer.from(image)
          }
        }
      }
      if (done) break
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // 이미 해제됨
    }
  }

  if (!finalImage) {
    throw new Error(apiError ?? '스트림에서 최종 이미지를 받지 못함')
  }
  return finalImage
}
