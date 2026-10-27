import type { ReactNode } from 'react'
import { create } from 'zustand'

export interface SidePageContext {
  /** 페이지 넘김이 끝났는지 — 원본 해독 같은 무거운 작업은 이때부터 (같이 돌리면 넘김이 끊긴다) */
  ready: boolean
  /** 이 페이지를 덮고 원래 화면으로 돌아간다 */
  close: () => void
}

/**
 * 타이틀 바 아래 화면을 옆으로 넘겨 여는 한 장의 페이지.
 * 화면 전체가 필요한 편집 작업(도트화·모자이크 등)을 오버레이 대신 이걸로 연다.
 */
export interface SidePage {
  /** 페이지 식별자 — close(id)가 이 페이지가 열려 있을 때만 덮는 데 쓴다. 장 자체는 open할 때마다 새로 만든다 */
  id: string
  /** 페이지를 연 화면 — 그 화면이 내려갈 때 closeOwnedBy로 함께 덮는다 */
  owner?: string
  render: (ctx: SidePageContext) => ReactNode
}

interface SidePageState {
  page: SidePage | null
  open: (page: SidePage) => void
  /** id를 주면 그 페이지가 열려 있을 때만 덮는다 (이미 다른 페이지로 바뀌었으면 그대로) */
  close: (id?: string) => void
  closeOwnedBy: (owner: string) => void
}

export const useSidePageStore = create<SidePageState>((set, get) => ({
  page: null,
  open: (page) => set({ page }),
  close: (id) => {
    const { page } = get()
    if (page && (id == null || page.id === id)) set({ page: null })
  },
  closeOwnedBy: (owner) => {
    if (get().page?.owner === owner) set({ page: null })
  }
}))
