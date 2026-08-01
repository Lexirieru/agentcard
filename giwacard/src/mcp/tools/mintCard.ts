import { randomBytes } from 'node:crypto'
import { z } from 'zod'

import type { Hex } from '../../chain/keystore.js'
import { nowSeconds, sessionAddress } from '../context.js'
import {
  McpToolError,
  approvalPendingError,
  insufficientAvailableBalanceError,
  merchantOutOfScopeError,
  sessionKeyRevokedError,
} from '../errors.js'
import {
  evaluatePolicy,
  isMerchantAllowed,
  mintCardInPolicy,
  readBalances,
  readPaymentToken,
  readPolicy,
} from '../vault.js'
import {
  addressSchema,
  amountSchema,
  defineTool,
  parseAddress,
  parseAmount,
} from './define.js'

/** Default card lifetime when the agent does not ask for one: one hour. */
export const DEFAULT_CARD_TTL_SECONDS = 3600

/**
 * `mint_card` — the only tool that can move value, and the fork between the
 * two consent tiers (KTD-2, KTD-3).
 *
 * The decision is made *before* anything is submitted:
 *
 * - **In policy** → the session EOA calls `mintCard` directly and the agent gets
 *   a `card_id`. There is no signature step; the vault checks `msg.sender`
 *   against the registered session-key policy.
 * - **Over policy** → **no transaction is attempted at all.** A transaction
 *   would revert, burn the session key's gas, and teach the agent nothing. The
 *   request is queued for the owner instead and the agent gets an `approval_id`
 *   to poll with `check_approval_status`.
 *
 * Two failure modes are checked ahead of the policy fork and are never queued —
 * see {@link evaluatePolicy} for why an unknown merchant (AE7) and an empty
 * balance (AE5) are errors rather than approval prompts.
 */

const inputSchema = z.object({
  amount: amountSchema.describe(
    'Maximum chargeable amount, in base units of the vault payment token. ' +
      'The full amount is escrowed at mint and the unspent remainder returns ' +
      'to the vault when the card is charged.',
  ),
  merchant: addressSchema.describe(
    'The only address allowed to charge this card. Must already be on the ' +
      "session key's allowlist.",
  ),
  expires_in_seconds: z
    .number()
    .int()
    .positive()
    .max(365 * 24 * 3600)
    .optional()
    .describe(
      `How long the card stays chargeable. Defaults to ${DEFAULT_CARD_TTL_SECONDS}s.`,
    ),
  reason: z
    .string()
    .max(500)
    .optional()
    .describe(
      'Why this card is needed. Shown to the human owner when the request is ' +
        'over policy, so write it for them.',
    ),
  idempotency_key: z
    .string()
    .max(200)
    .optional()
    .describe(
      'Retry-safe key. Reusing it never files a second approval request; it ' +
        'returns APPROVAL_PENDING while the original is undecided.',
    ),
})

/** A fresh single-use `approvalId` for the EIP-712 payload the owner signs. */
function newApprovalId(): Hex {
  return `0x${randomBytes(32).toString('hex')}`
}

export const mintCardTool = defineTool({
  name: 'mint_card',
  title: 'Mint a virtual card',
  description:
    'Mint a single-use virtual card scoped to one merchant, backed by escrowed ' +
    'funds from the vault. Returns a card_id when the request fits the session ' +
    "key's policy. When it does not, nothing is submitted onchain: the request " +
    'is queued for the human owner and an approval_id is returned instead — ' +
    'poll it with check_approval_status.',
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  inputSchema,
  async handler(args, context) {
    const cap = parseAmount(args.amount, 'amount')
    const merchant = parseAddress(args.merchant)
    const now = nowSeconds(context)
    const expiry = now + BigInt(args.expires_in_seconds ?? DEFAULT_CARD_TTL_SECONDS)
    const session = sessionAddress(context)

    const snapshot = await readPolicy(context)
    if (!snapshot.policy.active) {
      throw sessionKeyRevokedError(session, context.vaultOwner)
    }

    // AE7 before anything else: a merchant outside scope cannot be fixed by
    // approval, so there is nothing to queue and nothing to submit.
    if (!(await isMerchantAllowed(context, merchant))) {
      throw merchantOutOfScopeError(merchant, 'mint')
    }

    // AE5: the owner-signed path checks the same balance, so queueing a request
    // that cannot be funded would only waste the owner's attention.
    const balances = await readBalances(context)
    if (balances.available < cap) {
      throw insufficientAvailableBalanceError(balances.available, cap)
    }

    const verdict = evaluatePolicy(snapshot, { cap, merchantScope: merchant, expiry }, now)

    if (verdict.fits) {
      const { cardId, txHash } = await mintCardInPolicy(context, {
        cap,
        merchantScope: merchant,
        expiry,
      })
      return {
        status: 'minted',
        card_id: cardId.toString(),
        amount: cap.toString(),
        merchant,
        expires_at: Number(expiry),
        mint_tx_hash: txHash,
        path: 'in_policy',
        message:
          `Card ${cardId} is active for up to ${cap} at ${merchant}. It can be ` +
          'charged exactly once.',
      }
    }

    /* ------------------------- over policy: queue only ---------------------- */

    const token = await readPaymentToken(context)
    const approvalRequest = {
      // The exact CardApproval the owner's client will sign (CardTypes.sol).
      // Stored verbatim so the signature commits to the terms this server later
      // relays — see check_approval_status.
      vaultOwner: context.vaultOwner,
      agent: session,
      token,
      cap: cap.toString(),
      merchantScope: merchant,
      expiry: expiry.toString(),
      approvalId: newApprovalId(),
      // Domain context the owner's signer needs but the struct does not carry.
      vault: context.vaultAddress,
    }

    const { record, created } = await context.approvals.create({
      sessionKey: session,
      request: approvalRequest,
      reason: args.reason ?? verdict.explanation,
      agent: context.agentLabel ?? null,
      idempotencyKey: args.idempotency_key ?? null,
    })

    if (!created) {
      // A replayed idempotency key. Answer with the state of the original.
      if (record.status === 'pending') throw approvalPendingError(record.id)
      if (record.status === 'denied') {
        throw new McpToolError(
          'APPROVAL_DENIED',
          `The vault owner denied approval request ${record.id}` +
            `${record.decisionNote ? `: ${record.decisionNote}` : '.'} ` +
            'Do not re-file the same request.',
          { details: { approvalId: record.id } },
        )
      }
      if (record.status === 'expired') {
        throw new McpToolError(
          'APPROVAL_EXPIRED',
          `Approval request ${record.id} expired before the owner decided. ` +
            'File a new one with a different idempotency_key.',
          { details: { approvalId: record.id } },
        )
      }
    }

    return {
      status: 'approval_required',
      approval_id: record.id,
      amount: cap.toString(),
      merchant,
      expires_at: Number(expiry),
      over_policy_reasons: verdict.reasons,
      path: 'over_policy',
      submitted_onchain: false,
      approval_expires_at: record.expiresAt,
      message:
        `${verdict.explanation} No transaction was submitted. The request is ` +
        `queued for the vault owner as ${record.id}; poll check_approval_status ` +
        'with that approval_id. Approval is owner-only — you cannot grant it.',
    }
  },
})
