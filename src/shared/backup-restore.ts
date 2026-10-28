import type { IpcInvokeMap } from './types'

/**
 * Channels a running restore lets through: reads, window/UI calls, queue cancel, and
 * backup:import itself (restore() refuses an overlapping restore). Everything else may write
 * workspace data the restore is about to replace, so it is refused until the restore ends.
 * A new channel is refused during a restore until it is listed here.
 */
const RESTORE_PASSTHROUGH: ReadonlySet<string> = new Set<keyof IpcInvokeMap>([
  'db:status',
  'app:version',
  'backup:import',
  'backup:restoreStatus',
  'nai:verifyToken',
  'nai:tokenStatus',
  'nai:revealToken',
  'nai:listAccounts',
  'nai:revealAccountToken',
  'nai:balance',
  'nai:anlasUsage',
  'queue:cancel',
  'queue:status',
  'settings:get',
  'settings:getSaveDir',
  'window:control',
  'window:setBackground',
  'notify:done',
  'tags:search',
  'tokens:count',
  'images:list',
  'images:payload',
  'images:readForSource',
  'images:readMetadata',
  'images:analyzeArtists',
  'images:showInFolder',
  'images:copy',
  'chars:list',
  'frags:list',
  'vibes:list',
  'crefs:list',
  'promptPresets:list',
  'scenePresets:list',
  'scenes:list',
  'scenes:get',
  'scenes:images',
  'scenes:reservedTotal',
  'scenes:openFolder',
  'library:list'
])

/**
 * Serializes a backup restore against IPC writes. A restore waits for writes already running,
 * then replaces the workspace while new writes are refused. Every write therefore lands either
 * before the restore (and is replaced, as the user asked) or is rejected, never applied and then
 * silently wiped by the restore transaction.
 */
export class RestoreLock {
  private restoring = false
  private writes = 0
  private idle: (() => void)[] = []

  constructor(
    private readonly options: {
      /** Called when a restore starts and ends — the runtime tells every window */
      notify: (restoring: boolean) => void
      /** Error a refused request rejects with */
      refusal: () => Error
    }
  ) {}

  get active(): boolean {
    return this.restoring
  }

  /** Runs one IPC request. Writes are refused during a restore and tracked otherwise */
  async request<T>(channel: string, run: () => T | Promise<T>): Promise<T> {
    if (RESTORE_PASSTHROUGH.has(channel)) return run()
    if (this.restoring) throw this.options.refusal()
    this.writes++
    try {
      return await run()
    } finally {
      this.writes--
      if (this.writes === 0) this.idle.splice(0).forEach((resolve) => resolve())
    }
  }

  /** Waits for running writes, then runs the restore with every other write refused */
  async restore<T>(run: () => T | Promise<T>): Promise<T> {
    if (this.restoring) throw this.options.refusal()
    this.restoring = true
    this.options.notify(true)
    try {
      if (this.writes > 0) await new Promise<void>((resolve) => this.idle.push(resolve))
      return await run()
    } finally {
      this.restoring = false
      this.options.notify(false)
    }
  }
}
