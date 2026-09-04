import { Dice5, Lock, LockOpen } from 'lucide-react'
import type { UcPresetIndex } from '@shared/types'
import { NOISE_SCHEDULES, SAMPLERS, UC_PRESET_OPTIONS } from '../lib/constants'
import { useT } from '../lib/i18n'
import {
  generationDefaultsForModel,
  inpaintingModelFor,
  modelCapabilities
} from '@shared/nai-models'
import { ResolutionPicker } from './resolution-picker'
import { useGenerationStore } from '../stores/generation-store'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'
import { Input } from './ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { Slider } from './ui/slider'
import { Switch } from './ui/switch'

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="shrink-0 text-[13px] text-muted">{label}</span>
      {children}
    </div>
  )
}

export function ParamsDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const t = useT()
  const request = useGenerationStore((s) => s.request)
  const source = useGenerationStore((s) => s.source)
  const patch = useGenerationStore((s) => s.patchRequest)
  const seedLocked = useGenerationStore((s) => s.seedLocked)
  const setSeedLocked = useGenerationStore((s) => s.setSeedLocked)
  const capabilities = modelCapabilities(request.model)
  const effectiveModel = source?.maskBase64 ? inpaintingModelFor(request.model) : request.model
  const supportsTransparency = modelCapabilities(effectiveModel).transparency

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[420px] p-5">
        <DialogTitle className="mb-4">{t('생성 파라미터')}</DialogTitle>
        <div className="grid gap-4">
          <Row label={t('모델')}>
            <Select
              value={request.model}
              onValueChange={(model) => patch({ model, ...generationDefaultsForModel(model) })}
            >
              <SelectTrigger className="w-52" aria-label={t('모델')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="nai-diffusion-5-curated">V5 Curated</SelectItem>
                <SelectItem value="nai-diffusion-5-full">V5 Full</SelectItem>
                <SelectItem value="nai-diffusion-4-5-full">V4.5 Full</SelectItem>
                <SelectItem value="nai-diffusion-4-5-curated">V4.5 Curated</SelectItem>
              </SelectContent>
            </Select>
          </Row>
          <Row label={t('해상도')}>
            <ResolutionPicker
              className="w-52"
              width={request.width}
              height={request.height}
              ariaLabel={t('해상도')}
              onPick={(width, height) => patch({ width, height })}
            />
          </Row>

          <Row label={t('시드')}>
            <div className="flex w-52 items-center gap-1.5">
              <Input
                className="font-mono"
                aria-label={t('시드')}
                value={request.seed < 0 ? '' : String(request.seed)}
                placeholder={t('랜덤')}
                onChange={(e) => {
                  const n = Number(e.target.value)
                  patch({ seed: e.target.value === '' || Number.isNaN(n) ? -1 : n })
                }}
              />
              <Button
                size="icon"
                variant={seedLocked ? 'accent' : 'ghost'}
                title={seedLocked ? t('시드 고정됨') : t('시드 고정')}
                onClick={() => setSeedLocked(!seedLocked)}
              >
                {seedLocked ? <Lock size={14} /> : <LockOpen size={14} />}
              </Button>
              <Button
                size="icon"
                variant="ghost"
                title={t('랜덤 시드')}
                onClick={() => patch({ seed: -1 })}
              >
                <Dice5 size={14} />
              </Button>
            </div>
          </Row>

          <Row label={t('스텝 {0}', request.steps)}>
            <Slider
              className="w-52"
              aria-label={t('스텝 {0}', request.steps)}
              min={1}
              max={50}
              step={1}
              value={[request.steps]}
              onValueChange={([v]) => patch({ steps: v })}
            />
          </Row>

          <Row label={`CFG ${request.cfgScale}`}>
            <Slider
              className="w-52"
              aria-label={`CFG ${request.cfgScale}`}
              min={1}
              max={10}
              step={0.1}
              value={[request.cfgScale]}
              onValueChange={([v]) => patch({ cfgScale: Math.round(v * 10) / 10 })}
            />
          </Row>

          <Row label={`Rescale ${request.cfgRescale}`}>
            <Slider
              className="w-52"
              aria-label={`Rescale ${request.cfgRescale}`}
              min={0}
              max={1}
              step={0.02}
              value={[request.cfgRescale]}
              onValueChange={([v]) => patch({ cfgRescale: Math.round(v * 100) / 100 })}
            />
          </Row>

          <Row label={t('샘플러')}>
            <Select value={request.sampler} onValueChange={(v) => patch({ sampler: v })}>
              <SelectTrigger className="w-52" aria-label={t('샘플러')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SAMPLERS.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>

          {capabilities.noiseScheduleSelection && (
            <Row label={t('노이즈 스케줄')}>
              <Select
                value={request.noiseSchedule}
                onValueChange={(v) => patch({ noiseSchedule: v })}
              >
                <SelectTrigger className="w-52" aria-label={t('노이즈 스케줄')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {NOISE_SCHEDULES.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Row>
          )}

          <Row label={t('UC 프리셋')}>
            <Select
              value={String(request.ucPreset)}
              onValueChange={(v) => patch({ ucPreset: Number(v) as UcPresetIndex })}
            >
              <SelectTrigger className="w-52" aria-label={t('UC 프리셋')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {UC_PRESET_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={String(o.value)}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>

          <Row label={t('퀄리티 태그')}>
            <Switch
              aria-label={t('퀄리티 태그')}
              checked={request.qualityToggle}
              onCheckedChange={(v) => patch({ qualityToggle: v })}
            />
          </Row>

          {capabilities.variety && (
            <Row label="Variety+">
              <Switch
                aria-label="Variety+"
                checked={request.variety}
                onCheckedChange={(v) => patch({ variety: v })}
              />
            </Row>
          )}

          {supportsTransparency && (
            <Row label={t('투명 배경')}>
              <Switch
                aria-label={t('투명 배경')}
                checked={request.transparentBackground ?? false}
                onCheckedChange={(v) => patch({ transparentBackground: v })}
              />
            </Row>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
