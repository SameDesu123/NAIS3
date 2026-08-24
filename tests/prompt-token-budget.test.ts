import { describe, expect, it } from 'vitest'
import { promptTokenBudgetTexts } from '../src/shared/prompt-token-budget'

describe('공유 프롬프트 토큰 예산', () => {
  it('베이스와 네거티브, 활성 캐릭터의 양쪽 캡션을 모두 포함한다', () => {
    expect(
      promptTokenBudgetTexts({
        prompt: 'base prompt',
        negativePrompt: 'base negative',
        characters: [
          {
            prompt: 'character prompt',
            negativePrompt: 'character negative',
            enabled: true
          }
        ]
      })
    ).toEqual(['base prompt', 'base negative', 'character prompt', 'character negative'])
  })

  it('실제 payload에서 제외되는 캐릭터와 빈 캡션은 세지 않는다', () => {
    expect(
      promptTokenBudgetTexts({
        prompt: '',
        negativePrompt: 'base negative',
        characters: [
          { prompt: 'disabled', negativePrompt: 'disabled negative', enabled: false },
          { prompt: '   ', negativePrompt: 'orphan negative', enabled: true },
          { prompt: 'active', negativePrompt: '', enabled: true }
        ]
      })
    ).toEqual(['base negative', 'active'])
  })
})
