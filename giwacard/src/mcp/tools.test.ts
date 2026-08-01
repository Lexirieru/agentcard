import { describe, expect, test } from 'bun:test'
import {
  ContractFunctionRevertedError,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  type Address,
  type Hex,
} from 'viem'

import {
  CardStatus,
  cardVaultAbi,
  type VaultCard,
  type VaultSessionPolicy,
} from '../chain/cardVaultAbi.js'
import { RateLimitExceededError } from '../daemon/errors.js'
import type {
  ApprovalClient,
  ApprovalCreateOutcome,
  ApprovalRecordWire,
  CreateApprovalInput,
  MarkApprovalConsumedInput,
} from './approvals.js'
import type {
  GiwaCardMcpContext,
  VaultPublicClient,
  VaultWalletClient,
} from './context.js'
import { containsSecretShapedText } from './redact.js'
import { GIWACARD_TOOLS } from './tools/index.js'
import { runTool, type ToolDefinition, type ToolResult } from './tools/define.js'
import { payMerchant } from './vault.js'

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const VAULT = '0x5FbDB2315678afecb367f032d93F642f64180aa3' as Address
const OWNER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address
const SESSION = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as Address
const MERCHANT = '0x90F79bf6EB2c4f870365E785982E1f101E93b906' as Address
const OTHER_MERCHANT = '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65' as Address
const TOKEN = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0' as Address
const TX_HASH = `0x${'11'.repeat(32)}` as Hex
/** A real-shaped owner signature. Never a live key. */
const OWNER_SIGNATURE = `0x${'ab'.repeat(65)}` as Hex

const NOW_MS = 1_800_000_000_000
const NOW_S = BigInt(Math.floor(NOW_MS / 1000))

interface ChainState {
  policy: VaultSessionPolicy
  day: bigint
  mintedToday: bigint
  balance: bigint
  escrowed: bigint
  merchants: Record<string, boolean>
  cards: Record<string, VaultCard>
  gas: bigint
  nextCardId: bigint
  /** Set to throw from every read, to exercise the safe generic. */
  readError?: Error
  /** Set to throw from the next write. */
  writeError?: Error
}

function defaultState(): ChainState {
  return {
    policy: {
      capPerCard: 1_000_000n,
      dailyCap: 5_000_000n,
      maxExpiry: 86_400n,
      active: true,
    },
    day: NOW_S / 86_400n,
    mintedToday: 0n,
    balance: 10_000_000n,
    escrowed: 0n,
    merchants: { [MERCHANT.toLowerCase()]: true },
    cards: {},
    gas: 10n ** 16n,
    nextCardId: 1n,
  }
}

/** Encode a real `CardMinted` log so the receipt decoding path is exercised. */
function cardMintedLog(state: ChainState, card: VaultCard, cardId: bigint) {
  return {
    address: VAULT,
    topics: encodeEventTopics({
      abi: cardVaultAbi,
      eventName: 'CardMinted',
      args: { cardId, vaultOwner: card.vaultOwner, agent: card.agent },
    }),
    data: encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'uint64' },
      ],
      [card.token, card.cap, card.merchantScope, card.expiry],
    ),
    blockNumber: 1n,
    blockHash: `0x${'22'.repeat(32)}` as Hex,
    logIndex: 0,
    transactionHash: TX_HASH,
    transactionIndex: 0,
    removed: false,
  }
}

function cardChargedLog(
  cardId: bigint,
  merchant: Address,
  amount: bigint,
  released: bigint,
) {
  return {
    address: VAULT,
    topics: encodeEventTopics({
      abi: cardVaultAbi,
      eventName: 'CardCharged',
      args: { cardId, vaultOwner: OWNER, merchant },
    }),
    data: encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }],
      [amount, released],
    ),
    blockNumber: 1n,
    blockHash: `0x${'22'.repeat(32)}` as Hex,
    logIndex: 0,
    transactionHash: TX_HASH,
    transactionIndex: 0,
    removed: false,
  }
}

