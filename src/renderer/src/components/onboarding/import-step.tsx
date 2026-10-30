import { Download } from 'lucide-react'
import { useState } from 'react'
import { importBackup } from '../../lib/backup-import'
import { useT } from '../../lib/i18n'
import { Button } from '../ui/button'
import { ResultBox, type StepProps } from './parts'
import { FOOT_NOTE } from './styles'

export function ImportStep({ done, onDone, busy, onBusyChange }: StepProps): React.JSX.Element {
  const t = useT()
  // 방금 불러왔으면 사라진 버튼 대신 결과 상자로 포커스를 옮긴다 (단계를 다시 열 때는 제목으로)
  const [justImported, setJustImported] = useState(false)

  return (
    <div className="w-full max-w-[560px]">
      {done ? (
        <ResultBox focusOnMount={justImported} title={t('ui.onboardingImportDone')} />
      ) : (
        <Button
          size="lg"
          className="h-14 w-full gap-2.5 rounded-xl text-[15px]"
          disabled={busy}
          onClick={async () => {
            onBusyChange(true)
            try {
              if (await importBackup()) {
                setJustImported(true)
                onDone()
              }
            } finally {
              onBusyChange(false)
            }
          }}
        >
          <Download size={18} /> {t('ui.importData')}
        </Button>
      )}
      <p className={FOOT_NOTE}>{t('ui.onboardingImportOptional')}</p>
    </div>
  )
}
