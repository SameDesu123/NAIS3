/**
 * Anlas 비용 추정 — NAI 웹 번들의 실제 비용 함수를 이식 (2026-07-05 _app 번들에서 추출).
 *
 * 확인된 사실:
 * - V4/4.5 계열 비용: ceil(2.951823174884865e-6·px + 5.753298233447344e-7·px·steps)
 *   (SMEA 미사용 기준 — V4.5는 SMEA 없음)
 * - i2i/인페인트: ceil(비용 × strength), 최소 2
 * - 무료 조건(eX): "캐릭터 레퍼런스 없음" && px ≤ 1024² && steps ≤ 28, Opus 구독 시
 *   요청당 1장 차감 — NAIS3는 배치를 요청 N개(각 1장)로 쪼개므로 조건 충족 시 배치 전체 무료
 * - 프롬프트 길이는 비용에 영향 없음 (번들 전수 확인 — 관련 항 자체가 없다)
 * - 바이브 인코딩: encode-vibe 1회당 2 Anlas, 인코딩 캐시 재사용 시 0 (NAIS2에서 검증)
 * - 참고: 디렉터 툴(배경제거 등) 테이블 — [[1048576,7],[786432,5],[524288,3],[409600,2],
 *   [262144,1]], Opus는 409600px 이하 무료 (추후 스마트 툴에서 사용)
 */

export interface AnlasEstimateInput {
  width: number
  height: number
  steps: number
  /** i2i/인페인트 강도 (t2i는 1) */
  strength?: number
  hasCharacterReference: boolean
  isOpus: boolean
  /** NAIS3 배치 = 요청 N개 × 1장 */
  batchCount: number
  /** 이번 생성에서 새로 인코딩해야 하는 바이브 수 (캐시된 것 제외) */
  unencodedVibes?: number
}

export interface AnlasEstimate {
  /** 장당 생성 비용 (무료 적용 전) */
  perImage: number
  /** 생성 비용 합계 (무료 적용 후) */
  generation: number
  /** 바이브 인코딩 비용 (1회성, 캐시되면 이후 0) */
  vibeEncoding: number
  total: number
  free: boolean
}

const VIBE_ENCODE_COST = 2

/**
 * 디렉터 툴(배경제거·색칠 등)·업스케일 비용 — 웹 번들 픽셀 버킷 테이블.
 * [[262144,1],[409600,2],[524288,3],[786432,5],[1048576,7]] — Opus는 409600px 이하 무료.
 * (실사용 검증: 768×1024 업스케일 = 5 Anlas)
 */
export function directorToolCost(width: number, height: number, isOpus: boolean): number {
  const px = width * height
  if (isOpus && px <= 409600) return 0
  if (px <= 262144) return 1
  if (px <= 409600) return 2
  if (px <= 524288) return 3
  if (px <= 786432) return 5
  return 7
}

export function estimateAnlas(input: AnlasEstimateInput): AnlasEstimate {
  const px = Math.max(input.width * input.height, 65536)
  const strength = input.strength ?? 1

  const base = Math.ceil(2.951823174884865e-6 * px + 5.753298233447344e-7 * px * input.steps)
  const perImage = Math.max(Math.ceil(base * strength), 2)

  const freeEligible =
    !input.hasCharacterReference && px <= 1048576 && input.steps <= 28 && input.isOpus

  const generation = freeEligible ? 0 : perImage * input.batchCount
  const vibeEncoding = (input.unencodedVibes ?? 0) * VIBE_ENCODE_COST
  const total = generation + vibeEncoding

  return { perImage, generation, vibeEncoding, total, free: total === 0 }
}
