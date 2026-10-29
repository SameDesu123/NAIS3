import type { MessageId } from '@shared/i18n'
import { mixHex } from '../../lib/color'
import { useT } from '../../lib/i18n'
import {
  getThemePreset,
  THEME_PRESETS,
  type Palette,
  type ThemeMode
} from '../../lib/theme-presets'
import { cn } from '../../lib/utils'
import { useThemeStore, type Theme } from '../../stores/theme-store'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { ChoiceGroup, ChoiceLabel, SectionLabel } from './parts'
import { choiceFrame, DROP_DOWN, PANEL } from './styles'

const LOOKS = ['light', 'dark', 'system'] as const satisfies readonly Theme[]
const LOOK_LABELS: Record<Theme, MessageId> = {
  light: 'ui.light',
  dark: 'ui.dark',
  system: 'ui.followSystemSetting'
}

function paletteFor(presetId: string, mode: ThemeMode): Palette | undefined {
  const preset = getThemePreset(presetId)
  return preset[mode] ?? preset.dark ?? preset.light
}

/** system 모드면 지금 OS가 고른 쪽 */
function resolvedMode(theme: Theme): ThemeMode {
  if (theme !== 'system') return theme
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/**
 * 모드 미리보기를 하나의 그림으로. system은 같은 그림의 왼쪽 절반을 라이트,
 * 오른쪽 절반을 다크 색으로 칠한다 (다크 그림을 겹쳐 오른쪽 절반만 보이게 자름).
 */
function ModeSplit({
  mode,
  children
}: {
  mode: Theme
  children: (mode: ThemeMode) => React.ReactNode
}): React.JSX.Element {
  if (mode !== 'system') return <>{children(mode)}</>
  return (
    <div className="relative h-full">
      {children('light')}
      <div className="absolute inset-0" style={{ clipPath: 'inset(0 0 0 50%)' }}>
        {children('dark')}
      </div>
    </div>
  )
}

/** 앱 창 미니어처 — 현재 테마와 무관하게 선택한 팔레트 색으로 그린다 */
function LookPane({ presetId, mode }: { presetId: string; mode: ThemeMode }): React.JSX.Element {
  const palette = paletteFor(presetId, mode)
  if (!palette) return <div className="h-full" />
  const panel = mixHex(palette.neutral, palette.ink, 0.07)
  const bar = mixHex(palette.neutral, palette.ink, 0.22)
  return (
    <div className="flex h-full gap-2 p-2.5" style={{ background: palette.neutral }}>
      <div className="flex w-1/3 flex-col gap-1.5 rounded-md p-2" style={{ background: panel }}>
        <div className="h-1.5 w-3/4 rounded-full" style={{ background: bar }} />
        <div className="h-1.5 w-1/2 rounded-full" style={{ background: bar }} />
        <div className="mt-auto h-3 rounded-sm" style={{ background: palette.primary }} />
      </div>
      <div className="flex flex-1 flex-col gap-2">
        <div className="h-2 w-2/3 rounded-full" style={{ background: bar }} />
        <div className="flex-1 rounded-md" style={{ background: panel }} />
      </div>
    </div>
  )
}

/** 팔레트 키 컬러 — 살짝 겹친 원. 테두리는 놓인 바탕색(--dot-ring)으로 끊어 보이게 */
function PaletteDots({ presetId, mode }: { presetId: string; mode: ThemeMode }): React.JSX.Element {
  const palette = paletteFor(presetId, mode)
  // 프리셋에 따라 강조색과 오류색이 같은 경우가 있어 중복은 한 번만
  const colors = palette
    ? [
        ...new Set([
          palette.primary,
          palette.accent,
          palette.success,
          palette.warning,
          palette.error
        ])
      ]
    : []
  return (
    <span className="flex items-center -space-x-1" aria-hidden>
      {colors.map((color) => (
        <span
          key={color}
          className="size-4 rounded-full ring-2 ring-(--dot-ring)"
          style={{ background: color }}
        />
      ))}
    </span>
  )
}

export function AppearanceStep(): React.JSX.Element {
  const t = useT()
  const theme = useThemeStore((s) => s.theme)
  const setTheme = useThemeStore((s) => s.setTheme)
  const presetId = useThemeStore((s) => s.presetId)
  const setPreset = useThemeStore((s) => s.setPreset)
  const mode = resolvedMode(theme)
  return (
    <>
      <SectionLabel>{t('ui.colorMode')}</SectionLabel>
      <ChoiceGroup
        className="grid w-full grid-cols-3 gap-5"
        label={t('ui.colorMode')}
        values={LOOKS}
        value={theme}
        onSelect={setTheme}
      >
        {(look, selected) => (
          <>
            <div className={choiceFrame(selected)}>
              <div className="h-[108px] overflow-hidden rounded-xl shorter:h-[84px]">
                <ModeSplit mode={look}>
                  {(m) => <LookPane presetId={presetId} mode={m} />}
                </ModeSplit>
              </div>
            </div>
            <ChoiceLabel selected={selected}>{t(LOOK_LABELS[look])}</ChoiceLabel>
          </>
        )}
      </ChoiceGroup>
      <div
        className={cn(
          PANEL,
          'mt-8 flex w-full items-center justify-between gap-4 px-5 py-4 shorter:mt-5 shorter:py-3'
        )}
      >
        <span className="text-[15px] text-ink">{t('ui.themePreset')}</span>
        <Select value={presetId} onValueChange={setPreset}>
          <SelectTrigger
            className="h-10 w-64 text-[14px] [--dot-ring:var(--paper)]"
            aria-label={t('ui.themePreset')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent {...DROP_DOWN}>
            {THEME_PRESETS.map((preset) => (
              <SelectItem
                key={preset.id}
                value={preset.id}
                className="py-2 text-[14px] [--dot-ring:var(--surface)] data-[highlighted]:[--dot-ring:var(--surface-2)]"
              >
                <span className="flex items-center gap-3">
                  {preset.name}
                  <PaletteDots presetId={preset.id} mode={mode} />
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </>
  )
}
