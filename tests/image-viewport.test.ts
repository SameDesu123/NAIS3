// @vitest-environment happy-dom
import { useLanguageStore } from '../src/renderer/src/lib/i18n'
import { act, createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ZoomableImageStage } from '../src/renderer/src/components/image-viewport'
let cleanup = async (): Promise<void> => {}
afterEach(async () => {
  await cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function renderStage(): Promise<HTMLDivElement> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useLanguageStore.setState({ lang: 'ko' })
  const div = document.createElement('div')
  document.body.append(div)
  const root = createRoot(div)
  cleanup = async () => {
    await act(async () => root.unmount())
    div.remove()
  }
  await act(async () =>
    root.render(h(ZoomableImageStage, { src: 'data:image/png;base64,AAAA', width: 64, height: 64 }))
  )
  return div
}

it('preserves Space defaults on controls while suppressing page scroll on the viewport', async () => {
  const div = await renderStage()
  const viewport = div.firstElementChild!
  const button = div.querySelector('button')!
  const slider = document.createElement('span')
  slider.setAttribute('role', 'slider')
  const input = document.createElement('input')
  const editable = document.createElement('div')
  editable.setAttribute('contenteditable', 'true')
  viewport.append(slider, input, editable)
  for (const target of [button, slider, input, editable]) {
    const event = new KeyboardEvent('keydown', {
      key: ' ',
      code: 'Space',
      bubbles: true,
      cancelable: true
    })
    target.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    target.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', bubbles: true }))
  }
  const event = new KeyboardEvent('keydown', {
    key: ' ',
    code: 'Space',
    bubbles: true,
    cancelable: true
  })
  viewport.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(true)
})

it('cancels browser wheel zoom, applies successive events, and releases the listener on unmount', async () => {
  const registrations = vi.spyOn(HTMLElement.prototype, 'addEventListener')
  const div = await renderStage()
  const viewport = div.firstElementChild!
  // happy-dom does not trigger React's passive-listener feature detection. Check the
  // actual DOM registration as well as cancellation so this catches browser regressions.
  expect(
    registrations.mock.calls.some(
      ([type, , options], index) =>
        registrations.mock.contexts[index] === viewport &&
        type === 'wheel' &&
        typeof options === 'object' &&
        options?.passive === false
    )
  ).toBe(true)
  const wheel = (): WheelEvent =>
    new WheelEvent('wheel', {
      deltaY: -100,
      ctrlKey: true,
      bubbles: true,
      cancelable: true
    })
  const first = wheel()
  const second = wheel()
  await act(async () => {
    viewport.dispatchEvent(first)
    viewport.dispatchEvent(second)
  })
  expect(first.defaultPrevented).toBe(true)
  expect(second.defaultPrevented).toBe(true)
  expect(div.textContent).toContain('135%')
  await cleanup()
  cleanup = async () => {}
  const afterUnmount = wheel()
  viewport.dispatchEvent(afterUnmount)
  expect(afterUnmount.defaultPrevented).toBe(false)
})

it('keeps zooming when plus is clicked twice quickly', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useLanguageStore.setState({ lang: 'ko' })
  const div = document.createElement('div')
  document.body.append(div)
  const root = createRoot(div)
  cleanup = async () => {
    await act(async () => root.unmount())
    div.remove()
  }
  await act(async () =>
    root.render(h(ZoomableImageStage, { src: 'data:image/png;base64,AAAA', width: 64, height: 64 }))
  )
  const plus = div.querySelector('button[title="확대"]') as HTMLButtonElement
  await act(async () => plus.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })))
  expect(div.textContent).toContain('125%')
  await act(async () => plus.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 })))
  expect(div.textContent).toContain('156%')
  await act(async () =>
    plus.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }))
  )
  expect(div.textContent).toContain('156%')
  await act(async () =>
    div.firstElementChild!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }))
  )
  expect(div.textContent).toContain('100%')
})