/** Build a viem-shaped revert error carrying a decodable custom error. */
function vaultRevert(errorName: string, args: readonly unknown[]): Error {
  const data = encodeErrorResult({
    abi: cardVaultAbi,
    errorName: errorName as never,
    args: args as never,
  })
  // The shape viem produces: the decodable payload lives down the cause chain.
  const error = new Error(
    'The contract function reverted.',
  ) as Error & { cause?: unknown }
  error.cause = new ContractFunctionRevertedError({
    abi: cardVaultAbi,
    data,
    functionName: 'mintCard',
  })
  return error
}

interface Harness {
  context: GiwaCardMcpContext
  state: ChainState
  writes: { functionName: string; args: readonly unknown[] }[]
  approvalCalls: { method: string; input: unknown }[]
  approvalRecord: ApprovalRecordWire
  approvalCreated: boolean
}

function approvalRecord(
  overrides: Partial<ApprovalRecordWire> = {},
): ApprovalRecordWire {
  return {
    id: 'appr-1',
    sessionKey: SESSION.toLowerCase(),
    agent: 'test-agent',
    status: 'pending',
    reason: 'over policy',
    request: {},
    idempotencyKey: null,
    createdAt: NOW_MS,
    expiresAt: NOW_MS + 86_400_000,
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

function createHarness(
  overrides: Partial<ChainState> = {},
  options: { ownerClient?: boolean } = {},
): Harness {
  const state = { ...defaultState(), ...overrides }
  const writes: Harness['writes'] = []
  const approvalCalls: Harness['approvalCalls'] = []

  const harness = {
    state,
    writes,
    approvalCalls,
    approvalRecord: approvalRecord(),
    approvalCreated: true,
  } as Harness

  const publicClient: VaultPublicClient = {
    async readContract({ functionName, args = [] }) {
      if (state.readError) throw state.readError
      switch (functionName) {
        case 'sessionPolicy':
          return state.policy
        case 'currentDay':
          return state.day
        case 'mintedOnDay':
          return state.mintedToday
        case 'balanceOf':
          return state.balance
        case 'escrowedOf':
          return state.escrowed
        case 'availableBalanceOf':
          return state.balance - state.escrowed
        case 'paymentToken':
          return TOKEN
        case 'isMerchantAllowed':
          return state.merchants[String(args[2]).toLowerCase()] === true
        case 'getCard':
          return (
            state.cards[String(args[0])] ?? {
              vaultOwner: '0x0000000000000000000000000000000000000000',
              agent: '0x0000000000000000000000000000000000000000',
              token: '0x0000000000000000000000000000000000000000',
              cap: 0n,
              merchantScope: '0x0000000000000000000000000000000000000000',
              expiry: 0n,
              status: CardStatus.None,
            }
          )
        default:
          throw new Error(`unmocked read: ${functionName}`)
      }
    },
    async getBalance() {
      if (state.readError) throw state.readError
      return state.gas
    },
    async waitForTransactionReceipt() {
      const last = writes[writes.length - 1]
      const logs: unknown[] = []
      if (last?.functionName === 'mintCard' || last?.functionName === 'mintCardWithApproval') {
        const cardId = state.nextCardId
        const card: VaultCard =
          last.functionName === 'mintCard'
            ? {
                vaultOwner: OWNER,
                agent: SESSION,
                token: TOKEN,
                cap: last.args[1] as bigint,
                merchantScope: last.args[2] as Address,
                expiry: last.args[3] as bigint,
                status: CardStatus.Active,
              }
            : {
                vaultOwner: OWNER,
                agent: SESSION,
                token: TOKEN,
                cap: (last.args[0] as { cap: bigint }).cap,
                merchantScope: (last.args[0] as { merchantScope: Address })
                  .merchantScope,
                expiry: (last.args[0] as { expiry: bigint }).expiry,
                status: CardStatus.Active,
              }
        state.cards[cardId.toString()] = card
        state.nextCardId += 1n
        logs.push(cardMintedLog(state, card, cardId))
      }
      if (last?.functionName === 'charge') {
        const cardId = last.args[0] as bigint
        const amount = last.args[1] as bigint
        const card = state.cards[cardId.toString()]
        logs.push(
          cardChargedLog(
            cardId,
            card?.merchantScope ?? MERCHANT,
            amount,
            (card?.cap ?? amount) - amount,
          ),
        )
      }
      return {
        status: 'success' as const,
        transactionHash: TX_HASH,
        logs: logs as never,
      }
    },
  }

  const wallet = (address: Address): VaultWalletClient => ({
    account: { address },
    async writeContract({ functionName, args = [] }) {
      if (state.writeError) {
        const error = state.writeError
        state.writeError = undefined
        throw error
      }
      writes.push({ functionName, args })
      return TX_HASH
    },
  })

  const approvals: ApprovalClient = {
    async create(input: CreateApprovalInput): Promise<ApprovalCreateOutcome> {
      approvalCalls.push({ method: 'create', input })
      return { record: harness.approvalRecord, created: harness.approvalCreated }
    },
    async get(id: string): Promise<ApprovalRecordWire> {
      approvalCalls.push({ method: 'get', input: id })
      return harness.approvalRecord
    },
    async markConsumed(
      id: string,
      input: MarkApprovalConsumedInput,
    ): Promise<ApprovalRecordWire> {
      approvalCalls.push({ method: 'markConsumed', input: { id, ...input } })
      return harness.approvalRecord
    },
  }

  harness.context = {
    vaultAddress: VAULT,
    vaultOwner: OWNER,
    publicClient,
    sessionClient: wallet(SESSION),
    ownerClient: options.ownerClient ? wallet(OWNER) : undefined,
    approvals,
    knownMerchants: [MERCHANT, OTHER_MERCHANT],
    agentLabel: 'test-agent',
    now: () => NOW_MS,
  }

  return harness
}

function tool(name: string): ToolDefinition {
  const found = GIWACARD_TOOLS.find((entry) => entry.name === name)
  if (!found) throw new Error(`no tool named ${name}`)
  return found
}

/** Call a tool the way the MCP layer does, and parse what an agent would see. */
async function call(
  harness: Harness,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ result: ToolResult; payload: Record<string, unknown> }> {
  const definition = tool(name)
  // Validate against the real schema first, exactly as the SDK would.
  const parsed = definition.inputSchema.parse(args)
  const result = await runTool(definition, parsed, harness.context)
  return {
    result,
    payload: result.structuredContent,
  }
}

function activeCard(overrides: Partial<VaultCard> = {}): VaultCard {
  return {
    vaultOwner: OWNER,
    agent: SESSION,
    token: TOKEN,
    cap: 500_000n,
    merchantScope: MERCHANT,
    expiry: NOW_S + 3600n,
    status: CardStatus.Active,
    ...overrides,
  }
}

/* -------------------------------------------------------------------------- */
/* Happy paths                                                                */
/* -------------------------------------------------------------------------- */

describe('mint_card — in policy (KTD-2)', () => {
  test('mints directly and returns a card_id', async () => {
    const harness = createHarness()
    const { payload } = await call(harness, 'mint_card', {
      amount: '500000',
      merchant: MERCHANT,
    })

    expect(payload['ok']).toBe(true)
    expect(payload['status']).toBe('minted')
    expect(payload['card_id']).toBe('1')
    expect(payload['path']).toBe('in_policy')
    // The session EOA submitted `mintCard` itself — no signature step exists.
    expect(harness.writes).toHaveLength(1)
    expect(harness.writes[0]?.functionName).toBe('mintCard')
    expect(harness.approvalCalls).toHaveLength(0)
  })

  test('escrows against available balance, not total balance', async () => {
    // 10_000_000 deposited but 9_600_000 escrowed leaves 400_000 available.
    const harness = createHarness({ escrowed: 9_600_000n })
    const { payload } = await call(harness, 'mint_card', {
      amount: '500000',
      merchant: MERCHANT,
    })
    expect(payload['error']).toMatchObject({
      code: 'INSUFFICIENT_AVAILABLE_BALANCE',
    })
  })
})

describe('mint_card — over policy (KTD-3)', () => {
  test('returns an approval_id and submits NO transaction', async () => {
    const harness = createHarness()
    const { payload } = await call(harness, 'mint_card', {
      amount: '2000000', // over capPerCard of 1_000_000
      merchant: MERCHANT,
      reason: 'bulk order',
    })

    expect(payload['status']).toBe('approval_required')
    expect(payload['approval_id']).toBe('appr-1')
    expect(payload['submitted_onchain']).toBe(false)
    expect(payload['over_policy_reasons']).toEqual(['cap_per_card'])
    // The load-bearing assertion: nothing went onchain.
    expect(harness.writes).toHaveLength(0)
    expect(harness.approvalCalls).toHaveLength(1)
  })

  test('queues the exact CardApproval the owner will sign', async () => {
    const harness = createHarness()
    await call(harness, 'mint_card', {
      amount: '2000000',
      merchant: MERCHANT,
      expires_in_seconds: 600,
    })

    const request = (
      harness.approvalCalls[0]?.input as CreateApprovalInput
    ).request
    expect(request).toMatchObject({
      vaultOwner: OWNER,
      agent: SESSION,
      token: TOKEN,
      cap: '2000000',
      merchantScope: MERCHANT,
      expiry: (NOW_S + 600n).toString(),
      vault: VAULT,
    })
    expect(String(request['approvalId'])).toMatch(/^0x[0-9a-f]{64}$/)
  })

  test('a daily-cap breach is over policy, not an error', async () => {
    const harness = createHarness({ mintedToday: 4_800_000n })
    const { payload } = await call(harness, 'mint_card', {
      amount: '900000',
      merchant: MERCHANT,
    })
    expect(payload['status']).toBe('approval_required')
    expect(payload['over_policy_reasons']).toEqual(['daily_cap'])
  })

  test('an over-long expiry is over policy', async () => {
    const harness = createHarness()
    const { payload } = await call(harness, 'mint_card', {
      amount: '500000',
      merchant: MERCHANT,
      expires_in_seconds: 200_000, // maxExpiry is 86_400
    })
    expect(payload['status']).toBe('approval_required')
    expect(payload['over_policy_reasons']).toEqual(['max_expiry'])
  })
})

describe('get_card_status', () => {
  test('reports a chargeable card', async () => {
    const harness = createHarness()
    harness.state.cards['4'] = activeCard()
    const { payload } = await call(harness, 'get_card_status', { card_id: '4' })

    expect(payload).toMatchObject({
      card_id: '4',
      status: 'active',
      chargeable: true,
      amount: '500000',
      merchant: MERCHANT,
    })
  })

  test('an active-but-expired card is not chargeable', async () => {
    const harness = createHarness()
    harness.state.cards['5'] = activeCard({ expiry: NOW_S - 10n })
    const { payload } = await call(harness, 'get_card_status', { card_id: '5' })

    expect(payload['status']).toBe('active')
    expect(payload['chargeable']).toBe(false)
    expect(payload['expired']).toBe(true)
  })

  test('an unknown id is CARD_NOT_FOUND, not a silent zero card', async () => {
    const harness = createHarness()
    const { payload } = await call(harness, 'get_card_status', { card_id: '99' })
    expect(payload['error']).toMatchObject({ code: 'CARD_NOT_FOUND' })
  })
})

describe('get_balance', () => {
  test('leads with available, not total', async () => {
    const harness = createHarness({ escrowed: 3_000_000n })
    const { payload } = await call(harness, 'get_balance')
    expect(payload).toMatchObject({
      available: '7000000',
      balance: '10000000',
      escrowed: '3000000',
      token: TOKEN,
    })
  })
})

describe('get_policy', () => {
  test('reports caps, today’s remaining budget and merchant scope', async () => {
    const harness = createHarness({ mintedToday: 1_000_000n })
    const { payload } = await call(harness, 'get_policy')

    expect(payload).toMatchObject({
      active: true,
      cap_per_card: '1000000',
      daily_cap: '5000000',
      minted_today: '1000000',
      remaining_today: '4000000',
      max_expiry_seconds: 86_400,
      merchants_enumerable: false,
    })
    expect(payload['merchants']).toEqual([
      { address: MERCHANT, allowed: true },
      { address: OTHER_MERCHANT, allowed: false },
    ])
  })
})

describe('cancel_card', () => {
  test('cancels through the owner wallet when one is configured', async () => {
    const harness = createHarness({}, { ownerClient: true })
    harness.state.cards['2'] = activeCard()
    const { payload } = await call(harness, 'cancel_card', { card_id: '2' })

    expect(payload).toMatchObject({ status: 'revoked', released: '500000' })
    expect(harness.writes[0]?.functionName).toBe('cancelCard')
  })

  test('refuses to escalate a session key when no owner wallet is present', async () => {
    const harness = createHarness()
    harness.state.cards['2'] = activeCard()
    const { payload } = await call(harness, 'cancel_card', { card_id: '2' })

    expect(payload['error']).toMatchObject({ code: 'OWNER_ACTION_REQUIRED' })
    expect(harness.writes).toHaveLength(0)
  })
})

/* -------------------------------------------------------------------------- */
/* check_approval_status — the stateless discovery path (R10b)                */
/* -------------------------------------------------------------------------- */

describe('check_approval_status', () => {
  test('reports a pending request without minting', async () => {
    const harness = createHarness()
    const { payload } = await call(harness, 'check_approval_status', {
      approval_id: 'appr-1',
    })
    expect(payload['status']).toBe('pending')
    expect(harness.writes).toHaveLength(0)
  })

  test('surfaces the card_id with no live session from the original request', async () => {
    // A brand-new harness: nothing here filed the request, and no state
    // survives from the session that did. The daemon record is the only input.
    const harness = createHarness()
    harness.approvalRecord = approvalRecord({
      status: 'approved',
      cardId: '42',
      mintTxHash: TX_HASH,
      ownerSignature: null,
      signatureConsumed: true,
      terminal: true,
      request: {
        cap: '2000000',
        merchantScope: MERCHANT,
        expiry: (NOW_S + 600n).toString(),
      },
    })

    const { payload } = await call(harness, 'check_approval_status', {
      approval_id: 'appr-1',
    })

    expect(payload).toMatchObject({
      status: 'approved',
      card_id: '42',
      merchant: MERCHANT,
    })
    // Already minted: this poll must not mint a second card.
    expect(harness.writes).toHaveLength(0)
  })

  test('relays the owner signature once, then marks it consumed', async () => {
    const harness = createHarness()
    harness.approvalRecord = approvalRecord({
      status: 'approved',
      ownerSignature: OWNER_SIGNATURE,
      terminal: true,
      request: {
        vaultOwner: OWNER,
        agent: SESSION,
        token: TOKEN,
        cap: '2000000',
        merchantScope: MERCHANT,
        expiry: (NOW_S + 600n).toString(),
        approvalId: `0x${'cd'.repeat(32)}`,
      },
    })

    const { result, payload } = await call(harness, 'check_approval_status', {
      approval_id: 'appr-1',
    })

    expect(payload['status']).toBe('approved')
    expect(payload['card_id']).toBe('1')
    expect(harness.writes[0]?.functionName).toBe('mintCardWithApproval')
    // KTD-16: the daemon is told to delete the signature.
    const consumed = harness.approvalCalls.find(
      (entry) => entry.method === 'markConsumed',
    )
    expect(consumed?.input).toMatchObject({ cardId: '1' })
    // R10b: the signature never appears in what the agent receives.
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(OWNER_SIGNATURE)
    expect(serialized).not.toContain('ab'.repeat(20))
  })

  test('reports a denial as a terminal answer, not a retryable error', async () => {
    const harness = createHarness()
    harness.approvalRecord = approvalRecord({
      status: 'denied',
      decisionNote: 'too much',
      terminal: true,
    })
    const { payload } = await call(harness, 'check_approval_status', {
      approval_id: 'appr-1',
    })
    expect(payload['status']).toBe('denied')
    expect(payload['note']).toBe('too much')
  })
})

/* -------------------------------------------------------------------------- */
/* Error taxonomy — every class returns its stable code                       */
/* -------------------------------------------------------------------------- */

describe('error taxonomy', () => {
  test('SESSION_KEY_REVOKED when the policy is inactive', async () => {
    const harness = createHarness({
      policy: { ...defaultState().policy, active: false },
    })
    const { payload } = await call(harness, 'mint_card', {
      amount: '1000',
      merchant: MERCHANT,
    })
    expect(payload['error']).toMatchObject({ code: 'SESSION_KEY_REVOKED' })
    expect(harness.writes).toHaveLength(0)
  })

  test('MERCHANT_OUT_OF_SCOPE (AE7) is an error, never an approval prompt', async () => {
    const harness = createHarness()
    const { payload } = await call(harness, 'mint_card', {
      amount: '1000',
      merchant: OTHER_MERCHANT,
    })
    expect(payload['error']).toMatchObject({ code: 'MERCHANT_OUT_OF_SCOPE' })
    // Neither queued nor submitted: an unknown merchant is a scope decision.
    expect(harness.approvalCalls).toHaveLength(0)
    expect(harness.writes).toHaveLength(0)
  })

  test('INSUFFICIENT_AVAILABLE_BALANCE (AE5) is an error, never queued', async () => {
    const harness = createHarness({ balance: 100n })
    const { payload } = await call(harness, 'mint_card', {
      amount: '1000',
      merchant: MERCHANT,
    })
    expect(payload['error']).toMatchObject({
      code: 'INSUFFICIENT_AVAILABLE_BALANCE',
      details: { available: '100', required: '1000' },
    })
    expect(harness.approvalCalls).toHaveLength(0)
  })

  test('CARD_ALREADY_USED (AE3) on a charged card', async () => {
    const harness = createHarness({}, { ownerClient: true })
    harness.state.cards['3'] = activeCard({ status: CardStatus.Used })
    const { payload } = await call(harness, 'cancel_card', { card_id: '3' })
    expect(payload['error']).toMatchObject({ code: 'CARD_ALREADY_USED' })
  })

  test('NO_GAS when the session EOA cannot pay for gas', async () => {
    const harness = createHarness({ gas: 0n })
    const { payload } = await call(harness, 'mint_card', {
      amount: '500000',
      merchant: MERCHANT,
    })
    expect(payload['error']).toMatchObject({ code: 'NO_GAS', retryable: true })
    expect(harness.writes).toHaveLength(0)
  })

  test('RATE_LIMITED when the approval queue refuses another request', async () => {
    const harness = createHarness()
    harness.context.approvals.create = async () => {
      throw new RateLimitExceededError(SESSION, 20, 3_600_000, 42_000)
    }
    const { payload } = await call(harness, 'mint_card', {
      amount: '2000000',
      merchant: MERCHANT,
    })
    expect(payload['error']).toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true,
    })
  })

  test('APPROVAL_PENDING when an idempotency key replays a live request', async () => {
    const harness = createHarness()
    harness.approvalCreated = false // the daemon answered 200, not 201
    const { payload } = await call(harness, 'mint_card', {
      amount: '2000000',
      merchant: MERCHANT,
      idempotency_key: 'retry-1',
    })
    expect(payload['error']).toMatchObject({
      code: 'APPROVAL_PENDING',
      retryable: true,
    })
  })

  test('APPROVAL_DENIED when an idempotency key replays a denied request', async () => {
    const harness = createHarness()
    harness.approvalCreated = false
    harness.approvalRecord = approvalRecord({
      status: 'denied',
      decisionNote: 'no',
      terminal: true,
    })
    const { payload } = await call(harness, 'mint_card', {
      amount: '2000000',
      merchant: MERCHANT,
      idempotency_key: 'retry-1',
    })
    expect(payload['error']).toMatchObject({ code: 'APPROVAL_DENIED' })
  })

  test('an RPC failure returns the safe generic and no stack', async () => {
    const harness = createHarness()
    harness.state.readError = new Error(
      'connect ECONNREFUSED 10.0.0.1:8545 at Socket.emit (node:events:517:28)',
    )
    const { result, payload } = await call(harness, 'get_balance')

    const error = payload['error'] as Record<string, unknown>
    expect(error['code']).toBe('RPC_UNAVAILABLE')
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('ECONNREFUSED')
    expect(serialized).not.toContain('node:events')
    expect(serialized).not.toContain('10.0.0.1')
  })

  test('a decoded vault revert maps to its specific code', async () => {
    const harness = createHarness()
    harness.state.writeError = vaultRevert('InsufficientAvailableBalance', [
      100n,
      500_000n,
    ])
    const { payload } = await call(harness, 'mint_card', {
      amount: '500000',
      merchant: MERCHANT,
    })
    expect(payload['error']).toMatchObject({
      code: 'INSUFFICIENT_AVAILABLE_BALANCE',
    })
  })
})

