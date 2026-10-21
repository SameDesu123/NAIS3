// @vitest-environment happy-dom
import { act, createElement as h, Profiler } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NaisApi } from '../src/preload/index'
import { useLanguageStore } from '../src/renderer/src/lib/i18n'
import { useCharactersStore } from '../src/renderer/src/stores/characters-store'
import { DEFAULT_REQUEST, useGenerationStore } from '../src/renderer/src/stores/generation-store'
import { useLayoutStore } from '../src/renderer/src/stores/layout-store'

// ParamsDialog renders once per PromptPanel render, so it counts panel renders
const probe = vi.hoisted(() => ({ panelRenders: 0 }))
vi.mock('../src/renderer/src/components/params-dialog', () => ({
  ParamsDialog: () => {
    probe.panelRenders++
    return null
  }
}))

const { PromptPanel } = await import('../src/renderer/src/components/prompt-panel')
const { Titlebar } = await import('../src/renderer/src/components/titlebar')

let root: Root
let container: HTMLDivElement
const invoke = vi.fn()

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers()
  invoke.mockImplementation(async (channel: string, req?: { texts?: string[] }) => {
    if (channel === 'promptPresets:list') return { items: [] }
    if (channel === 'tokens:count') return { counts: req!.texts!.map(() => 3) }
    return { value: null }
  })
  window.nais = { invoke, on: () => () => {} } as NaisApi
  useLanguageStore.setState({ lang: 'ko' })
  useGenerationStore.setState({ request: { ...DEFAULT_REQUEST, prompt: '' }, queue: null })
  useLayoutStore.setState({ centerMode: 'main', quickGenerationControlsEnabled: false })
  useCharactersStore.setState({ items: [], folders: [] })
  probe.panelRenders = 0
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  invoke.mockReset()
})

const type = (text: string): Promise<void> =>
  act(async () => useGenerationStore.getState().patchRequest({ prompt: text }))

describe('prompt typing re-renders', () => {
  it('does not re-render the prompt panel shell on prompt keystrokes', async () => {
    await act(async () => root.render(h(PromptPanel)))
    const before = probe.panelRenders
    for (const text of ['a', 'ab', 'abc']) await type(text)
    expect(probe.panelRenders).toBe(before)
    expect(container.querySelector('textarea')?.value).toBe('abc')
  })

  it('still re-renders the panel when a field it shows changes', async () => {
    await act(async () => root.render(h(PromptPanel)))
    const before = probe.panelRenders
    await act(async () => useGenerationStore.getState().patchRequest({ steps: 12 }))
    expect(probe.panelRenders).toBeGreaterThan(before)
  })

  it('counts positive tokens without recounting the negative prompt', async () => {
    useGenerationStore.setState({
      request: { ...DEFAULT_REQUEST, prompt: 'girl', negativePrompt: 'bad' }
    })
    await act(async () => root.render(h(PromptPanel)))
    await act(async () => vi.advanceTimersByTime(250))
    invoke.mockClear()
    await type('girl, smile')
    await act(async () => vi.advanceTimersByTime(250))
    expect(invoke.mock.calls.filter(([c]) => c === 'tokens:count')).toEqual([
      ['tokens:count', { texts: ['girl, smile'], model: DEFAULT_REQUEST.model }]
    ])
  })

  it('does not re-render the titlebar on prompt keystrokes', async () => {
    let commits = 0
    await act(async () =>
      root.render(h(Profiler, { id: 'titlebar', onRender: () => commits++ }, h(Titlebar)))
    )
    const before = commits
    for (const text of ['a', 'ab', 'abc']) await type(text)
    expect(commits).toBe(before)
  })
})
