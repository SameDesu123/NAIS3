import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  directory: '',
  backupPath: '',
  handlers: new Map<string, (event: unknown, request: unknown) => unknown>(),
  sent: [] as { channel: string; payload: unknown }[],
  onSend: undefined as ((channel: string, payload: unknown) => void) | undefined
}))

vi.mock('electron', () => {
  const window = {
    webContents: {
      send: (channel: string, payload: unknown) => {
        electron.sent.push({ channel, payload })
        electron.onSend?.(channel, payload)
      }
    }
  }
  return {
    app: {
      getPath: () => electron.directory,
      getLocale: () => 'en-US',
      getVersion: () => '0.0.0-test'
    },
    safeStorage: { isEncryptionAvailable: () => false },
    ipcMain: {
      handle: (channel: string, handler: (event: unknown, request: unknown) => unknown) =>
        electron.handlers.set(channel, handler)
    },
    BrowserWindow: { getFocusedWindow: () => window, getAllWindows: () => [window] },
    dialog: {
      showSaveDialog: async () => ({ canceled: false, filePath: electron.backupPath }),
      showOpenDialog: async () => ({ canceled: false, filePaths: [electron.backupPath] })
    },
    clipboard: {},
    nativeImage: {},
    Notification: { isSupported: () => false },
    shell: {}
  }
})
vi.mock('../src/main/updater', () => ({ startUpdateDownload: vi.fn() }))
vi.mock('../src/main/nai/token-counter', () => ({ countPromptTokens: vi.fn() }))

import { closeDb, initDb } from '../src/main/db'
import { resolveInitialLanguage, t } from '../src/main/i18n'
import { registerIpcHandlers } from '../src/main/ipc'
import type { GenerationQueue } from '../src/main/queue/generation-queue'

async function call(channel: string, request?: unknown): Promise<unknown> {
  const handler = electron.handlers.get(channel)
  if (!handler) throw new Error(`No handler for ${channel}`)
  return handler({}, request)
}

async function characterNames(): Promise<string[]> {
  const { items } = (await call('chars:list')) as { items: { name: string }[] }
  return items.map((item) => item.name)
}

const restoreEvents = (): unknown[] =>
  electron.sent
    .filter((message) => message.channel === 'backup:restoreChanged')
    .map((message) => message.payload)

beforeEach(() => {
  electron.directory = mkdtempSync(join(tmpdir(), 'nais3-restore-race-'))
  electron.backupPath = join(electron.directory, 'workspace.nais')
  electron.handlers.clear()
  electron.sent = []
  electron.onSend = undefined
  const { isNewDatabase } = initDb()
  resolveInitialLanguage(isNewDatabase)
  registerIpcHandlers({ dbVersion: 0, queue: { on: vi.fn() } as unknown as GenerationQueue })
})

afterEach(() => {
  closeDb()
  rmSync(electron.directory, { recursive: true, force: true })
})

describe('backup restore race', () => {
  it('refuses writes made while a .nais archive is unzipped instead of wiping them', async () => {
    await call('chars:create', { name: 'in backup', folderId: null })
    await call('settings:set', { key: 'main_params', value: '{"prompt":"in backup"}' })
    expect(await call('backup:export')).toMatchObject({ saved: true })
    await call('chars:create', { name: 'after backup', folderId: null })

    // Fire renderer writes the moment the restore starts — the archive is still being unzipped
    let duringRestore: Promise<PromiseSettledResult<unknown>[]> | undefined
    electron.onSend = (channel, payload) => {
      if (channel !== 'backup:restoreChanged' || !(payload as { restoring: boolean }).restoring)
        return
      duringRestore = Promise.allSettled([
        call('chars:create', { name: 'during restore', folderId: null }),
        call('settings:set', { key: 'main_params', value: '{"prompt":"during restore"}' }),
        call('chars:list')
      ])
    }

    const result = await call('backup:import')
    expect(result).toEqual({ summary: expect.any(String) })
    const [create, setting, read] = (await duringRestore) ?? []
    expect(create).toMatchObject({
      status: 'rejected',
      reason: { message: t('ui.backupRestoreInProgress') }
    })
    expect(setting.status).toBe('rejected')
    // Reads still pass, so a window reloaded mid-restore can hydrate
    expect(read.status).toBe('fulfilled')

    expect(await characterNames()).toEqual(['in backup'])
    expect(await call('settings:get', { key: 'main_params' })).toEqual({
      value: '{"prompt":"in backup"}'
    })
    expect(restoreEvents()).toEqual([{ restoring: true }, { restoring: false }])
  })

  it('exposes the lock to a window that reloads mid-restore, then releases it', async () => {
    await call('chars:create', { name: 'in backup', folderId: null })
    await call('backup:export')

    const statusDuring: Promise<unknown>[] = []
    electron.onSend = (channel, payload) => {
      if (channel === 'backup:restoreChanged' && (payload as { restoring: boolean }).restoring)
        statusDuring.push(call('backup:restoreStatus'))
    }
    await call('backup:import')

    expect(await Promise.all(statusDuring)).toEqual([{ restoring: true }])
    expect(await call('backup:restoreStatus')).toEqual({ restoring: false })
    // Writes work again once the restore ended
    await call('chars:create', { name: 'after restore', folderId: null })
    expect(await characterNames()).toEqual(['in backup', 'after restore'])
  })

  it('releases the lock when the restore fails', async () => {
    const { writeFileSync } = await import('fs')
    writeFileSync(electron.backupPath, 'not a backup')
    expect(await call('backup:import')).toHaveProperty('error')
    expect(await call('backup:restoreStatus')).toEqual({ restoring: false })
    expect(restoreEvents()).toEqual([{ restoring: true }, { restoring: false }])
    await call('chars:create', { name: 'still writable', folderId: null })
    expect(await characterNames()).toEqual(['still writable'])
  })
})
