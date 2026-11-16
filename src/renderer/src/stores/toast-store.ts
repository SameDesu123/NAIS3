import { create } from 'zustand'

export type ToastType = 'error' | 'info' | 'success'

export interface Toast {
  id: number
  message: string
  type: ToastType
}

interface ToastState {
  toasts: Toast[]
  push: (message: string, type?: ToastType) => void
  dismiss: (id: number) => void
  pause: (id: number) => void
  resume: (id: number) => void
}

let seq = 0
const timers = new Map<number, ReturnType<typeof setTimeout>>()
const paused = new Set<number>()
const deadlines = new Map<number, number>()
const remaining = new Map<number, number>()

function clearTimer(id: number): void {
  clearTimeout(timers.get(id))
  timers.delete(id)
}

function forgetTimer(id: number): void {
  clearTimer(id)
  paused.delete(id)
  deadlines.delete(id)
  remaining.delete(id)
}

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: (message, type = 'info') => {
    const existing = get().toasts.find((toast) => toast.message === message && toast.type === type)
    if (existing) {
      if (!paused.has(existing.id)) get().resume(existing.id)
      return
    }
    const id = ++seq
    // Bound simultaneous messages without removing a toast the user is interacting with.
    const toasts = [...get().toasts, { id, message, type }]
    if (toasts.length > 5) {
      const removable = toasts.findIndex((toast) => timers.has(toast.id))
      if (removable >= 0) {
        forgetTimer(toasts[removable].id)
        toasts.splice(removable, 1)
      }
    }
    set({ toasts })
    get().resume(id)
  },
  dismiss: (id) => {
    forgetTimer(id)
    set({ toasts: get().toasts.filter((t) => t.id !== id) })
  },
  pause: (id) => {
    if (!get().toasts.some((toast) => toast.id === id)) return
    if (timers.has(id)) remaining.set(id, Math.max(0, deadlines.get(id)! - Date.now()))
    clearTimer(id)
    paused.add(id)
  },
  resume: (id) => {
    // Rendering a sibling or receiving a duplicate must not restart a running timer.
    if (timers.has(id)) return
    const toast = get().toasts.find((toast) => toast.id === id)
    if (!toast) return
    paused.delete(id)
    const duration = remaining.get(id) ?? (toast.type === 'error' ? 5000 : 3000)
    deadlines.set(id, Date.now() + duration)
    remaining.delete(id)
    timers.set(
      id,
      setTimeout(() => get().dismiss(id), duration)
    )
  }
}))