/* -------------------------------------------------------------------------- */
/* AE4 — every tool result passes redaction                                   */
/* -------------------------------------------------------------------------- */

describe('redaction of every tool result (AE4)', () => {
  /** One success case and one failure case per tool. */
  async function everyResult(): Promise<ToolResult[]> {
    const results: ToolResult[] = []

    const ok = createHarness({}, { ownerClient: true })
    ok.state.cards['1'] = activeCard()
    ok.approvalRecord = approvalRecord({
      status: 'approved',
      cardId: '7',
      mintTxHash: TX_HASH,
      // A live owner signature on the record: the tool must not echo it.
      ownerSignature: OWNER_SIGNATURE,
      request: { cap: '2000000', merchantScope: MERCHANT, expiry: '1800000600' },
    })

    results.push((await call(ok, 'get_balance')).result)
    results.push((await call(ok, 'get_policy')).result)
    results.push(
      (await call(ok, 'get_card_status', { card_id: '1' })).result,
    )
    results.push(
      (await call(ok, 'check_approval_status', { approval_id: 'appr-1' }))
        .result,
    )
    results.push(
      (await call(ok, 'mint_card', { amount: '500000', merchant: MERCHANT }))
        .result,
    )
    results.push((await call(ok, 'cancel_card', { card_id: '1' })).result)

    // Failure results are text an agent reads too, and historically the more
    // likely leak: an unmapped error can carry a whole config object.
    const bad = createHarness({ gas: 0n })
    bad.state.readError = new Error(
      `rpc auth failed for key 0x${'de'.repeat(32)} at https://node/rpc`,
    )
    results.push((await call(bad, 'get_balance')).result)
    results.push((await call(bad, 'get_policy')).result)

    return results
  }

  test('no result contains anything key-shaped', async () => {
    // Scanned per channel, not over `JSON.stringify(result)`: the outer
    // stringify escapes the text block's own quotes, which hides the `"key":`
    // context the backstop uses to tell a public tx hash from a private key.
    // That direction fails closed (it would over-redact), but it also makes the
    // assertion meaningless, so the check runs on what an agent actually reads.
    for (const result of await everyResult()) {
      expect(
        containsSecretShapedText(JSON.stringify(result.structuredContent)),
      ).toBe(false)
      for (const block of result.content) {
        expect(containsSecretShapedText(block.text)).toBe(false)
      }
    }
  })

  test('no result contains an owner signature or a private key', async () => {
    for (const result of await everyResult()) {
      const serialized = JSON.stringify(result)
      expect(serialized).not.toContain(OWNER_SIGNATURE)
      expect(serialized).not.toContain('de'.repeat(32))
    }
  })

  test('the text block and the structured content always agree', async () => {
    for (const result of await everyResult()) {
      const text = result.content[0]?.text ?? ''
      expect(JSON.parse(text)).toEqual(result.structuredContent)
    }
  })
})

