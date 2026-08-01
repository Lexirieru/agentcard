import { keccak256, toHex, type Address, type Hex } from 'viem'
import { privateKeyToAddress } from 'viem/accounts'

import {
  CARD_APPROVAL_EIP712_TYPES,
  CARD_VAULT_EIP712_DOMAIN_NAME,
  CARD_VAULT_EIP712_DOMAIN_VERSION,
  type CardApproval,
} from '../../chain/cardVaultAbi.js'
import { GIWA_SEPOLIA_ID } from '../../chain/giwaSepolia.js'
import { GUSD_DECIMALS, GUSD_SYMBOL } from '../../chain/gusdAbi.js'
import type { ApprovalRecordWire } from '../../mcp/approvals.js'
import {
  requireKey,
  requireTokenAddress,
  requireVaultAddress,
  unsealKeystore,
  type CliRuntime,
  type CliSigner,
} from '../context.js'
import {
  CliError,
  cancelledError,
  formatDuration,
  formatTimestamp,
  formatUnits,
} from '../errors.js'
import { readWizardState } from '../wizardState.js'

/**
 * `giwacard approve` — the human half of the two-tier model (F3, KTD-3).
 *
 * An over-policy card cannot be minted by the agent. The agent files a request
 * with the local daemon and stops; this command is where a person reads it,
 * decides, and — if they approve — produces the EIP-712 signature the vault will
 * check at mint time.
 *
 * Two properties are load-bearing:
 *
 * - **The daemon never holds a key.** The signature is produced here, from the
 *   owner key in the local keystore, and POSTed to the daemon for the agent to
 *   collect. The daemon stores it and deletes it once it has been spent onchain.
 * - **What is signed is what was asked.** The `CardApproval` struct is built from
 *   the stored request and sent back alongside the signature as
 *   `approvedRequest`, so the terms the agent later submits are byte-for-byte
 *   the ones the owner saw.
 */

export interface ApproveCommandOptions {
  /** Resolve this request id without showing the picker. */
  id?: string
  /** Skip the picker and act on the single pending request, if there is one. */
  yes?: boolean
}

/** The fields the CLI needs out of a stored over-policy request. */
interface RequestedCard {
  agent: Address
  cap: bigint
  merchantScope: Address
  expiry: bigint
  token?: Address
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

function asAddress(value: unknown, field: string): Address {
  if (typeof value !== 'string' || !ADDRESS_RE.test(value)) {
    throw new CliError(
      'INVALID_ARGUMENT',
      `The queued request has no usable \`${field}\`, so there is nothing safe to sign.`,
      {
        hint: 'Deny it and ask the agent to re-file the request.',
      },
    )
  }
  return value as Address
}

function asBigInt(value: unknown, field: string): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value)
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return BigInt(value)
  }
  throw new CliError(
    'INVALID_ARGUMENT',
    `The queued request has no usable \`${field}\`, so there is nothing safe to sign.`,
    { hint: 'Deny it and ask the agent to re-file the request.' },
  )
}

/**
 * Read the card terms out of a stored request.
 *
 * The queue stores the request schemalessly on purpose (see
 * `src/daemon/queue.ts`), so this is where the shape is finally asserted — and
 * it is asserted strictly. An owner must never be shown a summary the signature
 * does not actually commit to.
 */
export function parseRequestedCard(
  record: ApprovalRecordWire,
): RequestedCard {
  const request = record.request
  const token = request['token']
  return {
    agent: asAddress(request['agent'] ?? record.sessionKey, 'agent'),
    cap: asBigInt(request['cap'], 'cap'),
    merchantScope: asAddress(request['merchantScope'], 'merchantScope'),
    expiry: asBigInt(request['expiry'], 'expiry'),
    ...(typeof token === 'string' && ADDRESS_RE.test(token)
      ? { token: token as Address }
      : {}),
  }
}

/**
 * Derive the approval's replay nonce.
 *
 * `CardVault` marks `approvalId` used the moment a signature is consumed, so it
 * has to be unique per approval and stable between what is signed and what is
 * submitted. Deriving it from the request id gives both for free — and makes a
 * resumed `approve` on the same request produce the same id rather than a second
 * one the agent has no way to find.
 */
