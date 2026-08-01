/**
 * The human-facing error taxonomy for `npx giwacard`.
 *
 * The MCP taxonomy in `src/mcp/errors.ts` exists so an *agent* can branch on a
 * stable code. This one exists for the opposite reader: a person at a terminal
 * who needs to be told what went wrong and what to type next, and who must never
 * be shown a viem stack trace. Every failure the CLI prints goes through here.
 *
 * The rule the whole module enforces is that a {@link CliError} carries a
 * `message` already phrased as a sentence a user can act on, and an optional
 * `hint` naming the exact next command. Anything that cannot be classified
 * becomes {@link unexpectedError}, whose text is fixed — an unclassified failure
 * is precisely the case where we do not know what its message contains.
 */

/** Stable failure classes. Each maps to one thing the user can do next. */
export type CliErrorCode =
  /** No `~/.giwacard/keystore.json` on this machine yet. */
  | 'NO_KEYSTORE'
  /** The keystore exists but the passphrase did not open it. */
  | 'BAD_PASSPHRASE'
  /** The keystore opened but does not hold the key this command needs. */
  | 'KEYSTORE_INCOMPLETE'
  /** A required address (vault, token, merchant) is not configured. */
  | 'NOT_CONFIGURED'
  /** The public RPC rate-limited or timed out us. Retryable. */
  | 'RPC_UNAVAILABLE'
  /** The submitting address cannot pay for the transaction it is about to send. */
  | 'INSUFFICIENT_GAS'
  /** The gUSD faucet is still inside its 24h cooldown for this address. */
  | 'FAUCET_COOLDOWN'
  /** The local approval daemon could not be reached or started. */
  | 'DAEMON_UNAVAILABLE'
  /** The request was already approved, denied or expired by someone else. */
  | 'ALREADY_RESOLVED'
  /** No card, approval or session key with the identifier given. */
  | 'NOT_FOUND'
  /** The argv is wrong — a missing subject, an unparseable address or id. */
  | 'INVALID_ARGUMENT'
  /** A transaction was mined but reverted. */
  | 'TRANSACTION_REVERTED'
  /** The user pressed Ctrl-C or answered "cancel" at a prompt. */
  | 'CANCELLED'
  /** The safe generic. */
  | 'UNEXPECTED'

/**
 * A failure with a message written for a person.
 *
 * @example
 * throw new CliError('NOT_FOUND', 'No card 42 in this vault.', {
 *   hint: 'Run `giwacard status` to list your active cards.',
 * })
 */
export class CliError extends Error {
  override readonly name: string = 'CliError'
  readonly code: CliErrorCode
  /** The exact next command, printed under the message. */
  readonly hint: string | undefined
  /** Whether re-running the identical command could succeed. */
  readonly retryable: boolean

  constructor(
    code: CliErrorCode,
    message: string,
    options: { hint?: string; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : {})
    this.code = code
    this.hint = options.hint
    this.retryable = options.retryable ?? false
  }
}

/** Text shown when a command runs on a machine that has never been set up. */
export const ONBOARDING_MESSAGE =
  'giwacard is not set up on this machine yet — there is no keystore at ' +
  '~/.giwacard/keystore.json.'

/** The one command that fixes {@link ONBOARDING_MESSAGE}. */
export const ONBOARDING_HINT =
  'Run `giwacard init` to create your owner wallet, attach to the vault, and ' +
  'register a session key. It takes about two minutes.'

/**
 * The onboarding error every command raises when there is no keystore.
 *
 * Deliberately one shared constructor rather than a per-command message: a user
 * who has not run `init` should see the same sentence whichever command they
 * happened to try first.
 */
export function noKeystoreError(path: string): CliError {
  return new CliError('NO_KEYSTORE', `${ONBOARDING_MESSAGE} (looked in ${path})`, {
    hint: ONBOARDING_HINT,
  })
}

/** The passphrase did not decrypt the keystore. */
export function badPassphraseError(path: string, cause?: unknown): CliError {
  return new CliError(
    'BAD_PASSPHRASE',
    `That passphrase does not open the keystore at ${path}.`,
    {
      hint:
        'Passphrases are never stored, so there is no recovery. If you have ' +
        'lost it, move the file aside and run `giwacard init` for a fresh wallet.',
      retryable: true,
      cause,
    },
  )
}

