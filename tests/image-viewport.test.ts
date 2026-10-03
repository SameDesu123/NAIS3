// @vitest-environment happy-dom
import { useLanguageStore } from '../src/renderer/src/lib/i18n'
import { act, createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ZoomableImageStage } from '../src/renderer/src/components/image-viewport'
let cleanup = async (): Promise<void> => {}
afterEach(async () => {
  await cleanup()
  vi.unstubAllGlobals()
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
