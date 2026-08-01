import boxen from 'boxen'
import Table from 'cli-table3'

import {
  detectCapabilities,
  hasAnsi,
  stripAnsi,
  type TerminalCapabilities,
} from './theme.js'

/**
 * Output primitives: panels, tables, and the writable surface commands print to.
 *
 * Everything here obeys the same rule as the banner (KTD-13): when
 * {@link TerminalCapabilities.rich} is false, the third-party renderer is not
 * called at all and a hand-rolled ASCII equivalent is emitted instead. That is
 * stricter than passing the renderer a "no colour" option — `boxen` still draws
 * Unicode box characters and `cli-table3` still emits its own escapes — and it
 * means the plain surface has no dependency on either library behaving.
 *
 * The final {@link stripAnsi} sweep in {@link CliOutput.write} is the backstop.
 */

/** Where a command writes. Injected, so tests capture output as a string. */
export interface CliWritable {
  write(chunk: string): unknown
}

export interface CliOutputOptions {
  stdout?: CliWritable
  stderr?: CliWritable
  capabilities?: TerminalCapabilities
}

/** A key/value row in a summary panel. */
export interface PanelRow {
  label: string
  value: string
}

/** A table, as the commands describe one before it is rendered. */
export interface TableSpec {
  head: readonly string[]
  rows: readonly (readonly string[])[]
  /** Shown instead of an empty grid. Never omitted — see the empty-state rule. */
  empty?: string
}

/**
 * The output surface every command is handed.
 *
 * Commands never touch `process.stdout` directly; they call these methods. That
 * is what makes "assert the exact bytes a user would see" a one-line test.
 */
export class CliOutput {
  readonly capabilities: TerminalCapabilities
  readonly #stdout: CliWritable
  readonly #stderr: CliWritable

  constructor(options: CliOutputOptions = {}) {
    this.capabilities = options.capabilities ?? detectCapabilities()
    this.#stdout = options.stdout ?? process.stdout
    this.#stderr = options.stderr ?? process.stderr
  }

  /** Write to stdout, stripping escapes when the plain surface is in force. */
  write(text: string): void {
    this.#stdout.write(this.#sanitize(text))
  }

  /** Write to stderr, with the same sanitisation. */
  writeError(text: string): void {
    this.#stderr.write(this.#sanitize(text))
  }

  /** Write a line to stdout. */
  line(text = ''): void {
    this.write(`${text}\n`)
  }

  /** Write a blank line. */
  blank(): void {
    this.write('\n')
  }

  #sanitize(text: string): string {
    if (this.capabilities.rich) return text
    return hasAnsi(text) ? stripAnsi(text) : text
  }

  /**
   * A bordered summary panel.
   *
   * @param title Heading shown on the border (decorated) or as `== title ==`.
   * @param body Lines, or key/value rows aligned on their labels.
   */
  panel(title: string, body: string | readonly PanelRow[]): void {
    const text =
      typeof body === 'string' ? body : alignRows(body)
    this.write(`${renderPanel(title, text, this.capabilities)}\n`)
  }

  /** A table, or its `empty` text when there are no rows. */
  table(spec: TableSpec): void {
    this.write(`${renderTable(spec, this.capabilities)}\n`)
  }

  /**
   * A state with nothing in it.
   *
   * Its own method because "never show a blank screen" is a requirement, and a
   * requirement with a named function behind it is one a reviewer can grep for.
   */
  emptyState(message: string, hint?: string): void {
    this.line(message)
    if (hint !== undefined) this.line(`  ${hint}`)
  }
}

/** Right-pad labels so a two-column body lines up without a table border. */
export function alignRows(rows: readonly PanelRow[]): string {
  const width = rows.reduce((widest, row) => Math.max(widest, row.label.length), 0)
  return rows
    .map((row) => `${row.label.padEnd(width)}  ${row.value}`)
    .join('\n')
}

/**
 * Render a panel.
 *
 * Exported separately from {@link CliOutput} so the plain form can be asserted
 * without constructing an output surface.
 */
export function renderPanel(
  title: string,
  body: string,
  capabilities: TerminalCapabilities,
): string {
  if (!capabilities.rich) {
    const rule = '-'.repeat(Math.max(4, Math.min(capabilities.columns, 78)))
    return [`== ${title} ==`, body, rule].join('\n')
  }
  return boxen(body, {
    title,
    padding: { top: 0, bottom: 0, left: 1, right: 1 },
    borderStyle: 'round',
    width: Math.min(capabilities.columns - 2, 78),
  })
}

/**
 * Render a table, or its empty text.
 *
 * The plain form is a two-space-separated grid with a dashed header rule: still
 * readable by a person, and unlike `cli-table3`'s output it is stable enough for
 * `awk`.
 */
export function renderTable(
  spec: TableSpec,
  capabilities: TerminalCapabilities,
): string {
  if (spec.rows.length === 0) {
    return spec.empty ?? '(nothing to show)'
  }

  if (!capabilities.rich) {
    const all = [spec.head, ...spec.rows]
    const widths = spec.head.map((_, column) =>
      all.reduce((widest, row) => Math.max(widest, (row[column] ?? '').length), 0),
    )
    const render = (row: readonly string[]) =>
      row
        .map((cell, column) => cell.padEnd(widths[column] ?? 0))
        .join('  ')
        .trimEnd()
    return [
      render(spec.head),
      widths.map((width) => '-'.repeat(width)).join('  '),
      ...spec.rows.map(render),
    ].join('\n')
  }

  const table = new Table({ head: [...spec.head] })
  for (const row of spec.rows) table.push([...row])
  return table.toString()
}
