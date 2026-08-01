import type { Address, Hex, TypedDataDomain } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import {
  createGiwaFlashblocksClient,
  createGiwaPublicClient,
  createGiwaWalletClient,
} from '../chain/clients.js'
import {
  keystoreExists,
  keystorePath,
  loadKeystore,
  KeystoreDecryptionError,
  KeystoreNotFoundError,
  type KeystoreData,
  type KeystoreOptions,
} from '../chain/keystore.js'
import type { AgentConfigFs } from './agentConfig.js'
import type {
  CliPreconfClient,
  CliPublicClient,
  CliWalletClient,
} from './chain.js'
import { loadCliConfig, type CliConfig, type CliEnv } from './config.js'
import { OwnerDaemonClient, type OwnerApprovalClient } from './daemon.js'
import {
  badPassphraseError,
  CliError,
  noKeystoreError,
  unexpectedError,
} from './errors.js'
import { NonInteractivePrompter, type Prompter } from './prompts.js'
import { CliOutput } from './ui.js'

/**
 * Everything a command is handed, and nothing it may reach around.
 *
 * The entire CLI is written against this object: no command imports viem
 * directly, opens the keystore itself, or writes to `process.stdout`. That is
 * what makes the whole surface testable without a live RPC, a real daemon, or a
 * terminal — the test suite constructs a runtime whose chain and daemon are
 * plain object literals.
 */

/** Signs EIP-712 payloads. The owner's approval signature (F3) needs this. */
export interface CliSigner {
  address: Address
  signTypedData(args: {
    domain: TypedDataDomain
    types: Record<string, readonly { name: string; type: string }[]>
    primaryType: string
    message: Record<string, unknown>
  }): Promise<Hex>
}

/**
 * How a command obtains chain access.
 *
 * A factory rather than eagerly-built clients: `giwacard --version` and the
 * no-keystore onboarding path must not open a socket or read a private key, and
 * a factory makes that structural instead of a rule someone has to remember.
 */
export interface ChainFactory {
  publicClient(): CliPublicClient
  /** Flashblocks read client for the preconfirmation phase (KTD-5). */
  preconfClient(): CliPreconfClient | undefined
  wallet(privateKey: Hex): CliWalletClient
  signer(privateKey: Hex): CliSigner
}

/**
 * Where the wizard looks for agent-host config files, and how it writes them.
 *
 * Overridable purely so tests never touch a developer's real
 * `~/.cursor/mcp.json`. Production leaves every field unset.
 */
export interface AgentConfigOverrides {
  fs?: AgentConfigFs
  home?: string
  platform?: NodeJS.Platform
  /** Project root for per-project hosts (Claude Code's `.mcp.json`). */
  cwd?: string
}

/** The runtime handed to every command. */
export interface CliRuntime {
  config: CliConfig
  output: CliOutput
  prompter: Prompter
  env: CliEnv
  keystoreOptions: KeystoreOptions
  chain: ChainFactory
  /** The owner's approval-queue client. Auto-starts the daemon on first use. */
  daemon(): OwnerApprovalClient
  /** Epoch ms. Injected so faucet cooldown maths is testable. */
  now(): number
  /** See {@link AgentConfigOverrides}. Empty in production. */
  agentConfig?: AgentConfigOverrides
}

/* -------------------------------------------------------------------------- */
/* Production chain factory                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The viem-backed {@link ChainFactory}.
 *
 * Private keys enter here and are handed straight to viem's account/transport
 * layer. They are never returned, logged, or placed in anything a command can
 * print — the only export shaped like a key is {@link CliSigner.address}.
 */
export function createChainFactory(config: CliConfig): ChainFactory {
  const transport = config.rpcUrl ? { transport: { url: config.rpcUrl } } : {}
  return {
    publicClient: () =>
      createGiwaPublicClient(transport) as unknown as CliPublicClient,
    preconfClient: () =>
      // Only the standard endpoint is overridden by $GIWACARD_RPC_URL; a
      // dedicated RPC is not a Flashblocks endpoint, and pointing the
      // preconfirmation reads at it would silently report `latest` as
      // `pending`.
      createGiwaFlashblocksClient() as unknown as CliPreconfClient,
    wallet: (privateKey) => createWallet(privateKey, transport),
    signer: (privateKey) => createSigner(privateKey),
  }
}

function createWallet(
  privateKey: Hex,
  transport: { transport?: { url: string } },
): CliWalletClient {
  return createGiwaWalletClient({
    account: privateKeyToAccount(privateKey),
    ...transport,
  }) as unknown as CliWalletClient
}

function createSigner(privateKey: Hex): CliSigner {
  const account = privateKeyToAccount(privateKey)
  return {
    address: account.address,
    signTypedData: (args) => account.signTypedData(args as never) as Promise<Hex>,
  }
}

/* -------------------------------------------------------------------------- */
/* Runtime construction                                                       */
/* -------------------------------------------------------------------------- */

export interface CreateRuntimeOptions {
  env?: CliEnv
  output?: CliOutput
  prompter?: Prompter
  chain?: ChainFactory
  daemon?: OwnerApprovalClient
  now?: () => number
}

/**
 * Build the production runtime.
 *
 * @param options Overrides. Tests replace `chain`, `daemon` and `prompter`;
 * production passes nothing.
 */
