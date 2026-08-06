import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { ArrowUpRight, Check, Copy, Menu, Play, Plus, User, X } from 'lucide-react'
import gsap from 'gsap'

const BG_IMAGE_1 =
  'https://images.higgs.ai/?default=1&output=webp&url=https%3A%2F%2Fd8j0ntlcm91z4.cloudfront.net%2Fuser_38xzZboKViGWJOttwIXH07lWA1P%2Fhf_20260721_161708_64fad17a-06cc-4227-b6d2-1fefec159ec7.png&w=1920&q=85'
const BG_IMAGE_2 =
  'https://images.higgs.ai/?default=1&output=webp&url=https%3A%2F%2Fd8j0ntlcm91z4.cloudfront.net%2Fuser_38xzZboKViGWJOttwIXH07lWA1P%2Fhf_20260721_161933_6afd5ffe-5710-4fe1-9d61-11843a494893.png&w=1920&q=85'
const CARD_IMAGE_1 =
  'https://images.higgs.ai/?default=1&output=webp&url=https%3A%2F%2Fd8j0ntlcm91z4.cloudfront.net%2Fuser_38xzZboKViGWJOttwIXH07lWA1P%2Fhf_20260721_181520_8e5bcf81-0d47-45a4-83a5-ad3dcfbf1b8d.png&w=1920&q=85'
const CARD_IMAGE_2 =
  'https://images.higgs.ai/?default=1&output=webp&url=https%3A%2F%2Fd8j0ntlcm91z4.cloudfront.net%2Fuser_38xzZboKViGWJOttwIXH07lWA1P%2Fhf_20260721_182252_81b91edf-7491-454c-9c19-2203b871032c.png&w=1920&q=85'
const VIDEO_SRC =
  'https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260722_103029_2c529df7-48ee-452e-925a-3301b74de32b.mp4'

const SPOTLIGHT_R = 260
const GRID_CELL = 48
const SWIPE_THRESHOLD = 40

/** Wheel deltas (px) that must accumulate at the top before the intro re-locks. */
const UP_RELEASE = 120
/** Ignore upward wheel for this long after the document lands back at the top,
 *  so trackpad momentum from a fast scroll-up does not snap into the hero. */
const TOP_SETTLE_MS = 400
const TOP_EPSILON = 2

/** Deployed and verified on GIWA Sepolia — see smartcontracts/deployments. */
const VAULT_URL =
  'https://sepolia-explorer.giwa.io/address/0xD89395Df78aaFdF86b330899d1C6189211e88750'
const REPO_URL = 'https://github.com/Lexirieru/agentcard'
const DASHBOARD_URL = 'https://agentcard-fe.vercel.app'
const README_URL = `${REPO_URL}#readme`

const SECTION_FEATURES = 'features'
const SECTION_INSTALL = 'install'

type NavItem = { label: string; target?: string; href?: string }

const NAV_ITEMS: NavItem[] = [
  { label: 'Product', target: SECTION_FEATURES },
  { label: 'Agents', target: SECTION_INSTALL },
  { label: 'Contracts', href: VAULT_URL },
  { label: 'Docs', href: README_URL },
  { label: 'GitHub', href: REPO_URL },
]

const INSTALL_COMMAND = 'npx giwacard'

/**
 * Two exchanges. The first shows a purchase completing; the second shows one
 * being stopped. The second is the product's actual argument — the agent wanted
 * to pay, and the limit held without anyone watching — so it types last and its
 * closing line is emphasised.
 */
const TRANSCRIPT: { speaker: 'you' | 'agent'; text: string; emphasis?: boolean }[] = [
  { speaker: 'you', text: 'buy the insights report' },
  { speaker: 'agent', text: 'making a card. $1, one shop.' },
  { speaker: 'agent', text: 'paid. that card is done.' },
  { speaker: 'you', text: 'put my Claude sub on giwacard' },
  { speaker: 'agent', text: '$20 a month — more than you allow' },
  { speaker: 'agent', text: 'waiting on your yes.', emphasis: true },
]

const FEATURES: { title: string; body: ReactNode }[] = [
  {
    title: 'One command to start',
    body: (
      <>
        <code className="font-code rounded bg-[#18161B]/[0.07] px-1.5 py-0.5 text-[13px]">
          npx giwacard
        </code>{' '}
        sets up your wallet, your account, and the key your agent will use.
      </>
    ),
  },
  {
    title: 'The limits are not a suggestion',
    body: 'An amount, one shop, a deadline. If the agent is tricked into asking for more, it simply does not go through.',
  },
  {
    title: 'MCP server included',
    body: 'Your agent gets seven ready-made actions. Nothing to build on your side.',
  },
]

const PROOFS: { title: string; body: string; href: string; source: string }[] = [
  {
    title: 'The code is published, not described',
    body: 'Every line running your money is on the explorer. Read it before you trust it.',
    href: VAULT_URL,
    source: 'sepolia-explorer.giwa.io',
  },
  {
    title: '960 tests passing',
    body: '78 contracts, 542 CLI/MCP, 215 merchant, 125 dashboard.',
    href: REPO_URL,
    source: 'github.com/Lexirieru/agentcard',
  },
  {
    title: 'The agent can never approve itself',
    body: 'It has no way to say yes on your behalf. A test checks that on every build.',
    href: REPO_URL,
    source: 'github.com/Lexirieru/agentcard',
  },
  {
    title: 'Fees are rounding errors',
    body: 'Setting all of this up on GIWA cost less than a cent.',
    href: VAULT_URL,
    source: 'sepolia-explorer.giwa.io',
  },
]

const LOGO_PATHS = [
  'M 128 192 L 128 256 L 64.5 256 L 32 223 L 0 192 L 0 128 L 64 128 Z',
  'M 256 192 L 256 256 L 192.5 256 L 160 223 L 128 192 L 128 128 L 192 128 Z',
  'M 128 64 L 128 128 L 64.5 128 L 32 95 L 0 64 L 0 0 L 64 0 Z',
  'M 256 64 L 256 128 L 192.5 128 L 160 95 L 128 64 L 128 0 L 192 0 Z',
]

const STAGGER_EASE = 'cubic-bezier(0.16, 1, 0.3, 1)'

