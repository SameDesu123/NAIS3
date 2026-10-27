import { useEffect, useRef, useState } from 'react'

/** 설정 값 ↔ 문자열 변환. parse가 null을 주면 저장된 값을 무시하고 기본값을 쓴다 */
export interface SettingCodec<T> {
  parse: (raw: string) => T | null
  format: (value: T) => string
}

/** 범위 안 정수 (범위 밖 값은 가장자리로) */
export function intSetting(min: number, max: number): SettingCodec<number> {
  return {
    parse: (raw) => {
      const n = Math.round(Number(raw))
      return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null
    },
    format: String
  }
}

export const boolSetting: SettingCodec<boolean> = {
  parse: (raw) => raw === '1',
  format: (on) => (on ? '1' : '0')
}

/**
 * settings:get/set에 저장되는 값 하나 — 편집 툴의 슬라이더·스위치처럼 재시작 후에도 유지할 값.
 * 저장된 값을 불러오기 전에 사용자가 먼저 바꿨다면 늦게 도착한 값으로 덮지 않는다.
 * codec은 렌더마다 새로 만들지 말고 모듈 상수로 넘긴다.
 */
export function useStoredSetting<T>(
  key: string,
  initial: T,
  codec: SettingCodec<T>
): [T, (value: T) => void] {
  const [value, setValue] = useState(initial)
  const touched = useRef(false)

  useEffect(() => {
    let alive = true
    void window.nais.invoke('settings:get', { key }).then(({ value: raw }) => {
      if (!alive || touched.current || !raw) return
      const parsed = codec.parse(raw)
      if (parsed !== null) setValue(parsed)
    })
    return () => {
      alive = false
    }
  }, [key, codec])

  function update(next: T): void {
    touched.current = true
    setValue(next)
    void window.nais.invoke('settings:set', { key, value: codec.format(next) })
  }

  return [value, update]
}
