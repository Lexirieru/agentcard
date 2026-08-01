import figlet from 'figlet'
import gradient from 'gradient-string'

import { GIWA_SEPOLIA_ID, giwaSepolia } from '../chain/giwaSepolia.js'
import { VERSION } from '../version.js'
import {
  detectCapabilities,
  hasAnsi,
  MIN_RICH_COLUMNS,
  stripAnsi,
  type DetectCapabilitiesOptions,
  type TerminalCapabilities,
} from './theme.js'

/**
 * The product's identity in the terminal (KTD-13).
 *
 * Two renderings, one contract. The decorated one is figlet's `ANSI Shadow`
 * wordmark under a **fixed** two-colour gradient — fixed because a banner whose
 * colours drift run to run is not a wordmark, it is noise. The plain one is
 * three lines of uncoloured ASCII carrying exactly the same facts.
 *
 * The plain rendering is mandatory, not a nicety: `NO_COLOR`, a non-TTY stdout,
 * or a window under {@link MIN_RICH_COLUMNS} columns each force it on their own
 * (see `./theme.ts`). A fourth, narrower guard lives here — if the rendered
 * wordmark is wider than the window even though the window cleared 60 columns,
 * the plain form wins too, because a wrapped figlet banner is strictly worse
 * than no banner. That guard can only ever *add* plain renderings, so it cannot
 * weaken the three required gates.
 */

/** The word rendered in figlet. Uppercase: `ANSI Shadow` has no lowercase. */
export const BANNER_WORD = 'GIWACARD' as const

/** figlet font. Named in KTD-13 and not configurable. */
export const BANNER_FONT = 'ANSI Shadow' as const

/**
 * The fixed two-colour gradient, cyan → violet.
 *
 * Two stops, both hard-coded. `gradient-string` accepts any number of stops;
 * taking exactly two is what makes the wordmark reproducible.
 */
export const BANNER_GRADIENT: readonly [string, string] = ['#22D3EE', '#8B5CF6']

/** One-line description printed under the wordmark in both renderings. */
export const BANNER_TAGLINE =
  'Agent-native virtual cards, with a human in the loop.'

export interface RenderBannerOptions extends DetectCapabilitiesOptions {
  /** Pre-computed capabilities. Skips detection entirely. */
  capabilities?: TerminalCapabilities
  /** Override the version string. Tests pin this so output is stable. */
  version?: string
}

/** A rendered banner plus the decision that produced it. */
export interface BannerRendering {
  text: string
  /** True when the figlet + gradient form was used. */
  decorated: boolean
  capabilities: TerminalCapabilities
}

/**
 * The subtitle lines, identical in both renderings.
 *
 * Kept as data rather than a template so the plain and decorated paths cannot
 * drift into telling the user different things about which chain they are on.
 */
function subtitleLines(version: string): string[] {
  return [
    `giwacard v${version}  ·  ${giwaSepolia.name} (chain ${GIWA_SEPOLIA_ID})`,
    BANNER_TAGLINE,
  ]
}

/**
 * The plain rendering: no escapes, no box drawing, no figlet.
 *
 * Exported on its own because the fallback is a testable requirement, not an
 * internal detail — a test asserts this exact function's output contains no
 * ANSI at all.
 */
export function renderPlainBanner(version: string = VERSION): string {
  return ['GIWACARD', ...subtitleLines(version)].join('\n')
}

/**
 * The decorated rendering, or `null` when figlet cannot produce the wordmark.
 *
 * Returns `null` rather than throwing: a missing font file in some exotic
 * install is a reason to show the plain banner, never a reason for `npx
 * giwacard` to crash before it has printed anything at all.
 */
export function renderFigletWordmark(): string | null {
  try {
    const art = figlet.textSync(BANNER_WORD, { font: BANNER_FONT })
    return art.replace(/\s+$/, '')
  } catch {
    return null
  }
}

