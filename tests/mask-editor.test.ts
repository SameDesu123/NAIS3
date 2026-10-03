// @vitest-environment happy-dom
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MaskEditor } from '../src/renderer/src/components/mask-editor'
import { useLanguageStore } from '../src/renderer/src/lib/i18n'

let root: Root
let container: HTMLDivElement
const ctx = {
  beginPath: vi.fn(),
  moveTo: vi.fn(),
  lineTo: vi.fn(),
  stroke: vi.fn(),
  arc: vi.fn(),
  fill: vi.fn(),
  fillRect: vi.fn(),
  clearRect: vi.fn(),
  globalCompositeOperation: 'source-over',
  lineWidth: 0
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('innerWidth', 1200)
  vi.stubGlobal('innerHeight', 1000)
  useLanguageStore.setState({ lang: 'en' })
  // happy-dom has no canvas renderer; record commands at the browser canvas boundary.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never)
  vi.spyOn(HTMLElement.prototype, 'setPointerCapture').mockImplementation(() => {})
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

async function renderEditor(): Promise<HTMLCanvasElement> {
  await act(async () =>
    root.render(
      h(MaskEditor, {
        imageBase64: '',
        width: 1240,
        height: 620,
        onCancel: vi.fn(),
        onConfirm: vi.fn()
      })
    )
  )
  return document.querySelector('canvas')!
}

async function click(label: string): Promise<void> {
  const button = Array.from(document.querySelectorAll('button')).find(
    (el) => el.getAttribute('aria-label') === label || el.textContent?.trim() === label
  )
  expect(button, `button: ${label}`).toBeDefined()
  await act(async () => button!.click())
}

async function pointer(
  canvas: HTMLCanvasElement,
  type: string,
  x: number,
  y: number,
  button = 0
): Promise<void> {
  await act(async () => {
    canvas.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        pointerId: 1,
        clientX: x,
        clientY: y,
        button
      })
    )
  })
}

describe('precise inpaint editing', () => {
  it('paints with a one-source-pixel diameter and increments in single pixels', async () => {
    const canvas = await renderEditor()
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 80, 620, 310))
    const slider = document.querySelector('[role="slider"]')!
    await act(async () => {
      slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    })
    await pointer(canvas, 'pointerdown', 110, 90)
    await pointer(canvas, 'pointerup', 110, 90)
    expect(ctx.fillRect).toHaveBeenLastCalledWith(20, 20, 1, 1)
    expect(ctx.arc).not.toHaveBeenCalled()
    await act(async () => {
      slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    await pointer(canvas, 'pointerdown', 110, 90)
    expect(ctx.lineWidth).toBe(2)
  })

  it('erases whole single pixels along a continuous thin stroke', async () => {
    const canvas = await renderEditor()
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 80, 620, 310))
    const slider = document.querySelector('[role="slider"]')!
    await act(async () => {
      slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    })
    await click('Erase')
    await pointer(canvas, 'pointerdown', 110, 90)
    await pointer(canvas, 'pointermove', 111.5, 91)
    await pointer(canvas, 'pointerup', 111.5, 91)
    expect(ctx.clearRect.mock.calls).toEqual([
      [20, 20, 1, 1],
      [20, 20, 1, 1],
      [21, 21, 1, 1],
      [22, 21, 1, 1],
      [23, 22, 1, 1]
    ])
    expect(ctx.arc).not.toHaveBeenCalled()
  })

  it('zooms around the viewport center without changing the bitmap or source brush size', async () => {
    const canvas = await renderEditor()
    await click('Zoom in')
    const surface = canvas.parentElement!
    expect(parseFloat(surface.style.width)).toBe(775)
    expect(parseFloat(surface.style.left)).toBe(-77.5)
    expect(canvas.width).toBe(1240)
    expect(canvas.height).toBe(620)
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(22.5, 41.25, 775, 387.5))
    await pointer(canvas, 'pointerdown', 410, 235)
    await pointer(canvas, 'pointerup', 410, 235)
    expect(ctx.arc).toHaveBeenLastCalledWith(620, 310, 14, 0, Math.PI * 2)
    await click('Fit to view')
    expect(parseFloat(surface.style.width)).toBe(620)
    expect(parseFloat(surface.style.left)).toBe(0)
    expect(ctx.clearRect).not.toHaveBeenCalled()
  })

  it('anchors wheel zoom at the pointer and pans without painting', async () => {
    const canvas = await renderEditor()
    const surface = canvas.parentElement!
    const viewport = surface.parentElement!
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 80, 620, 310))
    const wheel = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX: 200,
      clientY: 130,
      deltaY: -100
    })
    // happy-dom's WheelEvent extends UIEvent and omits the MouseEvent coordinates.
    Object.defineProperties(wheel, { clientX: { value: 200 }, clientY: { value: 130 } })
    await act(async () => {
      canvas.dispatchEvent(wheel)
    })
    expect(wheel.defaultPrevented).toBe(true)
    const scale = parseFloat(surface.style.width) / 1240
    expect(scale).toBeGreaterThan(0.5)
    expect((100 - parseFloat(surface.style.left)) / scale).toBeCloseTo(200)
    expect((50 - parseFloat(surface.style.top)) / scale).toBeCloseTo(100)
    const left = parseFloat(surface.style.left)
    await pointer(canvas, 'pointerdown', 200, 130, 1)
    await pointer(canvas, 'pointermove', 250, 160, 1)
    await pointer(canvas, 'pointerup', 250, 160, 1)
    expect(parseFloat(surface.style.left)).toBeCloseTo(left + 50)
    expect(ctx.arc).not.toHaveBeenCalled()
  })

  it('does not paint on right click or continue a cancelled stroke', async () => {
    const canvas = await renderEditor()
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 620, 310))
    await pointer(canvas, 'pointerdown', 10, 10, 2)
    expect(ctx.arc).not.toHaveBeenCalled()
    await pointer(canvas, 'pointerdown', 10, 10)
    await pointer(canvas, 'pointercancel', 10, 10)
    await pointer(canvas, 'pointermove', 20, 20)
    expect(ctx.arc).toHaveBeenCalledTimes(1)
  })

  it('allows Space-drag after focusing a zoom button', async () => {
    const canvas = await renderEditor()
    await click('Zoom in')
    const button = document.querySelector<HTMLButtonElement>('button[aria-label="Zoom in"]')!
    await act(async () => {
      button.focus()
      button.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }))
    })
    const surface = canvas.parentElement!
    const left = parseFloat(surface.style.left)
    await pointer(canvas, 'pointerdown', 200, 130)
    await pointer(canvas, 'pointermove', 250, 160)
    await pointer(canvas, 'pointerup', 250, 160)
    expect(ctx.arc).not.toHaveBeenCalled()
    expect(parseFloat(surface.style.left)).toBe(left + 50)
  })
})
