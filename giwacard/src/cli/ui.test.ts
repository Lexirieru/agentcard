import { describe, expect, test } from 'bun:test'

import { formatDuration, formatEth, formatTimestamp, formatUnits } from './errors.js'
import { detectCapabilities, hasAnsi, type TerminalCapabilities } from './theme.js'
import { alignRows, renderPanel, renderTable } from './ui.js'
import { RecordingOutput } from './testing.js'

/**
 * The plain surface is where a piped `giwacard status` ends up, so it is the one
 * that has to be readable *and* free of escapes. Both are asserted; asserting
 * only "no escapes" would pass on an empty string.
 */

const RICH: TerminalCapabilities = detectCapabilities({
  stream: { isTTY: true, columns: 120 },
  env: {},
})
const PLAIN: TerminalCapabilities = detectCapabilities({
  stream: { isTTY: false },
  env: {},
})

describe('panels', () => {
  test('the plain panel is uncoloured and keeps the title and body', () => {
    const text = renderPanel('Vault', 'balance 10\nescrowed 2', PLAIN)
    expect(hasAnsi(text)).toBe(false)
    expect(text).toContain('== Vault ==')
    expect(text).toContain('balance 10')
    expect(text).toContain('escrowed 2')
  })

  test('the rich panel draws a box', () => {
    const text = renderPanel('Vault', 'balance 10', RICH)
    expect(text).toContain('Vault')
    expect(text).toContain('balance 10')
    // boxen draws a border; the plain form deliberately does not.
    expect(text.split('\n').length).toBeGreaterThan(2)
  })

  test('rows are aligned on their labels', () => {
    const text = alignRows([
      { label: 'Owner', value: '0xabc' },
      { label: 'Vault', value: '0xdef' },
      { label: 'Available', value: '10' },
    ])
    const lines = text.split('\n')
    // Every value starts in the same column.
    const columns = lines.map((line) => line.indexOf('0x') >= 0 ? line.indexOf('0x') : line.lastIndexOf('10'))
    expect(new Set(columns).size).toBe(1)
  })
})

describe('tables', () => {
  const spec = {
    head: ['id', 'cap', 'merchant'],
    rows: [
      ['1', '10 gUSD', '0xaaa'],
      ['22', '5 gUSD', '0xbbb'],
    ],
    empty: 'No active cards.',
  }

  test('the plain table is a padded grid with no escapes', () => {
    const text = renderTable(spec, PLAIN)
    expect(hasAnsi(text)).toBe(false)
    const lines = text.split('\n')
    expect(lines[0]).toContain('id')
    expect(lines[1]).toMatch(/^-+ {2}-+ {2}-+$/)
    expect(lines).toHaveLength(4)
    expect(text).toContain('0xbbb')
  })

  test('an empty table renders its empty text, never a bare grid', () => {
    expect(renderTable({ ...spec, rows: [] }, PLAIN)).toBe('No active cards.')
    expect(renderTable({ ...spec, rows: [] }, RICH)).toBe('No active cards.')
  })

  test('a table with no empty text still says something', () => {
    expect(renderTable({ head: ['a'], rows: [] }, PLAIN)).toBe('(nothing to show)')
  })

  test('the rich table is drawn by cli-table3', () => {
    const text = renderTable(spec, RICH)
    expect(text).toContain('0xbbb')
    expect(text.split('\n').length).toBeGreaterThan(4)
  })
})

describe('the output surface', () => {
  test('strips any escape that reaches it while plain', () => {
    const output = new RecordingOutput()
    const esc = String.fromCharCode(27)
    output.line(`${esc}[31mred${esc}[39m`)
    expect(output.stdout).toBe('red\n')
  })

  test('an empty state always writes a sentence', () => {
    const output = new RecordingOutput()
    output.emptyState('No active cards.', 'Your agent mints one.')
    expect(output.stdout).toContain('No active cards.')
    expect(output.stdout).toContain('Your agent mints one.')
  })
})

describe('formatting', () => {
  test('formatUnits renders gUSD base units', () => {
    expect(formatUnits(10_000_000n, 6)).toBe('10')
    expect(formatUnits(7_500_000n, 6)).toBe('7.5')
    expect(formatUnits(1n, 6)).toBe('0.000001')
    expect(formatUnits(0n, 6)).toBe('0')
  })

  test('formatEth renders wei without exponent notation', () => {
    expect(formatEth(10n ** 18n)).toBe('1')
    expect(formatEth(5n * 10n ** 15n)).toBe('0.005')
    expect(formatEth(0n)).toBe('0')
  })

  test('formatDuration reads like a person would say it', () => {
    expect(formatDuration(0n)).toBe('now')
    expect(formatDuration(45n)).toBe('45s')
    expect(formatDuration(90n)).toBe('1m 30s')
    expect(formatDuration(3600n * 18n)).toBe('18h 0m')
    expect(formatDuration(86_400n)).toBe('24h 0m')
  })

  test('formatTimestamp is an unambiguous UTC instant', () => {
    expect(formatTimestamp(0n)).toBe('1970-01-01 00:00 UTC')
    expect(formatTimestamp(1_700_000_000n)).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/,
    )
  })
})
