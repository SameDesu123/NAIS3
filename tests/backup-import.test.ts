// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NaisApi } from '../src/preload/index'
import type { IpcEventMap } from '../src/shared/types'
import {
  bindBackupRestore,
  importBackup,
  useBackupRestoreStore
} from '../src/renderer/src/lib/backup-import'
import { useCharactersStore } from '../src/renderer/src/stores/characters-store'
import { useGenerationStore } from '../src/renderer/src/stores/generation-store'
import { useToastStore } from '../src/renderer/src/stores/toast-store'

type Handler = (request: unknown) => unknown
let handlers: Record<string, Handler>
let listeners: Map<string, Set<(payload: unknown) => void>>
const invoke = vi.fn()

function emit<C extends keyof IpcEventMap>(channel: C, payload: IpcEventMap[C]): void {
  listeners.get(channel)?.forEach((listener) => listener(payload))
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const restoredCharacter = { id: 7, name: 'restored', prompt: '', negativePrompt: '' }

beforeEach(() => {
  listeners = new Map()
  handlers = {
    'backup:restoreStatus': () => ({ restoring: false }),
    'chars:list': () => ({ folders: [], items: [restoredCharacter] }),
    'settings:get': (request) =>
      (request as { key: string }).key === 'main_params'
        ? { value: '{"prompt":"restored prompt"}' }
        : { value: null },
    'queue:status': () => ({ items: [], running: false, delayMs: 600 })
  }
  invoke.mockReset()
  invoke.mockImplementation(async (channel: string, request: unknown) => {
    const handler = handlers[channel]
    if (handler) return handler(request)
    return { items: [], folders: [], stacks: [], total: 0 }
  })
  window.nais = {
    invoke,
    on: (channel: string, listener: (payload: unknown) => void) => {
      const set = listeners.get(channel) ?? new Set()
      listeners.set(channel, set)
      set.add(listener)
      return () => set.delete(listener)
    }
  } as unknown as NaisApi
  useBackupRestoreStore.setState({ restoring: false })
  useCharactersStore.setState({ items: [] })
  useGenerationStore.setState({
    request: { ...useGenerationStore.getState().request, prompt: 'stale prompt' }
  })
  useToastStore.setState({ toasts: [] })
})

describe('backup restore in the renderer', () => {
  it('recovers the lock after a reload mid-restore and reloads the stores when it ends', async () => {
    handlers['backup:restoreStatus'] = () => ({ restoring: true })
    const charsList = deferred()
    handlers['chars:list'] = async () => {
      await charsList.promise
      return { folders: [], items: [restoredCharacter] }
    }
    const unbind = bindBackupRestore()
    await flush()
    expect(useBackupRestoreStore.getState().restoring).toBe(true)

    emit('backup:restoreChanged', { restoring: false })
    await flush()
    // Still blocked until the stores hold the restored rows
    expect(useBackupRestoreStore.getState().restoring).toBe(true)
    charsList.resolve()
    await flush()
    expect(useBackupRestoreStore.getState().restoring).toBe(false)
    expect(useCharactersStore.getState().items.map((item) => item.name)).toEqual(['restored'])
    expect(useGenerationStore.getState().request.prompt).toBe('restored prompt')
    unbind()
  })

  it('blocks from the restore-start event even when another window started the restore', async () => {
    const unbind = bindBackupRestore()
    emit('backup:restoreChanged', { restoring: true })
    expect(useBackupRestoreStore.getState().restoring).toBe(true)
    emit('backup:restoreChanged', { restoring: false })
    await flush()
    expect(useBackupRestoreStore.getState().restoring).toBe(false)
    expect(useCharactersStore.getState().items.map((item) => item.name)).toEqual(['restored'])
    unbind()
  })

  it('reports success only after the stores were refreshed', async () => {
    const unbind = bindBackupRestore()
    handlers['backup:import'] = async () => {
      // The runtime announces the restore, replaces the data, then announces the end
      emit('backup:restoreChanged', { restoring: true })
      emit('backup:restoreChanged', { restoring: false })
      return { summary: 'restored 1 item' }
    }

    await expect(importBackup()).resolves.toBe(true)
    expect(useCharactersStore.getState().items.map((item) => item.name)).toEqual(['restored'])
    expect(useGenerationStore.getState().request.prompt).toBe('restored prompt')
    expect(useBackupRestoreStore.getState().restoring).toBe(false)
    expect(useToastStore.getState().toasts.map((toast) => toast.message)).toEqual([
      'restored 1 item'
    ])
    unbind()
  })

  it('does nothing when the file picker is canceled, and reports errors', async () => {
    handlers['backup:import'] = () => ({ canceled: true })
    await expect(importBackup()).resolves.toBe(false)
    expect(invoke).not.toHaveBeenCalledWith('chars:list', undefined)

    handlers['backup:import'] = () => ({ error: 'corrupt archive' })
    await expect(importBackup()).resolves.toBe(false)
    expect(useToastStore.getState().toasts[0]?.type).toBe('error')
  })
})
