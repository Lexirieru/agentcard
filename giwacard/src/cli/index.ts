import { keystoreExists, keystorePath } from '../chain/keystore.js'
import { VERSION } from '../version.js'
import { bannerText } from './banner.js'
import { runApproveCommand } from './commands/approve.js'
import { runFaucetCommand } from './commands/faucet.js'
import { runInitCommand } from './commands/init.js'
import { runRevokeCommand } from './commands/revoke.js'
import { runStatusCommand } from './commands/status.js'
import { createRuntime, type CliRuntime } from './context.js'
import { CliError, ONBOARDING_HINT, ONBOARDING_MESSAGE } from './errors.js'
import { ClackPrompter, NonInteractivePrompter, type Prompter } from './prompts.js'
import { detectCapabilities } from './theme.js'
import { CliOutput, type CliWritable } from './ui.js'

/**
 * argv routing, and the one place a {@link CliError} becomes terminal output.
 *
 * Two properties matter more than the routing itself.
 *
 * **Nothing reaches the user as a stack.** Every command throws typed errors;
 * this module renders them as a message, a hint, and a non-zero exit code. The
 * raw cause is printed only under `GIWACARD_DEBUG=1`. A user who has just been
 * rate-limited by a public RPC should read one sentence, not forty frames of
 * viem.
 *
 * **A machine with no keystore is answered, not failed.** `giwacard status` on a
 * fresh laptop is not an error condition, it is the most likely first command
 * anyone types. It prints the onboarding message and points at `giwacard init`.
 */

/** Result of parsing argv. */
export interface ParsedArgs {
  command: string
  positional: string[]
  flags: Record<string, string | boolean>
}

/**
 * Parse argv into a command, positionals and flags.
 *
 * Hand-rolled rather than a dependency: the whole grammar is `giwacard <cmd>
 * [subject] [target] [--flag[=value]]`, and a parser library would be more code
 * to audit than the parser.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = []
  const flags: Record<string, string | boolean> = {}

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index] as string
    if (!token.startsWith('-')) {
      positional.push(token)
      continue
    }
    const name = token.replace(/^--?/, '')
    const equals = name.indexOf('=')
    if (equals >= 0) {
      flags[name.slice(0, equals)] = name.slice(equals + 1)
      continue
    }
    const next = argv[index + 1]
    // A bare `--flag` followed by a non-flag is `--flag value`; followed by
    // nothing or another flag it is boolean.
    if (next !== undefined && !next.startsWith('-') && VALUE_FLAGS.has(name)) {
      flags[name] = next
      index++
    } else {
      flags[name] = true
    }
  }

  return {
    command: positional.shift() ?? '',
    positional,
    flags,
  }
}

/** Flags that take a value. Everything else is boolean. */
const VALUE_FLAGS: ReadonlySet<string> = new Set(['id', 'host'])

/** The help text. Written so the two `revoke` forms cannot be confused. */
export const HELP_TEXT = `
Usage: giwacard <command> [options]

Commands
  init                    Set up your wallet, vault, session key and agent (resumable)
  status                  Balance, escrowed, available, active cards, pending approvals
  approve                 Review over-policy card requests and sign or deny them
  revoke key <address>    Deactivate a session key. Cards it already minted STAY ACTIVE.
  revoke card <id>        Cancel one card and release its escrow. The key stays active.
  faucet                  Claim 100 gUSD (once per address per 24 hours)
  daemon                  Run the local approval queue in the foreground
  mcp                     Run the MCP server on stdio (agent hosts spawn this)

Options
  --yes                   Accept defaults; do not prompt
  --id <id>               approve: resolve this request without the picker
  --host <name>           init: agent host to configure. One of:
                            claude-code     .mcp.json in the project root
                            claude-desktop  claude_desktop_config.json
                            cursor          ~/.cursor/mcp.json
                            gemini          ~/.gemini/settings.json
                          "claude" is refused: the two Claudes read different files.
  --fresh                 init: ignore recorded progress and re-run every step
  --gas                   status: also show the per-submitter gas budget
  --version, -v           Print the version
  --help, -h              Print this help

Environment
  GIWACARD_VAULT_ADDRESS    The canonical CardVault proxy
  GIWACARD_GUSD_ADDRESS     The gUSD token the vault settles in
  GIWACARD_MERCHANT_ADDRESS The demo merchant seeded into the allowlist
  GIWACARD_RPC_URL          A dedicated RPC, if the public one is throttling you
  GIWACARD_PASSPHRASE       Keystore passphrase, for non-interactive runs
  GIWACARD_HOME             Keystore and daemon directory (default ~/.giwacard)
  NO_COLOR                  Force plain, uncoloured output
`.trimStart()

export interface RunCliOptions {
  argv?: readonly string[]
  stdout?: CliWritable
  stderr?: CliWritable
  env?: NodeJS.ProcessEnv
  /** Injected in tests so no terminal, RPC or daemon is touched. */
  runtime?: CliRuntime
  /** Injected in tests. Defaults to clack when stdin is a TTY. */
  prompter?: Prompter
}

