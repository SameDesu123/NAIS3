import { Hash, LayoutGrid, Puzzle, Users, Zap, type LucideIcon } from 'lucide-react'
import type { MessageId } from '@shared/i18n'
import { useT } from '../../lib/i18n'
import { formatCombo, useShortcutsStore } from '../../stores/shortcuts-store'

const TIPS: { icon: LucideIcon; title: MessageId; body: MessageId }[] = [
  { icon: Hash, title: 'ui.onboardingTipCommentTitle', body: 'ui.onboardingTipComment' },
  { icon: Puzzle, title: 'ui.onboardingTipFragmentTitle', body: 'ui.onboardingTipFragment' },
  { icon: Users, title: 'ui.onboardingTipCharacterTitle', body: 'ui.onboardingTipCharacter' },
  { icon: LayoutGrid, title: 'ui.onboardingTipTabsTitle', body: 'ui.onboardingTipTabs' }
]

export function TipsStep(): React.JSX.Element {
  const t = useT()
  const generateCombo = useShortcutsStore((s) => s.bindings.generate)
  return (
    <>
      {/* 아이콘이 왼쪽에 몰려 있어 글 덩어리가 왼쪽으로 치우쳐 보인다 — 폭은 그대로 두고 살짝 오른쪽으로 */}
      <ul className="grid w-full grid-cols-1 gap-x-10 gap-y-8 break-keep wrap-break-word sm:translate-x-3 sm:grid-cols-2 short:gap-y-6 shorter:gap-y-5">
        {TIPS.map(({ icon: Icon, title, body }) => (
          <li key={title} className="flex gap-5">
            <div className="grid size-12 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent-ink">
              <Icon size={22} />
            </div>
            <div className="min-w-0">
              <p className="text-[18px] font-medium text-ink">{t(title)}</p>
              <p className="mt-1.5 text-[16px] leading-snug text-muted">{t(body)}</p>
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-10 flex items-center gap-2 break-keep rounded-full bg-surface-2/60 px-5 py-2.5 text-[15px] text-muted short:mt-7 shorter:mt-5">
        <Zap size={16} className="text-accent-ink" />
        {t('ui.onboardingTipGenerate', formatCombo(generateCombo))}
      </p>
    </>
  )
}
