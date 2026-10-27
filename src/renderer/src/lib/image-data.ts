import { useEffect, useState } from 'react'

/**
 * base64 PNG를 원본 해상도의 ImageData로 해독한다 (로컬 편집 툴의 색 샘플링·합성 소스).
 * enabled가 꺼져 있으면 해독을 미룬다 — 페이지 넘김 중에 큰 이미지를 해독하면 애니메이션이 끊긴다.
 * 입력이 바뀌면 이전 결과는 버리고 새로 해독이 끝날 때까지 null.
 */
export function useImageData(
  base64: string,
  width: number,
  height: number,
  enabled = true
): ImageData | null {
  const [loaded, setLoaded] = useState<{ base64: string; data: ImageData } | null>(null)

  useEffect(() => {
    if (!enabled) return
    let alive = true
    const img = new Image()
    img.onload = () => {
      if (!alive) return
      const off = document.createElement('canvas')
      off.width = width
      off.height = height
      const ctx = off.getContext('2d')
      if (!ctx) return
      ctx.drawImage(img, 0, 0, width, height)
      setLoaded({ base64, data: ctx.getImageData(0, 0, width, height) })
    }
    img.src = `data:image/png;base64,${base64}`
    return () => {
      alive = false
    }
  }, [enabled, base64, width, height])

  const data = loaded?.base64 === base64 ? loaded.data : null
  return data && data.width === width && data.height === height ? data : null
}

/** ImageData → base64 PNG (data URL 접두어 제외) */
export function imageDataToBase64(data: ImageData): string {
  const canvas = document.createElement('canvas')
  canvas.width = data.width
  canvas.height = data.height
  canvas.getContext('2d')!.putImageData(data, 0, 0)
  return canvas.toDataURL('image/png').split(',')[1]
}
