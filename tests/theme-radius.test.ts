// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_RADIUS, useThemeStore } from '../src/renderer/src/stores/theme-store'

let settings: Record<string, string>
const invoke = vi.fn()

beforeEach(() => {
  settings = {}
  invoke.mockReset()
  invoke.mockImplementation(async (channel: string, request?: Record<string, string>) => {
    if (channel === 'settings:get') return { value: settings[request!.key] ?? null }
    if (channel === 'settings:set') settings[request!.key] = request!.value
    return undefined
  })
  vi.stubGlobal('nais', { invoke, on: () => () => {}, runtime: 'browser' })
  useThemeStore.setState({ radius: DEFAULT_RADIUS })
  document.documentElement.style.removeProperty('--radius')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const cssRadius = (): string => document.documentElement.style.getPropertyValue('--radius')

describe('corner radius setting', () => {
  it('applies, clamps and persists the base radius', () => {
    useThemeStore.getState().setRadius(12)
    expect(useThemeStore.getState().radius).toBe(12)
    expect(cssRadius()).toBe('12px')
    expect(settings.ui_radius).toBe('12')

    useThemeStore.getState().setRadius(40)
    expect(useThemeStore.getState().radius).toBe(16)
    useThemeStore.getState().setRadius(-3)
    expect(useThemeStore.getState().radius).toBe(0)
    expect(cssRadius()).toBe('0px')
  })

  it('restores the saved radius and falls back to the default for bad values', async () => {
    settings.ui_radius = '5'
    await useThemeStore.getState().hydrate()
    expect(useThemeStore.getState().radius).toBe(5)
    expect(cssRadius()).toBe('5px')

    settings.ui_radius = 'round'
    await useThemeStore.getState().hydrate()
    expect(useThemeStore.getState().radius).toBe(DEFAULT_RADIUS)

    delete settings.ui_radius
    await useThemeStore.getState().hydrate()
    expect(useThemeStore.getState().radius).toBe(DEFAULT_RADIUS)
  })
})
