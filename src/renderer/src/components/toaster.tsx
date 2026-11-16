import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useToastStore, type Toast, type ToastType } from '../stores/toast-store'
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
  const [host, setHost] = useState<HTMLElement>(() => document.body)
  const [announcements, setAnnouncements] = useState<Toast[]>([])

  useEffect(() => {
    const findHost = (): void => {
      const dialogs = document.querySelectorAll<HTMLElement>(
        '[data-notification-dialog][data-state="open"]'
      )
      setHost(dialogs[dialogs.length - 1] ?? document.body)
    }
    findHost()
    // Application dialog portals mount directly under body. Popovers never become hosts.
    const observer = new MutationObserver(findHost)
    observer.observe(document.body, { childList: true })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const element = region.current
    if (element && typeof element.togglePopover === 'function') element.togglePopover(true)
  }, [host])

  useEffect(() => {
    for (const toast of toasts) {
      const item = region.current?.querySelector(`[data-toast-id="${toast.id}"]`)
      if (item?.contains(document.activeElement) || item?.matches(':hover')) pause(toast.id)
      else resume(toast.id)
    }
  }, [toasts, host, pause, resume])

  useEffect(() => {
    let active = true
    let pending: Toast[] = []
    let scheduled = false
    const announce = (current: Toast[], previous: Toast[]): void => {
      const previousIds = new Set(previous.map((toast) => toast.id))
      const fresh = current.filter((toast) => !previousIds.has(toast.id))
      if (!fresh.length) return
      const announcer = document as Document & {
        ariaNotify?: (message: string, options: { priority: 'high' | 'normal' }) => void
      }
      if (typeof announcer.ariaNotify === 'function') {
        for (const toast of fresh) {
          announcer.ariaNotify(toast.message, {
            priority: toast.type === 'error' ? 'high' : 'normal'
          })
        }
      } else {
        // Only new arrivals enter the live regions; dismissing a toast is not an announcement.
        // Collect same-turn arrivals so React batching cannot discard all but the last message.
        pending.push(...fresh)
        if (!scheduled) {
          scheduled = true
          queueMicrotask(() => {
            if (!active) return
            setAnnouncements(pending)
            pending = []
            scheduled = false
          })
        }
      }
    }
    announce(useToastStore.getState().toasts, [])
    const unsubscribe = useToastStore.subscribe((state, previous) =>
      announce(state.toasts, previous.toasts)
    )
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

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

  return createPortal(
    <div
      ref={region}
      popover="manual"
      role="region"
      aria-label={t('ui.notifications')}
      className="pointer-events-none fixed inset-x-0 top-auto bottom-5 z-[200] m-0 flex w-full max-w-none flex-col items-center gap-2 overflow-visible border-0 bg-transparent px-3 text-inherit"
    >
      {/* Fallback for runtimes without ariaNotify. Keys also reannounce identical new messages. */}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcements
          .filter((toast) => toast.type !== 'error')
          .map((toast) => (
            <span key={toast.id} className="block">
              {toast.message}
            </span>
          ))}
      </div>
      <div className="sr-only" role="alert" aria-live="assertive" aria-atomic="true">
        {announcements
          .filter((toast) => toast.type === 'error')
          .map((toast) => (
            <span key={toast.id} className="block">
              {toast.message}
            </span>
          ))}
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
    </div>,
    host
  )
}