/* -------------------------------------------------------------------------- */
/* KTD-9 — the internal pay flow                                              */
/* -------------------------------------------------------------------------- */

describe('payMerchant (KTD-9, internal)', () => {
  test('charges the card and builds an X-PAYMENT header naming the tx', async () => {
    const harness = createHarness()
    harness.state.cards['8'] = activeCard({ cap: 500_000n })

    const payment = await payMerchant(harness.context, {
      cardId: 8n,
      amount: 120_000n,
      merchant: MERCHANT,
    })

    expect(harness.writes[0]?.functionName).toBe('charge')
    expect(payment.payload).toMatchObject({
      scheme: 'giwacard-charge',
      cardId: '8',
      amount: '120000',
      merchant: MERCHANT,
      txHash: TX_HASH,
    })
    expect(payment.released).toBe(380_000n)
    // The header is what the facilitator decodes before verifying the event.
    expect(
      JSON.parse(Buffer.from(payment.header, 'base64').toString('utf8')),
    ).toEqual(payment.payload)
  })

  test('a charge settled to another merchant is AE7', async () => {
    const harness = createHarness()
    harness.state.cards['9'] = activeCard({ merchantScope: MERCHANT })

    await expect(
      payMerchant(harness.context, {
        cardId: 9n,
        amount: 1_000n,
        merchant: OTHER_MERCHANT,
      }),
    ).rejects.toMatchObject({ code: 'MERCHANT_OUT_OF_SCOPE' })
  })
})
