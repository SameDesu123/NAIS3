import { Monitor, Moon, Sun } from 'lucide-react'
import { cn } from '../lib/utils'
import { useT } from '../lib/i18n'
import { useThemeStore, type Theme } from '../stores/theme-store'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'

const MODES: { mode: Theme; Icon: typeof Sun; label: string }[] = [
  { mode: 'light', Icon: Sun, label: '라이트' },
  { mode: 'dark', Icon: Moon, label: '다크' },
  { mode: 'system', Icon: Monitor, label: '시스템 설정 따름' }
]

export function ThemeToggle(): React.JSX.Element {
  const t = useT()
  const theme = useThemeStore((s) => s.theme)
  const setTheme = useThemeStore((s) => s.setTheme)

  return (
    <ToggleGroup
      type="single"
      value={theme}
      onValueChange={(v) => {
        if (v) setTheme(v as Theme)
      }}
      className="inline-flex rounded-md bg-surface-2 p-0.5"
      aria-label={t('색상 모드')}
    >
      {MODES.map(({ mode, Icon, label }) => (
        <ToggleGroupItem
          key={mode}
          value={mode}
          title={t(label)}
          className={cn(
            'grid h-6 w-[26px] place-items-center rounded-[5px] text-muted transition-colors hover:text-ink',
            theme === mode && 'bg-paper text-ink shadow-[0_1px_2px_rgba(0,0,0,0.12)]'
          )}
        >
          <Icon size={14} />
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
