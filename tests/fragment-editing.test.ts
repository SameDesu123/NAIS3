// @vitest-environment happy-dom
import { act, createElement as h, Fragment } from 'react'
import { MotionGlobalConfig } from 'motion/react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FragmentOverlay } from '../src/renderer/src/components/fragment-overlay'
import { PromptEditor } from '../src/renderer/src/components/prompt-editor'
import { FragmentEditorDialog } from '../src/renderer/src/components/fragment-editor-dialog'
import { fragmentAtSelection, useFragmentsStore } from '../src/renderer/src/stores/fragments-store'
import { useLanguageStore } from '../src/renderer/src/lib/i18n'
import type { NaisApi } from '../src/preload/index'

let root: Root
let container: HTMLDivElement
const invoke = vi.fn()

beforeEach(() => {
  // Animation timing is not part of these interaction tests.
  MotionGlobalConfig.skipAnimations = true
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  invoke.mockResolvedValue({ items: [], counts: [0] })
  window.nais = { invoke, on: () => () => {} } as NaisApi
  useLanguageStore.setState({ lang: 'ko' })
  useFragmentsStore.setState({
    ...useFragmentsStore.getInitialState(),
    loaded: true,
    folders: [{ id: 10, name: '배경', collapsed: false, color: null }],
    items: [{ id: 1, name: '오피스', content: 'office, desk', folderId: 10 }]
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
  invoke.mockReset()
  MotionGlobalConfig.skipAnimations = false
})

describe('large fragment editor', () => {
  it('keeps focus in the editor when following another fragment reference', async () => {
    useFragmentsStore.setState({
      items: [
        { id: 1, name: 'one', content: '<two>', folderId: null },
        { id: 2, name: 'two', content: 'target', folderId: null }
      ]
    })
    await act(async () => root.render(h(FragmentEditorDialog)))
    await act(async () => useFragmentsStore.getState().openEditor(1))
    const source = document.querySelector('textarea')!
    source.setSelectionRange(1, 4)
    await act(async () => source.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
    expect(useFragmentsStore.getState().editingId).toBe(2)
    expect(document.activeElement).toBe(document.querySelector('textarea'))
  })

  it('restores focus to the row after opening from its context menu', async () => {
    await act(async () =>
      root.render(h(Fragment, null, h(FragmentOverlay), h(FragmentEditorDialog)))
    )
    const title = Array.from(container.querySelectorAll('button')).find(
      (el) => el.textContent === '오피스'
    )!
    title.focus()
    await act(async () =>
      title.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }))
    )
    const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
      (el) => el.textContent?.includes('크게 편집')
    )!
    await act(async () => item.click())
    await vi.waitFor(async () => {
      await act(async () => {})
      expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    })
    await act(async () => useFragmentsStore.getState().closeEditor())
    await vi.waitFor(() => expect(document.activeElement).toBe(title))
  })

  async function openFromPrompt(): Promise<HTMLTextAreaElement> {
    await act(async () =>
      root.render(
        h(
          Fragment,
          null,
          h(PromptEditor, { value: '<배경/오피스>', onValueChange: vi.fn(), tokensOverride: null }),
          h(FragmentEditorDialog)
        )
      )
    )
    const source = container.querySelector('textarea')!
    source.focus()
    source.setSelectionRange(4, 7)
    await act(async () => source.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('오피스')
    return source
  }

  it('edits the shared fragment content and returns focus to the original prompt on close', async () => {
    const source = await openFromPrompt()
    const editor = document.querySelector<HTMLTextAreaElement>('[aria-label="조각 내용"]')!
    expect(document.activeElement).toBe(editor)
    expect(editor.value).toBe('office, desk')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        editor,
        'office, window'
      )
      editor.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(useFragmentsStore.getState().items[0].content).toBe('office, window')
    expect(invoke).toHaveBeenCalledWith('frags:update', {
      id: 1,
      patch: { content: 'office, window' }
    })
    await key(editor, 'Escape')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    // Radix restores focus in a deferred unmount callback.
    await vi.waitFor(() => expect(document.activeElement).toBe(source))
    expect(source.value).toBe('<배경/오피스>')
    expect(source.selectionStart).toBe(4)
  })

  it('closes find first, then the editor, with Escape', async () => {
    await openFromPrompt()
    const shortcut = vi.fn()
    window.addEventListener('keydown', shortcut)
    const editor = document.querySelector<HTMLTextAreaElement>('[aria-label="조각 내용"]')!
    await act(async () =>
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }))
    )
    const find =
      document.querySelector<HTMLInputElement>('input[placeholder="찾기…"]') ??
      document.querySelector<HTMLInputElement>('[data-prompt-find] input')!
    expect(find).not.toBeNull()
    window.removeEventListener('keydown', shortcut)
    expect(shortcut).not.toHaveBeenCalled()
    await key(find, 'Escape')
    expect(document.querySelector('[data-prompt-find]')).toBeNull()
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    await key(editor, 'Escape')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
})

