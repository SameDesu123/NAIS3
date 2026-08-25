import { create } from 'zustand'
import { EN } from '@shared/i18n/dict-en'
import { isLang, translate, type Lang } from '@shared/i18n'

interface LanguageState {
  lang: Lang
  setLang: (lang: Lang) => void
  /** SQLite settings에서 초기값 로드. 미설정이면 OS 로케일로 결정 */
  hydrate: () => Promise<void>
}

export const useLanguageStore = create<LanguageState>((set) => ({
  lang: 'ko',
  setLang: (lang) => {
    set({ lang })
    void window.nais.invoke('settings:set', { key: 'ui_language', value: lang })
  },
  hydrate: async () => {
    const { value } = await window.nais.invoke('settings:get', { key: 'ui_language' })
    if (isLang(value)) {
      set({ lang: value })
    } else {
      set({ lang: navigator.language.toLowerCase().startsWith('ko') ? 'ko' : 'en' })
    }
  }
}))

/**
 * 현재 언어로 번역. 키는 한국어 원문, {0} {1} 자리에 args 치환.
 * 컴포넌트 렌더 경로에서는 언어 변경 시 리렌더가 필요하므로 useT()를 쓴다.
 */
export function t(key: string, ...args: (string | number)[]): string {
  return translate(EN, useLanguageStore.getState().lang, key, args)
}

/** 언어 store를 구독해 언어 변경 시 리렌더되는 t */
export function useT(): typeof t {
  useLanguageStore((s) => s.lang)
  return t
}
