import { useEffect, useMemo, useState } from 'react'
import { isV5Model } from '@shared/nai-models'
import { promptTokenBudgetTexts, type PromptTokenCharacter } from '@shared/prompt-token-budget'

interface PromptTokenBudgetOptions {
  model: string
  prompt: string
  negativePrompt: string
  characters: readonly PromptTokenCharacter[]
}

export function usePromptTokenBudget({
  model,
  prompt,
  negativePrompt,
  characters
}: PromptTokenBudgetOptions): number | null {
  const texts = useMemo(
    () => promptTokenBudgetTexts({ prompt, negativePrompt, characters }),
    [prompt, negativePrompt, characters]
  )
  const [tokens, setTokens] = useState<number | null>(null)

  useEffect(() => {
    // V5 requires Qwen 3.5. Keep its count hidden until that tokenizer is available.
    if (isV5Model(model) || texts.length === 0) {
      const timer = setTimeout(() => setTokens(null))
      return () => clearTimeout(timer)
    }

    let cancelled = false
    const timer = setTimeout(() => {
      void window.nais
        .invoke('tokens:count', { texts })
        .then(({ counts }) => {
          if (!cancelled) setTokens(counts.reduce((sum, count) => sum + count, 0))
        })
        .catch(() => {
          if (!cancelled) setTokens(null)
        })
    }, 250)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [model, texts])

  return tokens
}