/** A public GIWA endpoint rate-limited or timed out on us. */
export function rpcUnavailableError(cause?: unknown): CliError {
  return new CliError(
    'RPC_UNAVAILABLE',
    'The GIWA Sepolia RPC did not answer — it is rate-limited (HTTP 429) or ' +
      'timed out. Nothing was submitted.',
    {
      hint:
        'Both public GIWA endpoints are dev-only and throttled. Wait a few ' +
        'seconds and retry, or point $GIWACARD_RPC_URL at a dedicated endpoint.',
      retryable: true,
      cause,
    },
  )
}

/** The gUSD faucet is still inside its 24h cooldown. */
export function faucetCooldownError(
  address: string,
  availableAtSeconds: bigint,
  nowSeconds: bigint,
): CliError {
  const remaining = availableAtSeconds > nowSeconds ? availableAtSeconds - nowSeconds : 0n
  return new CliError(
    'FAUCET_COOLDOWN',
    `The gUSD faucet is still on cooldown for ${address}. It unlocks at ` +
      `${formatTimestamp(availableAtSeconds)} — ${formatDuration(remaining)} from now.`,
    {
      hint:
        'The faucet mints 100 gUSD per address per 24 hours. You can keep using ' +
        'the balance you already have; run `giwacard status` to see it.',
    },
  )
}

/** The submitting address cannot cover the gas this transaction needs. */
export function insufficientGasError(options: {
  address: string
  role: string
  balanceWei: bigint
  requiredWei: bigint
  faucetUrl: string
}): CliError {
  const short = options.requiredWei - options.balanceWei
  return new CliError(
    'INSUFFICIENT_GAS',
    `The ${options.role} (${options.address}) holds ${formatEth(options.balanceWei)} ETH ` +
      `but this transaction needs about ${formatEth(options.requiredWei)} ETH in gas — ` +
      `${formatEth(short > 0n ? short : 0n)} ETH short. Nothing was signed or sent.`,
    {
      hint: `Top the address up from the GIWA Sepolia faucet (${options.faucetUrl}), then re-run this command.`,
    },
  )
}

/** The user cancelled at a prompt or pressed Ctrl-C. */
export function cancelledError(what = 'Cancelled'): CliError {
  return new CliError('CANCELLED', what, {
    hint: 'Nothing was changed. Re-run the command when you are ready.',
  })
}

/** Fixed text for anything that could not be classified. */
export const UNEXPECTED_MESSAGE =
  'giwacard hit an unexpected error. Nothing was submitted that this command ' +
  'has not already told you about.'

/**
 * The safe generic.
 *
 * The cause is attached (so `--debug` can print it) but never interpolated into
 * the message, because an unclassified error is exactly the one whose text we
 * cannot vouch for.
 */
export function unexpectedError(cause?: unknown): CliError {
  return new CliError('UNEXPECTED', UNEXPECTED_MESSAGE, {
    hint: 'Re-run with GIWACARD_DEBUG=1 to see the underlying error.',
    cause,
  })
}

/* -------------------------------------------------------------------------- */
/* Formatting helpers shared by the messages above                            */
/* -------------------------------------------------------------------------- */

/** Render a unix-seconds timestamp as an ISO-8601 UTC string, to the minute. */
export function formatTimestamp(seconds: bigint): string {
  const millis = Number(seconds) * 1000
  if (!Number.isFinite(millis)) return 'an unknown time'
  return `${new Date(millis).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

/** Render a second count as `2h 15m`, `45s`, or `now`. */
export function formatDuration(seconds: bigint): string {
  if (seconds <= 0n) return 'now'
  const total = Number(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = Math.floor(total % 60)
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${secs}s`
  return `${secs}s`
}

/** Render wei as a short decimal ETH string, e.g. `0.00042`. */
export function formatEth(wei: bigint, fractionDigits = 6): string {
  const negative = wei < 0n
  const value = negative ? -wei : wei
  const whole = value / 10n ** 18n
  const fraction = value % 10n ** 18n
  const padded = fraction.toString().padStart(18, '0').slice(0, fractionDigits)
  const trimmed = padded.replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${trimmed === '' ? '' : `.${trimmed}`}`
}

/** Render a base-unit token amount at `decimals` places, e.g. `12.5`. */
export function formatUnits(amount: bigint, decimals: number): string {
  const negative = amount < 0n
  const value = negative ? -amount : amount
  const base = 10n ** BigInt(decimals)
  const whole = value / base
  const fraction = (value % base).toString().padStart(decimals, '0')
  const trimmed = fraction.replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${trimmed === '' ? '' : `.${trimmed}`}`
}
