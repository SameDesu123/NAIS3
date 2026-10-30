import { describe, expect, it } from 'vitest'
import { parseSubscriptionResponse } from '../src/main/nai/client'

describe('V5 Opus usage 응답', () => {
  it('subscription 응답의 충전 게이지와 Anlas를 함께 정규화한다', () => {
    expect(
      parseSubscriptionResponse({
        tier: 3,
        trainingStepsLeft: { fixedTrainingStepsLeft: 9000, purchasedTrainingSteps: 500 },
        usage: { percent: 42, isNegative: false, timeUntilNextPercent: 6048 }
      })
    ).toEqual({
      tier: 'opus',
      anlasFixed: 9000,
      anlasPurchased: 500,
      usage: { percent: 42, isNegative: false, timeUntilNextPercent: 6048 }
    })
  })

  it('usage가 없는 이전 응답도 정상 처리한다', () => {
    expect(parseSubscriptionResponse({ tier: 1 }).usage).toBeUndefined()
  })

  it('Opus가 아닌 구독 응답의 잔여 usage는 전달하지 않는다', () => {
    expect(
      parseSubscriptionResponse({
        tier: 0,
        usage: { percent: 15, isNegative: false, timeUntilNextPercent: 6048 }
      })
    ).toEqual({
      tier: 'paper',
      anlasFixed: 0,
      anlasPurchased: 0
    })
  })

  it('부스트로 100%를 넘긴 usage도 상한 없이 전달한다', () => {
    const usage = { percent: 230, isNegative: false, timeUntilNextPercent: 6048 }
    expect(parseSubscriptionResponse({ tier: 3, usage }).usage).toEqual(usage)
  })

  it('Extra Usage(purchasedPercent)도 함께 전달하고 잘못된 값은 usage를 버린다', () => {
    const usage = {
      percent: 40,
      purchasedPercent: 120,
      isNegative: false,
      timeUntilNextPercent: 6048
    }
    expect(parseSubscriptionResponse({ tier: 3, usage }).usage).toEqual(usage)
    expect(
      parseSubscriptionResponse({ tier: 3, usage: { ...usage, purchasedPercent: Number.NaN } })
        .usage
    ).toBeUndefined()
  })

  it('만료된 구독은 tier가 남아 있어도 혜택 없는 paper로 취급한다', () => {
    const now = 1_800_000_000_000
    const expired = {
      tier: 3,
      accountType: 0,
      expiresAt: now / 1000 - 60,
      usage: { percent: 57, isNegative: false, timeUntilNextPercent: 6048 }
    }
    expect(parseSubscriptionResponse(expired, now)).toEqual({
      tier: 'paper',
      anlasFixed: 0,
      anlasPurchased: 0,
      expired: true
    })
    expect(parseSubscriptionResponse({ ...expired, expiresAt: now / 1000 + 60 }, now)).toEqual(
      expect.objectContaining({ tier: 'opus', usage: expired.usage })
    )
    expect(
      parseSubscriptionResponse({ ...expired, expiresAt: now / 1000 + 60 }, now)
    ).not.toHaveProperty('expired')
    // 처음부터 무료였던 계정은 만료가 아니다
    expect(parseSubscriptionResponse({ ...expired, tier: 0 }, now)).not.toHaveProperty('expired')
  })

  it('NAI 웹처럼 RETAIL이 아닌 계정은 만료 시각과 무관하게 활성으로 본다', () => {
    const now = 1_800_000_000_000
    expect(parseSubscriptionResponse({ tier: 3, accountType: 2, expiresAt: 0 }, now).tier).toBe(
      'opus'
    )
  })

  it('잘못된 usage 값은 UI에 전달하지 않는다', () => {
    expect(
      parseSubscriptionResponse({
        tier: 3,
        usage: { percent: 120, isNegative: false, timeUntilNextPercent: -1 }
      }).usage
    ).toBeUndefined()
  })
})
