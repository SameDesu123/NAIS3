// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NaisApi } from '../src/preload/index'
import { useLayoutStore } from '../src/renderer/src/stores/layout-store'

const invoke = vi.fn()

beforeEach(() => {
  invoke.mockReset()
  invoke.mockImplementation(async (channel: string, request?: { key?: string }) => {
    if (channel !== 'settings:get') return undefined
    return {
      value: request?.key === 'ui_quick_generation_controls' ? '1' : null
    }
  })
  window.nais = { invoke, on: () => () => {} } as NaisApi
})

describe('layout settings', () => {
  it('hydrates the opt-in quick generation controls setting', async () => {
    await useLayoutStore.getState().hydrate()

    expect(useLayoutStore.getState().quickGenerationControlsEnabled).toBe(true)
  })

  it('persists quick generation controls changes', () => {
    useLayoutStore.getState().setQuickGenerationControlsEnabled(false)

    expect(useLayoutStore.getState().quickGenerationControlsEnabled).toBe(false)
    expect(invoke).toHaveBeenCalledWith('settings:set', {
      key: 'ui_quick_generation_controls',
      value: '0'
    })
  })
})
