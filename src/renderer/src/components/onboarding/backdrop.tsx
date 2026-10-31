import { motion } from 'motion/react'

/**
 * 온보딩 카드 뒤 배경. 반짝임·원·십자·세모·물결 같은 작은 선 무늬가 카드 둘레에 흩어져 천천히 떠다니고,
 * 카드를 둘러싼 궤도 고리가 느리게 돈다. 단계를 넘길 때마다 무늬 밭이 조금씩 비껴 진행감을 준다.
 * 색은 모두 테마 토큰에서 나와 팔레트·다크 모드를 그대로 따르고, 크기는 vmin이라 큰 화면에서도 비율이
 * 같으며, 움직임은 transform만 쓴다. 처음 뜰 때는 카드가 다가오는 동안 배경이 살짝 물러나 깊이감을 준다
 */
export function OnboardingBackdrop({
  progress,
  leaving
}: {
  /** 0(첫 단계) ~ 1(마지막 단계) */
  progress: number
  leaving: boolean
}): React.JSX.Element {
  return (
    <motion.div
      aria-hidden
      // 창 전체를 덮어 투명한 타이틀바 아래까지 무늬가 이어진다
      className="pointer-events-none fixed inset-0 overflow-hidden"
      initial={{ opacity: 0, scale: 1.08 }}
      animate={{ opacity: leaving ? 0 : 1, scale: 1 }}
      transition={
        leaving
          ? { duration: 0.28, ease: [0.4, 0, 1, 1] }
          : { opacity: { duration: 1.2 }, scale: { duration: 1.8, ease: [0.22, 1, 0.36, 1] } }
      }
    >
      {/* 무늬 밭 — 단계가 진행될수록 왼쪽 위로 살짝 비낀다 */}
      <motion.div
        className="absolute inset-0"
        initial={false}
        animate={{ x: `${-3 * progress}vmin`, y: `${-2 * progress}vmin` }}
        transition={{ duration: 1.6, ease: [0.22, 1, 0.36, 1] }}
      >
        {MOTIFS.map((motif, i) => (
          <motion.svg
            key={i}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="absolute"
            style={{
              left: `${motif.x}%`,
              top: `${motif.y}%`,
              width: `${motif.size}vmin`,
              height: `${motif.size}vmin`,
              // 가운데 맞춤은 여백으로 — transform의 y는 떠오르는 움직임이 쓴다
              marginLeft: `${-motif.size / 2}vmin`,
              marginTop: `${-motif.size / 2}vmin`,
              color: motif.accent
                ? 'color-mix(in oklch, var(--accent) 70%, transparent)'
                : 'color-mix(in oklch, var(--faint) 45%, transparent)'
            }}
            initial={{ rotate: motif.rotate }}
            animate={{
              rotate: [motif.rotate, motif.rotate + motif.spin],
              y: ['0vmin', `${motif.float}vmin`]
            }}
            transition={{
              duration: motif.duration,
              ease: 'easeInOut',
              repeat: Infinity,
              repeatType: 'mirror'
            }}
          >
            {SHAPES[motif.shape]}
          </motion.svg>
        ))}
      </motion.div>
      {/* 궤도 고리 — 카드 가운데를 중심으로 한 가는 원들이 카드 양옆으로 비져 나오고, 원마다 강조색
          점 하나가 천천히 돈다. 창 가장자리로 갈수록 지운다 */}
      <div
        className="absolute inset-0"
        style={{
          maskImage: `radial-gradient(ellipse 70% 75% at 50% ${CARD_CENTER_Y}, black 40%, transparent 100%)`
        }}
      >
        {ORBITS.map((orbit, i) => (
          <motion.div
            key={i}
            className="absolute left-1/2 rounded-full border"
            style={{
              top: CARD_CENTER_Y,
              width: `${orbit.size}vmin`,
              height: `${orbit.size}vmin`,
              x: '-50%',
              y: '-50%',
              borderColor: 'color-mix(in oklch, var(--faint) 30%, transparent)'
            }}
            initial={{ rotate: orbit.start }}
            animate={{ rotate: orbit.start + 360 * orbit.turn }}
            transition={{ duration: orbit.duration, ease: 'linear', repeat: Infinity }}
          >
            <span
              className="absolute left-1/2 top-0 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent"
              style={{ boxShadow: '0 0 12px 3px var(--accent-soft)' }}
            />
          </motion.div>
        ))}
      </div>
    </motion.div>
  )
}

/** 카드 가운데 높이 — 배경은 창 전체를 덮지만 카드는 타이틀바(h-14) 아래 영역의 가운데에 놓인다 */
const CARD_CENTER_Y = 'calc(50% + 1.75rem)'

// 지름(창의 짧은 변 대비 vmin — 큰 화면에서도 카드 둘레를 채운다)·처음 각도·도는 방향(1 시계, -1 반시계)·한 바퀴 시간(초)
const ORBITS = [
  { size: 115, start: 70, turn: 1, duration: 90 },
  { size: 145, start: 230, turn: -1, duration: 120 },
  { size: 180, start: 140, turn: 1, duration: 160 }
]

/** 24×24 선 무늬 */
const SHAPES = {
  sparkle: (
    <path d="M12 3c.6 4.8 3.6 8 9 9-5.4 1-8.4 4.2-9 9-.6-4.8-3.6-8-9-9 5.4-1 8.4-4.2 9-9Z" />
  ),
  circle: <circle cx="12" cy="12" r="8" />,
  plus: <path d="M12 5v14M5 12h14" />,
  triangle: <path d="M12 4.5 20 19H4Z" />,
  wave: <path d="M2 12c2.5-4 4.5-4 7 0s4.5 4 7 0 4.5-4 6 0" />,
  diamond: <path d="M12 3.5 20.5 12 12 20.5 3.5 12Z" />,
  square: <rect x="5" y="5" width="14" height="14" rx="3" />,
  dot: <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />
}
type Shape = keyof typeof SHAPES
const SHAPE_ORDER = Object.keys(SHAPES) as Shape[]

/** 매번 같은 배치가 나오도록 씨앗을 고정한 난수 (mulberry32) */
function seeded(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 무늬 배치. 카드에 가려지는 가운데는 비우고, 서로 너무 붙지 않게 뿌린다. 넷 중 하나쯤은 강조색.
 * x·y는 창 대비 %, size는 vmin, float은 위아래로 떠오르는 거리(vmin), spin은 기우는 각도
 */
const MOTIFS = (() => {
  const rand = seeded(20261029)
  const placed: { x: number; y: number }[] = []
  for (let tries = 0; placed.length < 30 && tries < 2000; tries++) {
    const x = 3 + rand() * 94
    const y = 5 + rand() * 90
    if (Math.abs(x - 50) < 24 && Math.abs(y - 50) < 30) continue
    if (placed.some((p) => Math.hypot(p.x - x, (p.y - y) * 0.6) < 9)) continue
    placed.push({ x, y })
  }
  return placed.map(({ x, y }, i) => ({
    x,
    y,
    shape: SHAPE_ORDER[i % SHAPE_ORDER.length],
    size: 2.4 + rand() * 2,
    accent: rand() < 0.25,
    rotate: Math.round(rand() * 360),
    spin: (rand() < 0.5 ? -1 : 1) * (15 + rand() * 30),
    float: -(0.8 + rand() * 1.2),
    duration: 7 + rand() * 7
  }))
})()
