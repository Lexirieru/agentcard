import { parseEventLogs, type Address, type Hex } from 'viem'

import {
  cardVaultAbi,
  type CardApproval,
  type VaultCard,
  type VaultSessionPolicy,
} from '../chain/cardVaultAbi.js'
import { sessionAddress, type GiwaCardMcpContext } from './context.js'
import {
  McpToolError,
  merchantOutOfScopeError,
  noGasError,
  toMcpError,
} from './errors.js'

/**
 * Every read and write this package performs against `CardVault`.
 *
 * The tools in `./tools/` contain no chain code at all: they validate input,
 * call in here, and shape the result. That split is what keeps the two-path
 * mint decision (KTD-2/KTD-3) in one readable place, and it means the RPC
 * mocking in the test suite happens at exactly one seam.
 *
 * Every function here funnels its failures through {@link toMcpError}, so a
 * revert is already an agent-facing code by the time a tool sees it.
 */

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

async function read<T>(
  context: GiwaCardMcpContext,
  functionName: string,
  args: readonly unknown[] = [],
): Promise<T> {
  try {
    return (await context.publicClient.readContract({
      address: context.vaultAddress,
      abi: cardVaultAbi,
      functionName,
      args,
    })) as T
  } catch (error) {
    throw toMcpError(error, { sessionKey: sessionAddress(context) })
  }
}

/** The session key's onchain policy, plus today's usage against its daily cap. */
export interface PolicySnapshot {
  policy: VaultSessionPolicy
  /** Sum of card caps this key already minted during the current UTC day. */
  mintedToday: bigint
  /** `dailyCap - mintedToday`, floored at zero. */
  remainingToday: bigint
  /** UTC day index the vault is currently in. */
  day: bigint
}

/** Read the session key's policy and its spend against today's cap. */
export async function readPolicy(
  context: GiwaCardMcpContext,
): Promise<PolicySnapshot> {
  const session = sessionAddress(context)
  const policy = await read<VaultSessionPolicy>(context, 'sessionPolicy', [
    context.vaultOwner,
    session,
  ])
  const day = await read<bigint>(context, 'currentDay')
  const mintedToday = await read<bigint>(context, 'mintedOnDay', [
    context.vaultOwner,
    session,
    day,
  ])
  const remainingToday =
    policy.dailyCap > mintedToday ? policy.dailyCap - mintedToday : 0n
  return { policy, mintedToday, remainingToday, day }
}

/** The vault owner's three balance figures. */
export interface BalanceSnapshot {
  /** Everything deposited and not yet withdrawn or spent. */
  balance: bigint
  /** Sum of the caps of still-active cards. Untouchable. */
  escrowed: bigint
  /** `balance - escrowed`: what a new card can actually be backed by. */
  available: bigint
}

/** Read the vault owner's balance, escrow and available funds. */
export async function readBalances(
  context: GiwaCardMcpContext,
): Promise<BalanceSnapshot> {
  const [balance, escrowed, available] = await Promise.all([
    read<bigint>(context, 'balanceOf', [context.vaultOwner]),
    read<bigint>(context, 'escrowedOf', [context.vaultOwner]),
    read<bigint>(context, 'availableBalanceOf', [context.vaultOwner]),
  ])
  return { balance, escrowed, available }
}

/** Read one card. A never-minted id comes back with status `None` (0). */
export async function readCard(
  context: GiwaCardMcpContext,
  cardId: bigint,
): Promise<VaultCard> {
  return read<VaultCard>(context, 'getCard', [cardId])
}

/** Whether the session key may scope a card to `merchant`. */
export async function isMerchantAllowed(
  context: GiwaCardMcpContext,
  merchant: Address,
): Promise<boolean> {
  return read<boolean>(context, 'isMerchantAllowed', [
    context.vaultOwner,
    sessionAddress(context),
    merchant,
  ])
}

