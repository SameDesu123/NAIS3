// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SAVE_DELAY_MS,
  flushPendingSaves,
  invokeAfterSaves,
  queueSave
} from '../src/renderer/src/lib/pending-saves'
import { useCharactersStore } from '../src/renderer/src/stores/characters-store'
import { useFragmentsStore } from '../src/renderer/src/stores/fragments-store'
import { useScenesStore } from '../src/renderer/src/stores/scenes-store'
import { useVibesStore } from '../src/renderer/src/stores/refs-store'
import type { CharacterCard, Scene, VibeItem } from '../src/shared/types'
import type { NaisApi } from '../src/preload/index'

const invoke = vi.fn()
const calls = (channel: string): unknown[] =>
  invoke.mock.calls.filter(([c]) => c === channel).map(([, req]) => req)

const card = (id: number): CharacterCard => ({
  id,
  name: '',
  prompt: '',
  negativePrompt: '',
  thumbnail: '',
  enabled: false,
  center: { x: 0.5, y: 0.5 },
  folderId: null
})

beforeEach(() => {
  vi.useFakeTimers()
  invoke.mockResolvedValue({ folders: [], items: [] })
  window.nais = { invoke, on: () => () => {} } as NaisApi
  useCharactersStore.setState({ ...useCharactersStore.getInitialState(), items: [card(1)] })
  useFragmentsStore.setState({
    ...useFragmentsStore.getInitialState(),
    items: [{ id: 5, name: 'office', content: '', folderId: null }]
  })
  useScenesStore.setState({ scenes: [{ id: 7, name: 'a', prompt: '' } as Scene] })
  useVibesStore.setState({ items: [{ id: 9, folderId: null, strength: 0.5 } as VibeItem] })
})

afterEach(() => {
  flushPendingSaves()
  vi.useRealTimers()
  invoke.mockReset()
})

describe('pending saves', () => {
  it('writes a character position drag once, with the last position', () => {
    const { updateCard } = useCharactersStore.getState()
    for (let i = 1; i <= 30; i++) updateCard(1, { center: { x: i / 100, y: 0.5 } })

    expect(useCharactersStore.getState().items[0].center).toEqual({ x: 0.3, y: 0.5 })
    expect(calls('chars:update')).toHaveLength(0)
    vi.advanceTimersByTime(SAVE_DELAY_MS)
    expect(calls('chars:update')).toEqual([{ id: 1, patch: { center: { x: 0.3, y: 0.5 } } }])
  })

  it('merges coalesced fields and sends discrete toggles at once', () => {
    const { updateCard } = useCharactersStore.getState()
    updateCard(1, { prompt: 'girl' })
    updateCard(1, { enabled: true })
    expect(calls('chars:update')).toEqual([{ id: 1, patch: { prompt: 'girl', enabled: true } }])
    vi.advanceTimersByTime(SAVE_DELAY_MS)
    expect(calls('chars:update')).toHaveLength(1)
  })

  it('sends pending edits before anything that reads them back from the database', async () => {
    useFragmentsStore.getState().update(5, { content: 'desk' })
    useScenesStore.getState().update(7, { prompt: 'sunset' })
    await invokeAfterSaves('queue:enqueue', { request: {} as never, count: 1 })

    expect(invoke.mock.calls.map(([c]) => c)).toEqual([
      'frags:update',
      'scenes:update',
      'queue:enqueue'
    ])
  })

  it('flushes before a store reloads its list, so the reload sees the edit', async () => {
    useFragmentsStore.getState().update(5, { content: 'desk' })
    await useFragmentsStore.getState().load()
    expect(invoke.mock.calls.map(([c]) => c)).toEqual(['frags:update', 'frags:list'])
  })

  it('drops the pending edit of an item that is deleted', () => {
    useFragmentsStore.getState().update(5, { content: 'desk' })
    useFragmentsStore.getState().remove(5)
    vi.advanceTimersByTime(SAVE_DELAY_MS)
    expect(invoke.mock.calls.map(([c]) => c)).toEqual(['frags:delete'])
  })

  it('keeps fragment renames immediate', () => {
    useFragmentsStore.getState().update(5, { name: 'room' })
    expect(calls('frags:update')).toEqual([{ id: 5, patch: { name: 'room' } }])
  })

  it('coalesces scene name typing but saves a resolution pick at once', () => {
    const { update } = useScenesStore.getState()
    void update(7, { name: 'ab' })
    void update(7, { name: 'abc' })
    expect(calls('scenes:update')).toHaveLength(0)
    void update(7, { width: 832, height: 1216 })
    expect(calls('scenes:update')).toEqual([
      { id: 7, patch: { name: 'abc', width: 832, height: 1216 } }
    ])
  })

  it('keeps the vibe slider debounce on the shared queue', () => {
    const { update } = useVibesStore.getState()
    update(9, { strength: 0.6 })
    update(9, { strength: 0.7 })
    vi.advanceTimersByTime(SAVE_DELAY_MS)
    expect(calls('vibes:update')).toEqual([{ id: 9, patch: { strength: 0.7 } }])
  })

  it('sends the last edit when the window unloads', () => {
    useScenesStore.getState().update(7, { prompt: 'night' })
    window.dispatchEvent(new Event('beforeunload'))
    expect(calls('scenes:update')).toEqual([{ id: 7, patch: { prompt: 'night' } }])
  })

  it('restarts the delay on every edit', () => {
    queueSave('k', { a: 1 }, (p) => invoke('x', p))
    vi.advanceTimersByTime(SAVE_DELAY_MS - 1)
    queueSave('k', { b: 2 }, (p) => invoke('x', p))
    vi.advanceTimersByTime(SAVE_DELAY_MS - 1)
    expect(calls('x')).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(calls('x')).toEqual([{ a: 1, b: 2 }])
  })
})
