import { app, dialog } from 'electron'
import type { BrowserWindow, MessageBoxOptions, MessageBoxReturnValue } from 'electron'
import { t } from '../i18n'
import type { QueueItem } from '../../shared/types'
import type { GenerationQueue } from './generation-queue'

/** How long "cancel all and quit" waits for the request in flight to abort */
const CANCEL_ALL_TIMEOUT_MS = 3000

type QuitQueue = Pick<GenerationQueue, 'unfinishedCount' | 'cancelAll'>

function showMessageBox(
  parent: BrowserWindow | undefined,
  options: MessageBoxOptions
): Promise<MessageBoxReturnValue> {
  return parent && !parent.isDestroyed()
    ? dialog.showMessageBox(parent, options)
    : dialog.showMessageBox(options)
}

export interface QuitGuard {
  setQueue(queue: QuitQueue): void
  /** Window `close` or app `before-quit`: stops the quit and asks while generations are unfinished */
  guard(event: { preventDefault: () => void }, parent: BrowserWindow | undefined): void
}

/**
 * Asks before quitting while generations are pending or in flight. Choices:
 * keep generating (default, also Esc), quit and resume next time (the queue journal keeps
 * the items), or cancel everything — the normal cancel path gives scene reservations back.
 */
export function createQuitGuard(): QuitGuard {
  let queue: QuitQueue | undefined
  // Once confirmed, the close/before-quit events app.quit() raises again pass through
  let confirmed = false
  let prompting = false

  async function ask(current: QuitQueue, parent: BrowserWindow | undefined): Promise<void> {
    const { response } = await showMessageBox(parent, {
      type: 'warning',
      title: 'NAIS3',
      message: t('ui.quitWhileGeneratingTitle'),
      detail: t('ui.quitWhileGeneratingDetail', current.unfinishedCount()),
      buttons: [
        t('ui.quitWhileGeneratingKeepGenerating'),
        t('ui.quitWhileGeneratingResumeLater'),
        t('ui.quitWhileGeneratingCancelAll')
      ],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })
    if (response === 0) return
    if (response === 2) await current.cancelAll(CANCEL_ALL_TIMEOUT_MS)
    confirmed = true
    app.quit()
  }

  return {
    setQueue(next) {
      queue = next
    },
    guard(event, parent) {
      const current = queue
      if (confirmed || !current || current.unfinishedCount() === 0) return
      event.preventDefault()
      if (prompting) return
      prompting = true
      void ask(current, parent).finally(() => {
        prompting = false
      })
    }
  }
}

/** Offers the generations a previous run left unfinished (forced quit, crash or "resume next time") */
export async function offerUnfinishedGenerations(
  queue: Pick<GenerationQueue, 'restore'>,
  items: readonly QueueItem[],
  parent: BrowserWindow
): Promise<void> {
  const { response } = await showMessageBox(parent, {
    type: 'question',
    title: 'NAIS3',
    message: t('ui.unfinishedGenerationsTitle'),
    detail: t('ui.unfinishedGenerationsDetail', items.length),
    buttons: [t('ui.unfinishedGenerationsResume'), t('ui.unfinishedGenerationsDiscard')],
    defaultId: 0,
    // Esc takes the choice that spends no Anlas; discarding gives scene reservations back
    cancelId: 1,
    noLink: true
  })
  queue.restore(items, response === 0)
}
