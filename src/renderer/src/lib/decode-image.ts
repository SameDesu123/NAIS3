import type { PixelBuffer } from './pixelate'

/**
 * base64 이미지 → 원본 해상도 RGBA. DOM 없이 돌아가 워커에서 쓴다 — 4K 이미지는 해독·픽셀 읽기만으로
 * 메인 스레드를 1초 가까이 막는다.
 */
export async function decodeImageBase64(
  base64: string,
  width: number,
  height: number
): Promise<PixelBuffer> {
  const bitmap = await createImageBitmap(new Blob([base64ToBytes(base64)]))
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('2d context unavailable')
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  return { data: ctx.getImageData(0, 0, width, height).data, width, height }
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const fromBase64 = (Uint8Array as { fromBase64?: (s: string) => Uint8Array<ArrayBuffer> })
    .fromBase64
  if (fromBase64) return fromBase64(base64)
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}
