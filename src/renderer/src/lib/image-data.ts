import { useEffect, useState } from 'react'
import type { ImageDecodeRequest, ImageDecodeResponse } from './image-decode.worker'

/**
 * base64 PNG를 원본 해상도의 ImageData로 해독한다 (로컬 편집 툴의 색 샘플링·합성 소스).
 * 해독은 워커에서 한다 — 4K 이미지는 해독·픽셀 읽기만으로 메인 스레드가 1초 가까이 멈춘다.
 * 워커를 쓸 수 없으면 메인 스레드에서 해독한다.
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
    const done = (data: ImageData): void => {
      if (alive) setLoaded({ base64, data })
    }
    const stopWorker = decodeInWorker(base64, width, height, done, () => {
      if (alive) decodeOnMainThread(base64, width, height, done)
    })
    return () => {
      alive = false
      stopWorker()
    }
  }, [enabled, base64, width, height])

  const data = loaded?.base64 === base64 ? loaded.data : null
  return data && data.width === width && data.height === height ? data : null
}

/** 워커에서 해독 — 워커를 만들 수 없거나 실패하면 fail. 반환값은 중단 */
function decodeInWorker(
  base64: string,
  width: number,
  height: number,
  done: (data: ImageData) => void,
  fail: () => void
): () => void {
  let worker: Worker
  try {
    if (typeof Worker === 'undefined') throw new Error('no worker')
    worker = new Worker(new URL('./image-decode.worker.ts', import.meta.url), { type: 'module' })
  } catch {
    fail()
    return () => undefined
  }
  worker.onmessage = (e: MessageEvent<ImageDecodeResponse>) => {
    worker.terminate()
    if ('data' in e.data) done(new ImageData(e.data.data, width, height))
    else fail()
  }
  worker.onerror = () => {
    worker.terminate()
    fail()
  }
  worker.postMessage({ base64, width, height } satisfies ImageDecodeRequest)
  return () => worker.terminate()
}

function decodeOnMainThread(
  base64: string,
  width: number,
  height: number,
  done: (data: ImageData) => void
): void {
  const img = new Image()
  img.onload = () => {
    const off = document.createElement('canvas')
    off.width = width
    off.height = height
    const ctx = off.getContext('2d')
    if (!ctx) return
    ctx.drawImage(img, 0, 0, width, height)
    done(ctx.getImageData(0, 0, width, height))
  }
  img.src = `data:image/png;base64,${base64}`
}

/** ImageData → base64 PNG (data URL 접두어 제외) */
export function imageDataToBase64(data: ImageData): string {
  const canvas = document.createElement('canvas')
  canvas.width = data.width
  canvas.height = data.height
  canvas.getContext('2d')!.putImageData(data, 0, 0)
  return canvas.toDataURL('image/png').split(',')[1]
}
