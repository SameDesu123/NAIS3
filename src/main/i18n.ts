import { app } from 'electron'
import { EN } from '../shared/i18n/dict-en'
import { isLang, translate, type Lang } from '../shared/i18n'
import { getSetting } from './db/settings'

/** DB가 아직 없거나 실패해도 안전하게 현재 언어를 결정 */
function currentLang(): Lang {
  try {
    const value = getSetting('ui_language')
    if (isLang(value)) return value
  } catch {
    // DB 초기화 전 — 로케일 폴백
  }
  try {
    return app.getLocale().toLowerCase().startsWith('ko') ? 'ko' : 'en'
  } catch {
    return 'ko'
  }
}

/** 메인 프로세스용 번역 (다이얼로그 제목, 네이티브 UI, 업데이트 알림 등) */
export function t(key: string, ...args: (string | number)[]): string {
  return translate(EN, currentLang(), key, args)
}
