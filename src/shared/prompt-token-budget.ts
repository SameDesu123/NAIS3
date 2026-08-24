export interface PromptTokenCharacter {
  prompt: string
  negativePrompt: string
  enabled: boolean
}

interface PromptTokenBudgetInput {
  prompt: string
  negativePrompt: string
  characters: readonly PromptTokenCharacter[]
}

/**
 * Collect every caption that shares the prompt token budget.
 *
 * Character activation mirrors the generation payload: disabled characters and
 * cards without a positive prompt are not sent, so neither caption contributes.
 */
export function promptTokenBudgetTexts({
  prompt,
  negativePrompt,
  characters
}: PromptTokenBudgetInput): string[] {
  const texts = [prompt, negativePrompt]

  for (const character of characters) {
    if (!character.enabled || !character.prompt.trim()) continue
    texts.push(character.prompt, character.negativePrompt)
  }

  return texts.filter((text) => text.trim())
}
