# landingpage

React 18 + Vite + Tailwind 3. A scroll-locked, two-scene page.

```bash
bun run build      # tsc + vite
bun run dev
```

## Read this before editing

**The copy is GiwaCard's, the visual machinery is inherited.** The page was
originally built to an external "Infinite / Portale" credit-card spec; the copy has
since been rewritten for this product, but the scroll machine, the spotlight, the
remote imagery and the video are all still that original build. If something reads
oddly, check whether it is copy (ours, change freely) or mechanics (recreated to a
spec, change deliberately).

**What it *is* load-bearing for:** the dashboard's visual language is derived
from here (KTD-18) — the `#F4F0ED` canvas, `#18161B` ink, `#0A0B11` night, the
Geist type, rounded-full controls, backdrop-blurred pills, and the
`fadeSlideUp` / `fadeIn` keyframes with `cubic-bezier(0.16, 1, 0.3, 1)`. Those
values are mirrored in `frontend/src/app/globals.css` and
`frontend/src/components/ui/`. Change them here and the two surfaces drift apart.

## How the page works

One full-viewport canvas, `h-screen overflow-hidden`. There is **no document
scroll** — a wheel/touch state machine moves through `idle → playing → done`:
hero, then a full-bleed transition video, then the card scene. Scrolling back is
only possible from `done`.

Both scenes use a spotlight reveal: a hidden canvas paints a radial-gradient mask
at a cursor position smoothed on `requestAnimationFrame` (`smooth += (mouse -
smooth) * 0.1`, radius 260), applied as a CSS `mask-image` over a second
full-bleed image. The hero additionally drifts its SVG grid ±16px against the
cursor.

## Things that will bite you

**Assets are remote and hardcoded** — Higgs CDN images and a CloudFront MP4.
There is no local fallback; offline, the page renders empty scenes.

**The local font is intentionally absent.** `@font-face` points at
`/fonts/HelveticaNeue-Roman.woff2`, which is not in the repo, so the hero falls
back through the stack. The console warning is expected, not a bug.

**Nav colour is driven by video phase**, not by scroll position — `navDark` is
`videoPhase === 'done' || sectionVisible`.
