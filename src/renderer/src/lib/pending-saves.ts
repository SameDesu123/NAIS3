import type { IpcInvokeMap } from '@shared/types'

/**
 * Coalesces rapid edits (pointer drags, keystrokes) into one IPC write per item.
 * Stores apply the change to their state immediately; only the DB write waits.
 *
 * Main reads these rows back (generation, list reloads, duplicate, export), so any
 * IPC call that could read them goes through invokeAfterSaves(): pending writes are
 * sent first, and IPC ordering keeps the read behind them.
 */
export const SAVE_DELAY_MS = 250

interface PendingSave {
  timer: ReturnType<typeof setTimeout>
  patch: Record<string, unknown>
  send: (patch: Record<string, unknown>) => void
}

const pending = new Map<string, PendingSave>()
let unloadHooked = false

function hookUnload(): void {
  if (unloadHooked || typeof window === 'undefined') return
  unloadHooked = true
  // Closing or reloading the window must not drop the last keystroke
  window.addEventListener('beforeunload', flushPendingSaves)
  window.addEventListener('pagehide', flushPendingSaves)
}

function definedOnly(patch: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))
}

/**
 * Queues `patch` under `key`, merging it with any patch still waiting there.
 * `immediate` sends the merged patch now, for discrete changes such as toggles.
 */
export function queueSave<P extends object>(
  key: string,
  patch: P,
  send: (patch: P) => void,
  { immediate = false }: { immediate?: boolean } = {}
): void {
  const prev = pending.get(key)
  if (prev) clearTimeout(prev.timer)
  const merged = { ...prev?.patch, ...definedOnly(patch) }
  const entry: PendingSave = {
    timer: setTimeout(() => flushSave(key), SAVE_DELAY_MS),
    patch: merged,
    send: send as PendingSave['send']
  }
  pending.set(key, entry)
  hookUnload()
  if (immediate) flushSave(key)
}

export function flushSave(key: string): void {
  const entry = pending.get(key)
  if (!entry) return
  clearTimeout(entry.timer)
  pending.delete(key)
  if (Object.keys(entry.patch).length > 0) entry.send(entry.patch)
}

/** Drops a pending write, e.g. when its item is being deleted. */
export function cancelSave(key: string): void {
  const entry = pending.get(key)
  if (!entry) return
  clearTimeout(entry.timer)
  pending.delete(key)
}

export function flushPendingSaves(): void {
  for (const key of [...pending.keys()]) flushSave(key)
}

/** window.nais.invoke, but only after every pending edit has been sent. */
export function invokeAfterSaves<C extends keyof IpcInvokeMap>(
  channel: C,
  req: IpcInvokeMap[C]['req']
): Promise<IpcInvokeMap[C]['res']> {
  flushPendingSaves()
  return window.nais.invoke(channel, req)
}
