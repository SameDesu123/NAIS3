import type { OpusUsageStatus, SubscriptionInfo } from './types'

/** NAI `/user/subscription` 응답 중 NAIS3가 읽는 필드 */
export interface NaiSubscriptionResponse {
  tier?: number
  /** 구독 만료 시각 (UNIX 초) */
  expiresAt?: number
  /** 0 = RETAIL, 1 = B2B, 2 = SERVICE, 3 = SUPPORT, 4 = ADMIN */
  accountType?: number
  trainingStepsLeft?: { fixedTrainingStepsLeft?: number; purchasedTrainingSteps?: number }
  usage?: OpusUsageStatus
}

const RETAIL_ACCOUNT = 0

/**
 * NAI 웹 `subscriptionIsActive`와 같은 판정. 만료된 구독은 tier가 남아 있어도
 * 혜택(무료 생성·V5 게이지)이 없다. 만료 시각이 없는 응답은 활성으로 취급한다.
 */
function subscriptionIsActive(data: NaiSubscriptionResponse, nowMs: number): boolean {
  if (data.accountType !== undefined && data.accountType !== RETAIL_ACCOUNT) return true
  if (typeof data.expiresAt !== 'number') return true
  return data.expiresAt > nowMs / 1000 && (data.tier ?? 0) > 0
}

export function parseSubscriptionResponse(
  data: NaiSubscriptionResponse,
  nowMs = Date.now()
): SubscriptionInfo {
  const tierNames = ['paper', 'tablet', 'scroll', 'opus'] as const
  const active = subscriptionIsActive(data, nowMs)
  const tier = active ? (tierNames[data.tier ?? 0] ?? 'paper') : 'paper'
  const usage = data.usage
  const validUsage =
    tier === 'opus' &&
    usage &&
    Number.isFinite(usage.percent) &&
    typeof usage.isNegative === 'boolean' &&
    Number.isFinite(usage.timeUntilNextPercent) &&
    usage.timeUntilNextPercent >= 0 &&
    (usage.purchasedPercent === undefined || Number.isFinite(usage.purchasedPercent))
  return {
    tier,
    anlasFixed: data.trainingStepsLeft?.fixedTrainingStepsLeft ?? 0,
    anlasPurchased: data.trainingStepsLeft?.purchasedTrainingSteps ?? 0,
    ...(validUsage ? { usage } : {}),
    ...(!active && (data.tier ?? 0) > 0 ? { expired: true } : {})
  }
}