/** Shared horizontal rhythm for the unlocked content below the intro. */
const GUTTER = 'px-5 sm:px-10 md:px-14'
const CONTAINER = 'mx-auto w-full'
const WIDE = 'max-w-5xl'
const NARROW = 'max-w-3xl'

const HEADING_STYLE = {
  fontSize: 'clamp(1.9rem, 5.2vw, 3.5rem)',
  lineHeight: 1.02,
  letterSpacing: '-0.03em',
} as const

const EYEBROW = 'text-[11px] uppercase tracking-[0.2em] text-[#18161B]/45'

type VideoPhase = 'idle' | 'playing' | 'done'

function prefersReducedMotion() {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

function scrollToSection(id: string) {
  const el = document.getElementById(id)
  if (!el) return
  el.scrollIntoView({
    behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    block: 'start',
  })
}

/** One-shot in-view flag; drives the shared `.anim-stagger` entrance. */
function useInView<T extends HTMLElement>(): [RefObject<T>, boolean] {
  const ref = useRef<T>(null)
  const [inView, setInView] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true)
          observer.disconnect()
        }
      },
      { threshold: 0.15, rootMargin: '0px 0px -8% 0px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return [ref, inView]
}

function Reveal({
  delay = 0,
  className = '',
  children,
}: {
  delay?: number
  className?: string
  children: ReactNode
}) {
  const [ref, inView] = useInView<HTMLDivElement>()

  return (
    <div
      ref={ref}
      className={`${inView ? 'anim-stagger' : 'opacity-0'} ${className}`}
      style={{ animationDelay: `${delay}s` }}
    >
      {children}
    </div>
  )
}

function RevealLayer({ image }: { image: string }) {
  const layerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = layerRef.current
    if (!el) return

    const size = SPOTLIGHT_R * 2
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const gradient = ctx.createRadialGradient(
      SPOTLIGHT_R,
      SPOTLIGHT_R,
      0,
      SPOTLIGHT_R,
      SPOTLIGHT_R,
      SPOTLIGHT_R,
    )
    gradient.addColorStop(0, 'rgba(255,255,255,1)')
    gradient.addColorStop(0.4, 'rgba(255,255,255,1)')
    gradient.addColorStop(0.6, 'rgba(255,255,255,0.75)')
    gradient.addColorStop(0.75, 'rgba(255,255,255,0.4)')
    gradient.addColorStop(0.88, 'rgba(255,255,255,0.12)')
    gradient.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, size, size)

    const maskUrl = `url(${canvas.toDataURL()})`
    el.style.setProperty('mask-image', maskUrl)
    el.style.setProperty('-webkit-mask-image', maskUrl)
    el.style.setProperty('mask-repeat', 'no-repeat')
    el.style.setProperty('-webkit-mask-repeat', 'no-repeat')

    // Start far offscreen so nothing is revealed until the cursor moves.
    const mouse = { x: -SPOTLIGHT_R * 4, y: -SPOTLIGHT_R * 4 }
    const smooth = { x: mouse.x, y: mouse.y }
    let raf = 0

    const onMouseMove = (e: MouseEvent) => {
      const rect = el.getBoundingClientRect()
      mouse.x = e.clientX - rect.left
      mouse.y = e.clientY - rect.top
    }

    const tick = () => {
      smooth.x += (mouse.x - smooth.x) * 0.1
      smooth.y += (mouse.y - smooth.y) * 0.1
      const pos = `${smooth.x - SPOTLIGHT_R}px ${smooth.y - SPOTLIGHT_R}px`
      el.style.setProperty('mask-position', pos)
      el.style.setProperty('-webkit-mask-position', pos)
      raf = requestAnimationFrame(tick)
    }

    window.addEventListener('mousemove', onMouseMove)
    raf = requestAnimationFrame(tick)

    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      cancelAnimationFrame(raf)
    }
  }, [image])

  return (
    <div
      ref={layerRef}
      className="absolute inset-0 bg-cover bg-center"
      style={{ backgroundImage: `url(${image})` }}
    />
  )
}

function HeroSection({ onSeeHow }: { onSeeHow: () => void }) {
  const sectionRef = useRef<HTMLElement>(null)
  const patternRef = useRef<SVGPatternElement>(null)

  useEffect(() => {
    const section = sectionRef.current
    const pattern = patternRef.current
    if (!section || !pattern) return

    const target = { x: 0, y: 0 }
    const offset = { x: 0, y: 0 }
    let raf = 0

    const onMouseMove = (e: MouseEvent) => {
      const rect = section.getBoundingClientRect()
      const cx = (e.clientX - rect.left) / rect.width - 0.5
      const cy = (e.clientY - rect.top) / rect.height - 0.5
      target.x = cx * 16
      target.y = cy * 16
    }

    const tick = () => {
      offset.x += (target.x - offset.x) * 0.06
      offset.y += (target.y - offset.y) * 0.06
      pattern.setAttribute('x', String(offset.x))
      pattern.setAttribute('y', String(offset.y))
      raf = requestAnimationFrame(tick)
    }

    window.addEventListener('mousemove', onMouseMove)
    raf = requestAnimationFrame(tick)

    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      cancelAnimationFrame(raf)
    }
  }, [])

  return (
    <section
      ref={sectionRef}
      className="font-helvetica-neue relative h-screen w-full overflow-clip"
    >
      <svg className="absolute inset-0 h-full w-full" style={{ opacity: 0.08 }}>
        <defs>
          <pattern
            ref={patternRef}
            id="hero-grid"
            width={GRID_CELL}
            height={GRID_CELL}
            patternUnits="userSpaceOnUse"
          >
            <path
              d={`M ${GRID_CELL} 0 L 0 0 0 ${GRID_CELL}`}
              fill="none"
              stroke="#94a3b8"
              strokeWidth="0.5"
            />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#hero-grid)" />
      </svg>

      <div
        className="anim-fade absolute inset-0 bg-cover bg-center"
        style={{ backgroundImage: `url(${BG_IMAGE_1})`, animationDelay: '0.1s' }}
      />

      <RevealLayer image={BG_IMAGE_2} />

      <div className="absolute inset-x-0 bottom-0 z-40 h-72 bg-gradient-to-t from-[#0A0B11] via-[#0A0B11]/60 to-transparent" />

      <div className="absolute inset-x-0 bottom-0 z-50 grid gap-10 px-6 pb-12 sm:px-10 sm:pb-16 md:grid-cols-12 md:items-end md:px-14 md:pb-20">
        <div className="md:col-span-7 lg:col-span-8">
          <div
            className="anim-stagger flex items-center gap-3"
            style={{ animationDelay: '0.3s' }}
          >
            <span className="h-2.5 w-2.5 rounded-full bg-white/80" />
            <span className="text-sm text-white/80 sm:text-[15px]">
              Live on GIWA · every contract published
            </span>
          </div>

          <h1
            className="anim-stagger mt-5 font-light text-white"
            style={{
              animationDelay: '0.5s',
              fontSize: 'clamp(2.2rem, 6.5vw, 5rem)',
              lineHeight: 0.95,
              letterSpacing: '-0.03em',
            }}
          >
            Give an Agent a Card
            <br />
            Not Your Wallet
          </h1>

          <div
            className="anim-stagger mt-8 flex flex-wrap items-center gap-3"
            style={{ animationDelay: '0.7s' }}
          >
            <button
              onClick={onSeeHow}
              className="flex items-center gap-2 rounded-full bg-white px-6 py-3 text-sm font-medium text-gray-900 transition-colors hover:bg-white/90"
            >
              <Play size={13} fill="currentColor" />
              See how it works
            </button>
            <a
              href={VAULT_URL}
              target="_blank"
              rel="noreferrer"
              className="rounded-full border border-white/10 bg-white/5 px-6 py-3 text-sm font-medium text-white backdrop-blur transition-colors hover:bg-white/10"
            >
              Read the contract
            </a>
          </div>
        </div>

        <div
          className="anim-stagger md:col-span-5 lg:col-span-4"
          style={{ animationDelay: '0.85s' }}
        >
          <p className="max-w-md text-[15px] leading-relaxed text-white/75 sm:text-base">
            Give an AI agent your wallet and one bad instruction can empty it. Give it a
            GiwaCard instead: a card that works once, at one shop, for an amount you set.
            Ask for more than that and it stops and waits for you.
          </p>
        </div>
      </div>
    </section>
  )
}

