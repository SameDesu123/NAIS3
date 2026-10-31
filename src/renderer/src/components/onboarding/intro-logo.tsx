import { useAnimate, useReducedMotion } from 'motion/react'
import { useContext, useEffect, useState } from 'react'
import { IntroContext } from './intro-context'

/**
 * 소개 화면 로고. 온보딩이 처음 뜰 때는 두 조각이 양쪽에서 날아와 카드 한가운데서 맞물리고, 그대로
 * 원래 자리(제목 위)로 옮겨 앉은 뒤에 카드·제목·버튼이 나타나도록 알린다. 그 뒤 소개 화면으로 돌아오면
 * 조립된 채로 그린다. 그림은 assets/nais3-logo.svg와 같은 두 조각
 */
export function IntroLogo(): React.JSX.Element {
  const { revealed, reveal } = useContext(IntroContext)
  // 마운트 시점에만 정한다 — 등장이 끝나 revealed가 바뀌어도 조각을 다시 숨기지 않게
  const [play] = useState(!revealed)
  const [scope, animate] = useAnimate<HTMLDivElement>()
  const reduce = useReducedMotion()

  useEffect(() => {
    if (!play) return
    let cancelled = false
    const run = async (): Promise<void> => {
      const logo = scope.current
      const card = logo.closest('section')
      const pieces = [...logo.querySelectorAll<SVGPathElement>('path')]
      if (reduce || !card) {
        await animate(pieces, { opacity: 1 }, { duration: 0.4 })
      } else {
        // 카드 가운데와 로고 자리의 높이 차. 카드에 걸린 zoom만큼 transform이 커지므로 나눠 준다
        const zoom = parseFloat(getComputedStyle(card).zoom) || 1
        const box = logo.getBoundingClientRect()
        const area = card.getBoundingClientRect()
        const dy = (area.top + area.height / 2 - (box.top + box.height / 2)) / zoom
        await animate(logo, { y: dy, scale: GATHER_SCALE }, { duration: 0 })
        PIECES.forEach((from, i) =>
          animate(
            pieces[i],
            {
              x: [from.x, 0],
              y: [from.y, 0],
              rotate: [from.rotate, 0],
              opacity: [0, 1]
            },
            {
              default: { type: 'spring', duration: ASSEMBLE, bounce: 0.2, delay: 0.2 + i * 0.08 },
              opacity: { duration: 0.35, delay: 0.2 + i * 0.08 }
            }
          )
        )
        // 스프링이 완전히 멎길 기다리면 꼬리가 길다 — 맞물린 직후부터 옮겨 앉기 시작한다
        await animate(
          logo,
          { y: 0, scale: 1 },
          { duration: 0.7, delay: 0.2 + 0.08 + ASSEMBLE, ease: SETTLE }
        )
      }
      if (!cancelled) reveal()
    }
    // 한 프레임 뒤에 잰다 — 소개 화면을 카드 정중앙에 두는 여백이 첫 레이아웃 뒤에 정해진다
    const frame = requestAnimationFrame(() => void run())
    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
    }
  }, [play, reduce, scope, animate, reveal])

  return (
    <div ref={scope} className="text-ink">
      <svg
        viewBox="0 0 739 668"
        role="img"
        aria-label="NAIS3"
        className="aspect-[739/668] h-[96px] overflow-visible"
      >
        <g transform="translate(-312 -372) matrix(1.234671 0 0 1.234671 60.12709 97.90301)">
          {PATHS.map((d) => (
            <path
              key={d}
              d={d}
              fill="currentColor"
              // motion은 SVG의 투명도를 속성으로 쓴다 — style로 두면 그쪽이 이겨 계속 안 보인다
              opacity={play ? 0 : 1}
              style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
            />
          ))}
        </g>
      </svg>
    </div>
  )
}

/** 조각이 날아와 맞물리는 시간(초) */
const ASSEMBLE = 0.75

/** 조립하는 동안의 배율 — 자리로 옮겨 앉으며 1로 줄어든다 */
const GATHER_SCALE = 1.35

/** 두 지점 사이를 옮겨 가는 움직임이라 양 끝을 모두 부드럽게 */
const SETTLE = [0.65, 0, 0.35, 1] as const

/** 왼쪽 위 아치 조각과 오른쪽 아래 조각 */
const PATHS = [
  'M204,667L204,419C204,302 292,222 411,222C473,222 528,248 566,292L400,341C384,346 373,348 367,356C359,367 358,381 359,402C359,402 358.361,630.685 355,632.75C320,659.25 242,674 204,667Z',
  'M410,389L784,279C791,277 798,276 802,276L802,552C802,676 714,763 590,763C506,763 435,718 402,644C407,640 410,635 410,626L410,389Z'
]

/** 조각마다 날아오는 출발점 (조각 좌표 기준 — 화면에선 대략 1/5 크기) */
const PIECES = [
  { x: -170, y: -120, rotate: -18 },
  { x: 170, y: 120, rotate: 18 }
]