/** Width of the widest line in a block of text. */
function blockWidth(text: string): number {
  return text
    .split('\n')
    .reduce((widest, line) => Math.max(widest, line.length), 0)
}

const ESC = String.fromCharCode(27)

/** Parse `#rrggbb` into its three components. */
function parseHex(colour: string): [number, number, number] {
  const value = Number.parseInt(colour.replace('#', ''), 16)
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
}

/**
 * Paint the wordmark with a two-stop truecolor gradient, ourselves.
 *
 * `gradient-string` colours through `chalk`, and chalk decides for itself
 * whether the environment supports colour — by sniffing `process.stdout`, `CI`,
 * `TERM` and friends. That decision is not ours to inherit: `./theme.ts` has
 * already made it, from the three gates KTD-13 specifies, against the stream the
 * output is actually going to. When chalk overrules us and returns bare text,
 * this is what puts the gradient back.
 *
 * The interpolation is linear in RGB across the *column* index, so every line of
 * the wordmark shares one horizontal ramp — which is what makes it read as a
 * single logo rather than six independently-shaded rows.
 */
function paintGradient(text: string): string {
  const [fromR, fromG, fromB] = parseHex(BANNER_GRADIENT[0])
  const [toR, toG, toB] = parseHex(BANNER_GRADIENT[1])
  const width = Math.max(1, blockWidth(text) - 1)

  return text
    .split('\n')
    .map((line) =>
      [...line]
        .map((character, column) => {
          if (character === ' ') return character
          const ratio = Math.min(1, column / width)
          const r = Math.round(fromR + (toR - fromR) * ratio)
          const g = Math.round(fromG + (toG - fromG) * ratio)
          const b = Math.round(fromB + (toB - fromB) * ratio)
          return `${ESC}[38;2;${r};${g};${b}m${character}`
        })
        .join('') + `${ESC}[39m`,
    )
    .join('\n')
}

/**
 * Render the banner for a given terminal.
 *
 * @param options.capabilities Pre-detected capabilities; otherwise detected from
 * `options.stream` / `options.env`.
 * @returns The text to print and whether it was decorated.
 */
export function renderBanner(
  options: RenderBannerOptions = {},
): BannerRendering {
  const capabilities = options.capabilities ?? detectCapabilities(options)
  const version = options.version ?? VERSION
  const plain = { text: renderPlainBanner(version), decorated: false, capabilities }

  if (!capabilities.rich) return plain

  const wordmark = renderFigletWordmark()
  if (wordmark === null) return plain
  // The 60-column gate above is the *stated* requirement; this one catches the
  // 60/61-column window where the gate passes but the 62-column wordmark would
  // still wrap.
  if (blockWidth(wordmark) > capabilities.columns) return plain

  let painted: string
  try {
    painted = gradient(BANNER_GRADIENT as unknown as string[]).multiline(wordmark)
  } catch {
    return plain
  }
  // chalk, underneath gradient-string, may have decided this environment has no
  // colour. Our own three gates already said otherwise, and they looked at the
  // right stream. See `paintGradient`.
  if (!hasAnsi(painted)) painted = paintGradient(wordmark)

  return {
    text: [painted, ...subtitleLines(version)].join('\n'),
    decorated: true,
    capabilities,
  }
}

/**
 * Render the banner and guarantee the plain form really is plain.
 *
 * The extra {@link stripAnsi} pass is not redundant defensiveness: it is the
 * enforcement point. Every decoration in this CLI is produced by a third-party
 * renderer that colours some output on its own schedule, and this is the last
 * place a stray escape can be caught before it reaches a `NO_COLOR` user's pipe.
 */
export function bannerText(options: RenderBannerOptions = {}): string {
  const rendering = renderBanner(options)
  if (rendering.decorated) return rendering.text
  return hasAnsi(rendering.text) ? stripAnsi(rendering.text) : rendering.text
}
