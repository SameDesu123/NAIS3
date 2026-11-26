// @vitest-environment happy-dom
import { act, createElement as h, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NaisApi } from '../src/preload/index'
import { CommandBar } from '../src/renderer/src/components/command-bar'
import { useLanguageStore } from '../src/renderer/src/lib/i18n'
import { useCommandBarStore } from '../src/renderer/src/stores/command-bar-store'
import { useLayoutStore } from '../src/renderer/src/stores/layout-store'
import {
  bindShortcuts,
  formatCombo,
  useShortcutsStore
} from '../src/renderer/src/stores/shortcuts-store'

let root: Root
let container: HTMLDivElement
let unbind: () => void
const invoke = vi.fn()

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  invoke.mockResolvedValue({ value: null })
  window.nais = { invoke, on: () => () => {} } as NaisApi
  useLanguageStore.setState({ lang: 'ko' })
  useLayoutStore.setState(useLayoutStore.getInitialState())
  useShortcutsStore.setState(useShortcutsStore.getInitialState())
  useCommandBarStore.setState({ open: false })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () =>
    root.render(h(Fragment, null, h('button', { id: 'opener' }, 'opener'), h(CommandBar)))
  )
  unbind = bindShortcuts()
})

afterEach(async () => {
  unbind()
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  invoke.mockReset()
})

const input = (): HTMLInputElement => document.querySelector('[role="combobox"]')!
const options = (): string[] =>
  Array.from(document.querySelectorAll('[role="option"]')).map((el) => el.textContent ?? '')
const selected = (): string =>
  document.querySelector('[role="option"][aria-selected="true"]')?.textContent ?? ''

/** n번째 결과에 곁들인 다른 언어 라벨 */
function matchedLabel(n: number): { text: string; lang: string } | null {
  const hint = document.querySelectorAll('[role="option"]')[n]?.querySelector('[lang]')
  return hint ? { text: hint.textContent ?? '', lang: hint.getAttribute('lang') ?? '' } : null
}

async function openBar(): Promise<void> {
  document.getElementById('opener')!.focus()
  await act(async () => useCommandBarStore.getState().setOpen(true))
  await vi.waitFor(() => expect(document.activeElement).toBe(input()))
}

async function type(value: string): Promise<void> {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setValue.call(input(), value)
    input().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function press(key: string, init: KeyboardEventInit = {}): Promise<void> {
  await act(async () => {
    input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }))
  })
}

describe('CommandBar', () => {
  it('opens and closes with Mod+K and blocks other shortcuts while open', async () => {
    const ctrl = (key: string): KeyboardEvent =>
      new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true })
    await act(async () => window.dispatchEvent(ctrl('k')))
    expect(useCommandBarStore.getState().open).toBe(true)

    // Mod+2(씬 모드)는 바 뒤에서 돌지 않는다
    await act(async () => window.dispatchEvent(ctrl('2')))
    expect(useLayoutStore.getState().centerMode).toBe('main')

    await act(async () => window.dispatchEvent(ctrl('k')))
    expect(useCommandBarStore.getState().open).toBe(false)
  })

  it('lists commands with their shortcuts and hides pages hidden from the tabs', async () => {
    useLayoutStore.setState({ hiddenPages: ['scene', 'websearch'] })
    await openBar()
    const labels = options()
    expect(labels.some((l) => l.startsWith('라이브러리 모드'))).toBe(true)
    expect(labels.some((l) => l.startsWith('설정 열기'))).toBe(true)
    expect(labels.some((l) => l.startsWith('씬 모드'))).toBe(false)
    expect(labels.some((l) => l.startsWith('웹 모드'))).toBe(false)
    expect(labels.some((l) => l.startsWith('커맨드 바 열기'))).toBe(false)
    expect(selected()).toContain(formatCombo('Mod+Enter'))
  })

  it('finds commands in any language and shows the other-language label that matched', async () => {
    await openBar()
    await type('ㄷㄹㅌ')
    expect(options()[0]).toContain('디렉터 모드')
    await type('settings')
    expect(options()[0]).toContain('설정 열기')
    // 지금 언어 라벨로 맞으면 다른 언어 라벨은 곁들이지 않는다
    await type('ㅆㅁ')
    expect(options()[0]).toBe('씬 모드' + formatCombo('Mod+2'))
    // 다른 언어의 라벨로 맞으면 그 라벨을 그 언어로 표시해 곁들인다
    await type('settings')
    expect(matchedLabel(0)).toEqual({ text: 'Open settings', lang: 'en' })
    await act(async () => useLanguageStore.setState({ lang: 'en' }))
    await type('ㅆㅁ')
    expect(options()[0]).toContain('Scene mode')
    expect(matchedLabel(0)).toEqual({ text: '씬 모드', lang: 'ko' })
    await type('scene')
    expect(matchedLabel(0)).toBeNull()
    await type('zzzz')
    expect(options()).toEqual([])
    expect(document.querySelector('[role="status"]')?.textContent).toBe('No matching commands')
  })

  it('moves the selection with the arrow keys, wrapping at the ends', async () => {
    await openBar()
    await type('모드')
    const all = options()
    expect(selected()).toBe(all[0])
    await press('ArrowDown')
    expect(selected()).toBe(all[1])
    await press('ArrowUp')
    await press('ArrowUp')
    expect(selected()).toBe(all.at(-1))
    expect(input().getAttribute('aria-activedescendant')).toBe(
      document.querySelector('[role="option"][aria-selected="true"]')!.id
    )
  })

  it('ignores Enter while the IME is composing', async () => {
    await openBar()
    await type('ㅆ')
    await press('Enter', { isComposing: true })
    expect(useCommandBarStore.getState().open).toBe(true)
  })

  it('runs the chosen command after closing and returns focus to where it was', async () => {
    await openBar()
    await type('씬 모드')
    await press('Enter')
    expect(useCommandBarStore.getState().open).toBe(false)
    await vi.waitFor(() => expect(useLayoutStore.getState().centerMode).toBe('scene'))
    expect(document.activeElement?.id).toBe('opener')
  })

  it('runs a command when its row is clicked', async () => {
    await openBar()
    const row = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((el) =>
      el.textContent?.startsWith('설정 열기')
    )!
    await act(async () => row.click())
    await vi.waitFor(() => expect(useLayoutStore.getState().settingsOpen).toBe(true))
  })

  it('returns focus without running anything when dismissed', async () => {
    await openBar()
    await press('Escape')
    await vi.waitFor(() => expect(document.activeElement?.id).toBe('opener'))
    expect(useCommandBarStore.getState().open).toBe(false)
    expect(useLayoutStore.getState().centerMode).toBe('main')
    expect(useLayoutStore.getState().settingsOpen).toBe(false)
  })
})
