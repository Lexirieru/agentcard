import { describe, expect, test } from 'bun:test'

import {
  BANNER_GRADIENT,
  bannerText,
  renderBanner,
  renderFigletWordmark,
  renderPlainBanner,
} from './banner.js'
import {
  ASSUMED_COLUMNS,
  detectCapabilities,
  hasAnsi,
  MIN_RICH_COLUMNS,
  noColorRequested,
  stripAnsi,
} from './theme.js'

/**
 * KTD-13's fallback rule is a testable requirement, not a nicety: plain,
 * uncoloured text when `NO_COLOR` is set, when stdout is not a TTY, or when the
 * terminal is under 60 columns. Each of the three gets its own test, plus one
 * that proves the decorated form does appear when none of them apply — a
 * fallback that fires unconditionally would pass the first three tests and be
 * useless.
 */

const RICH_STREAM = { isTTY: true, columns: 120 }

function noColorEnv(): Record<string, string | undefined> {
  return { NO_COLOR: '1' }
}

describe('capability detection', () => {
  test('is rich on a wide colour TTY', () => {
    const capabilities = detectCapabilities({ stream: RICH_STREAM, env: {} })
    expect(capabilities.rich).toBe(true)
    expect(capabilities.color).toBe(true)
    expect(capabilities.tty).toBe(true)
    expect(capabilities.reasons).toEqual([])
  })

  test('NO_COLOR forces plain', () => {
    const capabilities = detectCapabilities({
      stream: RICH_STREAM,
      env: noColorEnv(),
    })
    expect(capabilities.rich).toBe(false)
    expect(capabilities.color).toBe(false)
    expect(capabilities.reasons).toContain('no-color')
  })

  test('an empty NO_COLOR is not "set" (no-color.org)', () => {
    expect(noColorRequested({ NO_COLOR: '' })).toBe(false)
    expect(noColorRequested({})).toBe(false)
    expect(noColorRequested({ NO_COLOR: '0' })).toBe(true)
  })

  test('a non-TTY forces plain', () => {
    const capabilities = detectCapabilities({
      stream: { isTTY: false, columns: 200 },
      env: {},
    })
    expect(capabilities.rich).toBe(false)
    expect(capabilities.reasons).toContain('not-a-tty')
  })

  test('under 60 columns forces plain', () => {
    const capabilities = detectCapabilities({
      stream: { isTTY: true, columns: MIN_RICH_COLUMNS - 1 },
      env: {},
    })
    expect(capabilities.rich).toBe(false)
    expect(capabilities.reasons).toContain('too-narrow')
  })

  test('exactly 60 columns is not too narrow', () => {
    const capabilities = detectCapabilities({
      stream: { isTTY: true, columns: MIN_RICH_COLUMNS },
      env: {},
    })
    expect(capabilities.reasons).not.toContain('too-narrow')
  })

  test('a stream with no columns assumes a sane default', () => {
    const capabilities = detectCapabilities({ stream: { isTTY: true }, env: {} })
    expect(capabilities.columns).toBe(ASSUMED_COLUMNS)
  })
})

describe('banner fallback (KTD-13)', () => {
  test('falls back to plain uncoloured text when NO_COLOR is set', () => {
    const rendering = renderBanner({
      stream: RICH_STREAM,
      env: noColorEnv(),
      version: '9.9.9',
    })
    expect(rendering.decorated).toBe(false)
    expect(hasAnsi(rendering.text)).toBe(false)
    expect(rendering.text).toBe(renderPlainBanner('9.9.9'))
  })

  test('falls back to plain uncoloured text when stdout is not a TTY', () => {
    const rendering = renderBanner({
      stream: { isTTY: false, columns: 200 },
      env: {},
      version: '9.9.9',
    })
    expect(rendering.decorated).toBe(false)
    expect(hasAnsi(rendering.text)).toBe(false)
  })

  test('falls back to plain uncoloured text below 60 columns', () => {
    const rendering = renderBanner({
      stream: { isTTY: true, columns: 40 },
      env: {},
      version: '9.9.9',
    })
    expect(rendering.decorated).toBe(false)
    expect(hasAnsi(rendering.text)).toBe(false)
  })

  test('the plain banner still carries the version and the chain', () => {
    const text = renderPlainBanner('1.2.3')
    expect(text).toContain('GIWACARD')
    expect(text).toContain('1.2.3')
    expect(text).toContain('91342')
    expect(hasAnsi(text)).toBe(false)
  })

  test('uses figlet + the fixed gradient on a wide colour TTY', () => {
    const rendering = renderBanner({ stream: RICH_STREAM, env: {}, version: '1.0.0' })
    expect(rendering.decorated).toBe(true)
    // If this ever stops being coloured the fallback tests above become
    // vacuous, so the positive case is asserted too.
    expect(hasAnsi(rendering.text)).toBe(true)
    expect(stripAnsi(rendering.text)).toContain('1.0.0')
  })

  test('the gradient is exactly two fixed stops', () => {
    expect(BANNER_GRADIENT).toHaveLength(2)
    expect(BANNER_GRADIENT[0]).toMatch(/^#[0-9a-fA-F]{6}$/)
    expect(BANNER_GRADIENT[1]).toMatch(/^#[0-9a-fA-F]{6}$/)
  })

  test('the ANSI Shadow wordmark renders', () => {
    const wordmark = renderFigletWordmark()
    expect(wordmark).not.toBeNull()
    expect((wordmark as string).split('\n').length).toBeGreaterThan(3)
  })

  test('a 60-61 column window still avoids a wrapped wordmark', () => {
    // The stated gate passes at 60, but ANSI Shadow's "GIWACARD" is wider than
    // that, so the width guard has to catch it.
    const rendering = renderBanner({
      stream: { isTTY: true, columns: 60 },
      env: {},
    })
    expect(rendering.decorated).toBe(false)
  })

  test('bannerText strips any escape that survives the plain path', () => {
    const text = bannerText({ stream: { isTTY: false }, env: {} })
    expect(hasAnsi(text)).toBe(false)
  })
})
