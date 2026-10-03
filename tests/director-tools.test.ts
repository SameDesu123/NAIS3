// @vitest-environment happy-dom
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NaisApi } from '../src/preload/index'
import { DirectorMode } from '../src/renderer/src/components/director-mode'
import { useLanguageStore } from '../src/renderer/src/lib/i18n'
import { useDirectorStore } from '../src/renderer/src/stores/director-store'

let root: Root
let container: HTMLDivElement
let invoke: ReturnType<typeof vi.fn>
let run: ReturnType<typeof vi.fn>

const initialDirectorState = useDirectorStore.getState()

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  invoke = vi.fn().mockResolvedValue({ value: null })
  window.nais = { invoke, on: () => () => {} } as unknown as NaisApi
  run = vi.fn().mockResolvedValue(undefined)
  useLanguageStore.setState({ lang: 'ko' })
  useDirectorStore.setState({
    ...initialDirectorState,
    stack: ['AAAA'],
    loading: false,
    instantRun: false,
    run
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  useDirectorStore.setState(initialDirectorState, true)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function button(text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((b) =>
    b.textContent?.trim().startsWith(text)
  )
  if (!found) throw new Error(`button not found: ${text}`)
  return found
}

const click = (el: HTMLElement): Promise<void> => act(async () => el.click())

describe('director tool panel', () => {
  it('selects a tool on click and runs it only from the action button', async () => {
    await act(async () => root.render(h(DirectorMode)))

    await click(button('라인아트'))
    expect(button('라인아트').getAttribute('aria-pressed')).toBe('true')
    expect(run).not.toHaveBeenCalled()

    await click(button('적용'))
    expect(run).toHaveBeenCalledWith('lineart')
  })

  it('passes tool options from the action bar', async () => {
    await act(async () => root.render(h(DirectorMode)))

    await click(button('색칠'))
    await click(button('적용'))
    expect(run).toHaveBeenCalledWith('colorize', { prompt: '', defry: 0 })
  })

  it('runs a tool on a single click when instant run is enabled', async () => {
    useDirectorStore.setState({ instantRun: true })
    await act(async () => root.render(h(DirectorMode)))

    await click(button('스케치'))
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith('sketch')
  })
})

describe('director instant run preference', () => {
  it('defaults to off and hydrates the stored value', async () => {
    useDirectorStore.setState({ instantRun: false })
    await useDirectorStore.getState().hydrate()
    expect(useDirectorStore.getState().instantRun).toBe(false)

    invoke.mockResolvedValueOnce({ value: '1' })
    await useDirectorStore.getState().hydrate()
    expect(invoke).toHaveBeenLastCalledWith('settings:get', { key: 'director_instant_run' })
    expect(useDirectorStore.getState().instantRun).toBe(true)
  })

  it('persists changes through the settings store', () => {
    useDirectorStore.getState().setInstantRun(true)
    expect(useDirectorStore.getState().instantRun).toBe(true)
    expect(invoke).toHaveBeenCalledWith('settings:set', { key: 'director_instant_run', value: '1' })
  })
})
