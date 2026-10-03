import { useRef } from 'react'
import type { Fragment } from '@shared/types'
import { useT } from '../lib/i18n'
import { useFragmentsStore } from '../stores/fragments-store'
import { Input } from './ui/input'

/** Keep the IME draft in the input; only persist a completed rename. */
export function FragmentNameInput({
  fragment,
  onDone
}: {
  fragment: Fragment
  onDone: () => void
}): React.JSX.Element {
  const t = useT()
  const finished = useRef(false)
  return (
    <Input
      autoFocus
      aria-label={t('ui.fragmentName')}
      className="h-7 min-w-0 flex-1"
      defaultValue={fragment.name}
      onFocus={(e) => e.currentTarget.select()}
      onPointerDown={(e) => e.stopPropagation()}
      onBlur={(e) => {
        if (finished.current) return
        finished.current = true
        const name = e.currentTarget.value.trim()
        if (name && name !== fragment.name) {
          useFragmentsStore.getState().update(fragment.id, { name })
        }
        onDone()
      }}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.nativeEvent.isComposing || e.keyCode === 229) return
        if (e.key === 'Enter') {
          e.preventDefault()
          e.currentTarget.blur()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          finished.current = true
          onDone()
        }
      }}
    />
  )
}
