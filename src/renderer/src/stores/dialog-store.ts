import { create } from 'zustand'
import { t } from '../lib/i18n'

/**
 * 텍스트 입력 다이얼로그 (Electron은 window.prompt를 지원하지 않음).
 * askText(...)가 Promise를 반환하고, <TextPromptHost/>가 실제 UI를 렌더한다.
 */
interface TextPromptReq {
  title: string
  value: string
  placeholder?: string
  resolve: (value: string | null) => void
}

interface ConfirmReq {
  title: string
  message?: string
  confirmLabel: string
  danger: boolean
  /** 있으면 버튼 위에 체크박스 — 결과의 checked로 돌려준다 */
  checkboxLabel?: string
  resolve: (result: ConfirmResult) => void
}

interface ConfirmOptions {
  message?: string
  confirmLabel?: string
  danger?: boolean
  checkboxLabel?: string
}

export interface ConfirmResult {
  ok: boolean
  checked: boolean
}

interface DialogState {
  textPrompt: TextPromptReq | null
  confirm: ConfirmReq | null
  askText: (title: string, defaultValue?: string, placeholder?: string) => Promise<string | null>
  askConfirm: (title: string, opts?: ConfirmOptions) => Promise<ConfirmResult>
  _resolve: (value: string | null) => void
  _resolveConfirm: (ok: boolean, checked?: boolean) => void
}

export const useDialogStore = create<DialogState>((set, get) => ({
  textPrompt: null,
  confirm: null,
  askText: (title, defaultValue = '', placeholder) =>
    new Promise((resolve) => {
      set({ textPrompt: { title, value: defaultValue, placeholder, resolve } })
    }),
  askConfirm: (title, opts) =>
    new Promise((resolve) => {
      set({
        confirm: {
          title,
          message: opts?.message,
          confirmLabel: opts?.confirmLabel ?? t('ui.ok'),
          danger: opts?.danger ?? false,
          checkboxLabel: opts?.checkboxLabel,
          resolve
        }
      })
    }),
  _resolve: (value) => {
    get().textPrompt?.resolve(value)
    set({ textPrompt: null })
  },
  _resolveConfirm: (ok, checked = false) => {
    get().confirm?.resolve({ ok, checked: ok && checked })
    set({ confirm: null })
  }
}))

/** 어디서든 호출 가능한 텍스트 프롬프트 헬퍼 */
export function askText(
  title: string,
  defaultValue?: string,
  placeholder?: string
): Promise<string | null> {
  return useDialogStore.getState().askText(title, defaultValue, placeholder)
}

/** 어디서든 호출 가능한 확인(예/아니오) 헬퍼 — 네이티브 confirm 대체 */
export async function askConfirm(
  title: string,
  opts?: Omit<ConfirmOptions, 'checkboxLabel'>
): Promise<boolean> {
  return (await useDialogStore.getState().askConfirm(title, opts)).ok
}

/** 체크박스가 달린 확인 — 체크 여부도 돌려준다 (확인했을 때만 checked) */
export function askConfirmWithCheckbox(
  title: string,
  opts: ConfirmOptions & { checkboxLabel: string }
): Promise<ConfirmResult> {
  return useDialogStore.getState().askConfirm(title, opts)
}