function CardSection({
  visible,
  imagesVisible,
}: {
  visible: boolean
  imagesVisible: boolean
}) {
  const [inView, setInView] = useState(false)

  useEffect(() => {
    setInView(visible)
  }, [visible])

  const h2Style = {
    fontSize: 'clamp(2rem, 7vw, 5.5rem)',
    lineHeight: 0.95,
    letterSpacing: '-0.03em',
  }

  const staggerClass = (base: string) =>
    `${base} ${inView ? 'anim-stagger' : 'opacity-0'}`

  return (
    <section
      className={`absolute inset-0 z-[1] h-screen overflow-hidden transition-opacity duration-700 ${
        visible ? 'opacity-100' : 'opacity-0'
      }`}
    >
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <span
          className="font-medium uppercase text-white/[0.04]"
          style={{ fontSize: 'clamp(4rem, 15vw, 14rem)', letterSpacing: '-0.02em' }}
        >
          GIWACARD
        </span>
      </div>

      <div
        className={`absolute inset-0 transition-opacity duration-700 ${
          imagesVisible ? 'opacity-100' : 'opacity-0'
        }`}
      >
        <div
          className="absolute inset-0 bg-cover bg-center"
          style={{ backgroundImage: `url(${CARD_IMAGE_1})` }}
        />
        <RevealLayer image={CARD_IMAGE_2} />
      </div>

      <div className="absolute inset-x-0 top-0 flex items-start justify-between gap-4 px-5 pt-16 sm:px-10 sm:pt-28 md:px-14 md:pt-32">
        <h2
          className={staggerClass('font-light text-[#18161B]')}
          style={{ ...h2Style, animationDelay: '0.15s' }}
        >
          It Spends Once
        </h2>
        <div
          className={staggerClass(
            'flex shrink-0 items-center gap-1.5 rounded-full border border-[#18161B]/15 bg-[#18161B]/10 px-4 py-2 text-sm text-[#18161B]/80',
          )}
          style={{ animationDelay: '0.3s' }}
        >
          <Plus size={15} />
          Works once
        </div>
      </div>

      <div className="absolute inset-x-0 bottom-0 flex flex-col gap-8 px-5 pb-10 sm:px-10 sm:pb-14 md:flex-row md:items-end md:justify-between md:px-14 md:pb-16">
        <div className={staggerClass('max-w-md')} style={{ animationDelay: '0.7s' }}>
          <p className="text-[15px] leading-relaxed text-[#18161B]/75 sm:text-base">
            The money is set aside the moment you make the card, so it can never spend more
            than you gave it. The shop charges it once. Anything left over comes straight
            back to you.
          </p>
          <a
            href={DASHBOARD_URL}
            target="_blank"
            rel="noreferrer"
            className="mt-6 inline-block rounded-full bg-[#18161B] px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-[#18161B]/90"
          >
            Open the dashboard
          </a>
        </div>
        <h2
          className={staggerClass('font-light text-[#18161B] md:text-right')}
          style={{ ...h2Style, animationDelay: '0.5s' }}
        >
          Then It’s Gone
        </h2>
      </div>
    </section>
  )
}

/**
 * Types the transcript out on a GSAP timeline the first time it scrolls into
 * view. A pause before each agent reply makes the exchange read as a
 * conversation rather than as text appearing. It plays once — a transcript that
 * loops forever competes with the prose around it.
 */
