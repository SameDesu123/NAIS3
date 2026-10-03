import {
  ChartColumn,
  Globe,
  Image,
  LayoutGrid,
  Library,
  Wand2,
  type LucideIcon
} from 'lucide-react'
import { motion } from 'motion/react'
import type { MessageId } from '@shared/i18n'
import { cn } from '../lib/utils'
import { useT } from '../lib/i18n'
import { useLayoutStore, type CenterMode } from '../stores/layout-store'

const PAGES: { id: CenterMode; label: MessageId; icon: LucideIcon }[] = [
  { id: 'main', label: 'ui.main', icon: Image },
  { id: 'scene', label: 'ui.scene', icon: LayoutGrid },
  { id: 'director', label: 'ui.director', icon: Wand2 },
  { id: 'library', label: 'ui.library', icon: Library },
  { id: 'websearch', label: 'ui.web', icon: Globe },
  { id: 'stats', label: 'ui.stats', icon: ChartColumn }
]

/**
 * 상단 중앙 페이지 네비게이션 (NAIS2 AnimatedNavBar 이식).
 * 활성 탭에 layoutId 슬라이딩 pill이 부드럽게 이동한다.
 */
export function PageNav(): React.JSX.Element {
  const t = useT()
  const centerMode = useLayoutStore((s) => s.centerMode)
  const setCenterMode = useLayoutStore((s) => s.setCenterMode)
  const hiddenPages = useLayoutStore((s) => s.hiddenPages)
  const visible = PAGES.filter((p) => p.id === 'main' || !hiddenPages.includes(p.id))

  return (
    <nav
      aria-label={t('ui.pages')}
      className="no-drag pointer-events-auto flex items-center gap-1 rounded-full border border-line/70 bg-surface/95 p-1 shadow-md backdrop-blur"
    >
      {visible.map((page) => {
        const active = centerMode === page.id
        return (
          <button
            key={page.id}
            onClick={() => setCenterMode(page.id)}
            aria-current={active ? 'page' : undefined}
            className={cn(
              // 최소 창 폭(1080)에서도 좌우 칩과 겹치지 않게 좁은 화면에서는 여백을 줄인다
              'relative z-0 rounded-full px-2.5 py-1.5 text-[13px] font-medium transition-colors xl:px-4',
              active ? 'text-ink' : 'text-muted hover:text-ink'
            )}
          >
            {active && (
              <motion.div
                layoutId="pageNavActive"
                className="absolute inset-0 -z-10 rounded-full border border-ink/10 bg-ink/[0.08] shadow-sm backdrop-blur-md"
                transition={{ type: 'spring', bounce: 0.2, duration: 0.6 }}
              />
            )}
            <span className="relative z-10 flex items-center gap-1.5 xl:gap-2">
              <page.icon className="size-4" />
              {t(page.label)}
            </span>
          </button>
        )
      })}
    </nav>
  )
}
