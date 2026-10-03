import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import type { ComponentProps } from 'react'
import { cn } from '../../lib/utils'
import { hasActiveSelectPopup } from './select'

export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogClose = DialogPrimitive.Close

function hasOpenNestedPopup(): boolean {
  return Boolean(
    hasActiveSelectPopup() ||
    document.querySelector('[data-radix-popper-content-wrapper]') ||
    document.querySelector('[data-radix-select-content]') ||
    document.querySelector('[role="listbox"][data-state="open"]')
  )
}

function isNestedPopupInteraction(target: HTMLElement | null): boolean {
  return Boolean(
    hasOpenNestedPopup() ||
    target?.closest('[data-radix-popper-content-wrapper]') ||
    target?.closest('[data-radix-select-content]') ||
    target?.closest('[role="listbox"][data-state="open"]')
  )
}

export function DialogContent({
  className,
  children,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
      <DialogPrimitive.Content
        className={cn(
          'fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-[460px] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl border border-line bg-surface text-ink shadow-2xl outline-none',
          className
        )}
        {...props}
        // Let nested popups such as Select close themselves before the dialog
        // sees the same outside interaction as a dismiss request.
        onPointerDownOutside={(e) => {
          const target = e.target as HTMLElement | null
          if (isNestedPopupInteraction(target)) {
            e.preventDefault()
            return
          }
          props.onPointerDownOutside?.(e)
        }}
        onFocusOutside={(e) => {
          const target = e.target as HTMLElement | null
          if (isNestedPopupInteraction(target)) {
            e.preventDefault()
            return
          }
          props.onFocusOutside?.(e)
        }}
        onInteractOutside={(e) => {
          const target = e.target as HTMLElement | null
          if (isNestedPopupInteraction(target)) {
            e.preventDefault()
            return
          }
          props.onInteractOutside?.(e)
        }}
      >
        {children}
        <DialogPrimitive.Close
          aria-label="Close"
          className="absolute right-2.5 top-2.5 z-10 grid size-7 place-items-center rounded-md bg-surface/90 text-muted transition-colors hover:bg-surface-2 hover:text-ink"
        >
          <X size={16} />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}

export function DialogTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn('text-[15px] font-semibold text-ink', className)}
      {...props}
    />
  )
}

export function DialogDescription({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description className={cn('text-[12px] text-muted', className)} {...props} />
  )
}
