import { CheckCircle2 } from 'lucide-react'
import { LANGUAGES, SUPPORTED_LANGUAGES } from '@shared/i18n'
import { useLanguageStore, useT } from '../../lib/i18n'
import { ChoiceGroup, ChoiceLabel } from './parts'
import { choiceFrame } from './styles'

export function LanguageStep(): React.JSX.Element {
  const t = useT()
  const lang = useLanguageStore((s) => s.lang)
  const setLang = useLanguageStore((s) => s.setLang)
  return (
    <ChoiceGroup
      className="flex w-full max-w-[480px] flex-col gap-2"
      label={t('ui.language')}
      values={SUPPORTED_LANGUAGES}
      value={lang}
      onSelect={setLang}
    >
      {(code, selected) => (
        <div className={choiceFrame(selected)}>
          <div className="flex h-14 items-center justify-between rounded-xl bg-surface-2/60 px-5 shorter:h-12">
            <ChoiceLabel selected={selected} className="text-[16px]">
              <span lang={code}>{LANGUAGES[code].label}</span>
            </ChoiceLabel>
            {selected && <CheckCircle2 size={20} className="text-accent" aria-hidden />}
          </div>
        </div>
      )}
    </ChoiceGroup>
  )
}
