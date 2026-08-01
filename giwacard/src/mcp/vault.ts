import {
  getAddress,
  isAddress,
  isHex,
  parseEventLogs,
  type Address,
  type Hex,
} from 'viem'

import {
  cardVaultAbi,
  type CardApproval,
  type VaultCard,
  type VaultSessionPolicy,
} from '../chain/cardVaultAbi.js'
import {
  sessionAddress,
  type FacilitatorFetch,
  type FacilitatorResponse,
  type GiwaCardMcpContext,
} from './context.js'
import {
  McpToolError,
  merchantRefusalError,
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
 *
 * The KTD-9 pay flow lives at the bottom of this file and is the one thing here
 * that is *not* a chain call: since the merchant submits `CardVault.charge`,
 * paying is an HTTP request naming a card. It is kept alongside the vault code
 * because the thing it presents — a cardId — is minted by the code above it.
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
        'key, not the owner key. Ask the user to run `giwacard revoke card ' +
        `${cardId}\` or cancel it from the dashboard.`,
      { details: { cardId: cardId.toString() } },
    )
  }

  await assertCanPayGas(context)
  const { txHash } = await submit(context, owner, 'cancelCard', [cardId])
  return txHash
}

/* -------------------------------------------------------------------------- */
/* KTD-9: presenting a card to a merchant                                     */
/* -------------------------------------------------------------------------- */

/**
 * ## Which way the money moves
 *
 * `CardVault.charge` requires `msg.sender == card.merchantScope` and transfers
 * the funds to `msg.sender`. So the **merchant** submits it, exactly like a real
 * card: the holder presents the card, and the merchant is the one who runs it.
 * This client never calls `charge` — if it did, the vault would revert with
 * `MerchantScopeMismatch` and nobody would be paid.
 *
 * What that leaves on this side is pleasantly small, and worth stating because
 * it is easy to reintroduce the old shape by accident:
 *
 * - no transaction, therefore **no gas**: presenting a card costs the session
 *   key nothing, and `NO_GAS` is not reachable from this path;
 * - no receipt to hand over, therefore no `txHash` in `X-PAYMENT` — the header
 *   carries the **cardId**, plus the vault and chain the client expects, so a
 *   misconfigured merchant refuses rather than charging through some other
 *   contract;
 * - the settlement transaction hash comes **back**, in `PAYMENT-RESPONSE`. It is
 *   a public identifier and is surfaced to the agent as `txHash`, a field name
 *   the redaction backstop allowlists (`redact.ts`, `PUBLIC_HASH_FIELD_NAMES`).
 *
 * Everything else in the merchant's response is text a stranger wrote. Only the
 * fields below are read out of it, each validated by shape; the merchant's own
 * prose never becomes an agent-facing error message (AE7).
 */

/** Chain id of GIWA Sepolia, used when no facilitator config overrides it. */
const GIWA_SEPOLIA_CHAIN_ID = 91_342

/** Scheme id shared with `merchant/src/x402.ts`. Must match byte for byte. */
export const GIWA_VAULT_CHARGE_SCHEME = 'giwa-vault-charge' as const

/** x402 protocol version this client speaks. */
export const X402_VERSION = 1 as const

/** Request header naming the card being presented. */
export const PAYMENT_HEADER = 'X-PAYMENT' as const

/** Response header carrying the merchant's settlement receipt. */
export const PAYMENT_RESPONSE_HEADER = 'PAYMENT-RESPONSE' as const

/** The payload carried by the `X-PAYMENT` header, before base64 encoding. */
export interface GiwaCardPaymentPayload {
  x402Version: typeof X402_VERSION
  scheme: typeof GIWA_VAULT_CHARGE_SCHEME
  /** Network the card must be settled on. */
  network: string
  payload: {
    /** The card being presented. The merchant charges this and nothing else. */
    cardId: string
    /** Vault the card lives in; the merchant refuses if it settles elsewhere. */
    vault: Address
    /** Chain id the card lives on. */
    chainId: number
  }
}

/**
 * The merchant's settlement receipt, reduced to the fields we can validate.
 *
 * Deliberately *not* the merchant's JSON passed through: a receipt is written by
 * the counterparty, and an agent reads whatever we return. Every field here is
 * shape-checked before it survives the copy.
 */
export interface PaymentSettlement {
  /** The merchant's own `CardVault.charge` transaction. Public. */
  txHash: Hex
  /** Card the merchant charged. Should be the one presented. */
  cardId: string
  /** Amount moved, in token base units. */
  amount: string
  /** Unspent cap returned to the vault owner's available balance. */
  released: string
  /** Address the merchant paid itself — the card's `merchantScope`. */
  payee: Address
  /** Vault that emitted the verified `CardCharged` event. */
  vault: Address
  /** Block the settlement landed in. */
  blockNumber: string
}

