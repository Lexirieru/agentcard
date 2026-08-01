import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { VERSION } from '../version.js'
import { HELP_TEXT, parseArgs, reportError, runCli } from './index.js'
import { CliError } from './errors.js'
import { hasAnsi } from './theme.js'
import { RecordingOutput } from './testing.js'

/**
 * Argv routing and the single place a failure becomes terminal output.
 *
 * The behaviours asserted here are the ones a user notices when something has
 * gone wrong: no stack ever reaches the terminal, a fresh machine gets an
 * onboarding pointer rather than an error, and the two `revoke` forms are both
 * spelled out wherever they are mentioned.
 */

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'giwacard-cli-router-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Capture a run against a fresh, empty giwacard home. */
async function run(argv: string[], env: NodeJS.ProcessEnv = {}) {
  const output = new RecordingOutput()
  const code = await runCli({
    argv,
    env: { GIWACARD_HOME: dir, NO_COLOR: '1', ...env },
    stdout: { write: (chunk: string) => output.stdoutChunks.push(chunk) },
    stderr: { write: (chunk: string) => output.stderrChunks.push(chunk) },
  })
  return { code, out: output.stdout, err: output.stderr, all: output.all }
}

describe('parseArgs', () => {
  test('splits the command, positionals and flags', () => {
    const parsed = parseArgs(['revoke', 'card', '7', '--yes'])
    expect(parsed.command).toBe('revoke')
    expect(parsed.positional).toEqual(['card', '7'])
    expect(parsed.flags['yes']).toBe(true)
  })

  test('accepts --flag=value and --flag value for value flags', () => {
    expect(parseArgs(['approve', '--id=abc']).flags['id']).toBe('abc')
    expect(parseArgs(['approve', '--id', 'abc']).flags['id']).toBe('abc')
    expect(parseArgs(['init', '--host', 'cursor']).flags['host']).toBe('cursor')
  })

  test('a boolean flag does not swallow the next positional', () => {
    const parsed = parseArgs(['revoke', '--yes', 'card', '7'])
    expect(parsed.flags['yes']).toBe(true)
    expect(parsed.positional).toEqual(['card', '7'])
  })

  test('an empty argv has no command', () => {
    expect(parseArgs([]).command).toBe('')
  })
})

describe('the bare command on a machine with no keystore', () => {
  test('leads with the onboarding message and the init pointer', async () => {
    const { code, out } = await run([])
    expect(code).toBe(0)
    expect(out).toContain('not set up on this machine yet')
    expect(out).toContain('giwacard init')
    // The banner is present but plain, because NO_COLOR is set.
    expect(out).toContain('GIWACARD')
    expect(hasAnsi(out)).toBe(false)
  })

  test('help lists both revoke forms with their different consequences', async () => {
    const { out } = await run(['help'])
    expect(out).toContain('revoke key <address>')
    expect(out).toContain('revoke card <id>')
    expect(out).toContain('STAY ACTIVE')
    expect(out).toContain('The key stays active')
  })

  test('--version prints just the version', async () => {
    const { code, out } = await run(['--version'])
    expect(code).toBe(0)
    expect(out.trim()).toBe(VERSION)
  })

  test('an unknown command exits 2 with the help text', async () => {
    const { code, all } = await run(['frobnicate'])
    expect(code).toBe(2)
    expect(all).toContain('Unknown command "frobnicate"')
    expect(all).toContain(HELP_TEXT.slice(0, 40))
  })
})

describe('a real command with no keystore', () => {
  test('`giwacard status` renders the onboarding message, not a stack', async () => {
    const { code, err } = await run(['status'])
    expect(code).toBe(1)
    expect(err).toContain('not set up on this machine yet')
    expect(err).toContain('giwacard init')
    expect(err).not.toContain('    at ')
    expect(err).not.toContain('KeystoreNotFoundError')
  })

  test('`giwacard faucet` and `giwacard approve` say the same thing', async () => {
    for (const command of ['faucet', 'approve']) {
      const { code, err } = await run([command])
      expect(code).toBe(1)
      expect(err).toContain('giwacard init')
    }
  })

  test('`giwacard revoke` with no subject explains both forms before asking for a keystore', async () => {
    const { code, err } = await run(['revoke'])
    expect(code).toBe(1)
    expect(err).toContain('giwacard revoke key <address>')
    expect(err).toContain('giwacard revoke card <id>')
    expect(err).not.toContain('    at ')
  })
})

describe('reportError', () => {
  test('prints the message and the hint, and nothing else', () => {
    const output = new RecordingOutput()
    const code = reportError(
      output,
      new CliError('RPC_UNAVAILABLE', 'The RPC did not answer.', {
        hint: 'Try again in a moment.',
        cause: new Error('secret internals'),
      }),
    )
    expect(code).toBe(1)
    expect(output.stderr).toContain('The RPC did not answer.')
    expect(output.stderr).toContain('Try again in a moment.')
    expect(output.stderr).not.toContain('secret internals')
  })

  test('GIWACARD_DEBUG=1 adds the underlying cause', () => {
    const output = new RecordingOutput()
    reportError(
      output,
      new CliError('UNEXPECTED', 'Something broke.', {
        cause: new Error('the real reason'),
      }),
      true,
    )
    expect(output.stderr).toContain('the real reason')
    expect(output.stderr).toContain('[debug]')
  })

  test('an unclassified throw becomes the safe generic', () => {
    const output = new RecordingOutput()
    const code = reportError(output, new TypeError('x is not a function'))
    expect(code).toBe(1)
    expect(output.stderr).toContain('unexpected error')
    expect(output.stderr).not.toContain('x is not a function')
    expect(output.stderr).toContain('GIWACARD_DEBUG=1')
  })

  test('a cancellation exits 130, not 0', () => {
    const output = new RecordingOutput()
    expect(reportError(output, new CliError('CANCELLED', 'Cancelled.'))).toBe(130)
  })
})
