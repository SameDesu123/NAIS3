import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useToastStore, type ToastType } from '../stores/toast-store'
import { useT } from '../lib/i18n'
import { cn } from '../lib/utils'

const ICON: Record<ToastType, typeof Info> = {
  error: AlertCircle,
  info: Info,
  success: CheckCircle2
}
const TONE: Record<ToastType, string> = {
  error: 'border-danger/40 text-danger-ink',
  info: 'border-line text-ink',
  success: 'border-success/40 text-success-ink'
}

/** One accessible notification surface; sound and OS delivery live in the notification manager. */
export function Toaster(): React.JSX.Element {
  const t = useT()
  const toasts = useToastStore((s) => s.toasts)
  const dismiss = useToastStore((s) => s.dismiss)
  const pause = useToastStore((s) => s.pause)
  const resume = useToastStore((s) => s.resume)
  const reducedMotion = useReducedMotion()
  const region = useRef<HTMLDivElement>(null)
  const priorFocus = useRef<HTMLElement | null>(null)
  const [modalOpen, setModalOpen] = useState(false)

  useEffect(() => {
    const checkModal = (): void => {
      setModalOpen(Boolean(document.querySelector('[role="dialog"][data-state="open"]')))
    }
    checkModal()
    // Radix portals mount directly under body. Watching just those children avoids
    // scanning the document on every prompt edit or generation preview update.
    const observer = new MutationObserver(checkModal)
    observer.observe(document.body, { childList: true })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const element = region.current
    // Progressive enhancement: older browser runtimes retain the existing fixed-position surface.
    if (element && typeof element.togglePopover === 'function') element.togglePopover(!modalOpen)
    for (const toast of toasts) {
      const item = element?.querySelector(`[data-toast-id="${toast.id}"]`)
      if (modalOpen || item?.contains(document.activeElement) || item?.matches(':hover'))
        pause(toast.id)
      else resume(toast.id)
    }
  }, [modalOpen, toasts, pause, resume])

  useEffect(() => {
    if (toasts.length && !region.current?.contains(document.activeElement)) {
      priorFocus.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null
    }
  }, [toasts])

  const close = (id: number): void => {
    const element = region.current
    const focused = element
      ?.querySelector(`[data-toast-id="${id}"]`)
      ?.contains(document.activeElement)
    if (focused) {
      const nextToast = toasts.find((toast) => toast.id !== id)
      const next =
        nextToast &&
        element?.querySelector<HTMLButtonElement>(`[data-toast-id="${nextToast.id}"] button`)
      if (next) next.focus()
      else priorFocus.current?.focus()
    }
    dismiss(id)
  }

  return (
    <div
      ref={region}
      popover="manual"
      role="region"
      aria-label={t('ui.notifications')}
      aria-hidden={modalOpen || undefined}
      style={{ visibility: modalOpen ? 'hidden' : undefined }}
      className="pointer-events-none fixed inset-x-0 top-auto bottom-5 z-[200] m-0 flex w-full max-w-none flex-col items-center gap-2 overflow-visible border-0 bg-transparent px-3 text-inherit"
    >
      {/* Mounted before messages arrive, including runtimes without ariaNotify support. */}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {toasts
          .filter((toast) => toast.type !== 'error')
          .map((toast) => toast.message)
          .join('\n')}
      </div>
      <div className="sr-only" role="alert" aria-live="assertive" aria-atomic="true">
        {toasts
          .filter((toast) => toast.type === 'error')
          .map((toast) => toast.message)
          .join('\n')}
      </div>
      <AnimatePresence initial={true}>
        {toasts.map((toast) => {
          const Icon = ICON[toast.type]
          return (
            <motion.div
              key={toast.id}
              data-toast-id={toast.id}
              layout={!reducedMotion}
              initial={reducedMotion ? false : { opacity: 0, y: 16, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.96 }}
              transition={{ duration: reducedMotion ? 0 : 0.2, ease: [0.22, 1, 0.36, 1] }}
              onMouseEnter={() => pause(toast.id)}
              onMouseLeave={(event) => {
                if (!event.currentTarget.contains(document.activeElement)) resume(toast.id)
              }}
              onFocus={(event) => {
                if (
                  event.relatedTarget instanceof HTMLElement &&
                  !region.current?.contains(event.relatedTarget)
                ) {
                  priorFocus.current = event.relatedTarget
                }
                pause(toast.id)
              }}
              onBlur={(event) => {
                if (
                  !event.currentTarget.contains(event.relatedTarget) &&
                  !event.currentTarget.matches(':hover')
                )
                  resume(toast.id)
              }}
              className={cn(
                'pointer-events-auto flex w-full max-w-[420px] items-center gap-2.5 rounded-lg border bg-surface/95 py-2 pl-3 pr-2 text-[12.5px] shadow-xl backdrop-blur',
                TONE[toast.type]
              )}
            >
              <Icon size={15} className="shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1 whitespace-pre-line break-words text-ink">
                {toast.message}
              </span>
              <button
                aria-label={t('ui.close')}
                className="shrink-0 rounded p-1 text-faint transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
                onClick={() => close(toast.id)}
              >
                <X size={13} aria-hidden="true" />
              </button>
            </motion.div>
          )
        })}
      </AnimatePresence>
    </div>
  )
}