/** A completed payment: what was sent, what came back, and the product. */
export interface PaymentResult {
  /** Decoded form of the `X-PAYMENT` header that was sent. */
  payload: GiwaCardPaymentPayload
  /** Base64 JSON, the exact value of the `X-PAYMENT` header. */
  header: string
  /** HTTP status of the paid response. Always 2xx here; failures throw. */
  status: number
  /**
   * The merchant's settlement receipt, or `null` when it served the product
   * without one. Absent proof is not a reason to reject a product we asked for
   * and received, but it *is* worth the agent knowing.
   */
  settlement: PaymentSettlement | null
  /**
   * Settlement transaction hash, hoisted for convenience. Public, and named so
   * the redaction backstop lets it through.
   */
  txHash: Hex | null
  /** The merchant's response body: the product. Untrusted content. */
  body: unknown
}

export interface PayMerchantInput {
  /** Card to present. Minted scoped to this merchant. */
  cardId: bigint
  /** Absolute URL of the paid resource, from the merchant's 402 requirements. */
  resource: string
}

/** Build the `X-PAYMENT` payload for a card. Pure, so it is trivially testable. */
export function buildPaymentPayload(
  context: GiwaCardMcpContext,
  cardId: bigint,
): GiwaCardPaymentPayload {
  return {
    x402Version: X402_VERSION,
    scheme: GIWA_VAULT_CHARGE_SCHEME,
    network: context.facilitator?.network ?? 'giwa-sepolia',
    payload: {
      cardId: cardId.toString(),
      vault: context.vaultAddress,
      chainId: context.facilitator?.chainId ?? GIWA_SEPOLIA_CHAIN_ID,
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A decimal string, or `null` if the merchant sent something else. */
function decimalField(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  if (typeof value === 'string' && /^\d+$/.test(value)) return value
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return String(value)
  }
  return null
}

/** A 20-byte address, or `null`. */
function addressField(source: Record<string, unknown>, key: string): Address | null {
  const value = source[key]
  return typeof value === 'string' && isAddress(value) ? getAddress(value) : null
}

/** A 32-byte hash, or `null`. */
function hashField(source: Record<string, unknown>, key: string): Hex | null {
  const value = source[key]
  if (typeof value !== 'string' || !isHex(value) || value.length !== 66) return null
  return value.toLowerCase() as Hex
}

/**
 * Decode a `PAYMENT-RESPONSE` header into the fields we are willing to repeat.
 *
 * Returns `null` rather than throwing when the receipt is missing or unreadable:
 * the merchant already served the product, and refusing to return a report we
 * paid for because its receipt was malformed would be a strange trade.
 */
export function parseSettlementHeader(raw: string | null): PaymentSettlement | null {
  if (raw === null || raw.trim() === '') return null

  let decoded: unknown
  try {
    const text = raw.trim().startsWith('{')
      ? raw.trim()
      : Buffer.from(raw.trim(), 'base64').toString('utf8')
    decoded = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(decoded)) return null

  const txHash = hashField(decoded, 'transaction')
  const payee = addressField(decoded, 'payee')
  const vault = addressField(decoded, 'vault')
  const cardId = decimalField(decoded, 'cardId')
  const amount = decimalField(decoded, 'amount')
  if (txHash === null || payee === null || vault === null || cardId === null) {
    return null
  }

  return {
    txHash,
    cardId,
    amount: amount ?? '0',
    released: decimalField(decoded, 'released') ?? '0',
    payee,
    vault,
    blockNumber: decimalField(decoded, 'blockNumber') ?? '0',
  }
}

/* -------------------------------------------------------------------------- */
/* Discovering what a paid resource costs (the 402)                           */
/* -------------------------------------------------------------------------- */

/**
 * The `accepts[0]` fields this client is willing to act on.
 *
 * A strict subset of what the merchant sends, copied field by field after a
 * shape check, for the same reason {@link PaymentSettlement} is: the 402 body is
 * the one part of the exchange an attacker controls for free, and everything in
 * here ends up informing a spend decision.
 */
export interface MerchantPaymentRequirements {
  /** Payment scheme the merchant implements. */
  scheme: string
  /** Network slug the merchant settles on. */
  network: string
  /** Price in token base units, as a decimal string. */
  maxAmountRequired: string
  /** The address that will charge the card — the card's `merchantScope`. */
  payTo: Address
  /** `CardVault` the merchant settles through. */
  vault: Address
  /** Chain id the charge will land on. */
  chainId: number
}

/** What an unpaid request to a resource turned out to be. */
export type MerchantProbe =
  /** The ordinary case: the merchant wants a card. */
  | { status: 'payment_required'; requirements: MerchantPaymentRequirements }
  /** The resource was served without payment. Nothing to mint, nothing to spend. */
  | { status: 'free'; httpStatus: number; body: unknown }

function readRequirements(body: unknown): Record<string, unknown> | null {
  if (!isRecord(body)) return null
  const accepts = body['accepts']
  const first = Array.isArray(accepts) ? accepts[0] : undefined
  return isRecord(first) ? first : null
}

/**
 * Ask a paid resource what it costs, without presenting anything.
 *
 * This is step one of the 402 exchange and the only step that is allowed to
 * fail cheaply: no card exists yet, so nothing can be spent, expired or
 * double-charged by getting it wrong.
 *
 * The **venue checks are the point**. A merchant states which vault and which
 * chain it settles through; if either disagrees with this server's, the card we
 * would mint could not be charged there — and in the worst reading, we would be
 * minting against an attacker's contract because a 402 body said so. So a
 * mismatch is refused here, before a card is minted, rather than discovered
 * after the escrow is locked.
 *
 * @throws {McpToolError} `INVALID_REQUEST` when the merchant is unreachable in
 * the protocol sense — no 402, no readable requirements, a scheme this client
 * cannot settle, or a vault/chain that is not ours; `RPC_UNAVAILABLE` when the
 * merchant itself is down.
 */
export async function probeMerchant(
  context: GiwaCardMcpContext,
  resource: string,
): Promise<MerchantProbe> {
  const fetchImpl: FacilitatorFetch = context.facilitator?.fetch ?? globalThis.fetch
  const expectedChainId = context.facilitator?.chainId ?? GIWA_SEPOLIA_CHAIN_ID

  let response: FacilitatorResponse
  try {
    response = await fetchImpl(resource, { headers: {} })
  } catch (cause) {
    throw new McpToolError(
      'RPC_UNAVAILABLE',
      `The merchant at ${resource} could not be reached. No card was minted ` +
        'and nothing was spent. Retry in a few seconds.',
      { retryable: true, cause, details: { resource } },
    )
  }

  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    // Left null; the branches below each say what that means for them.
  }

  if (response.ok) {
    return { status: 'free', httpStatus: response.status, body }
  }

  if (response.status >= 500) {
    throw new McpToolError(
      'RPC_UNAVAILABLE',
      `The merchant at ${resource} failed with HTTP ${response.status} before ` +
        'quoting a price. No card was minted and nothing was spent. Retry once.',
      { retryable: true, details: { resource, httpStatus: response.status } },
    )
  }

  if (response.status !== 402) {
    throw new McpToolError(
      'INVALID_REQUEST',
      `The merchant at ${resource} answered HTTP ${response.status} rather ` +
        'than the 402 that quotes a price, so there is nothing to pay. No card ' +
        'was minted. Check the URL.',
      { details: { resource, httpStatus: response.status } },
    )
  }

  const accepts = readRequirements(body)
  const payTo = accepts ? addressField(accepts, 'payTo') : null
  const price = accepts ? decimalField(accepts, 'maxAmountRequired') : null
  if (!accepts || payTo === null || price === null) {
    throw new McpToolError(
      'INVALID_REQUEST',
      `The merchant at ${resource} asked for payment but its 402 does not say ` +
        'who to pay or how much, so no card can be scoped to it. No card was ' +
        'minted. This is a merchant-side protocol error, not something to retry.',
      { details: { resource } },
    )
  }

  const scheme = typeof accepts['scheme'] === 'string' ? accepts['scheme'] : ''
  if (scheme !== GIWA_VAULT_CHARGE_SCHEME) {
    throw new McpToolError(
      'INVALID_REQUEST',
      `The merchant at ${resource} settles with the "${scheme}" scheme, which ` +
        `this vault cannot pay — it issues ${GIWA_VAULT_CHARGE_SCHEME} cards. ` +
        'No card was minted. Nothing can be retried here; the merchant is not ' +
        'compatible with GiwaCard.',
      { details: { resource, scheme } },
    )
  }

  const extra = isRecord(accepts['extra']) ? accepts['extra'] : {}
  const vault = addressField(extra, 'vault')
  const chainIdRaw = extra['chainId']
  const chainId =
    typeof chainIdRaw === 'number' && Number.isSafeInteger(chainIdRaw)
      ? chainIdRaw
      : null

  if (vault === null || vault.toLowerCase() !== context.vaultAddress.toLowerCase()) {
    throw new McpToolError(
      'INVALID_REQUEST',
      `The merchant at ${resource} settles through CardVault ` +
        `${vault ?? 'an unstated address'}, not ${context.vaultAddress}. A ` +
        'card from this vault could not be charged there. No card was minted ' +
        'and nothing was spent — do not present a card to this merchant.',
      { details: { resource, merchantVault: vault ?? null } },
    )
  }

  if (chainId !== null && chainId !== expectedChainId) {
    throw new McpToolError(
      'INVALID_REQUEST',
      `The merchant at ${resource} settles on chain ${chainId}, not ` +
        `${expectedChainId}. No card was minted and nothing was spent.`,
      { details: { resource, merchantChainId: chainId } },
    )
  }

  const network =
    typeof accepts['network'] === 'string'
      ? accepts['network']
      : (context.facilitator?.network ?? 'giwa-sepolia')

  return {
    status: 'payment_required',
    requirements: {
      scheme,
      network,
      maxAmountRequired: price,
      payTo,
      vault,
      chainId: chainId ?? expectedChainId,
    },
  }
}

/**
 * Present a card to a merchant and collect the product it sells (KTD-9).
 *
 * The whole client-side flow is one request carrying one header. The merchant
 * charges the card, verifies its own transaction, and returns the product with
 * a `PAYMENT-RESPONSE` receipt naming the settlement. The `X-PAYMENT` header is
 * built and sent **here**, inside the server: R10b says the agent never
 * constructs payment-bearing material, which is only true if the exchange
 * happens on this side of the tool boundary. `pay_merchant` is the tool that
 * calls it; nothing hands the header out.
 *
 * Failures are mapped through {@link mapMerchantRefusal}, so a card that is
 * spent, expired or scoped elsewhere reaches the agent as the same stable code
 * it would have got from a local revert.
 *
 * @throws {McpToolError} for any non-2xx response, or an unreachable merchant.
 */
export async function payMerchant(
  context: GiwaCardMcpContext,
  input: PayMerchantInput,
): Promise<PaymentResult> {
  const payload = buildPaymentPayload(context, input.cardId)
  const header = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
  const fetchImpl: FacilitatorFetch = context.facilitator?.fetch ?? globalThis.fetch

  let response: FacilitatorResponse
  try {
    response = await fetchImpl(input.resource, {
      headers: { [PAYMENT_HEADER]: header },
    })
  } catch (cause) {
    throw new McpToolError(
      'RPC_UNAVAILABLE',
      `The merchant at ${input.resource} could not be reached. Nothing was ` +
        'charged — the card is still spendable. Retry in a few seconds.',
      { retryable: true, cause, details: { cardId: input.cardId.toString() } },
    )
  }

  if (!response.ok) {
    throw await mapMerchantRefusal(response, input.cardId)
  }

  const settlement = parseSettlementHeader(
    response.headers.get(PAYMENT_RESPONSE_HEADER),
  )

  let body: unknown
  try {
    body = await response.json()
  } catch {
    // A merchant that served 200 with an unreadable body still charged the
    // card, so this is not a payment failure; the agent gets the receipt and an
    // empty product rather than an error that invites a second card.
    body = null
  }

  return {
    payload,
    header,
    status: response.status,
    settlement,
    txHash: settlement?.txHash ?? null,
    body,
  }
}

/**
 * Turn a merchant's refusal into the agent-facing taxonomy.
 *
 * Only the machine-readable `reason` and the advertised `payTo` are read out of
 * the body; the merchant's prose is never quoted back to the agent. That is not
 * fastidiousness — a paid API that can put text into an agent's context is a
 * prompt-injection surface, and the 402 body is the one part of the exchange an
 * attacker controls for free (AE7).
 */
async function mapMerchantRefusal(
  response: FacilitatorResponse,
  cardId: bigint,
): Promise<McpToolError> {
  let reason: string | null = null
  let payTo: Address | null = null
  try {
    const body: unknown = await response.json()
    if (isRecord(body)) {
      if (typeof body['reason'] === 'string') reason = body['reason']
      const accepts = body['accepts']
      const first = Array.isArray(accepts) ? accepts[0] : undefined
      if (isRecord(first)) payTo = addressField(first, 'payTo')
    }
  } catch {
    // A refusal with no readable body still refuses; fall through to the
    // status-based mapping below.
  }

  return merchantRefusalError({
    reason,
    status: response.status,
    cardId: cardId.toString(),
    merchant: payTo,
  })
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