async function click(titleOrText: string): Promise<void> {
  const button = Array.from(container.querySelectorAll('button')).find(
    (el) => el.title === titleOrText || el.textContent?.trim() === titleOrText
  )
  expect(button, titleOrText).toBeDefined()
  await act(async () => button!.click())
}

async function key(input: HTMLElement, key: string, isComposing = false): Promise<void> {
  await act(async () => {
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key, isComposing, bubbles: true, cancelable: true })
    )
  })
}

describe('opening fragment references', () => {
  it('resolves normalized collisions in backend order even when the list groups folders', async () => {
    invoke.mockResolvedValueOnce({
      folders: [{ id: 10, name: '배경', collapsed: false, color: null }],
      items: [
        { id: 2, name: 'OFFICE', content: 'root', folderId: null },
        { id: 3, name: 'office', content: 'folder', folderId: 10 }
      ]
    })
    await useFragmentsStore.getState().load()
    expect(fragmentAtSelection('<office>', 1, 7)?.id).toBe(3)
  })

  it('keeps quick edit aligned with generation after dragging colliding references', async () => {
    useFragmentsStore.setState({
      folders: [{ id: 10, name: 'folder', collapsed: false, color: null }],
      items: [
        { id: 3, name: 'office', content: 'folder', folderId: 10 },
        { id: 2, name: 'OFFICE', content: 'root', folderId: null },
        { id: 4, name: 'other', content: 'other', folderId: null }
      ],
      referenceOrder: [2, 3, 4]
    })
    useFragmentsStore.getState().move('i-4', 'i-2')
    expect(fragmentAtSelection('<office>', 1, 7)?.id).toBe(3)
  })

  it.each(['<배경/오피스>', '<오피스>', '<* 배경 / 오피스 >'])(
    'opens %s from a prompt without changing the prompt',
    async (reference) => {
      const onValueChange = vi.fn()
      await act(async () =>
        root.render(
          h(PromptEditor, { value: `1girl, ${reference}`, onValueChange, tokensOverride: null })
        )
      )
      const input = container.querySelector('textarea')!
      input.setSelectionRange(10, 12)
      await act(async () => input.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
      expect(useFragmentsStore.getState()).toMatchObject({ editingId: 1 })
      expect(onValueChange).not.toHaveBeenCalled()
    }
  )

  it.each(['<없는조각>', '<오피스|다른옵션>', '<오피스', 'ordinary text'])(
    'keeps ordinary selection for %s',
    async (value) => {
      await act(async () =>
        root.render(h(PromptEditor, { value, onValueChange: vi.fn(), tokensOverride: null }))
      )
      const input = container.querySelector('textarea')!
      input.setSelectionRange(1, 3)
      await act(async () => input.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
      expect(useFragmentsStore.getState()).toMatchObject({ editingId: null })
    }
  )
})

describe('fragment list editing', () => {
  async function renameInput(): Promise<HTMLInputElement> {
    await act(async () => root.render(h(FragmentOverlay)))
    await click('오피스')
    await click('이름 변경')
    const input = container.querySelector<HTMLInputElement>('input[aria-label="조각 이름"]')
    expect(input).not.toBeNull()
    return input!
  }

  it('renames inline only when confirmed, ignoring the IME confirmation Enter', async () => {
    const input = await renameInput()
    input.value = '새 사무실'
    await key(input, 'Enter', true)
    expect(document.activeElement).toBe(input)
    expect(invoke).not.toHaveBeenCalledWith('frags:update', expect.anything())
    await key(input, 'Enter')
    expect(useFragmentsStore.getState().items[0].name).toBe('새 사무실')
    expect(invoke).toHaveBeenCalledWith('frags:update', { id: 1, patch: { name: '새 사무실' } })
  })

  it('cancels a rename on Escape without saving on blur', async () => {
    const input = await renameInput()
    input.value = 'discard this'
    await key(input, 'Escape')
    await act(async () => input.blur())
    expect(useFragmentsStore.getState().items[0].name).toBe('오피스')
    expect(invoke).not.toHaveBeenCalledWith('frags:update', expect.anything())
  })

  it('commits trimmed names on blur and ignores blank names', async () => {
    const input = await renameInput()
    input.value = '   '
    await act(async () => input.blur())
    expect(useFragmentsStore.getState().items[0].name).toBe('오피스')
    await click('이름 변경')
    const next = container.querySelector<HTMLInputElement>('input[aria-label="조각 이름"]')!
    next.value = '  새 이름  '
    await act(async () => next.blur())
    expect(useFragmentsStore.getState().items[0].name).toBe('새 이름')
  })

  it('opens the expanded card in the shared large editor', async () => {
    await act(async () => root.render(h(FragmentOverlay)))
    await click('오피스')
    await click('크게 편집')
    expect(useFragmentsStore.getState()).toMatchObject({ editingId: 1 })
  })
})
