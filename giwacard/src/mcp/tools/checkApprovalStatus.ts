import { isAddress, isHex, type Hex } from 'viem'
import { z } from 'zod'

import type { CardApproval } from '../../chain/cardVaultAbi.js'
import type { ApprovalRecordWire } from '../approvals.js'
import { McpToolError } from '../errors.js'
import { mintCardWithApproval } from '../vault.js'
import { defineTool, parseAddress } from './define.js'

/**
 * `check_approval_status` — how an agent discovers the card an owner approved.
 *
 * This is the stateless half of the over-policy flow (KTD-3, R10b). Everything
 * it needs lives in the daemon, so it works when the session that filed the
 * request is long gone: a new process, a new agent run, days later. The
 * `approval_id` is the only thing the agent has to have kept.
 *
 * When the owner has approved and no card exists yet, this tool completes the
 * mint: it reads the owner's signature from the local daemon, relays
 * `mintCardWithApproval`, and tells the daemon to delete the signature (KTD-16).
 * That relay is the *only* place in this package that touches an owner
 * signature, and it never leaves this process — the agent receives a `card_id`
 * and nothing else. Handing the agent the signature would hand it a reusable
 * authorisation, which is the exact thing the approval flow exists to withhold.
 */

const inputSchema = z.object({
  approval_id: z
    .string()
    .min(1)
    .max(200)
    .describe('The approval_id returned by mint_card when it queued a request.'),
})

/** Fields of the stored request that must be present to rebuild a CardApproval. */
function requireString(
  request: Record<string, unknown>,
  field: string,
  approvalId: string,
): string {
  const value = request[field]
  if (typeof value !== 'string' || value === '') {
    throw new McpToolError(
      'INVALID_REQUEST',
      `Approval request ${approvalId} is missing "${field}" and cannot be ` +
        'relayed. Ask the user to re-approve, or file a new request.',
      { details: { approvalId, field } },
    )
  }
  return value
}

/**
 * Rebuild the `CardApproval` struct the owner signed.
 *
 * The stored request is schemaless by design (the daemon must survive contract
 * changes), so every field is validated here rather than trusted. A mismatch
 * means the signature would not verify anyway; failing loudly beats burning gas
 * to find out.
 */
function toCardApproval(
  record: ApprovalRecordWire,
): CardApproval {
  const request = record.request
  const address = (field: string): Hex => {
    const value = requireString(request, field, record.id)
    if (!isAddress(value)) {
      throw new McpToolError(
        'INVALID_REQUEST',
        `Approval request ${record.id} has a malformed "${field}".`,
        { details: { approvalId: record.id, field } },
      )
    }
    return parseAddress(value)
  }
  const amount = (field: string): bigint => {
    const value = requireString(request, field, record.id)
    if (!/^\d+$/.test(value)) {
      throw new McpToolError(
        'INVALID_REQUEST',
        `Approval request ${record.id} has a malformed "${field}".`,
        { details: { approvalId: record.id, field } },
      )
    }
    return BigInt(value)
  }

  const approvalId = requireString(request, 'approvalId', record.id)
  if (!isHex(approvalId) || approvalId.length !== 66) {
    throw new McpToolError(
      'INVALID_REQUEST',
      `Approval request ${record.id} has a malformed "approvalId".`,
      { details: { approvalId: record.id, field: 'approvalId' } },
    )
  }

  return {
    vaultOwner: address('vaultOwner'),
    agent: address('agent'),
    token: address('token'),
    cap: amount('cap'),
    merchantScope: address('merchantScope'),
    expiry: amount('expiry'),
    approvalId,
  }
}

/** Non-secret summary of what the owner was asked to approve. */
function requestSummary(record: ApprovalRecordWire): Record<string, unknown> {
  const request = record.request
  return {
    amount: typeof request['cap'] === 'string' ? request['cap'] : null,
    merchant:
      typeof request['merchantScope'] === 'string'
        ? request['merchantScope']
        : null,
    expires_at:
      typeof request['expiry'] === 'string' ? Number(request['expiry']) : null,
  }
}

export const checkApprovalStatusTool = defineTool({
  name: 'check_approval_status',
  title: 'Check approval status',
  description:
    'Check whether the human owner has approved an over-policy card request, ' +
    'using the approval_id from mint_card. Once approved, this returns the ' +
    'card_id of the newly minted card. Safe to poll, and works from a fresh ' +
    'session — you only need the approval_id.',
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  inputSchema,
  async handler(args, context) {
    const record = await context.approvals.get(args.approval_id)
    const summary = requestSummary(record)

    if (record.status === 'pending') {
      return {
        approval_id: record.id,
        status: 'pending',
        ...summary,
        approval_expires_at: record.expiresAt,
        message:
          'The vault owner has not decided yet. Poll again in a few seconds. ' +
          'You cannot approve this yourself — only the owner can, from the ' +
          'giwacard CLI or dashboard.',
      }
    }

    if (record.status === 'denied') {
      return {
        approval_id: record.id,
        status: 'denied',
        ...summary,
        note: record.decisionNote,
        message:
          `The vault owner denied this request${
            record.decisionNote ? `: ${record.decisionNote}` : '.'
          } This is final — do not re-file the same request.`,
      }
    }

    if (record.status === 'expired') {
      return {
        approval_id: record.id,
        status: 'expired',
        ...summary,
        message:
          'This request expired before the owner decided. Expiry is final; ' +
          'file a new request if the card is still needed.',
      }
    }

    /* ------------------------------ approved ------------------------------- */

    // Already minted — by an earlier poll, possibly in a session that has since
    // ended. This is the branch that makes discovery stateless.
    if (record.cardId !== null && record.cardId !== '') {
      return {
        approval_id: record.id,
        status: 'approved',
        card_id: record.cardId,
        ...summary,
        mint_tx_hash: record.mintTxHash,
        message:
          `Approved and minted. Card ${record.cardId} is ready to use at ` +
          `${summary['merchant'] ?? 'its scoped merchant'}.`,
      }
    }

    if (record.ownerSignature === null || record.ownerSignature === '') {
      throw new McpToolError(
        'INVALID_REQUEST',
        `Approval request ${record.id} is approved but its owner signature has ` +
          'already been spent and no card id was recorded. Check the dashboard ' +
          'for the resulting card before requesting another.',
        { details: { approvalId: record.id } },
      )
    }

    const approval = toCardApproval(record)
    const signature = record.ownerSignature as Hex
    const { cardId, txHash } = await mintCardWithApproval(
      context,
      approval,
      signature,
    )

    // Tell the daemon the signature is spent so it deletes it (KTD-16), and
    // record the card id so a later poll — from any session — finds it above.
    await context.approvals.markConsumed(record.id, {
      cardId: cardId.toString(),
      mintTxHash: txHash,
    })

    return {
      approval_id: record.id,
      status: 'approved',
      card_id: cardId.toString(),
      ...summary,
      mint_tx_hash: txHash,
      message:
        `The vault owner approved this request. Card ${cardId} is now active ` +
        `for up to ${approval.cap} at ${approval.merchantScope}.`,
    }
  },
})
