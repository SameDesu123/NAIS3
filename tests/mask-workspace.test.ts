// @vitest-environment happy-dom
import { useLanguageStore } from '../src/renderer/src/lib/i18n'
import { act, createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { NaisApi } from '../src/preload'
import { MaskWorkspace } from '../src/renderer/src/components/mask-workspace'
let cleanup = async (): Promise<void> => {}
afterEach(async () => {
  await cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
it('Escape in mask display popover only dismisses the popover', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useLanguageStore.setState({ lang: 'ko' })
  window.nais = { invoke: vi.fn().mockResolvedValue({ value: null }) } as unknown as NaisApi
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () =>
      ({
        getImageData: () => ({ data: new Uint8ClampedArray(64 * 64 * 4) }),
        createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: vi.fn(),
        clearRect: vi.fn()
      }) as unknown as CanvasRenderingContext2D
  )
  const div = document.createElement('div')
  document.body.append(div)
  const root = createRoot(div)
  const cancel = vi.fn()
  cleanup = async () => {
    await act(async () => root.unmount())
    div.remove()
  }
  await act(async () =>
    root.render(
      h(MaskWorkspace, {
        imageBase64: 'AAAA',
        width: 64,
        height: 64,
        onConfirm: vi.fn(),
        onCancel: cancel
      })
    )
  )
  const trigger = div.querySelector('button[title="마스크 표시 설정"]') as HTMLButtonElement
  expect(trigger).toBeTruthy()
  await act(async () => trigger.click())
  expect(document.querySelector('[data-radix-popper-content-wrapper]')).toBeTruthy()
  await act(async () =>
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        bubbles: true,
        cancelable: true
      })
    )
  )
  expect(cancel).not.toHaveBeenCalled()
  expect(document.querySelector('[data-radix-popper-content-wrapper]')).toBeNull()
  await act(async () =>
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    )
  )
  expect(cancel).toHaveBeenCalledOnce()
})
