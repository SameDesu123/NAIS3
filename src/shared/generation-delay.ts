import type { GenerationDelayRandomization } from './types'

export function normalizeDelayMs(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

export function normalizeDelayRandomization(
  value: GenerationDelayRandomization
): GenerationDelayRandomization {
  return {
    enabled: value.enabled,
    minusMs: normalizeDelayMs(value.minusMs),
    plusMs: normalizeDelayMs(value.plusMs)
  }
}

export function randomizedGenerationDelayMs(
  delayMs: number,
  randomization: GenerationDelayRandomization,
  random: () => number = Math.random
): number {
  const base = normalizeDelayMs(delayMs)
  if (!randomization.enabled) return base
  const { minusMs, plusMs } = normalizeDelayRandomization(randomization)
  const min = Math.max(0, base - minusMs)
  const max = base + plusMs
  return Math.round(min + (max - min) * random())
}
