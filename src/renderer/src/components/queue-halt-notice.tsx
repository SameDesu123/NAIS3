import { AlertCircle, X } from 'lucide-react'
import { useT } from '../lib/i18n'
import { useGenerationStore } from '../stores/generation-store'

/** Queue stops remain discoverable even when every notification channel is disabled. */
export function QueueHaltNotice(): React.JSX.Element | null {
  const t = useT()
  const reason = useGenerationStore((s) => s.queueHaltReason)
  const dismiss = useGenerationStore((s) => s.dismissQueueHalt)
  if (!reason) return null
  return (
    <div
      role="status"
      className="flex shrink-0 items-start gap-2 border-b border-danger/30 bg-surface px-4 py-2 text-[12px] text-danger-ink"
    >
      <AlertCircle size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
      <p className="min-w-0 flex-1 whitespace-pre-line break-words">
        <strong className="font-medium">{t('ui.nais3GenerationStopped')}</strong> {reason}
      </p>
      <button
        onClick={dismiss}
        aria-label={t('ui.close')}
        className="shrink-0 rounded p-1 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent"
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  )
}