export function approvalIdFor(record: ApprovalRecordWire): Hex {
  return keccak256(toHex(`giwacard-approval:${record.id}`))
}

/** Build the exact EIP-712 struct the vault will verify. */
export function buildCardApproval(
  record: ApprovalRecordWire,
  vaultOwner: Address,
  token: Address,
): CardApproval {
  const requested = parseRequestedCard(record)
  return {
    vaultOwner,
    agent: requested.agent,
    token: requested.token ?? token,
    cap: requested.cap,
    merchantScope: requested.merchantScope,
    expiry: requested.expiry,
    approvalId: approvalIdFor(record),
  }
}

/** Sign a {@link CardApproval} under the vault's EIP-712 domain. */
export async function signCardApproval(
  signer: CliSigner,
  vault: Address,
  approval: CardApproval,
): Promise<Hex> {
  return signer.signTypedData({
    domain: {
      name: CARD_VAULT_EIP712_DOMAIN_NAME,
      version: CARD_VAULT_EIP712_DOMAIN_VERSION,
      chainId: GIWA_SEPOLIA_ID,
      verifyingContract: vault,
    },
    types: CARD_APPROVAL_EIP712_TYPES as unknown as Record<
      string,
      readonly { name: string; type: string }[]
    >,
    primaryType: 'CardApproval',
    message: {
      vaultOwner: approval.vaultOwner,
      agent: approval.agent,
      token: approval.token,
      cap: approval.cap,
      merchantScope: approval.merchantScope,
      expiry: approval.expiry,
      approvalId: approval.approvalId,
    },
  })
}

/**
 * Serialise a signed approval for the daemon.
 *
 * `bigint` is not JSON, and the decimal-string convention here has to match what
 * the MCP relay reads back — this function and `mintCardWithApproval` are the
 * two ends of that agreement.
 */
export function serializeApproval(
  approval: CardApproval,
): Record<string, unknown> {
  return {
    vaultOwner: approval.vaultOwner,
    agent: approval.agent,
    token: approval.token,
    cap: approval.cap.toString(),
    merchantScope: approval.merchantScope,
    expiry: approval.expiry.toString(),
    approvalId: approval.approvalId,
  }
}

/** One line summarising a request in the picker. */
function requestLabel(record: ApprovalRecordWire, nowMs: number): string {
  const requested = safeParse(record)
  const cap =
    requested === null
      ? 'unreadable terms'
      : `${formatUnits(requested.cap, GUSD_DECIMALS)} ${GUSD_SYMBOL}`
  const remaining = Math.max(0, record.expiresAt - nowMs)
  return (
    `${cap} · ${record.agent ?? 'unnamed agent'} · ` +
    `expires in ${formatDuration(BigInt(Math.floor(remaining / 1000)))}`
  )
}

function safeParse(record: ApprovalRecordWire): RequestedCard | null {
  try {
    return parseRequestedCard(record)
  } catch {
    return null
  }
}

/**
 * Run `giwacard approve`.
 *
 * @returns The process exit code. 0 for "nothing pending" — an empty queue is
 * the normal, healthy state, not an error.
 */
