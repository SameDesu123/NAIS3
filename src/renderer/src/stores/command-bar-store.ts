import { create } from 'zustand'

/** 커맨드 바(빠른 명령 검색) 열림 상태 — 단축키(기본 Mod+K)와 <CommandBar/>가 함께 쓴다 */
interface CommandBarState {
  open: boolean
  setOpen: (open: boolean) => void
  toggle: () => void
}

export const useCommandBarStore = create<CommandBarState>((set, get) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set({ open: !get().open })
}))