export function createRuntime(options: CreateRuntimeOptions = {}): CliRuntime {
  const env = options.env ?? (process.env as CliEnv)
  const config = loadCliConfig(env)
  const output = options.output ?? new CliOutput()
  const prompter =
    options.prompter ?? new NonInteractivePrompter((message) => output.line(message))
  const chain = options.chain ?? createChainFactory(config)
  const keystoreOptions: KeystoreOptions = config.home ? { dir: config.home } : {}

  let daemonClient: OwnerApprovalClient | null = options.daemon ?? null

  return {
    config,
    output,
    prompter,
    env,
    keystoreOptions,
    chain,
    daemon: () => {
      daemonClient ??= new OwnerDaemonClient(
        config.home ? { daemon: { dir: config.home } } : {},
      )
      return daemonClient
    },
    now: options.now ?? (() => Date.now()),
  }
}

/* -------------------------------------------------------------------------- */
/* Unsealing the keystore                                                     */
/* -------------------------------------------------------------------------- */

/** An opened keystore, with the passphrase kept for a follow-up write. */
export interface UnsealedKeystore {
  data: KeystoreData
  /** Held in memory only, for `updateKeystore`. Never written anywhere. */
  passphrase: string
  path: string
}

export interface UnsealOptions {
  /** Text shown at the passphrase prompt. */
  message?: string
  /** How many wrong passphrases to tolerate before giving up. Default 3. */
  attempts?: number
}

/**
 * Open the keystore, asking for the passphrase.
 *
 * The two failure modes are kept strictly apart, because they call for opposite
 * responses. *No keystore at all* is the onboarding case: the user has never run
 * `init`, and the answer is a pointer to it, not a retry loop. A *wrong
 * passphrase* is a typo: the answer is to ask again.
 *
 * `$GIWACARD_PASSPHRASE` is honoured so scripted runs work, but it is never
 * written by this CLI — see `./agentConfig.ts`.
 *
 * @throws {CliError} `NO_KEYSTORE` when there is nothing to open,
 * `BAD_PASSPHRASE` after the attempts are used up.
 */
export async function unsealKeystore(
  runtime: CliRuntime,
  options: UnsealOptions = {},
): Promise<UnsealedKeystore> {
  const path = keystorePath(runtime.keystoreOptions)
  if (!keystoreExists(runtime.keystoreOptions)) throw noKeystoreError(path)

  const attempts = options.attempts ?? 3
  const fromEnv = runtime.env.GIWACARD_PASSPHRASE?.trim()

  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const passphrase =
      attempt === 1 && fromEnv
        ? fromEnv
        : await runtime.prompter.password({
            message: options.message ?? 'Keystore passphrase',
            validate: (value) =>
              value.length === 0 ? 'The passphrase cannot be empty.' : undefined,
          })

    try {
      return { data: loadKeystore(passphrase, runtime.keystoreOptions), passphrase, path }
    } catch (error) {
      lastError = error
      if (error instanceof KeystoreNotFoundError) throw noKeystoreError(path)
      if (!(error instanceof KeystoreDecryptionError)) throw unexpectedError(error)
      if (attempt < attempts) {
        runtime.prompter.error('That passphrase did not open the keystore.')
      }
    }
  }
  throw badPassphraseError(path, lastError)
}

/**
 * Pull a required key out of an opened keystore.
 *
 * @throws {CliError} `KEYSTORE_INCOMPLETE` when the key is absent, naming the
 * step of `giwacard init` that creates it.
 */
export function requireKey(
  keystore: UnsealedKeystore,
  which: 'ownerPrivateKey' | 'sessionPrivateKey',
): Hex {
  const key = keystore.data[which]
  if (!key) {
    const what = which === 'ownerPrivateKey' ? 'owner wallet' : 'session key'
    throw new CliError(
      'KEYSTORE_INCOMPLETE',
      `The keystore at ${keystore.path} has no ${what}.`,
      {
        hint: `Run \`giwacard init\` — it will resume at the "${what}" step and leave everything already set up alone.`,
      },
    )
  }
  return key
}

/**
 * The vault address a command must use.
 *
 * The wizard records it in the keystore at attach time, so a configured machine
 * needs no environment at all; `$GIWACARD_VAULT_ADDRESS` overrides it for anyone
 * pointing at a second deployment.
 *
 * @throws {CliError} `NOT_CONFIGURED` when neither source has one.
 */
export function requireVaultAddress(
  runtime: CliRuntime,
  recorded: Address | undefined,
): Address {
  const address = runtime.config.vaultAddress ?? recorded
  if (!address) {
    throw new CliError(
      'NOT_CONFIGURED',
      'giwacard does not know which CardVault to talk to.',
      {
        hint:
          'Set $GIWACARD_VAULT_ADDRESS to the canonical vault proxy, or run ' +
          '`giwacard init` to attach to it.',
      },
    )
  }
  return address
}

/**
 * The gUSD token address a command must use. Same resolution order as the vault.
 *
 * @throws {CliError} `NOT_CONFIGURED` when neither source has one.
 */
export function requireTokenAddress(
  runtime: CliRuntime,
  recorded: Address | undefined,
): Address {
  const address = runtime.config.tokenAddress ?? recorded
  if (!address) {
    throw new CliError(
      'NOT_CONFIGURED',
      'giwacard does not know which gUSD token this vault settles in.',
      {
        hint:
          'Set $GIWACARD_GUSD_ADDRESS to the gUSD proxy, or run `giwacard init`.',
      },
    )
  }
  return address
}
