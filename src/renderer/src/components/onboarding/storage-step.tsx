import { FolderOpen } from 'lucide-react'
import { useT } from '../../lib/i18n'
import { useBoolSetting, useSaveDir, useSetting } from '../../lib/setting-hooks'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Switch } from '../ui/switch'
import { SectionLabel } from './parts'
import { DROP_DOWN, PANEL } from './styles'

/** 저장 단계의 설정 한 줄 — 이름·설명 왼쪽, 컨트롤 오른쪽 */
function OptionRow({
  label,
  hint,
  children
}: {
  label: string
  hint: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-6 px-5 py-3.5">
      <div className="min-w-0">
        <p className="text-[15px] text-ink">{label}</p>
        <p className="mt-0.5 text-[13px] leading-snug text-muted">{hint}</p>
      </div>
      {children}
    </div>
  )
}

export function StorageStep(): React.JSX.Element {
  const t = useT()
  const { dir, refresh: refreshDir } = useSaveDir('main')
  const [autoSave, setAutoSave] = useBoolSetting('auto_save', true)
  const [dateFolders, setDateFolders] = useBoolSetting('date_folders', true)
  const [format, setFormat] = useSetting('image_format', 'png')

  return (
    <div className="w-full max-w-[600px]">
      <SectionLabel>{t('ui.mainSaveFolder')}</SectionLabel>
      <div className="flex items-center gap-2">
        <div
          className="w-0 min-w-0 flex-1 truncate rounded-xl border border-line bg-surface-2/60 px-4 py-3 font-mono text-[13.5px] text-muted"
          title={dir}
        >
          {dir}
        </div>
        <Button
          size="lg"
          className="h-12 gap-2 px-5 text-[15px]"
          onClick={async () => {
            const r = await window.nais.invoke('settings:pickSaveDir', { target: 'main' })
            if (r.dir) refreshDir()
          }}
        >
          <FolderOpen size={17} /> {t('ui.change')}
        </Button>
      </div>
      <p className="mt-2 text-[13px] text-muted">
        {t('ui.regularGenerationsAreSavedDirectlyIntoThisFolder')}
      </p>
      <div className={cn(PANEL, 'mt-6 divide-y divide-line')}>
        <OptionRow
          label={t('ui.autoSave')}
          hint={t('ui.whenOffMainGenerationsAreNotSavedToFilesHistoryKeepsOnlyTheLast28457b8e')}
        >
          <Switch aria-label={t('ui.autoSave')} checked={autoSave} onCheckedChange={setAutoSave} />
        </OptionRow>
        <OptionRow
          label={t('ui.dateFolders')}
          hint={t('ui.organizeTheMainSaveFolderIntoYyyyMmSubfolders')}
        >
          <Switch
            aria-label={t('ui.dateFolders')}
            checked={dateFolders}
            onCheckedChange={setDateFolders}
          />
        </OptionRow>
        <OptionRow label={t('ui.imageFormat')} hint={t('ui.webpFilesAreSmaller')}>
          <Select value={format} onValueChange={setFormat}>
            <SelectTrigger className="h-10 w-28 text-[14px]" aria-label={t('ui.imageFormat')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent {...DROP_DOWN}>
              <SelectItem value="png">PNG</SelectItem>
              <SelectItem value="webp">WEBP</SelectItem>
            </SelectContent>
          </Select>
        </OptionRow>
      </div>
    </div>
  )
}