/** The ERC-20 every card in this vault settles in. */
export async function readPaymentToken(
  context: GiwaCardMcpContext,
): Promise<Address> {
  return read<Address>(context, 'paymentToken')
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Refuse to send a transaction the session key cannot pay for.
 *
 * Checked up front rather than letting the RPC reject it, because the node's
 * "insufficient funds" prose varies and an agent needs the one stable `NO_GAS`
 * code with the faucet instruction attached.
 */
async function assertCanPayGas(context: GiwaCardMcpContext): Promise<void> {
  const session = sessionAddress(context)
  let balance: bigint
  try {
    balance = await context.publicClient.getBalance({ address: session })
  } catch (error) {
    throw toMcpError(error, { sessionKey: session })
  }
  if (balance === 0n) throw noGasError(session)
}

async function submit(
  context: GiwaCardMcpContext,
  client: { writeContract: VaultWrite },
  functionName: string,
  args: readonly unknown[],
): Promise<VaultTxResult> {
  let hash: Hex
  try {
    hash = await client.writeContract({
      address: context.vaultAddress,
      abi: cardVaultAbi,
      functionName,
      args,
    })
  } catch (error) {
    throw toMcpError(error, { sessionKey: sessionAddress(context) })
  }

  let receipt
  try {
    receipt = await context.publicClient.waitForTransactionReceipt({ hash })
  } catch (error) {
    throw toMcpError(error, { sessionKey: sessionAddress(context) })
  }

  if (receipt.status !== 'success') {
    // A mined-but-reverted transaction carries no decodable reason here; the
    // pre-flight reads above are what produce specific errors, so this is the
    // genuinely unexplained case.
    throw new McpToolError(
      'RPC_UNAVAILABLE',
      `Transaction ${hash} was mined but reverted. Re-read the card and vault ` +
        'state before retrying.',
      { retryable: false, details: { txHash: hash } },
    )
  }

  return { txHash: hash, receipt }
}

type VaultWrite = (args: {
  address: Address
  abi: readonly unknown[]
  functionName: string
  args?: readonly unknown[]
}) => Promise<Hex>

/** A confirmed transaction and its receipt. */
export interface VaultTxResult {
  txHash: Hex
  receipt: { status: 'success' | 'reverted'; logs: readonly unknown[] }
}

/**
 * Pull the freshly minted card id out of a receipt's `CardMinted` event.
 *
 * `mintCard` returns the id in Solidity, but a transaction has no return value
 * offchain — the event is the only place the id exists.
 */
function cardIdFromReceipt(receipt: {
  logs: readonly unknown[]
}): bigint | null {
  const events = parseEventLogs({
    abi: cardVaultAbi,
    eventName: 'CardMinted',
    // viem's `Log` shape is stricter than the structural receipt we accept.
    logs: receipt.logs as never,
  })
  const first = events[0]
  return first ? (first.args.cardId as bigint) : null
}

export interface MintCardInput {
  cap: bigint
  merchantScope: Address
  /** Unix seconds. */
  expiry: bigint
}

/** Outcome of a successful mint, by either path. */
export interface MintResult {
  cardId: bigint
  txHash: Hex
}

/**
 * KTD-2, in-policy path: the session EOA calls `mintCard` itself.
 *
 * There is no signature step and no approval — the vault checks `msg.sender`
 * against the registered session-key policy, and a signature would prove
 * nothing `msg.sender` does not already prove.
 */
export async function mintCardInPolicy(
  context: GiwaCardMcpContext,
  input: MintCardInput,
): Promise<MintResult> {
  await assertCanPayGas(context)

  const { txHash, receipt } = await submit(
    context,
    context.sessionClient,
    'mintCard',
    [context.vaultOwner, input.cap, input.merchantScope, input.expiry],
  )

  const cardId = cardIdFromReceipt(receipt)
  if (cardId === null) {
    throw new McpToolError(
      'RPC_UNAVAILABLE',
      `The mint transaction ${txHash} succeeded but no CardMinted event was ` +
        'found in its receipt. Check the transaction before minting again.',
      { details: { txHash } },
    )
  }
  return { cardId, txHash }
}

/**
 * KTD-3, over-policy path: relay the vault owner's signed approval.
 *
 * Called only from `check_approval_status`, once the owner has approved. The
 * signature is read from the daemon, used here, and never returned to the agent
 * — this function is the sole reason the MCP process ever touches one.
 */
export async function mintCardWithApproval(
  context: GiwaCardMcpContext,
  approval: CardApproval,
  signature: Hex,
): Promise<MintResult> {
  await assertCanPayGas(context)

  const { txHash, receipt } = await submit(
    context,
    context.sessionClient,
    'mintCardWithApproval',
    [approval, signature],
  )

  const cardId = cardIdFromReceipt(receipt)
  if (cardId === null) {
    throw new McpToolError(
      'RPC_UNAVAILABLE',
      `The approved mint transaction ${txHash} succeeded but no CardMinted ` +
        'event was found in its receipt.',
      { details: { txHash } },
    )
  }
  return { cardId, txHash }
}

/**
 * Cancel an active card and release its escrow.
 *
 * Requires the vault-owner wallet: `CardVault.cancelCard` checks
 * `msg.sender == card.vaultOwner`, and a session key never is. Without an
 * owner client configured this reports `OWNER_ACTION_REQUIRED` rather than
 * sending a transaction that would certainly revert.
 */
export async function cancelCard(
  context: GiwaCardMcpContext,
  cardId: bigint,
): Promise<Hex> {
  const owner = context.ownerClient
  if (!owner) {
    throw new McpToolError(
      'OWNER_ACTION_REQUIRED',
      `Cancelling card ${cardId} releases escrow from the vault owner's ` +
        'balance, so only the owner can do it. This MCP server holds a session ' +
        'key, not the owner key. Ask the user to run `giwacard cancel ' +
        `${cardId}\` or cancel it from the dashboard.`,
      { details: { cardId: cardId.toString() } },
    )
  }

  await assertCanPayGas(context)
  const { txHash } = await submit(context, owner, 'cancelCard', [cardId])
  return txHash
}

/* -------------------------------------------------------------------------- */
/* KTD-9: paying a merchant                                                   */
/* -------------------------------------------------------------------------- */

/** The payload carried by the `X-PAYMENT` header, before base64 encoding. */
export interface GiwaCardPaymentPayload {
  scheme: 'giwacard-charge'
  /** Chain the charge settled on, so the facilitator looks in the right place. */
  network: string
  vault: Address
  cardId: string
  amount: string
  merchant: Address
  /** The facilitator verifies the `CardCharged` event in this transaction. */
  txHash: Hex
}

/** A completed payment: the settled charge plus the header to send with it. */
export interface PaymentResult {
  payload: GiwaCardPaymentPayload
  /** Base64 JSON, the value of the `X-PAYMENT` header. */
  header: string
  txHash: Hex
  /** Unspent cap returned to the vault owner's available balance. */
  released: bigint
}

export interface PayMerchantInput {
  cardId: bigint
  amount: bigint
  merchant: Address
}

/**
 * Charge a card and produce the `X-PAYMENT` header for the merchant (KTD-9).
 *
 * Internal by construction: no MCP tool exposes it, and an agent never handles
 * payment material itself. The flow is submit `CardVault.charge(cardId,
 * amount)`, read the `CardCharged` event back out of the receipt, and hand the
 * merchant a header naming the transaction — the facilitator verifies the event
 * onchain rather than trusting anything in the header.
 *
 * The vault settles a charge to `msg.sender` and enforces
 * `card.merchantScope == msg.sender`, so a scope mismatch surfaces here as AE7
 * {@link merchantOutOfScopeError}.
 */
export async function payMerchant(
  context: GiwaCardMcpContext,
  input: PayMerchantInput,
): Promise<PaymentResult> {
  await assertCanPayGas(context)

  const { txHash, receipt } = await submit(context, context.sessionClient, 'charge', [
    input.cardId,
    input.amount,
  ])

  const charged = parseEventLogs({
    abi: cardVaultAbi,
    eventName: 'CardCharged',
    logs: receipt.logs as never,
  })[0]

  if (!charged) {
    throw new McpToolError(
      'RPC_UNAVAILABLE',
      `The charge transaction ${txHash} succeeded but emitted no CardCharged ` +
        'event, so there is nothing the merchant can verify. Do not retry ' +
        'blindly — re-read the card first.',
      { details: { txHash } },
    )
  }

  if (
    (charged.args.merchant as string).toLowerCase() !==
    input.merchant.toLowerCase()
  ) {
    throw merchantOutOfScopeError(input.merchant, 'charge')
  }

  const payload: GiwaCardPaymentPayload = {
    scheme: 'giwacard-charge',
    network: context.facilitator?.network ?? 'giwa-sepolia',
    vault: context.vaultAddress,
    cardId: input.cardId.toString(),
    amount: (charged.args.amount as bigint).toString(),
    merchant: input.merchant,
    txHash,
  }

  return {
    payload,
    header: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
    txHash,
    released: charged.args.released as bigint,
  }
}

/* -------------------------------------------------------------------------- */
/* Policy evaluation (KTD-2 vs KTD-3)                                         */
/* -------------------------------------------------------------------------- */

/** Why a requested card does not fit the session key's policy. */
export type OverPolicyReason =
  | 'cap_per_card'
  | 'daily_cap'
  | 'max_expiry'

/** Whether a requested card can be minted directly, and if not, why not. */
export type PolicyVerdict =
  | { fits: true; snapshot: PolicySnapshot }
  | {
      fits: false
      snapshot: PolicySnapshot
      reasons: OverPolicyReason[]
      /** One human sentence per reason, stored on the approval request. */
      explanation: string
    }

/**
 * Decide the mint path for a requested card.
 *
 * Only the *quantitative* limits make a request over-policy: cap, daily total
 * and lifetime are all things a vault owner can reasonably say yes to on the
 * spot. Two conditions are deliberately **not** treated as over-policy and are
 * raised as errors by the caller instead:
 *
 * - **Merchant not allowlisted (AE7).** The allowlist is a categorical scope
 *   decision, not a number to negotiate. Queueing unknown merchants would let
 *   an agent walk the owner through arbitrary payees one approval prompt at a
 *   time, which is precisely the consent-fatigue attack the two-tier model is
 *   supposed to prevent.
 * - **Insufficient available balance (AE5).** The owner approving does not
 *   create funds; `mintCardWithApproval` checks the same balance and would
 *   revert. Queueing it would waste the owner's attention on a certain failure.
 *
 * A revoked session key short-circuits both paths — a revoked key cannot mint
 * and should not be able to queue either.
 */
export function evaluatePolicy(
  snapshot: PolicySnapshot,
  input: MintCardInput,
  now: bigint,
): PolicyVerdict {
  const reasons: OverPolicyReason[] = []
  const sentences: string[] = []

  if (input.cap > snapshot.policy.capPerCard) {
    reasons.push('cap_per_card')
    sentences.push(
      `cap ${input.cap} exceeds the per-card limit of ${snapshot.policy.capPerCard}`,
    )
  }

  if (snapshot.mintedToday + input.cap > snapshot.policy.dailyCap) {
    reasons.push('daily_cap')
    sentences.push(
      `this would take today's total to ${snapshot.mintedToday + input.cap}, ` +
        `past the daily cap of ${snapshot.policy.dailyCap}`,
    )
  }

  const latestAllowed = now + snapshot.policy.maxExpiry
  if (input.expiry > latestAllowed) {
    reasons.push('max_expiry')
    sentences.push(
      `expiry ${input.expiry} is later than the longest lifetime this key may ` +
        `request (${latestAllowed})`,
    )
  }

  if (reasons.length === 0) return { fits: true, snapshot }
  return {
    fits: false,
    snapshot,
    reasons,
    explanation: `Over policy: ${sentences.join('; ')}.`,
  }
}