function useTypedTranscript(active: boolean) {
  const [typed, setTyped] = useState<string[]>(() => TRANSCRIPT.map(() => ''))
  const [typingIndex, setTypingIndex] = useState(-1)
  const [visibleCount, setVisibleCount] = useState(-1)
  const [thinking, setThinking] = useState(false)
  const played = useRef(false)

  useEffect(() => {
    if (!active || played.current) return
    played.current = true

    if (prefersReducedMotion()) {
      setTyped(TRANSCRIPT.map((e) => e.text))
      setVisibleCount(TRANSCRIPT.length)
      return
    }

    const tl = gsap.timeline()

    TRANSCRIPT.forEach((entry, i) => {
      // Agents pause before answering; you do not pause before your own line.
      if (entry.speaker === 'agent') {
        tl.call(() => setThinking(true))
        tl.to({}, { duration: 0.55 })
        tl.call(() => setThinking(false))
      }

      const counter = { n: 0 }
      tl.call(() => {
        setVisibleCount(i)
        setTypingIndex(i)
      })
      tl.to(counter, {
        n: entry.text.length,
        duration: Math.min(1.5, 0.22 + entry.text.length * 0.016),
        ease: 'none',
        onUpdate: () => {
          const n = Math.round(counter.n)
          setTyped((prev) => {
            if (prev[i]?.length === n) return prev
            const next = [...prev]
            next[i] = entry.text.slice(0, n)
            return next
          })
        },
      })
      tl.to({}, { duration: 0.28 })
    })

    tl.call(() => setTypingIndex(-1))

    return () => {
      tl.kill()
    }
  }, [active])

  return { typed, typingIndex, visibleCount, thinking }
}

function ChatDemoSection() {
  const [ref, inView] = useInView<HTMLDivElement>()
  const { typed, typingIndex, thinking } = useTypedTranscript(inView)

  return (
    <section
      ref={ref}
      className={`${GUTTER} flex min-h-screen scroll-mt-24 items-center bg-[#F4F0ED] py-24`}
    >
      <div className={`${CONTAINER} ${WIDE}`}>
        <div className="flex flex-col gap-4 sm:gap-6">
          {TRANSCRIPT.map((entry, i) => {
            const isYou = entry.speaker === 'you'
            const startsRun = i === 0 || TRANSCRIPT[i - 1]?.speaker !== entry.speaker
            const shown = typed[i] ?? ''
            const started = shown.length > 0 || i === typingIndex

            return (
              <div
                key={entry.text}
                className={`flex flex-col ${isYou ? 'items-start' : 'items-end'}`}
              >
                {startsRun && (
                  <span
                    className={`mb-2 px-3 text-xs text-[#18161B]/40 transition-opacity duration-300 sm:text-sm ${
                      started ? 'opacity-100' : 'opacity-0'
                    }`}
                  >
                    {isYou ? 'User:' : 'Agent:'}
                  </span>
                )}
                {/*
                  Every bubble is laid out from the start and only faded in, so
                  the section's height never changes while the transcript types.
                  Rendering them as they arrive made the background grow.
                */}
                <div
                  className={`max-w-full rounded-[1.75rem] px-6 py-3 transition-opacity duration-300 sm:rounded-full sm:px-8 sm:py-4 ${
                    started ? 'opacity-100' : 'opacity-0'
                  } ${
                    isYou
                      ? 'bg-[#18161B]/[0.06] text-[#18161B]'
                      : 'bg-[#18161B] text-[#F4F0ED]'
                  }`}
                  style={{
                    fontSize: 'clamp(1.05rem, 2.4vw, 1.75rem)',
                    lineHeight: 1.2,
                    letterSpacing: '-0.02em',
                  }}
                >
                  <span className="font-light">
                    {shown || entry.text}
                  </span>
                  {i === typingIndex && (
                    <span className="ml-1 inline-block h-[0.7em] w-[0.055em] animate-pulse bg-current align-middle" />
                  )}
                </div>
              </div>
            )
          })}
        </div>

        <div className="mt-10 flex h-3 items-center justify-end gap-1.5 pr-6">
          {thinking &&
            [0, 1, 2].map((d) => (
              <span
                key={d}
                className="h-2 w-2 animate-pulse rounded-full bg-[#18161B]/40"
                style={{ animationDelay: `${d * 0.15}s` }}
              />
            ))}
        </div>

        <p className="mt-6 max-w-lg text-[15px] leading-relaxed text-[#18161B]/55">
          Nothing sits waiting to be spent, and nothing the agent can quietly widen
          later. Each card covers one payment, and the rest of your money never moves.
        </p>
      </div>
    </section>
  )
}