/**
 * Build the prompter for this invocation.
 *
 * clack only when there is a real terminal on *both* ends: a wizard that starts
 * prompting into a pipe hangs forever, and a hang is the worst failure mode a
 * CLI has because the user cannot tell it apart from slow work.
 */
function defaultPrompter(output: CliOutput): Prompter {
  const interactive =
    process.stdin.isTTY === true && output.capabilities.tty
  return interactive
    ? new ClackPrompter()
    : new NonInteractivePrompter((message) => output.line(message))
}

/**
 * Run the CLI.
 *
 * @returns The process exit code. Never throws — every failure becomes a
 * rendered message and a non-zero code.
 */
export async function runCli(options: RunCliOptions = {}): Promise<number> {
  const argv = options.argv ?? process.argv.slice(2)
  const env = (options.env ?? process.env) as NodeJS.ProcessEnv
  const parsed = parseArgs(argv)

  const capabilities = detectCapabilities({
    env: env as Record<string, string | undefined>,
    ...(options.stdout !== undefined
      ? { stream: options.stdout as { isTTY?: boolean; columns?: number } }
      : {}),
  })
  const output =
    options.runtime?.output ??
    new CliOutput({
      capabilities,
      ...(options.stdout !== undefined ? { stdout: options.stdout } : {}),
      ...(options.stderr !== undefined ? { stderr: options.stderr } : {}),
    })

  if (parsed.flags['version'] || parsed.flags['v']) {
    output.line(VERSION)
    return 0
  }

  if (parsed.command === '' || parsed.command === 'help' || parsed.flags['help'] || parsed.flags['h']) {
    return runDefault(output, parsed.command === '' && !parsed.flags['help'] && !parsed.flags['h'], {
      env,
    })
  }

  const runtime =
    options.runtime ??
    createRuntime({
      env: env as never,
      output,
      prompter: options.prompter ?? defaultPrompter(output),
    })

  try {
    switch (parsed.command) {
      case 'init':
        return await runInitCommand(runtime, {
          fresh: parsed.flags['fresh'] === true,
          ...(typeof parsed.flags['host'] === 'string'
            ? { host: parsed.flags['host'] }
            : {}),
          yes: parsed.flags['yes'] === true,
        })

      case 'status':
        return await runStatusCommand(runtime, {
          gas: parsed.flags['gas'] === true,
        })

      case 'approve':
        return await runApproveCommand(runtime, {
          ...(typeof parsed.flags['id'] === 'string'
            ? { id: parsed.flags['id'] }
            : {}),
          yes: parsed.flags['yes'] === true,
        })

      case 'revoke':
        return await runRevokeCommand(runtime, {
          ...(parsed.positional[0] !== undefined
            ? { subject: parsed.positional[0] }
            : {}),
          ...(parsed.positional[1] !== undefined
            ? { target: parsed.positional[1] }
            : {}),
          yes: parsed.flags['yes'] === true,
        })

      case 'faucet':
        return await runFaucetCommand(runtime, {
          yes: parsed.flags['yes'] === true,
        })

      default:
        output.writeError(`Unknown command "${parsed.command}".\n\n`)
        output.write(HELP_TEXT)
        return 2
    }
  } catch (error) {
    return reportError(output, error, env['GIWACARD_DEBUG'] === '1')
  }
}

/**
 * The bare `giwacard` / `giwacard help` screen.
 *
 * With no keystore this is where a first-time user lands, so it leads with the
 * onboarding sentence rather than a command list they cannot yet use.
 */
function runDefault(
  output: CliOutput,
  bare: boolean,
  options: { env: NodeJS.ProcessEnv },
): number {
  const home = options.env['GIWACARD_HOME']
  const keystoreOptions = home ? { dir: home } : {}

  if (bare) {
    output.line(bannerText({ capabilities: output.capabilities }))
    output.blank()
    if (!keystoreExists(keystoreOptions)) {
      output.line(`${ONBOARDING_MESSAGE} (looked in ${keystorePath(keystoreOptions)})`)
      output.line(ONBOARDING_HINT)
      output.blank()
    } else {
      output.line(`Keystore: ${keystorePath(keystoreOptions)}`)
      output.blank()
    }
  }

  output.write(HELP_TEXT)
  return 0
}

/**
 * Render a failure.
 *
 * Exported so the tests can assert the exact shape a user sees — message, then
 * hint, and never a stack unless `GIWACARD_DEBUG=1` asked for one.
 */
export function reportError(
  output: CliOutput,
  error: unknown,
  debug = false,
): number {
  const cliError =
    error instanceof CliError
      ? error
      : new CliError(
          'UNEXPECTED',
          'giwacard hit an unexpected error and stopped.',
          { hint: 'Re-run with GIWACARD_DEBUG=1 to see the underlying error.', cause: error },
        )

  output.writeError(`\n${cliError.message}\n`)
  if (cliError.hint) output.writeError(`${cliError.hint}\n`)

  if (debug) {
    const cause = cliError.cause ?? cliError
    output.writeError(
      `\n[debug] ${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}\n`,
    )
  }

  // Cancellation is a decision, not a failure — but it still must not report
  // success, or a script would treat an abandoned wizard as a completed one.
  return cliError.code === 'CANCELLED' ? 130 : 1
}
