// @vitest-environment happy-dom
import { act, createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { NaisApi } from '../src/preload'
import { DirectorMode } from '../src/renderer/src/components/director-mode'
import { useLanguageStore } from '../src/renderer/src/lib/i18n'
import { useDirectorStore } from '../src/renderer/src/stores/director-store'
import { useGenerationStore } from '../src/renderer/src/stores/generation-store'
import { useLayoutStore } from '../src/renderer/src/stores/layout-store'

vi.mock('../src/renderer/src/components/mask-workspace', () => ({
  MaskWorkspace: ({
    onConfirm,
    onCancel
  }: {
    onConfirm: (mask: string) => void
    onCancel: () => void
  }) =>
    h(
      'div',
      { 'data-testid': 'inline-mask' },
      h('button', { onClick: () => onConfirm('MASK') }, 'Confirm mask'),
      h('button', { onClick: onCancel }, 'Cancel mask')
    )
}))
const initialDirector = useDirectorStore.getState()
const initialGeneration = useGenerationStore.getState()
const initialLayout = useLayoutStore.getState()
let cleanup = async (): Promise<void> => {}
afterEach(async () => {
  await cleanup()
  useDirectorStore.setState(initialDirector, true)
  useGenerationStore.setState(initialGeneration, true)
  useLayoutStore.setState(initialLayout, true)
  vi.unstubAllGlobals()
})
it('edits inline and only transfers the confirmed mask to Main', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'Image',
    class {
      naturalWidth = 640
      naturalHeight = 480
      onload: (() => void) | null = null
      set src(_value: string) {
        queueMicrotask(() => this.onload?.())
      }
    }
  )
  window.nais = {
    invoke: vi.fn().mockResolvedValue({ value: null }),
    on: () => () => {}
  } as unknown as NaisApi
  useLanguageStore.setState({ lang: 'en' })
  useDirectorStore.setState({ stack: ['SOURCE'], loading: false, instantRun: false })
  useGenerationStore.setState({ source: null, inpaintTarget: null })
  useLayoutStore.setState({ centerMode: 'director' })
  const div = document.createElement('div')
  document.body.append(div)
  const root = createRoot(div)
  cleanup = async () => {
    await act(async () => root.unmount())
    div.remove()
  }
  const click = async (label: string): Promise<void> => {
    const button = [...div.querySelectorAll('button')].find((b) =>
      b.textContent?.trim().startsWith(label)
    )
    expect(button).toBeDefined()
    await act(async () => button!.click())
  }
  await act(async () => root.render(h(DirectorMode)))
  await click('Inpaint')
  expect(div.querySelector('[data-testid="inline-mask"]')).toBeNull()
  await click('Open editor')
  expect(div.querySelector('[data-testid="inline-mask"]')).not.toBeNull()
  expect(useLayoutStore.getState().centerMode).toBe('director')
  expect(useGenerationStore.getState().inpaintTarget).toBeNull()
  await click('Cancel mask')
  expect(useGenerationStore.getState().source).toBeNull()
  await click('Open editor')
  await click('Confirm mask')
  expect(useLayoutStore.getState().centerMode).toBe('main')
  expect(useGenerationStore.getState().source).toEqual({
    imageBase64: 'SOURCE',
    maskBase64: 'MASK',
    width: 640,
    height: 480
  })
  expect(useGenerationStore.getState().inpaintTarget).toBeNull()
})
