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

function clearTimer(id: number): void {
  clearTimeout(timers.get(id))
  timers.delete(id)
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
        clearTimer(toasts[removable].id)
        toasts.splice(removable, 1)
      }
    }
    set({ toasts })
    get().resume(id)
  },
  dismiss: (id) => {
    clearTimer(id)
    paused.delete(id)
    set({ toasts: get().toasts.filter((t) => t.id !== id) })
  },
  pause: (id) => {
    clearTimer(id)
    paused.add(id)
  },
  resume: (id) => {
    clearTimer(id)
    paused.delete(id)
    const toast = get().toasts.find((toast) => toast.id === id)
    if (!toast) return
    timers.set(
      id,
      setTimeout(() => get().dismiss(id), toast.type === 'error' ? 5000 : 3000)
    )
  }
}))
