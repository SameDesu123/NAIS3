import { LoaderCircle } from 'lucide-react'
import { useEffect } from 'react'
import { useBackupRestoreStore } from '../lib/backup-import'
import { useT } from '../lib/i18n'

/** Blocks the whole window while a backup restore replaces the workspace */
export function RestoreOverlay(): React.JSX.Element | null {
  const t = useT()
  const restoring = useBackupRestoreStore((s) => s.restoring)

  // The overlay stops the pointer; keystrokes would still reach a focused editor or a shortcut
  useEffect(() => {
    if (!restoring) return
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    const swallow = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', swallow, true)
    return () => window.removeEventListener('keydown', swallow, true)
  }, [restoring])

  if (!restoring) return null
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-busy="true"
      aria-label={t('ui.restoringBackup')}
      className="fixed inset-0 z-[150] flex flex-col items-center justify-center gap-2 bg-black/60 backdrop-blur-sm"
    >
      <LoaderCircle size={28} className="animate-spin text-accent" />
      <p className="mt-1 text-[14px] text-ink">{t('ui.restoringBackup')}</p>
      <p className="max-w-[360px] text-center text-[12px] text-faint">
        {t('ui.restoringBackupHint')}
      </p>
    </div>
  )
}