function FeaturesSection() {
  return (
    <section id={SECTION_FEATURES} className={`${GUTTER} scroll-mt-24 py-16 sm:py-24`}>
      <div className={`${CONTAINER} ${WIDE}`}>
        <Reveal>
          <h2 className="max-w-2xl font-light text-[#18161B]" style={HEADING_STYLE}>
            What a card for an agent looks like
          </h2>
        </Reveal>

        <div className="mt-10 grid gap-4 sm:mt-14 md:grid-cols-3">
          {FEATURES.map((feature, i) => (
            <Reveal key={feature.title} delay={0.08 + i * 0.1} className="h-full">
              <article className="flex h-full flex-col rounded-3xl border border-[#18161B]/10 bg-white/50 p-6 backdrop-blur-sm sm:p-8">
                <h3 className="text-base font-medium text-[#18161B] sm:text-lg">
                  {feature.title}
                </h3>
                <p className="mt-3 text-[15px] leading-relaxed text-[#18161B]/65">
                  {feature.body}
                </p>
              </article>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}


/**
 * The MCP entry every host takes, and where each one keeps it.
 *
 * Paths are the ones `giwacard init` actually writes (see
 * giwacard/src/cli/agentConfig.ts) rather than guesses. Claude Code and Claude
 * Desktop are separate products reading separate files, so they are listed
 * separately — telling someone "Claude" would configure the wrong one half the
 * time.
 */
const MCP_ENTRY = `{
  "mcpServers": {
    "giwacard": {
      "command": "npx",
      "args": ["-y", "giwacard", "mcp"],
      "env": {
        "GIWACARD_VAULT_ADDRESS": "0xD89395Df78aaFdF86b330899d1C6189211e88750",
        "GIWACARD_VAULT_OWNER": "0xYourAddress"
      }
    }
  }
}`

const AGENT_PROMPT =
  'Read https://github.com/Lexirieru/agentcard/blob/main/giwacard/llms-install.md and set giwacard up for me.'

type HostTab = { id: string; label: string; where: string; body: string }

const HOST_TABS: HostTab[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    where: 'Save as .mcp.json in your project folder',
    body: MCP_ENTRY,
  },
  {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    where: 'Add to claude_desktop_config.json, then restart the app',
    body: MCP_ENTRY,
  },
  {
    id: 'cursor',
    label: 'Cursor',
    where: 'Add to ~/.cursor/mcp.json',
    body: MCP_ENTRY,
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    where: 'Add to ~/.gemini/settings.json',
    body: MCP_ENTRY,
  },
  {
    id: 'prompt',
    label: 'Just tell your agent',
    where: 'Paste this to any coding agent and it does the rest',
    body: AGENT_PROMPT,
  },
]

function CopyBlock({ text, mono = true }: { text: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 2200)
    return () => window.clearTimeout(timer)
  }, [copied])

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const field = document.createElement('textarea')
      field.value = text
      field.setAttribute('readonly', '')
      field.style.position = 'fixed'
      field.style.opacity = '0'
      document.body.appendChild(field)
      field.select()
      try {
        document.execCommand('copy')
      } catch {
        /* nothing else to try */
      }
      field.remove()
    }
    setCopied(true)
  }, [text])

  return (
    <div className="relative">
      <pre
        className={`max-h-[19rem] overflow-auto rounded-2xl bg-[#0A0B11] p-5 pr-16 text-[12.5px] leading-relaxed text-white/85 sm:text-[13.5px] ${
          mono ? 'font-code' : ''
        } ${mono ? '' : 'whitespace-pre-wrap'}`}
      >
        {text}
      </pre>
      <button
        type="button"
        onClick={copy}
        aria-label="Copy to clipboard"
        className="absolute right-3 top-3 flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-2 text-xs font-medium text-white backdrop-blur transition-colors hover:bg-white/20"
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

/** Tabs across the agent hosts, with a GSAP crossfade so switching never jumps. */
function HostSwitcher() {
  const [active, setActive] = useState(0)
  const panelRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
  const host = HOST_TABS[active]!

  useEffect(() => {
    const el = panelRef.current
    if (!el || prefersReducedMotion()) return
    const tween = gsap.fromTo(
      el,
      { opacity: 0, y: 8 },
      { opacity: 1, y: 0, duration: 0.32, ease: 'power2.out' },
    )
    return () => {
      tween.kill()
    }
  }, [active])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    e.preventDefault()
    const next =
      e.key === 'ArrowRight'
        ? (active + 1) % HOST_TABS.length
        : (active - 1 + HOST_TABS.length) % HOST_TABS.length
    setActive(next)
    tabRefs.current[next]?.focus()
  }

  return (
    <div className="mt-12">
      <p className={EYEBROW}>Then point your agent at it</p>

      <div
        role="tablist"
        aria-label="Agent hosts"
        onKeyDown={onKeyDown}
        className="mt-4 flex flex-wrap gap-2"
      >
        {HOST_TABS.map((tab, i) => (
          <button
            key={tab.id}
            ref={(el) => {
              tabRefs.current[i] = el
            }}
            role="tab"
            id={`host-tab-${tab.id}`}
            aria-selected={i === active}
            aria-controls={`host-panel-${tab.id}`}
            tabIndex={i === active ? 0 : -1}
            onClick={() => setActive(i)}
            className={`rounded-full px-4 py-2 text-sm transition-colors ${
              i === active
                ? 'bg-[#18161B] text-white'
                : 'bg-[#18161B]/[0.06] text-[#18161B]/70 hover:bg-[#18161B]/10'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div
        ref={panelRef}
        role="tabpanel"
        id={`host-panel-${host.id}`}
        aria-labelledby={`host-tab-${host.id}`}
        className="mt-5"
      >
        <p className="mb-3 text-[14px] text-[#18161B]/55">{host.where}</p>
        <CopyBlock text={host.body} mono={host.id !== 'prompt'} />
      </div>
    </div>
  )
}

function InstallSection() {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 2200)
    return () => window.clearTimeout(timer)
  }, [copied])

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(INSTALL_COMMAND)
    } catch {
      // Clipboard API is unavailable on insecure origins; fall back to a selection copy.
      const field = document.createElement('textarea')
      field.value = INSTALL_COMMAND
      field.setAttribute('readonly', '')
      field.style.position = 'fixed'
      field.style.opacity = '0'
      document.body.appendChild(field)
      field.select()
      try {
        document.execCommand('copy')
      } catch {
        /* nothing else to try */
      }
      field.remove()
    }
    setCopied(true)
  }, [])

  return (
    <section id={SECTION_INSTALL} className={`${GUTTER} scroll-mt-24 py-16 sm:py-24`}>
      <div className={`${CONTAINER} ${NARROW}`}>
        <Reveal>
          <p className={EYEBROW}>Start here</p>
        </Reveal>

        <Reveal delay={0.08}>
          <div className="mt-5 flex items-center gap-3 rounded-2xl bg-[#0A0B11] p-3 pl-5 sm:rounded-full sm:pl-7">
            <span className="font-code min-w-0 truncate text-[15px] text-white sm:text-lg">
              <span className="text-white/35">$&nbsp;</span>
              {INSTALL_COMMAND}
            </span>
            <button
              type="button"
              onClick={copy}
              className="ml-auto flex shrink-0 items-center gap-2 rounded-full bg-white px-4 py-2.5 text-sm font-medium text-[#18161B] transition-colors hover:bg-white/90 sm:px-5"
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? 'Copied' : 'Copy'}
            </button>
            <span className="sr-only" role="status" aria-live="polite">
              {copied ? 'Command copied to clipboard' : ''}
            </span>
          </div>
        </Reveal>

        <Reveal delay={0.16}>
          <p className="mt-5 text-[13px] leading-relaxed text-[#18161B]/50">
            Node 22.5 or newer. The wizard is resumable, so a faucet wait or a
            Ctrl-C costs you nothing — run it again and it picks up where it
            stopped. Source at{' '}
            <a
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
              className="underline decoration-[#18161B]/25 underline-offset-4 transition-colors hover:text-[#18161B]"
            >
              github.com/Lexirieru/agentcard
            </a>
            .
          </p>
        </Reveal>

        <Reveal delay={0.12}>
          <HostSwitcher />
        </Reveal>
      </div>
    </section>
  )
}

function ProofSection() {
  return (
    <section className={`${GUTTER} scroll-mt-24 py-16 sm:py-24`}>
      <div className={`${CONTAINER} ${WIDE}`}>
        <Reveal>
          <h2 className="max-w-2xl font-light text-[#18161B]" style={HEADING_STYLE}>
            What you can check yourself
          </h2>
        </Reveal>
        <Reveal delay={0.08}>
          <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-[#18161B]/60">
            Every claim on this page points at something you can open.
          </p>
        </Reveal>

        <div className="mt-10 grid gap-4 sm:mt-14 sm:grid-cols-2">
          {PROOFS.map((proof, i) => (
            <Reveal key={proof.title} delay={0.08 + i * 0.08} className="h-full">
              <a
                href={proof.href}
                target="_blank"
                rel="noreferrer"
                className="group flex h-full flex-col rounded-3xl border border-[#18161B]/10 bg-white/50 p-6 backdrop-blur-sm transition-colors hover:border-[#18161B]/25 hover:bg-white/70 sm:p-8"
              >
                <div className="flex items-start justify-between gap-4">
                  <h3 className="text-base font-medium text-[#18161B] sm:text-lg">
                    {proof.title}
                  </h3>
                  <ArrowUpRight
                    size={18}
                    className="mt-1 shrink-0 text-[#18161B]/30 transition-all group-hover:text-[#18161B] motion-safe:group-hover:-translate-y-0.5 motion-safe:group-hover:translate-x-0.5"
                  />
                </div>
                <p className="mt-3 text-[15px] leading-relaxed text-[#18161B]/65">
                  {proof.body}
                </p>
                <span className="font-code mt-6 block break-words text-[11px] tracking-tight text-[#18161B]/40 sm:mt-auto sm:pt-6">
                  {proof.source}
                </span>
              </a>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}

function ClosingSection() {
  return (
    <section className={`${GUTTER} pb-24 pt-10 sm:pb-32 sm:pt-16`}>
      <div className={`${CONTAINER} ${WIDE}`}>
        <Reveal>
          <h2
            className="max-w-3xl font-light text-[#18161B]"
            style={{
              fontSize: 'clamp(2.1rem, 7vw, 5rem)',
              lineHeight: 0.98,
              letterSpacing: '-0.03em',
            }}
          >
            What would you let an agent buy?
          </h2>
        </Reveal>
        <Reveal delay={0.12}>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="mt-8 inline-flex items-center gap-2 rounded-full bg-[#18161B] px-7 py-3.5 text-sm font-medium text-white transition-colors hover:bg-[#18161B]/90"
          >
            Open the repo
            <ArrowUpRight size={15} />
          </a>
        </Reveal>
      </div>
    </section>
  )
}


function Footer() {
  return (
    <footer className={`${GUTTER} border-t border-[#18161B]/10 bg-[#F4F0ED] py-14 sm:py-20`}>
      <div className={`${CONTAINER} ${WIDE}`}>
        <div className="flex flex-col gap-10 md:flex-row md:justify-between">
          <div className="max-w-xs">
            <div className="flex items-center gap-2.5">
              <svg viewBox="0 0 256 256" className="h-5 w-5" aria-hidden>
                {LOGO_PATHS.map((d) => (
                  <path key={d} d={d} className="fill-[#18161B]" />
                ))}
              </svg>
              <span className="text-sm font-medium uppercase tracking-wide text-[#18161B]">
                GiwaCard
              </span>
            </div>
            <p className="mt-4 text-[14px] leading-relaxed text-[#18161B]/55">
              Cards that work once, for AI agents. Built on GIWA.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-x-10 gap-y-8 sm:grid-cols-3">
            <div>
              <p className={EYEBROW}>Product</p>
              <ul className="mt-4 flex flex-col gap-2.5 text-[14px] text-[#18161B]/70">
                <li>
                  <button
                    onClick={() => scrollToSection(SECTION_FEATURES)}
                    className="transition-colors hover:text-[#18161B]"
                  >
                    How it works
                  </button>
                </li>
                <li>
                  <button
                    onClick={() => scrollToSection(SECTION_INSTALL)}
                    className="transition-colors hover:text-[#18161B]"
                  >
                    Install
                  </button>
                </li>
              </ul>
            </div>

            <div>
              <p className={EYEBROW}>On the chain</p>
              <ul className="mt-4 flex flex-col gap-2.5 text-[14px] text-[#18161B]/70">
                <li>
                  <a
                    href={VAULT_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="transition-colors hover:text-[#18161B]"
                  >
                    CardVault
                  </a>
                </li>
                <li>
                  <a
                    href="https://sepolia-explorer.giwa.io/address/0xADA0466303441102cb16F8eC1594C744d603f746"
                    target="_blank"
                    rel="noreferrer"
                    className="transition-colors hover:text-[#18161B]"
                  >
                    gUSD
                  </a>
                </li>
                <li>
                  <a
                    href="https://docs.giwa.io"
                    target="_blank"
                    rel="noreferrer"
                    className="transition-colors hover:text-[#18161B]"
                  >
                    GIWA docs
                  </a>
                </li>
              </ul>
            </div>

            <div>
              <p className={EYEBROW}>Source</p>
              <ul className="mt-4 flex flex-col gap-2.5 text-[14px] text-[#18161B]/70">
                <li>
                  <a
                    href={REPO_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="transition-colors hover:text-[#18161B]"
                  >
                    GitHub
                  </a>
                </li>
                <li>
                  <a
                    href={README_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="transition-colors hover:text-[#18161B]"
                  >
                    Docs
                  </a>
                </li>
              </ul>
            </div>
          </div>
        </div>

        <div className="mt-12 flex flex-col gap-3 border-t border-[#18161B]/10 pt-6 text-[13px] text-[#18161B]/45 sm:flex-row sm:items-center sm:justify-between">
          <p>Testnet only. gUSD is a test token with an open faucet and no value.</p>
          <p>Not affiliated with agentcard.sh.</p>
        </div>
      </div>
    </footer>
  )
}

function Content() {
  return (
    <main className="relative z-[4] bg-[#F4F0ED]">
      <ChatDemoSection />
      <FeaturesSection />
      <InstallSection />
      <ProofSection />
      <ClosingSection />
      <Footer />
    </main>
  )
}

function Nav({
  dark,
  scrolled,
  activeTarget,
  menuOpen,
  onToggleMenu,
  onCloseMenu,
  onNavigate,
}: {
  dark: boolean
  scrolled: boolean
  activeTarget: string
  menuOpen: boolean
  onToggleMenu: () => void
  onCloseMenu: () => void
  onNavigate: (id: string) => void
}) {
  // The mobile panel is near-black, so keep nav chrome white while it is open.
  const d = dark && !menuOpen

  const itemProps = (item: NavItem) =>
    item.href
      ? { href: item.href, target: '_blank', rel: 'noreferrer' as const }
      : {
          href: `#${item.target}`,
          onClick: (e: ReactMouseEvent) => {
            e.preventDefault()
            onNavigate(item.target!)
          },
        }

  const isActive = (item: NavItem) => Boolean(item.target) && item.target === activeTarget

  return (
    <>
      <div
        className={`fixed inset-0 z-[54] bg-black/60 backdrop-blur-sm transition-opacity duration-300 md:hidden ${
          menuOpen ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
        onClick={onCloseMenu}
      />

      <div
        className={`fixed inset-x-0 top-0 z-[55] bg-[#0A0B11]/[0.98] px-5 pb-8 pt-20 transition-transform duration-500 md:hidden ${
          menuOpen ? 'translate-y-0' : '-translate-y-full'
        }`}
        style={{ transitionTimingFunction: STAGGER_EASE }}
      >
        <nav className="flex flex-col">
          {NAV_ITEMS.map((item, i) => (
            <a
              key={item.label}
              {...itemProps(item)}
              className={`py-3 text-lg transition-all duration-400 ${
                isActive(item) ? 'text-white' : 'text-white/70'
              } ${menuOpen ? 'translate-y-0 opacity-100' : 'translate-y-3 opacity-0'}`}
              style={{
                transitionDelay: menuOpen ? `${80 + i * 40}ms` : '0ms',
                transitionTimingFunction: STAGGER_EASE,
              }}
            >
              {item.label}
            </a>
          ))}
          <div
            className={`mt-6 flex items-center gap-3 transition-all duration-400 ${
              menuOpen ? 'translate-y-0 opacity-100' : 'translate-y-3 opacity-0'
            }`}
            style={{
              transitionDelay: menuOpen ? '300ms' : '0ms',
              transitionTimingFunction: STAGGER_EASE,
            }}
          >
            <a
              href={DASHBOARD_URL}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2 rounded-full py-1.5 pr-4 text-sm text-white"
            >
              <span className="flex h-7 w-7 items-center justify-center rounded-full border border-white/20">
                <User size={14} strokeWidth={1.8} />
              </span>
              Account
            </a>
            <button
              onClick={() => onNavigate(SECTION_INSTALL)}
              className="rounded-full bg-white px-5 py-2.5 text-sm font-medium text-gray-900"
            >
              Get Started
            </button>
          </div>
        </nav>
      </div>

      <header
        className={`fixed inset-x-0 top-0 z-[60] flex items-center justify-between px-5 py-4 transition-colors duration-500 sm:px-8 sm:py-5 md:px-10 ${
          scrolled && !menuOpen
            ? 'border-b border-[#18161B]/[0.07] bg-[#F4F0ED]/80 backdrop-blur-md'
            : 'border-b border-transparent'
        }`}
      >
        <div className="flex items-center gap-2.5">
          <svg
            width="24"
            height="24"
            viewBox="0 0 256 256"
            className={`transition-colors duration-500 ${d ? 'fill-[#18161B]' : 'fill-white'}`}
          >
            {LOGO_PATHS.map((path) => (
              <path key={path} d={path} />
            ))}
          </svg>
          <span
            className={`text-sm font-medium uppercase tracking-wide transition-colors duration-500 ${
              d ? 'text-[#18161B]' : 'text-white'
            }`}
          >
            GIWACARD
          </span>
        </div>

        <nav
          className={`absolute left-1/2 top-1/2 hidden -translate-x-1/2 -translate-y-1/2 items-center rounded-full px-1.5 py-1.5 backdrop-blur-md transition-colors duration-500 md:flex ${
            d ? 'bg-[#18161B]/10' : 'bg-white/10'
          }`}
        >
          {NAV_ITEMS.map((item) => (
            <a
              key={item.label}
              {...itemProps(item)}
              className={`rounded-full px-4 py-2 text-sm transition-colors duration-500 ${
                isActive(item)
                  ? d
                    ? 'bg-[#18161B] text-white'
                    : 'bg-white text-gray-900'
                  : d
                    ? 'text-[#18161B]/70 hover:text-[#18161B]'
                    : 'text-white/70 hover:text-white'
              }`}
            >
              {item.label}
            </a>
          ))}
        </nav>

        <div className="hidden items-center gap-3 md:flex">
          <a
            href={DASHBOARD_URL}
            target="_blank"
            rel="noreferrer"
            className={`flex items-center gap-2 rounded-full py-1.5 pr-4 text-sm transition-colors duration-500 ${
              d ? 'text-[#18161B]' : 'text-white'
            }`}
          >
            <span
              className={`flex h-7 w-7 items-center justify-center rounded-full border transition-colors duration-500 ${
                d ? 'border-[#18161B]/20' : 'border-white/20'
              }`}
            >
              <User size={14} strokeWidth={1.8} />
            </span>
            Account
          </a>
          <button
            onClick={() => onNavigate(SECTION_INSTALL)}
            className={`rounded-full px-5 py-2.5 text-sm font-medium transition-colors duration-500 ${
              d ? 'bg-[#18161B] text-white' : 'bg-white text-gray-900'
            }`}
          >
            Get Started
          </button>
        </div>

        <button
          className={`relative flex h-10 w-10 items-center justify-center transition-colors duration-500 md:hidden ${
            d ? 'text-[#18161B]' : 'text-white'
          }`}
          onClick={onToggleMenu}
          aria-label="Toggle menu"
        >
          <Menu
            size={22}
            className={`absolute transition-all duration-300 ${
              menuOpen ? 'rotate-90 opacity-0' : 'rotate-0 opacity-100'
            }`}
          />
          <X
            size={22}
            className={`absolute transition-all duration-300 ${
              menuOpen ? 'rotate-0 opacity-100' : '-rotate-90 opacity-0'
            }`}
          />
        </button>
      </header>
    </>
  )
}

export default function App() {
  const [videoPhase, setVideoPhase] = useState<VideoPhase>('idle')
  const [sectionVisible, setSectionVisible] = useState(false)
  const [imagesVisible, setImagesVisible] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  const [activeTarget, setActiveTarget] = useState(SECTION_FEATURES)
  const videoRef = useRef<HTMLVideoElement>(null)
  const pendingScroll = useRef<string | null>(null)

  // `done` is also the unlocked state: the content below the intro only exists
  // then, so while the intro is playing the document is exactly one viewport
  // tall and cannot scroll at all.
  const unlocked = videoPhase === 'done'

  const startVideo = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    setVideoPhase('playing')
    setSectionVisible(false)
    setImagesVisible(false)
    video.currentTime = 0
    void video.play().catch(() => {})
  }, [])

  const resetToHero = useCallback(() => {
    const video = videoRef.current
    setVideoPhase('idle')
    setSectionVisible(false)
    setImagesVisible(false)
    if (video) {
      video.pause()
      video.currentTime = 0
    }
  }, [])

  /** Jump past the cinematic intro without playing it (nav clicks). */
  const releaseLock = useCallback(() => {
    const video = videoRef.current
    if (video) {
      video.pause()
      video.currentTime = 0
    }
    setVideoPhase('done')
    setSectionVisible(true)
    setImagesVisible(true)
  }, [])

  const goToSection = useCallback(
    (id: string) => {
      setMenuOpen(false)
      if (videoPhase === 'done') {
        // Defer a frame so a closing mobile menu settles before the scroll.
        requestAnimationFrame(() => scrollToSection(id))
        return
      }
      pendingScroll.current = id
      releaseLock()
    },
    [videoPhase, releaseLock],
  )

  // Scroll requested while the intro was still locked: the target only mounts
  // once `done` renders, so run it on the next frame after that commit.
  useEffect(() => {
    if (!unlocked || !pendingScroll.current) return
    const id = pendingScroll.current
    pendingScroll.current = null
    const raf = requestAnimationFrame(() => scrollToSection(id))
    return () => cancelAnimationFrame(raf)
  }, [unlocked])

  useEffect(() => {
    document.body.style.overflow = menuOpen ? 'hidden' : ''
    return () => {
      document.body.style.overflow = ''
    }
  }, [menuOpen])

  // Nav chrome + active item follow the document scroll once unlocked.
  useEffect(() => {
    if (!unlocked) {
      setScrolled(false)
      setActiveTarget(SECTION_FEATURES)
      return
    }
    let raf = 0
    const update = () => {
      raf = 0
      setScrolled(window.scrollY > 8)
      const install = document.getElementById(SECTION_INSTALL)
      const top = install ? install.getBoundingClientRect().top : Infinity
      setActiveTarget(top <= 240 ? SECTION_INSTALL : SECTION_FEATURES)
    }
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update)
    }
    update()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [unlocked])

  useEffect(() => {
    // Upward intent accumulated while the document is pinned at the top.
    let upAccum = 0
    let leftTopAt = 0

    const onWheel = (e: WheelEvent) => {
      if (videoPhase === 'idle') {
        if (e.deltaY > 0) startVideo()
        return
      }
      if (videoPhase !== 'done') return
      if (e.deltaY >= 0) {
        upAccum = 0
        return
      }
      if (window.scrollY > TOP_EPSILON) {
        upAccum = 0
        leftTopAt = performance.now()
        return
      }
      // Let momentum from the scroll that brought us here die out first.
      if (performance.now() - leftTopAt < TOP_SETTLE_MS) return
      upAccum += -e.deltaY
      if (upAccum >= UP_RELEASE) {
        upAccum = 0
        resetToHero()
      }
    }

    let touchStartY = 0
    let touchStartScroll = 0
    const onTouchStart = (e: TouchEvent) => {
      touchStartY = e.touches[0].clientY
      touchStartScroll = window.scrollY
    }
    const onTouchEnd = (e: TouchEvent) => {
      // Positive delta = swipe up (finger moved toward the top of the screen).
      const delta = touchStartY - e.changedTouches[0].clientY
      if (delta > SWIPE_THRESHOLD && videoPhase === 'idle') startVideo()
      else if (
        delta < -SWIPE_THRESHOLD &&
        videoPhase === 'done' &&
        touchStartScroll <= TOP_EPSILON &&
        window.scrollY <= TOP_EPSILON
      )
        resetToHero()
    }

    window.addEventListener('wheel', onWheel, { passive: true })
    window.addEventListener('touchstart', onTouchStart, { passive: true })
    window.addEventListener('touchend', onTouchEnd, { passive: true })
    return () => {
      window.removeEventListener('wheel', onWheel)
      window.removeEventListener('touchstart', onTouchStart)
      window.removeEventListener('touchend', onTouchEnd)
    }
  }, [videoPhase, startVideo, resetToHero])

  const navDark = videoPhase === 'done' || sectionVisible

  return (
    <div className="relative min-h-screen overflow-x-clip bg-[#F4F0ED]">
      <div className="relative h-screen overflow-hidden">
        <CardSection visible={sectionVisible} imagesVisible={imagesVisible} />

        <video
          ref={videoRef}
          src={VIDEO_SRC}
          muted
          playsInline
          preload="auto"
          onTimeUpdate={(e) => {
            if (videoPhase === 'playing' && e.currentTarget.currentTime >= 2) {
              setSectionVisible(true)
            }
          }}
          onEnded={() => {
            setVideoPhase('done')
            setImagesVisible(true)
          }}
          className={`pointer-events-none fixed inset-0 z-[2] h-full w-full object-cover transition-opacity duration-500 ${
            videoPhase === 'playing' ? 'opacity-100' : 'opacity-0'
          }`}
        />

        <div
          className={`absolute inset-0 z-[3] transition-opacity duration-700 ${
            videoPhase !== 'idle' ? 'pointer-events-none opacity-0' : 'opacity-100'
          }`}
        >
          <HeroSection onSeeHow={startVideo} />
        </div>
      </div>

      {unlocked && <Content />}

      <Nav
        dark={navDark}
        scrolled={scrolled}
        activeTarget={activeTarget}
        menuOpen={menuOpen}
        onToggleMenu={() => setMenuOpen((v) => !v)}
        onCloseMenu={() => setMenuOpen(false)}
        onNavigate={goToSection}
      />
    </div>
  )
}
