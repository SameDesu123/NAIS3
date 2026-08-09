import { useGenerationStore } from '../stores/generation-store'
import { MaskEditor } from './mask-editor'

/** 전역 인페인트 마스크 에디터 — App에 1회 배치. 어느 이미지 우클릭이든 여기서 뜬다 */
export function InpaintHost(): React.JSX.Element | null {
  const target = useGenerationStore((s) => s.inpaintTarget)
  const confirm = useGenerationStore((s) => s.confirmInpaint)
  const cancel = useGenerationStore((s) => s.cancelInpaint)
  if (!target) return null
  return (
    <MaskEditor
      imageBase64={target.base64}
      width={target.width}
      height={target.height}
      initialMaskBase64={target.initialMask}
      onCancel={cancel}
      onConfirm={confirm}
    />
  )
}
