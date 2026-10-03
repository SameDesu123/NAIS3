// @vitest-environment happy-dom
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CharacterOverlay } from '../src/renderer/src/components/character-overlay'
import { useCharactersStore } from '../src/renderer/src/stores/characters-store'
import { DEFAULT_REQUEST, useGenerationStore } from '../src/renderer/src/stores/generation-store'
import type { NaisApi } from '../src/preload'
let root: Root
let container: HTMLDivElement
const invoke = vi.fn()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers()
  vi.spyOn(Element.prototype, 'animate').mockImplementation(() => undefined as never)
  invoke.mockImplementation(async (channel: string, request: { texts: string[]; model: string }) =>
    channel === 'tokens:count'
      ? { counts: request.texts.map(() => (request.model === 'nai-diffusion-4-5-full' ? 10 : 20)) }
      : { value: null }
  )
  window.nais = { invoke } as unknown as NaisApi
  useGenerationStore.setState({ request: { ...DEFAULT_REQUEST, model: 'nai-diffusion-4-5-full' } })
  useCharactersStore.setState({
    items: [
      {
        id: 1,
        name: 'Character 1',
        prompt: 'girl',
        negativePrompt: 'bad',
        enabled: true,
        center: { x: 0.5, y: 0.5 },
        folderId: null,
        thumbnail: ''
      }
    ],
    folders: []
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  invoke.mockReset()
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
it('updates expanded character token counters and limits on model changes', async () => {
  await act(async () => root.render(h(CharacterOverlay)))
  const button = Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent === 'Character 1'
  )!
  await act(async () => button.click())
  await act(async () => vi.advanceTimersByTimeAsync(300))
  expect(container.textContent).toContain('10/512')
  await act(async () =>
    useGenerationStore.setState({ request: { ...DEFAULT_REQUEST, model: 'nai-diffusion-5-full' } })
  )
  await act(async () => vi.advanceTimersByTimeAsync(300))
  expect(container.textContent).toContain('20/1471')
  expect(container.textContent).not.toContain('10/512')
  await act(async () =>
    useGenerationStore.setState({
      request: { ...DEFAULT_REQUEST, model: 'nai-diffusion-5-curated' }
    })
  )
  await act(async () => vi.advanceTimersByTimeAsync(300))
  expect(container.textContent).not.toContain('20/1471')
})
