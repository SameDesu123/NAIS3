// @vitest-environment happy-dom
import { act, createElement as h, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  CharacterPositionEditor,
  CharacterPositionPanel
} from '../src/renderer/src/components/character-position-editor'
import { DEFAULT_POSITION_GUIDES } from '../src/renderer/src/lib/character-position'
import { useLanguageStore } from '../src/renderer/src/lib/i18n'
import type { CharacterCard } from '../src/shared/types'

let root: Root
let container: HTMLDivElement
const onPosition = vi.fn()

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useLanguageStore.setState({ lang: 'en' })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  onPosition.mockReset()
})

const characters: CharacterCard[] = [1, 2].map((id) => ({
  id,
  name: `Character ${id}`,
  prompt: 'girl',
  negativePrompt: '',
  thumbnail: '',
  enabled: true,
  center: { x: 0.2 * id, y: 0.25 },
  folderId: null
}))

const rect = {
  left: 100,
  top: 200,
  width: 500,
  height: 1000,
  right: 600,
  bottom: 1200,
  x: 100,
  y: 200,
  toJSON: () => ({})
}

const pointer = (type: string, clientX: number, clientY: number, button = 0): PointerEvent =>
  new PointerEvent(type, { bubbles: true, pointerId: 1, isPrimary: true, button, clientX, clientY })

function EditorHarness(): React.JSX.Element {
  const [guides, setGuides] = useState(DEFAULT_POSITION_GUIDES)
  return h(CharacterPositionEditor, {
    open: true,
    characters,
    width: 832,
    height: 1216,
    guides,
    onGuidesChange: setGuides,
    onPosition,
    onClose: vi.fn()
  })
}

it('keeps guide state across language changes', async () => {
  await act(async () => root.render(h(EditorHarness)))
  const button = (text: string): HTMLButtonElement =>
    Array.from(document.querySelectorAll('button')).find((item) => item.textContent === text)!
  await act(async () => button('Grid').click())
  await act(async () => useLanguageStore.setState({ lang: 'zh-CN' }))
  expect(button('网格').getAttribute('aria-pressed')).toBe('true')
  expect(document.querySelector('button[aria-label="增加列数"]')).not.toBeNull()
  await act(async () => useLanguageStore.setState({ lang: 'en' }))
  const increment = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Increase number of Columns"]'
  )!
  await act(async () => increment.click())
  expect(increment.parentElement?.textContent).toContain('4')
  expect(button('Grid').getAttribute('aria-pressed')).toBe('true')
})

it('drags the hovered marker directly without selecting it first', async () => {
  const onExpand = vi.fn()
  await act(async () =>
    root.render(
      h(CharacterPositionPanel, {
        characters,
        width: 832,
        height: 1216,
        guides: DEFAULT_POSITION_GUIDES,
        onPosition,
        onExpand
      })
    )
  )
  const canvas = container.querySelector<HTMLDivElement>('[role="group"]')!
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(rect)
  const marker = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Character 2 position: X 40.0%, Y 25.0%"]'
  )!
  const capture = vi.fn()
  Object.defineProperty(marker, 'setPointerCapture', { configurable: true, value: capture })

  // 오른쪽 클릭은 무시
  await act(async () => marker.dispatchEvent(pointer('pointerdown', 305, 452, 2)))
  await act(async () => marker.dispatchEvent(pointer('pointermove', 400, 500)))
  expect(onPosition).not.toHaveBeenCalled()

  // 마커 중심(300, 450)에서 (5, 2) 어긋난 곳을 잡아도 마커는 튀지 않고 이동량만큼 움직인다
  await act(async () => marker.dispatchEvent(pointer('pointerdown', 305, 452)))
  expect(document.activeElement).toBe(marker)
  expect(capture).toHaveBeenCalledWith(1)
  expect(onPosition).not.toHaveBeenCalled()
  await act(async () => marker.dispatchEvent(pointer('pointermove', 193, 662)))
  expect(onPosition).toHaveBeenLastCalledWith(2, { x: 0.176, y: 0.46 })
  await act(async () => marker.dispatchEvent(pointer('pointerup', 193, 662)))
  await act(async () => marker.dispatchEvent(pointer('pointermove', 400, 500)))
  expect(onPosition).toHaveBeenCalledTimes(1)

  await act(async () =>
    marker.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight', shiftKey: true })
    )
  )
  expect(onPosition).toHaveBeenLastCalledWith(2, { x: 0.41, y: 0.25 })

  container.querySelector<HTMLButtonElement>('button[aria-label="Expand position editor"]')!.click()
  expect(onExpand).toHaveBeenCalledOnce()
})
