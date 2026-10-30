import { useCallback, useEffect, useState } from 'react'

/** settings 테이블 값 하나 — 처음에 읽어 오고, 바꾸면 화면과 저장소를 함께 갱신 (설정·온보딩 공용) */
export function useSetting(key: string, fallback: string): [string, (value: string) => void] {
  const [value, setValue] = useState(fallback)
  useEffect(() => {
    void window.nais.invoke('settings:get', { key }).then((r) => setValue(r.value || fallback))
  }, [key, fallback])
  const update = useCallback(
    (next: string) => {
      setValue(next)
      void window.nais.invoke('settings:set', { key, value: next })
    },
    [key]
  )
  return [value, update]
}

/** 켜기/끄기 설정 ('1' / '0'). 값이 없으면 fallback */
export function useBoolSetting(key: string, fallback: boolean): [boolean, (on: boolean) => void] {
  const [value, update] = useSetting(key, fallback ? '1' : '0')
  return [value !== '0', useCallback((on: boolean) => update(on ? '1' : '0'), [update])]
}

/** 저장 폴더 경로와 기본값 여부. 폴더를 바꾸거나 되돌린 뒤 refresh로 다시 읽는다 */
export function useSaveDir(target: 'main' | 'scene'): {
  dir: string
  isDefault: boolean
  refresh: () => void
} {
  const [dir, setDir] = useState('')
  const [isDefault, setIsDefault] = useState(true)
  const refresh = useCallback(() => {
    void window.nais.invoke('settings:getSaveDir', { target }).then((r) => {
      setDir(r.dir)
      setIsDefault(r.isDefault)
    })
  }, [target])
  useEffect(refresh, [refresh])
  return { dir, isDefault, refresh }
}
