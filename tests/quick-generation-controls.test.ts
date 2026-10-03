// @vitest-environment happy-dom
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NaisApi } from '../src/preload/index'
import { PromptPanel } from '../src/renderer/src/components/prompt-panel'
import { useLanguageStore } from '../src/renderer/src/lib/i18n'
import { DEFAULT_REQUEST, useGenerationStore } from '../src/renderer/src/stores/generation-store'
import { useLayoutStore } from '../src/renderer/src/stores/layout-store'

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const invoke = vi.fn().mockImplementation(async (channel: string) => {
    if (channel === 'promptPresets:list') return { items: [] }
    return { value: null }
  })
  window.nais = {
    invoke,
    on: () => () => {}
  } as NaisApi
  useLanguageStore.setState({ lang: 'ko' })
  useGenerationStore.setState({ request: { ...DEFAULT_REQUEST }, queue: null })
  useLayoutStore.setState({
    centerMode: 'main',
    quickGenerationControlsEnabled: false
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('quick generation controls', () => {
  it('shows the resolution and numeric steps controls only when opted in', async () => {
    await act(async () => root.render(h(PromptPanel)))

    expect(container.querySelector('button[aria-label="해상도"]')).toBeNull()
    expect(container.querySelector('input[aria-label="스텝"]')).toBeNull()

    await act(async () => {
      useLayoutStore.setState({ quickGenerationControlsEnabled: true })
    })

    expect(container.querySelector('button[aria-label="해상도"]')).not.toBeNull()
    const steps = container.querySelector<HTMLInputElement>('input[aria-label="스텝"]')
    expect(steps?.type).toBe('number')
    expect(steps?.min).toBe('1')
    expect(steps?.max).toBe('50')
  })

  it('updates the shared generation steps from the numeric field', async () => {
    useLayoutStore.setState({ quickGenerationControlsEnabled: true })
    await act(async () => root.render(h(PromptPanel)))
    const steps = container.querySelector<HTMLInputElement>('input[aria-label="스텝"]')!

    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setValue?.call(steps, '37')
      steps.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))
    })

    expect(useGenerationStore.getState().request.steps).toBe(37)
  })
})
