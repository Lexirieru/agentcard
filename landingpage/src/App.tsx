import { useCallback, useEffect, useRef, useState } from 'react'
import { Menu, Play, Plus, User, X } from 'lucide-react'

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

const NAV_ITEMS = ['Product', 'Agents', 'Contracts', 'Docs', 'GitHub']

/** Deployed and verified on GIWA Sepolia — see smartcontracts/deployments. */
const VAULT_URL =
  'https://sepolia-explorer.giwa.io/address/0xD89395Df78aaFdF86b330899d1C6189211e88750'
const REPO_URL = 'https://github.com/Lexirieru/agentcard'

const LOGO_PATHS = [
  'M 128 192 L 128 256 L 64.5 256 L 32 223 L 0 192 L 0 128 L 64 128 Z',
  'M 256 192 L 256 256 L 192.5 256 L 160 223 L 128 192 L 128 128 L 192 128 Z',
  'M 128 64 L 128 128 L 64.5 128 L 32 95 L 0 64 L 0 0 L 64 0 Z',
  'M 256 64 L 256 128 L 192.5 128 L 160 95 L 128 64 L 128 0 L 192 0 Z',
]

const STAGGER_EASE = 'cubic-bezier(0.16, 1, 0.3, 1)'

type VideoPhase = 'idle' | 'playing' | 'done'

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
              Live on GIWA Sepolia · contracts verified
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
            An AI agent handed a wallet loses it to one prompt injection. GiwaCard gives
            it a single-use card instead — a cap, one merchant, an expiry, all enforced by
            the contract. Anything past those limits stops and waits for you.
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
          Spend Once
        </h2>
        <div
          className={staggerClass(
            'flex shrink-0 items-center gap-1.5 rounded-full border border-[#18161B]/15 bg-[#18161B]/10 px-4 py-2 text-sm text-[#18161B]/80',
          )}
          style={{ animationDelay: '0.3s' }}
        >
          <Plus size={15} />
          One-time authorization
        </div>
      </div>

      <div className="absolute inset-x-0 bottom-0 flex flex-col gap-8 px-5 pb-10 sm:px-10 sm:pb-14 md:flex-row md:items-end md:justify-between md:px-14 md:pb-16">
        <div className={staggerClass('max-w-md')} style={{ animationDelay: '0.7s' }}>
          <p className="text-[15px] leading-relaxed text-[#18161B]/75 sm:text-base">
            The cap is escrowed at mint, so a card can never spend more than it was given.
            The merchant charges it once, the card dies, and whatever went unspent is
            yours again immediately. Nothing here is enforced by a prompt.
          </p>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="mt-6 inline-block rounded-full bg-[#18161B] px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-[#18161B]/90"
          >
            Get started
          </a>
        </div>
        <h2
          className={staggerClass('font-light text-[#18161B] md:text-right')}
          style={{ ...h2Style, animationDelay: '0.5s' }}
        >
          Then It Is Dead
        </h2>
      </div>
    </section>
  )
}

function Nav({
  dark,
  menuOpen,
  onToggleMenu,
  onCloseMenu,
}: {
  dark: boolean
  menuOpen: boolean
  onToggleMenu: () => void
  onCloseMenu: () => void
}) {
  // The mobile panel is near-black, so keep nav chrome white while it is open.
  const d = dark && !menuOpen

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
              key={item}
              href="#"
              onClick={(e) => e.preventDefault()}
              className={`py-3 text-lg transition-all duration-400 ${
                item === 'Product' ? 'text-white' : 'text-white/70'
              } ${menuOpen ? 'translate-y-0 opacity-100' : 'translate-y-3 opacity-0'}`}
              style={{
                transitionDelay: menuOpen ? `${80 + i * 40}ms` : '0ms',
                transitionTimingFunction: STAGGER_EASE,
              }}
            >
              {item}
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
            <button className="flex items-center gap-2 rounded-full py-1.5 pr-4 text-sm text-white">
              <span className="flex h-7 w-7 items-center justify-center rounded-full border border-white/20">
                <User size={14} strokeWidth={1.8} />
              </span>
              Account
            </button>
            <button className="rounded-full bg-white px-5 py-2.5 text-sm font-medium text-gray-900">
              Get Started
            </button>
          </div>
        </nav>
      </div>

      <header className="fixed inset-x-0 top-0 z-[60] flex items-center justify-between px-5 py-4 sm:px-8 sm:py-5 md:px-10">
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
              key={item}
              href="#"
              onClick={(e) => e.preventDefault()}
              className={`rounded-full px-4 py-2 text-sm transition-colors duration-500 ${
                item === 'Product'
                  ? d
                    ? 'bg-[#18161B] text-white'
                    : 'bg-white text-gray-900'
                  : d
                    ? 'text-[#18161B]/70 hover:text-[#18161B]'
                    : 'text-white/70 hover:text-white'
              }`}
            >
              {item}
            </a>
          ))}
        </nav>

        <div className="hidden items-center gap-3 md:flex">
          <button
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
          </button>
          <button
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
  const videoRef = useRef<HTMLVideoElement>(null)

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

  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY > 0 && videoPhase === 'idle') startVideo()
      else if (e.deltaY < 0 && videoPhase === 'done') resetToHero()
    }

    let touchStartY = 0
    const onTouchStart = (e: TouchEvent) => {
      touchStartY = e.touches[0].clientY
    }
    const onTouchEnd = (e: TouchEvent) => {
      // Positive delta = swipe up (finger moved toward the top of the screen).
      const delta = touchStartY - e.changedTouches[0].clientY
      if (delta > SWIPE_THRESHOLD && videoPhase === 'idle') startVideo()
      else if (delta < -SWIPE_THRESHOLD && videoPhase === 'done') resetToHero()
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
    <div className="relative h-screen overflow-hidden bg-[#F4F0ED]">
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

      <Nav
        dark={navDark}
        menuOpen={menuOpen}
        onToggleMenu={() => setMenuOpen((v) => !v)}
        onCloseMenu={() => setMenuOpen(false)}
      />
    </div>
  )
}
