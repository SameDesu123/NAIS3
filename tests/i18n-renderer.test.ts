// @vitest-environment happy-dom
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FolderListView } from '../src/renderer/src/components/folder-list-view'
import { buildDisplayRows } from '../src/renderer/src/lib/folder-list'
import { useLanguageStore, useT } from '../src/renderer/src/lib/i18n'
import { useThemeStore } from '../src/renderer/src/stores/theme-store'
import type { NaisApi } from '../src/preload/index'

let root: Root
let container: HTMLDivElement
const invoke = vi.fn()

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  invoke.mockResolvedValue({ value: null })
  window.nais = { invoke, on: () => () => {} } as NaisApi
  useLanguageStore.setState({ lang: 'ko' })
  useThemeStore.setState({ uiFont: 'Custom Font', uiSize: 16 })
  document.documentElement.lang = 'ko'
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
})

describe('live language changes', () => {
  it.each([false, true])(
    'updates memoized cards without losing edited inputs (grid=%s)',
    async (grid) => {
      const items = [{ id: 1, folderId: null }]
      const rows = buildDisplayRows([], items)
      const folderActions = {
        rename: vi.fn(),
        toggleCollapse: vi.fn(),
        setColor: vi.fn(),
        remove: vi.fn(),
        addItem: vi.fn()
      }
      function Host(): React.ReactElement {
        const t = useT()
        const render = (): React.ReactNode =>
          h(
            'div',
            null,
            h('span', { 'data-translation': true }, t('ui.settings')),
            h('input', { defaultValue: 'original', 'aria-label': 'draft' })
          )
        return h(FolderListView, {
          rows,
          searching: true,
          expandedId: null,
          folderActions,
          onMove: vi.fn(),
          renderHeader: render,
          ...(grid ? { renderTile: render, columns: 2 } : {}),
          emptyText: t('ui.nothingYet')
        })
      }
      await act(async () => root.render(h(Host)))
      const input = container.querySelector('input')!
      input.value = 'unsaved draft'
      expect(container.querySelector('[data-translation]')?.textContent).toBe('설정')
      await act(async () => useLanguageStore.getState().setLang('en'))
      expect(container.querySelector('[data-translation]')?.textContent).toBe('Settings')
      expect(container.querySelector('input')).toBe(input)
      expect(input.value).toBe('unsaved draft')
      await act(async () => useLanguageStore.getState().setLang('zh-CN'))
      expect(container.querySelector('[data-translation]')?.textContent).toBe('设置')
      expect(input.value).toBe('unsaved draft')
      expect(document.documentElement.lang).toBe('zh-CN')
      const font = document.documentElement.style.getPropertyValue('--font-ui')
      expect(font).toContain('Custom Font')
      expect(font).toContain('PingFang SC')
      await act(async () => useLanguageStore.getState().setLang('ko'))
      expect(container.querySelector('[data-translation]')?.textContent).toBe('설정')
      expect(document.documentElement.style.getPropertyValue('--font-ui')).not.toContain(
        'PingFang SC'
      )
      expect(invoke).toHaveBeenCalledWith('settings:set', { key: 'ui_language', value: 'zh-CN' })
    }
  )

  it('hydrates a saved language without replacing it with the browser locale', async () => {
    window.nais.runtime = 'browser'
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-US')
    invoke.mockResolvedValue({ value: 'zh-CN' })
    await useLanguageStore.getState().hydrate()
    expect(useLanguageStore.getState().lang).toBe('zh-CN')
    expect(document.documentElement.lang).toBe('zh-CN')
    expect(invoke).not.toHaveBeenCalledWith('settings:set', expect.anything())
  })

  it('uses the locale for a new browser workspace, while retaining the desktop fallback', async () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('zh-SG')
    await useLanguageStore.getState().hydrate()
    expect(useLanguageStore.getState().lang).toBe('ko')
    window.nais.runtime = 'browser'
    await useLanguageStore.getState().hydrate()
    expect(useLanguageStore.getState().lang).toBe('zh-CN')
    expect(invoke).toHaveBeenCalledWith('settings:set', { key: 'ui_language', value: 'zh-CN' })
  })
})
