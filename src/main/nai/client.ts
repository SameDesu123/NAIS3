import JSZip from 'jszip'
import type { GenerationRequest, SubscriptionInfo } from '../../shared/types'
import { ENDPOINTS } from './endpoints'
import { buildGenerateImagePayload, type BuildOptions } from './payload'
import { readImageStream } from './stream'

/**
 * NAI HTTP 클라이언트. 메인 프로세스 전용 (CORS/CSP 무관).
 * 응답 zip 해제·파일 저장은 큐 쪽 책임 — 여기는 순수 API 호출만.
 */

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token.trim()}`,
    'Content-Type': 'application/json',
    // 500 에러 리포트용 상관관계 ID (docs/nai-api-2026-07.md)
    'x-correlation-id': Math.random().toString(36).slice(2, 8)
  }
}

export async function verifyToken(
  token: string
): Promise<{ valid: boolean; subscription?: SubscriptionInfo; error?: string }> {
  const res = await fetch(ENDPOINTS.subscription, { headers: headers(token) })
  if (res.status === 401) return { valid: false, error: '유효하지 않은 API 토큰' }
  if (!res.ok) return { valid: false, error: `API 오류: ${res.status}` }

  const data = (await res.json()) as {
    tier?: number
    trainingStepsLeft?: { fixedTrainingStepsLeft?: number; purchasedTrainingSteps?: number }
  }
  const tierNames = ['paper', 'tablet', 'scroll', 'opus'] as const
  return {
    valid: true,
    subscription: {
      tier: tierNames[data.tier ?? 0] ?? 'paper',
      anlasFixed: data.trainingStepsLeft?.fixedTrainingStepsLeft ?? 0,
      anlasPurchased: data.trainingStepsLeft?.purchasedTrainingSteps ?? 0
    }
  }
}

/** 현재 Anlas 잔액(fixed + purchased)과 구독 tier. 실패 시 둘 다 null */
export async function fetchAnlasBalance(
  token: string
): Promise<{ anlas: number | null; tier: string | null }> {
  try {
    const res = await fetch(ENDPOINTS.subscription, { headers: headers(token) })
    if (!res.ok) return { anlas: null, tier: null }
    const data = (await res.json()) as {
      tier?: number
      trainingStepsLeft?: { fixedTrainingStepsLeft?: number; purchasedTrainingSteps?: number }
    }
    const tierNames = ['paper', 'tablet', 'scroll', 'opus'] as const
    return {
      anlas:
        (data.trainingStepsLeft?.fixedTrainingStepsLeft ?? 0) +
        (data.trainingStepsLeft?.purchasedTrainingSteps ?? 0),
      tier: tierNames[data.tier ?? 0] ?? 'paper'
    }
  } catch {
    return { anlas: null, tier: null }
  }
}

/**
 * 스트리밍 생성. 진행 이벤트를 중계하고 최종 PNG를 반환한다.
 * sentPayload는 재현성을 위해 히스토리에 그대로 저장된다.
 */
export async function generateImageStream(
  token: string,
  request: GenerationRequest,
  buildOpts: Omit<BuildOptions, 'stream'> = {},
  onProgress?: (stepIx: number, previewPng?: Buffer) => void,
  signal?: AbortSignal
): Promise<{ png: Buffer; sentPayload: string }> {
  const payload = buildGenerateImagePayload(request, { ...buildOpts, stream: 'msgpack' })
  const sentPayload = JSON.stringify(payload)
  const res = await fetch(ENDPOINTS.generateImageStream, {
    method: 'POST',
    headers: { ...headers(token), Accept: 'application/x-msgpack' },
    body: sentPayload,
    signal
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`생성 실패 ${res.status}: ${text.slice(0, 300)}`)
  }
  if (!res.body) throw new Error('스트리밍 응답 없음')

  const png = await readImageStream(res.body as ReadableStream<Uint8Array>, { onProgress, signal })
  return { png, sentPayload }
}

/**
 * 디렉터 툴 (augment-image). bg-removal/lineart/sketch/colorize/emotion/declutter 등.
 * ZIP 응답에서 PNG를 추출한다 (생성과 동일). colorize/emotion만 prompt·defry를 보낸다.
 */
export async function augmentImage(
  token: string,
  opts: {
    method: string
    imageBase64: string
    width: number
    height: number
    prompt?: string
    defry?: number
  }
): Promise<Buffer> {
  const body: Record<string, unknown> = {
    req_type: opts.method,
    image: opts.imageBase64,
    width: opts.width,
    height: opts.height
  }
  if (opts.prompt !== undefined) body.prompt = opts.prompt
  if (opts.defry !== undefined) body.defry = opts.defry

  const res = await fetch(ENDPOINTS.augmentImage, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify(body)
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`디렉터 툴 실패 ${res.status}: ${text.slice(0, 300)}`)
  }
  const zip = await JSZip.loadAsync(await res.arrayBuffer())
  const names = Object.keys(zip.files)
  const entry = names[names.length - 1] // 마지막 엔트리가 결과
  if (!entry) throw new Error('디렉터 툴 응답에 이미지가 없음')
  return Buffer.from(await zip.file(entry)!.async('nodebuffer'))
}

/**
 * 업스케일. 주의: api.novelai.net 호스트(예외). ZIP 응답에서 PNG 추출.
 */
export async function upscaleImage(
  token: string,
  opts: { imageBase64: string; width: number; height: number; scale: number }
): Promise<Buffer> {
  const res = await fetch(ENDPOINTS.upscale, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({
      image: opts.imageBase64,
      width: opts.width,
      height: opts.height,
      scale: opts.scale
    })
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`업스케일 실패 ${res.status}: ${text.slice(0, 300)}`)
  }
  const zip = await JSZip.loadAsync(await res.arrayBuffer())
  const names = Object.keys(zip.files)
  const entry = names[names.length - 1]
  if (!entry) throw new Error('업스케일 응답에 이미지가 없음')
  return Buffer.from(await zip.file(entry)!.async('nodebuffer'))
}

/**
 * 비스트리밍 생성 (zip 응답). i2i/인페인트에 사용 — NAIS2 검증.
 * 스트리밍의 최종 프레임은 서버 합성 전 raw라 인페인트 경계가 깨지므로,
 * 이쪽은 서버가 원본과 합성을 끝낸 최종 이미지를 zip으로 준다.
 */
export async function generateImageZip(
  token: string,
  request: GenerationRequest,
  buildOpts: Omit<BuildOptions, 'stream'> = {},
  signal?: AbortSignal
): Promise<{ png: Buffer; sentPayload: string }> {
  const payload = buildGenerateImagePayload(request, buildOpts)
  const sentPayload = JSON.stringify(payload)
  const res = await fetch(ENDPOINTS.generateImage, {
    method: 'POST',
    headers: headers(token),
    body: sentPayload,
    signal
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`생성 실패 ${res.status}: ${text.slice(0, 300)}`)
  }
  const zip = await JSZip.loadAsync(await res.arrayBuffer())
  const entryName = Object.keys(zip.files)[0]
  if (!entryName) throw new Error('zip 응답에 이미지가 없음')
  const png = Buffer.from(await zip.file(entryName)!.async('nodebuffer'))
  return { png, sentPayload }
}
