// @vitest-environment happy-dom
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PromptTagHover } from '../src/renderer/src/components/prompt-tag-hover'
import { togglePromptTag } from '../src/shared/prompt-tags'
import { Dialog, DialogContent, DialogTitle } from '../src/renderer/src/components/ui/dialog'

vi.mock('../src/renderer/src/lib/i18n', () => ({ useT: () => (id: string) => id }))
let container: HTMLDivElement
let textarea: HTMLTextAreaElement
let root: Root
const update = vi.fn()
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  update.mockReset()
  container = document.createElement('div')
  textarea = document.createElement('textarea')
  document.body.append(container, textarea)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  textarea.remove()
})
async function render(value = 'blue eyes, red hair', modal = false): Promise<void> {
  const inputRef = { current: textarea }
  const oldTextarea = textarea
  const editor = h(PromptTagHover, {
    value,
    onValueChange: update,
    textarea: inputRef,
    children: h('textarea', { ref: inputRef, defaultValue: value }),
    typography: ''
  })
  await act(async () =>
    root.render(
      modal
        ? h(
            Dialog,
            { open: true },
            h(DialogContent, null, h(DialogTitle, null, 'Fragment'), editor)
          )
        : editor
    )
  )
  oldTextarea.remove()
  textarea = inputRef.current
  document.querySelectorAll<HTMLElement>('[data-tag-start]').forEach((span, i) => {
    span.getClientRects = () =>
      [{ left: 10 + i * 100, right: 90 + i * 100, top: 10, bottom: 30 }] as unknown as DOMRectList
  })
}
async function point(type: string, x = 20): Promise<MouseEvent> {
  const event = new MouseEvent(type, { clientX: x, clientY: 20, bubbles: true, cancelable: true })
  await act(async () => {
    textarea.dispatchEvent(event)
  })
  return event
}
it('opens only on right-click, stays open after mouseleave, and toggles the clicked occurrence', async () => {
  await render()
  await point('mousemove')
  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect((await point('contextmenu', 120)).defaultPrevented).toBe(true)
  await point('mouseleave')
  const item = document.querySelector<HTMLElement>('[role="menuitem"]')!
  expect(item.textContent).toBe('ui.disablePromptTag')
  await act(async () => item.click())
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  expect(update).toHaveBeenCalledWith(togglePromptTag('blue eyes, red hair', 11, 19))
  expect(document.querySelector('[role="menu"]')).toBeNull()
})
it('keeps a parent modal open when dismissing or selecting a tag menu', async () => {
  await render('blue eyes, red hair', true)
  await point('contextmenu')
  await act(async () =>
    document
      .querySelector('[role="menu"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  )
  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  await point('contextmenu', 120)
  await act(async () => document.querySelector<HTMLElement>('[role="menuitem"]')!.click())
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  expect(update).toHaveBeenCalledWith(togglePromptTag('blue eyes, red hair', 11, 19))
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  expect(document.activeElement).toBe(textarea)
})
it('does not offer tag controls on a comment line inside a multiline tag', async () => {
  await render('blue eyes\n# notes, with commas\nred hair, smile')
  expect(container.querySelector('[data-prompt-tag-mirror]')?.textContent).toContain(
    '# notes, with commas'
  )
  expect(
    [...container.querySelectorAll('[data-tag-start]')].some((span) =>
      span.textContent?.includes('#')
    )
  ).toBe(false)
})
it('adds a final-line sentinel and replaces stored marks without adding break opportunities', async () => {
  await render(togglePromptTag('longword', 0, 8) + '\n')
  const mirror = container.querySelector('[data-prompt-tag-mirror]')!
  expect(mirror.textContent).toBe([...'longword'].map((c) => c + '\u2060').join('') + '\n\u200b')
})
it('keeps the native menu outside tags and dismisses the custom menu with Escape', async () => {
  await render()
  expect((await point('contextmenu', 500)).defaultPrevented).toBe(false)
  await point('contextmenu')
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  expect(document.querySelector('[role="menu"]')).toBeNull()
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  expect(document.activeElement).toBe(textarea)
})
it('shows disabled text without a visible strike and offers reactivation', async () => {
  await render(togglePromptTag('blue eyes', 0, 9))
  const span = container.querySelector<HTMLElement>('[data-tag-start]')!
  expect(span.textContent).not.toContain('\u0336')
  expect(span.style.color).toBe('var(--prompt-tag-disabled-ink)')
  await point('contextmenu')
  expect(document.querySelector('[role="menuitem"]')?.textContent).toBe('ui.enablePromptTag')
  await act(async () => {
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  })
  expect(document.querySelector('[role="menu"]')).toBeNull()
})
