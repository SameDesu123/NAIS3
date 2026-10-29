import type { MessageId } from '@shared/i18n'
import { useT } from '../../lib/i18n'
import { cn } from '../../lib/utils'
import { useGenerationStore } from '../../stores/generation-store'
import { ChoiceGroup, ChoiceLabel } from './parts'
import { choiceFrame } from './styles'

// 한 칸(false) · 나눈 칸(true)
const PROMPT_LAYOUTS = [false, true] as const
const PROMPT_LAYOUT_TEXT: Record<'single' | 'split', { label: MessageId; hint: MessageId }> = {
  single: { label: 'ui.onboardingPromptSingle', hint: 'ui.onboardingPromptSingleHint' },
  split: { label: 'ui.onboardingPromptSplit', hint: 'ui.onboardingPromptSplitHint' }
}

const PROMPT_PARTS = ['ui.fixed', 'ui.variable', 'ui.detail'] as const

/** 글줄 흉내 — 미리보기 칸 안에 들어가는 회색 막대들 */
function TextBars({ widths }: { widths: string[] }): React.JSX.Element {
  return (
    <>
      {widths.map((width, i) => (
        <div key={i} className={cn('h-1.5 shrink-0 rounded-full bg-line', width)} />
      ))}
    </>
  )
}

/** 프롬프트 입력란 미리보기 — 한 칸 또는 고정·가변·디테일 세 칸 */
function PromptPreview({ split }: { split: boolean }): React.JSX.Element {
  const t = useT()
  if (!split) {
    return (
      <div className="flex h-full flex-col gap-2 rounded-lg border border-line bg-surface p-3">
        <TextBars widths={['w-11/12', 'w-4/5', 'w-full', 'w-2/3', 'w-5/6', 'w-1/2']} />
      </div>
    )
  }
  return (
    <div className="flex h-full flex-col gap-1.5">
      {PROMPT_PARTS.map((id, i) => (
        <div
          key={id}
          className="flex flex-1 flex-col gap-1.5 rounded-lg border border-line bg-surface px-3 py-2"
        >
          <span className="text-[10.5px] font-medium leading-none text-faint">{t(id)}</span>
          <TextBars widths={i === 1 ? ['w-1/2'] : ['w-4/5']} />
        </div>
      ))}
    </div>
  )
}

export function PromptStep(): React.JSX.Element {
  const t = useT()
  const split = useGenerationStore((s) => s.promptSplitEnabled)
  const setSplit = useGenerationStore((s) => s.setPromptSplitEnabled)
  return (
    <ChoiceGroup
      className="grid w-full max-w-[600px] grid-cols-2 gap-6"
      label={t('ui.onboardingPromptTitle')}
      values={PROMPT_LAYOUTS}
      value={split}
      onSelect={setSplit}
    >
      {(value, selected) => {
        const { label, hint } = PROMPT_LAYOUT_TEXT[value ? 'split' : 'single']
        return (
          <>
            <div className={choiceFrame(selected)}>
              <div
                className="h-[168px] overflow-hidden rounded-xl bg-paper p-3 text-left"
                aria-hidden
              >
                <PromptPreview split={value} />
              </div>
            </div>
            <ChoiceLabel selected={selected}>{t(label)}</ChoiceLabel>
            <span className="-mt-1 text-center text-[13px] leading-snug text-muted">{t(hint)}</span>
          </>
        )
      }}
    </ChoiceGroup>
  )
}
