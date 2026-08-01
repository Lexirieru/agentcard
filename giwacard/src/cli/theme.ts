/**
 * Terminal capability detection — the single gate behind every decorated byte
 * the CLI writes (KTD-13).
 *
 * There are exactly three conditions under which giwacard must degrade to plain,
 * uncoloured text, and they are checked in one place so that "decorated" and
 * "plain" can never disagree between the banner, the panels and the tables:
 *
 * 1. **`NO_COLOR` is set.** The https://no-color.org convention: present and
 *    non-empty means the user has asked every program on their machine not to
 *    emit colour. Honouring it is not optional.
 * 2. **stdout is not a TTY.** A pipe, a file, or a CI log. ANSI escapes there are
 *    not decoration, they are corruption of someone's `grep`.
 * 3. **The terminal is narrower than 60 columns.** A 62-column figlet banner in a
 *    50-column window is not a banner, it is six lines of wrapped noise.
 *
 * All three are `OR`-ed: any one of them turns everything plain.
 */

/** Below this many columns the decorated surface is never used. */
export const MIN_RICH_COLUMNS = 60

/** Assumed width when a stream reports no `columns` (pipes, most CI). */
export const ASSUMED_COLUMNS = 80

/** A stdout-ish stream, reduced to the two properties detection reads. */
export interface CapabilityStream {
  isTTY?: boolean | undefined
  columns?: number | undefined
}

export interface DetectCapabilitiesOptions {
  /** The stream the output will go to. Defaults to `process.stdout`. */
  stream?: CapabilityStream
  /** Environment to read `NO_COLOR` from. Defaults to `process.env`. */
  env?: Record<string, string | undefined>
  /** Force a column count, ignoring the stream. Used by tests. */
  columns?: number
}

/** What the renderer is allowed to do, and why. */
export interface TerminalCapabilities {
  /** True when ANSI colour may be emitted. */
  color: boolean
  /** True when the destination is an interactive terminal. */
  tty: boolean
  /** Effective width in columns. */
  columns: number
  /**
   * True only when all three KTD-13 gates pass. The one flag callers branch on.
   */
  rich: boolean
  /** Which gates failed, in the order this module checks them. Never `null`. */
  reasons: readonly PlainReason[]
}

/** Why the plain surface was chosen. Surfaced in tests and `--help` output. */
export type PlainReason = 'no-color' | 'not-a-tty' | 'too-narrow'

/**
 * Whether `NO_COLOR` is in force.
 *
 * Follows no-color.org: the variable must be present *and* non-empty. An empty
 * `NO_COLOR=` is how a user un-sets it for one command in POSIX shells, so
 * treating that as "no colour" would make the escape hatch impossible to use.
 */
export function noColorRequested(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env['NO_COLOR']
  return raw !== undefined && raw !== ''
}

/**
 * Decide what this terminal can be shown.
 *
 * @param options.stream The destination stream; defaults to `process.stdout`.
 * @param options.env Environment to read; defaults to `process.env`.
 * @returns The capability set, with `rich` already reduced from all three gates.
 */
export function detectCapabilities(
  options: DetectCapabilitiesOptions = {},
): TerminalCapabilities {
  const stream = options.stream ?? (process.stdout as CapabilityStream)
  const env = options.env ?? process.env
  const tty = stream.isTTY === true
  const columns =
    options.columns ??
    (typeof stream.columns === 'number' && stream.columns > 0
      ? stream.columns
      : ASSUMED_COLUMNS)

  const reasons: PlainReason[] = []
  if (noColorRequested(env)) reasons.push('no-color')
  if (!tty) reasons.push('not-a-tty')
  if (columns < MIN_RICH_COLUMNS) reasons.push('too-narrow')

  return {
    color: reasons.length === 0,
    tty,
    columns,
    rich: reasons.length === 0,
    reasons,
  }
}

/** Capabilities with every gate failed. The safe default in tests and pipes. */
export const PLAIN_CAPABILITIES: TerminalCapabilities = {
  color: false,
  tty: false,
  columns: ASSUMED_COLUMNS,
  rich: false,
  reasons: ['not-a-tty'],
}

/**
 * Strip every ANSI escape sequence from a string.
 *
 * Used as a belt-and-braces pass over anything a third-party renderer produced
 * while the plain surface is in force: `boxen` and `cli-table3` both colour some
 * output unconditionally, and one stray escape would defeat the whole gate.
 */
const ANSI_SOURCE =
  '\\u001B(?:\\[[0-9;?]*[ -/]*[@-~]|\\][^\\u0007\\u001B]*(?:\\u0007|\\u001B\\\\))'

/** Remove ANSI escapes. Idempotent. */
export function stripAnsi(text: string): string {
  return text.replace(new RegExp(ANSI_SOURCE, 'gu'), '')
}

/** Whether a string contains any ANSI escape sequence. */
export function hasAnsi(text: string): boolean {
  return new RegExp(ANSI_SOURCE, 'u').test(text)
}
