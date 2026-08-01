import type { Abi, Address, Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { CardStatus, type VaultCard, type VaultSessionPolicy } from '../chain/cardVaultAbi.js'
import type { KeystoreOptions } from '../chain/keystore.js'
import type { ApprovalRecordWire } from '../mcp/approvals.js'
import type { AgentConfigFs } from './agentConfig.js'
import type {
  CliPreconfClient,
  CliPublicClient,
  CliReceipt,
  CliWalletClient,
} from './chain.js'
import { loadCliConfig, type CliEnv } from './config.js'
import type {
  AgentConfigOverrides,
  ChainFactory,
  CliRuntime,
  CliSigner,
} from './context.js'
import type {
  ApprovalListWire,
  ListApprovalsOptions,
  OwnerApprovalClient,
  ResolveApprovalInput,
} from './daemon.js'
import type {
  ConfirmPromptOptions,
  PasswordPromptOptions,
  Prompter,
  PromptSpinner,
  SelectPromptOptions,
  TextPromptOptions,
} from './prompts.js'
import { PLAIN_CAPABILITIES } from './theme.js'
import { CliOutput } from './ui.js'

/**
 * Test doubles for the CLI.
 *
 * Kept in `src/` rather than a test file because more than one test file needs
 * them and because they are, in effect, the reference implementation of the
 * interfaces in `./chain.ts`, `./daemon.ts` and `./prompts.ts` — if a real
 * client stops satisfying one of these shapes, the compiler says so here.
 *
 * Nothing in this module is exported from the package entry point.
 */

/* -------------------------------------------------------------------------- */
/* Output                                                                     */
/* -------------------------------------------------------------------------- */

/** A {@link CliOutput} that accumulates everything written to it. */
export class RecordingOutput extends CliOutput {
  readonly stdoutChunks: string[] = []
  readonly stderrChunks: string[] = []

  constructor() {
    const stdoutChunks: string[] = []
    const stderrChunks: string[] = []
    super({
      capabilities: PLAIN_CAPABILITIES,
      stdout: { write: (chunk: string) => stdoutChunks.push(chunk) },
      stderr: { write: (chunk: string) => stderrChunks.push(chunk) },
    })
    this.stdoutChunks = stdoutChunks
    this.stderrChunks = stderrChunks
  }

  /** Everything written to stdout. */
  get stdout(): string {
    return this.stdoutChunks.join('')
  }

  /** Everything written to stderr. */
  get stderr(): string {
    return this.stderrChunks.join('')
  }

  /** Both streams, for assertions that do not care which one it landed on. */
  get all(): string {
    return `${this.stdout}\n${this.stderr}`
  }
}

/* -------------------------------------------------------------------------- */
/* Prompter                                                                   */
/* -------------------------------------------------------------------------- */

/** One scripted answer. `value` is returned by the matching prompt. */
export interface ScriptedAnswer {
  kind: 'text' | 'password' | 'confirm' | 'select'
  value: unknown
}

/**
 * A {@link Prompter} that answers from a script.
 *
 * Records every question it was asked, so a test can assert that a resumed
 * wizard did *not* re-ask something — which is the only way to prove a step was
 * genuinely skipped rather than silently repeated.
 */
export class ScriptedPrompter implements Prompter {
  readonly interactive = true
  readonly asked: { kind: string; message: string }[] = []
  readonly logged: string[] = []
  #answers: ScriptedAnswer[]

  constructor(answers: readonly ScriptedAnswer[] = []) {
    this.#answers = [...answers]
  }

  /** Messages of every question asked so far. */
  get questions(): string[] {
    return this.asked.map((entry) => entry.message)
  }

  #next(kind: ScriptedAnswer['kind'], message: string): unknown {
    this.asked.push({ kind, message })
    const answer = this.#answers.shift()
    if (answer === undefined) {
      throw new Error(
        `ScriptedPrompter ran out of answers at ${kind} prompt: ${message}`,
      )
    }
    if (answer.kind !== kind) {
      throw new Error(
        `ScriptedPrompter expected a ${answer.kind} answer but the CLI asked a ` +
          `${kind} question: ${message}`,
      )
    }
    return answer.value
  }

  intro(title: string): void {
    this.logged.push(title)
  }
  outro(message: string): void {
    this.logged.push(message)
  }
  note(message: string): void {
    this.logged.push(message)
  }
  info(message: string): void {
    this.logged.push(message)
  }
  warn(message: string): void {
    this.logged.push(message)
  }
  error(message: string): void {
    this.logged.push(message)
  }
  success(message: string): void {
    this.logged.push(message)
  }

  async text(options: TextPromptOptions): Promise<string> {
    return this.#next('text', options.message) as string
  }
  async password(options: PasswordPromptOptions): Promise<string> {
    return this.#next('password', options.message) as string
  }
  async confirm(options: ConfirmPromptOptions): Promise<boolean> {
    return this.#next('confirm', options.message) as boolean
  }
  async select<T>(options: SelectPromptOptions<T>): Promise<T> {
    return this.#next('select', options.message) as T
  }

  spinner(): PromptSpinner {
    return {
      start: (message) => {
        if (message !== undefined) this.logged.push(message)
      },
      message: (message) => this.logged.push(message),
      stop: (message) => {
        if (message !== undefined) this.logged.push(message)
      },
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Chain                                                                      */
/* -------------------------------------------------------------------------- */

/** One recorded contract write. */
export interface RecordedWrite {
  address: Address
  functionName: string
  args: readonly unknown[]
  from: Address
}

/** How the fake chain answers reads. */
export interface FakeChainState {
  /** Native ETH per address. */
  balances: Map<string, bigint>
  /** Contract read results, keyed `functionName` or `functionName:arg0`. */
  reads: Map<string, unknown>
  gasPrice: bigint
  gas: bigint
  receipt: CliReceipt
  safeBlock: bigint
}

/** A fake chain: deterministic reads, recorded writes, no network. */
export class FakeChain implements ChainFactory {
  readonly writes: RecordedWrite[] = []
  readonly state: FakeChainState

  constructor(overrides: Partial<FakeChainState> = {}) {
    this.state = {
      balances: overrides.balances ?? new Map(),
      reads: overrides.reads ?? new Map(),
      gasPrice: overrides.gasPrice ?? 1_000_000_000n,
      gas: overrides.gas ?? 50_000n,
      receipt:
        overrides.receipt ??
        ({
          status: 'success',
          transactionHash: ('0x' + '11'.repeat(32)) as Hex,
          blockNumber: 10n,
          logs: [],
        } satisfies CliReceipt),
      safeBlock: overrides.safeBlock ?? 100n,
    }
  }

  /** Seed a contract read. `key` is `functionName` or `functionName:<arg0>`. */
  setRead(key: string, value: unknown): this {
    this.state.reads.set(key, value)
    return this
  }

  /** Seed a native balance. */
  setBalance(address: string, wei: bigint): this {
    this.state.balances.set(address.toLowerCase(), wei)
    return this
  }

  /** Writes recorded for one contract function. */
  writesTo(functionName: string): RecordedWrite[] {
    return this.writes.filter((write) => write.functionName === functionName)
  }

  publicClient(): CliPublicClient {
    return {
      readContract: async (args) => {
        const first = args.args?.[0]
        const keyed = `${args.functionName}:${String(first).toLowerCase()}`
        if (this.state.reads.has(keyed)) return this.state.reads.get(keyed)
        if (this.state.reads.has(args.functionName)) {
          return this.state.reads.get(args.functionName)
        }
        throw new Error(
          `FakeChain has no seeded read for ${args.functionName} (tried "${keyed}")`,
        )
      },
      getBalance: async ({ address }) =>
        this.state.balances.get(address.toLowerCase()) ?? 10n ** 18n,
      getGasPrice: async () => this.state.gasPrice,
      estimateContractGas: async () => this.state.gas,
      waitForTransactionReceipt: async () => this.state.receipt,
      getBlock: async () => ({ number: this.state.safeBlock }),
    }
  }

  preconfClient(): CliPreconfClient | undefined {
    return undefined
  }

  wallet(privateKey: Hex): CliWalletClient {
    const address = privateKeyToAccount(privateKey).address
    return {
      account: { address },
      writeContract: async (args: {
        address: Address
        abi: Abi | readonly unknown[]
        functionName: string
        args?: readonly unknown[]
      }) => {
        this.writes.push({
          address: args.address,
          functionName: args.functionName,
          args: args.args ?? [],
          from: address,
        })
        return this.state.receipt.transactionHash
      },
    }
  }

  signer(privateKey: Hex): CliSigner {
    const account = privateKeyToAccount(privateKey)
    return {
      address: account.address,
      signTypedData: (args) => account.signTypedData(args as never) as Promise<Hex>,
    }
  }
}

/** Build a `Card` struct for seeding {@link FakeChain}. */
export function fakeCard(overrides: Partial<VaultCard> = {}): VaultCard {
  return {
    vaultOwner: '0x0000000000000000000000000000000000000001' as Hex,
    agent: '0x0000000000000000000000000000000000000002' as Hex,
    token: '0x0000000000000000000000000000000000000003' as Hex,
    cap: 5_000_000n,
    merchantScope: '0x0000000000000000000000000000000000000004' as Hex,
    expiry: 9_999_999_999n,
    status: CardStatus.Active,
    ...overrides,
  }
}

/** Build a `SessionPolicy` struct for seeding {@link FakeChain}. */
export function fakePolicy(
  overrides: Partial<VaultSessionPolicy> = {},
): VaultSessionPolicy {
  return {
    capPerCard: 10_000_000n,
    dailyCap: 50_000_000n,
    maxExpiry: 86_400n,
    active: true,
    ...overrides,
  }
}

/* -------------------------------------------------------------------------- */
/* Daemon                                                                     */
/* -------------------------------------------------------------------------- */

/** An in-memory approval queue implementing the owner-side client. */
export class FakeDaemon implements OwnerApprovalClient {
  readonly resolved: { id: string; input: ResolveApprovalInput }[] = []
  #records: Map<string, ApprovalRecordWire>
  #error: unknown = null

  constructor(records: readonly ApprovalRecordWire[] = []) {
    this.#records = new Map(records.map((record) => [record.id, record]))
  }

  /** Make every call throw. Used for the "daemon is down" path. */
  failWith(error: unknown): this {
    this.#error = error
    return this
  }

  async list(options: ListApprovalsOptions = {}): Promise<ApprovalListWire> {
    if (this.#error) throw this.#error
    const status = options.status ?? 'pending'
    const requests = [...this.#records.values()].filter(
      (record) => status === 'all' || record.status === status,
    )
    return { requests, count: requests.length }
  }

  async get(id: string): Promise<ApprovalRecordWire> {
    if (this.#error) throw this.#error
    const record = this.#records.get(id)
    if (!record) throw new Error(`FakeDaemon has no request ${id}`)
    return record
  }

  async resolve(
    id: string,
    input: ResolveApprovalInput,
  ): Promise<ApprovalRecordWire> {
    if (this.#error) throw this.#error
    const record = await this.get(id)
    this.resolved.push({ id, input })
    const next: ApprovalRecordWire = {
      ...record,
      status: input.decision === 'approve' ? 'approved' : 'denied',
      ownerSignature: input.ownerSignature ?? null,
      resolvedAt: Date.now(),
      terminal: true,
    }
    this.#records.set(id, next)
    return next
  }
}

/** Build an approval record for seeding {@link FakeDaemon}. */
export function fakeApproval(
  overrides: Partial<ApprovalRecordWire> = {},
): ApprovalRecordWire {
  return {
    id: 'req-1',
    sessionKey: '0x0000000000000000000000000000000000000002',
    agent: 'test-agent',
    status: 'pending',
    reason: 'over the per-card cap',
    request: {
      agent: '0x0000000000000000000000000000000000000002',
      cap: '25000000',
      merchantScope: '0x0000000000000000000000000000000000000004',
      expiry: '9999999999',
    },
    idempotencyKey: null,
    createdAt: 1,
    expiresAt: 2 ** 42,
    resolvedAt: null,
    resolvedBy: null,
    decisionNote: null,
    ownerSignature: null,
    signatureConsumedAt: null,
    cardId: null,
    mintTxHash: null,
    signatureConsumed: false,
    terminal: false,
    ...overrides,
  }
}

/* -------------------------------------------------------------------------- */
/* Agent config                                                               */
/* -------------------------------------------------------------------------- */

/** An in-memory {@link AgentConfigFs}, so no test writes a real dotfile. */
export function memoryAgentConfigFs(
  seed: Record<string, string> = {},
): AgentConfigFs & { files: Record<string, string> } {
  const files: Record<string, string> = { ...seed }
  return {
    files,
    exists: (path) => Object.hasOwn(files, path),
    read: (path) => files[path] ?? '',
    write: (path, contents) => {
      files[path] = contents
    },
    mkdir: () => {},
  }
}

/* -------------------------------------------------------------------------- */
/* Runtime                                                                    */
/* -------------------------------------------------------------------------- */

export interface FakeRuntimeOptions {
  env?: CliEnv
  keystoreOptions?: KeystoreOptions
  chain?: ChainFactory
  daemon?: OwnerApprovalClient
  prompter?: Prompter
  output?: RecordingOutput
  now?: () => number
  agentConfig?: AgentConfigOverrides
}

/** A runtime whose every dependency is a double. */
export function fakeRuntime(options: FakeRuntimeOptions = {}): CliRuntime & {
  output: RecordingOutput
} {
  const env = options.env ?? {}
  const output = options.output ?? new RecordingOutput()
  const daemon = options.daemon ?? new FakeDaemon()
  return {
    config: loadCliConfig(env),
    output,
    prompter: options.prompter ?? new ScriptedPrompter(),
    env,
    keystoreOptions: options.keystoreOptions ?? {},
    chain: options.chain ?? new FakeChain(),
    daemon: () => daemon,
    now: options.now ?? (() => 1_700_000_000_000),
    ...(options.agentConfig !== undefined
      ? { agentConfig: options.agentConfig }
      : {}),
  }
}