export async function runApproveCommand(
  runtime: CliRuntime,
  options: ApproveCommandOptions = {},
): Promise<number> {
  const keystore = await unsealKeystore(runtime)
  const ownerKey = requireKey(keystore, 'ownerPrivateKey')
  const owner = privateKeyToAddress(ownerKey)
  const state = readWizardState(keystore.data)
  const vault = requireVaultAddress(runtime, state.vaultAddress)
  const token = requireTokenAddress(runtime, state.tokenAddress)
  const daemon = runtime.daemon()

  /* ------------------------------------------------------------- selection */

  let record: ApprovalRecordWire
  if (options.id !== undefined) {
    record = await daemon.get(options.id)
    if (record.status !== 'pending') {
      // The already-resolved state, stated plainly. This is reachable whenever
      // the dashboard, another terminal, or the TTL got there first.
      runtime.output.line(
        `Approval ${record.id} is already ${record.status}. Nothing to do.`,
      )
      if (record.cardId) {
        runtime.output.line(`  It minted card ${record.cardId}.`)
      }
      return 0
    }
  } else {
    const pending = await daemon.list({ status: 'pending', limit: 50 })
    if (pending.requests.length === 0) {
      runtime.output.emptyState(
        'No approvals are waiting on you.',
        'Your agent files one here whenever it wants a card outside its policy. ' +
          'Run `giwacard status` to see the rest of your vault.',
      )
      return 0
    }

    if (pending.requests.length === 1 && options.yes) {
      record = pending.requests[0] as ApprovalRecordWire
    } else {
      const nowMs = runtime.now()
      record = await runtime.prompter.select<ApprovalRecordWire>({
        message: `${pending.requests.length} request(s) waiting. Which one?`,
        options: pending.requests.map((request) => ({
          value: request,
          label: requestLabel(request, nowMs),
          hint: request.reason ?? undefined,
        })),
      })
    }
  }

  /* --------------------------------------------------------------- review */

  const approval = buildCardApproval(record, owner, token)
  const nowSeconds = BigInt(Math.floor(runtime.now() / 1000))

  runtime.output.panel('Over-policy card request', [
    { label: 'Request', value: record.id },
    { label: 'Agent', value: record.agent ?? '(unnamed)' },
    { label: 'Session key', value: record.sessionKey },
    { label: 'Reason', value: record.reason ?? '(none given)' },
    {
      label: 'Cap',
      value: `${formatUnits(approval.cap, GUSD_DECIMALS)} ${GUSD_SYMBOL}`,
    },
    { label: 'Merchant', value: approval.merchantScope },
    {
      label: 'Expiry',
      value:
        `${formatTimestamp(approval.expiry)} ` +
        `(${formatDuration(
          approval.expiry > nowSeconds ? approval.expiry - nowSeconds : 0n,
        )} from now)`,
    },
    { label: 'Token', value: approval.token },
  ])

  runtime.output.line(
    'Approving signs these exact terms with your owner key. The agent submits ' +
      'the mint itself; your signature is spent once and then deleted.',
  )
  runtime.output.blank()

  /* ------------------------------------------------------------- decision */

  const decision = await runtime.prompter.select<'approve' | 'deny' | 'skip'>({
    message: 'Your decision',
    options: [
      { value: 'approve', label: 'Approve — sign these terms' },
      { value: 'deny', label: 'Deny — the agent gets a terminal refusal' },
      { value: 'skip', label: 'Skip — leave it pending' },
    ],
    initialValue: 'skip',
  })

  if (decision === 'skip') {
    runtime.output.line('Left pending. Nothing was signed.')
    return 0
  }

  if (decision === 'deny') {
    const note = runtime.prompter.interactive
      ? await runtime.prompter.text({
          message: 'Why? (optional, the agent sees this)',
          placeholder: 'too expensive for that merchant',
        })
      : ''
    const denied = await daemon.resolve(record.id, {
      decision: 'deny',
      ownerAddress: owner,
      note: note.trim() === '' ? null : note.trim(),
    })
    runtime.output.line(`Denied ${denied.id}. The agent gets a terminal refusal.`)
    return 0
  }

  /* -------------------------------------------------------------- approve */

  const confirmed = runtime.prompter.interactive
    ? await runtime.prompter.confirm({
        message:
          `Sign an approval for ${formatUnits(approval.cap, GUSD_DECIMALS)} ` +
          `${GUSD_SYMBOL} at ${approval.merchantScope}?`,
        initialValue: false,
      })
    : true
  if (!confirmed) throw cancelledError('Approval abandoned before signing.')

  const signer = runtime.chain.signer(ownerKey)
  const signature = await signCardApproval(signer, vault, approval)

  const resolved = await daemon.resolve(record.id, {
    decision: 'approve',
    ownerSignature: signature,
    ownerAddress: owner,
    // Sent back explicitly: the daemon stores this next to the signature, so
    // what the agent reads is exactly what was signed, not what was asked.
    approvedRequest: serializeApproval(approval),
  })

  runtime.output.panel('Approved', [
    { label: 'Request', value: resolved.id },
    { label: 'Signed by', value: owner },
    { label: 'Approval id', value: approval.approvalId },
    {
      label: 'Next',
      value: 'The agent polls `check_approval_status` and submits the mint.',
    },
  ])
  runtime.output.line(
    'Nothing has been sent onchain by you — the agent pays the gas for its own mint.',
  )
  return 0
}
