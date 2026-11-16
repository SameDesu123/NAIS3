// @vitest-environment happy-dom
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Toaster } from '../src/renderer/src/components/toaster'
import { Dialog, DialogContent, DialogTitle } from '../src/renderer/src/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '../src/renderer/src/components/ui/popover'
import { useToastStore } from '../src/renderer/src/stores/toast-store'
import type { NaisApi } from '../src/preload/index'

vi.mock('motion/react', async (original) => ({
  ...(await original<typeof import('motion/react')>()),
  useReducedMotion: () => true
}))

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  window.nais = { invoke: vi.fn(async () => ({ value: null })), on: () => () => {} } as NaisApi
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => {
    for (const toast of useToastStore.getState().toasts) useToastStore.getState().dismiss(toast.id)
    root.unmount()
  })
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const advance = async (ms: number): Promise<void> => {
  await act(async () => vi.advanceTimersByTimeAsync(ms))
}

const push = async (message: string): Promise<void> => {
  await act(async () => useToastStore.getState().push(message))
}

function region(): HTMLElement {
  return document.querySelector<HTMLElement>('[role="region"]')!
}

describe('rendered toast regressions', () => {
  it('keeps notifications visible while a non-modal Radix popover is open', async () => {
    await act(async () =>
      root.render(
        h(
          'div',
          null,
          h(
            Popover,
            { defaultOpen: true },
            h(PopoverTrigger, null, 'Resolution'),
            h(PopoverContent, { 'aria-label': 'Resolutions' }, 'Options')
          ),
          h(Toaster)
        )
      )
    )
    await push('This resolution already exists')
    expect(document.querySelector('[role="dialog"][data-state="open"]')).not.toBeNull()
    expect(region().getAttribute('aria-hidden')).not.toBe('true')
    expect(region().style.visibility).not.toBe('hidden')
  })

  it.each(['dialog', 'alertdialog'] as const)(
    'shows action results inside an open %s so its focus trap and accessibility tree include them',
    async (role) => {
      await act(async () =>
        root.render(
          h(
            'div',
            null,
            h(
              Dialog,
              { open: true },
              h(
                DialogContent,
                {
                  role,
                  'aria-describedby': undefined,
                  onOpenAutoFocus: (event) => event.preventDefault()
                },
                h(DialogTitle, null, 'Backup'),
                h('button', null, 'Export')
              )
            ),
            h(Toaster)
          )
        )
      )
      await push('Backup exported')
      const dialog = document.querySelector(`[role="${role}"]`)!
      expect(dialog.contains(region())).toBe(true)
      expect(region().getAttribute('aria-hidden')).not.toBe('true')
      expect(region().style.visibility).not.toBe('hidden')
      const close = region().querySelector('button')!
      await act(async () => close.focus())
      expect(document.activeElement).toBe(close)
    }
  )

  it('does not extend an existing toast when a new toast arrives or another is dismissed', async () => {
    await act(async () => root.render(h(Toaster)))
    await push('First')
    const firstId = useToastStore.getState().toasts[0].id
    await advance(1000)
    await push('Second')
    await advance(1000)
    await push('Third')
    const thirdId = useToastStore.getState().toasts.at(-1)!.id
    await act(async () => useToastStore.getState().dismiss(thirdId))
    await advance(1001)
    expect(useToastStore.getState().toasts.some((toast) => toast.id === firstId)).toBe(false)
    expect(useToastStore.getState().toasts.map((toast) => toast.message)).toEqual(['Second'])
  })

  it('preserves the remaining duration when keyboard focus pauses a toast', async () => {
    await act(async () => root.render(h(Toaster)))
    await push('Read this')
    await advance(2000)
    const close = region().querySelector('button')!
    await act(async () => close.focus())
    await advance(10000)
    expect(useToastStore.getState().toasts).toHaveLength(1)
    await act(async () => close.blur())
    await advance(1001)
    expect(useToastStore.getState().toasts).toHaveLength(0)
  })

  it('announces only new messages and never rereads older messages on dismissal', async () => {
    await act(async () => root.render(h(Toaster)))
    await push('First message')
    expect(region().querySelector('[role="status"]')?.textContent).toBe('First message')
    await push('Second message')
    const live = region().querySelector('[role="status"]')!
    expect(live.textContent).toBe('Second message')
    await act(async () =>
      useToastStore.getState().dismiss(useToastStore.getState().toasts.at(-1)!.id)
    )
    expect(live.textContent).not.toContain('First message')
  })
  it('keeps all same-turn arrivals in the fallback announcement without repeating earlier ones', async () => {
    await act(async () => root.render(h(Toaster)))
    await push('Earlier')
    await act(async () => {
      useToastStore.getState().push('Burst one')
      useToastStore.getState().push('Burst two')
    })
    const live = region().querySelector('[role="status"]')!
    expect(live.textContent).toContain('Burst one')
    expect(live.textContent).toContain('Burst two')
    expect(live.textContent).not.toContain('Earlier')
  })

  it('uses ariaNotify when supported without announcing removals or replaying old messages', async () => {
    const announce = vi.fn()
    Object.defineProperty(document, 'ariaNotify', { configurable: true, value: announce })
    try {
      await act(async () => root.render(h(Toaster)))
      await push('New information')
      await act(async () => useToastStore.getState().push('New error', 'error'))
      const id = useToastStore.getState().toasts[0].id
      await act(async () => useToastStore.getState().dismiss(id))
      expect(announce.mock.calls).toEqual([
        ['New information', { priority: 'normal' }],
        ['New error', { priority: 'high' }]
      ])
      expect(region().querySelector('[role="status"]')?.textContent).toBe('')
    } finally {
      Reflect.deleteProperty(document, 'ariaNotify')
    }
  })

  it('keeps a toast and its remaining time when its dialog closes', async () => {
    const view = (open: boolean): React.ReactElement =>
      h(
        'div',
        null,
        h(
          Dialog,
          { open },
          h(
            DialogContent,
            { 'aria-describedby': undefined, onOpenAutoFocus: (event) => event.preventDefault() },
            h(DialogTitle, null, 'Backup')
          )
        ),
        h(Toaster)
      )
    await act(async () => root.render(view(true)))
    await push('Export completed')
    await advance(1000)
    await act(async () => root.render(view(false)))
    expect(region().parentElement).toBe(document.body)
    expect(useToastStore.getState().toasts).toHaveLength(1)
    await advance(2001)
    expect(useToastStore.getState().toasts).toHaveLength(0)
  })
})
