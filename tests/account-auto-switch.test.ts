import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NaiAccountBalance } from '../src/main/nai/account-router'

const db = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  activeId: 'a',
  setActive: vi.fn()
}))
const accounts = [
  { id: 'a', label: 'A', token: 'token-a' },
  { id: 'b', label: 'B', token: 'token-b' }
]
vi.mock('../src/main/db/settings', () => ({
  getSetting: (key: string) => db.settings.get(key) ?? null,
  getNaiAccounts: () => accounts,
  getActiveNaiAccount: () => accounts.find((a) => a.id === db.activeId) ?? null,
  setActiveNaiAccount: db.setActive
}))
const balances: Record<string, NaiAccountBalance> = {
  'token-a': {
    anlas: 1000,
    tier: 'opus',
    usage: { percent: 0, isNegative: true, timeUntilNextPercent: 100 }
  },
  'token-b': {
    anlas: 1000,
    tier: 'opus',
    usage: { percent: 80, isNegative: false, timeUntilNextPercent: 100 }
  }
}
vi.mock('../src/main/nai/client', () => ({
  fetchAnlasBalance: async (token: string) => balances[token]
}))

const { resolveNaiAccountForGeneration } = await import('../src/main/nai/account-router')

describe('NAI 계정 자동 전환 설정', () => {
  beforeEach(() => {
    db.settings.clear()
    db.setActive.mockClear()
  })

  it('기본은 켜져 있어 게이지가 바닥난 계정에서 다음 계정으로 바꾼다', async () => {
    const selection = await resolveNaiAccountForGeneration(true)
    expect(selection?.account.id).toBe('b')
    expect(selection?.rotated).toBe(true)
    expect(db.setActive).toHaveBeenCalledWith('b')
  })

  it('끄면 게이지가 바닥나도 지금 계정을 그대로 쓴다', async () => {
    db.settings.set('nai_auto_switch', '0')
    const selection = await resolveNaiAccountForGeneration(true)
    expect(selection?.account.id).toBe('a')
    expect(selection?.rotated).toBe(false)
    expect(db.setActive).not.toHaveBeenCalled()
  })
})
