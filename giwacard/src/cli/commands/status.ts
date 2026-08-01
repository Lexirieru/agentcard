import { privateKeyToAddress } from 'viem/accounts'

import { GUSD_DECIMALS, GUSD_SYMBOL } from '../../chain/gusdAbi.js'
import { giwaSepoliaExplorer } from '../../chain/giwaSepolia.js'
import { gasBudgetCells, readGasBudget } from '../chain.js'
import {
  OWNER_GAS_TARGET_WEI,
  SESSION_KEY_GAS_TARGET_WEI,
} from '../config.js'
import {
  requireKey,
  requireVaultAddress,
  unsealKeystore,
  type CliRuntime,
} from '../context.js'
import { formatDuration, formatTimestamp, formatUnits } from '../errors.js'
import {
  readActiveCards,
  readSessionPolicy,
  readVaultBalances,
  type CardSummary,
} from '../vault.js'
import { readWizardState } from '../wizardState.js'

/**
 * `giwacard status` — balances, active cards, pending approvals.
 *
 * The command's real job is the **empty states**. A fresh vault has no cards and
 * no approvals, and a status screen that renders two blank tables tells the user
 * nothing about whether it worked, whether they are connected, or what to do
 * next. Every section here has a sentence for the case where it has no rows, and
 * each of those sentences names the command that would produce one.
 *
 * The approval count is read from the local daemon. If the daemon is unreachable
 * that is reported inline as one line, not raised — a user asking for their
 * balance should still get their balance.
 */

export interface StatusCommandOptions {
  /** Also print the per-submitter gas budget table (KTD-6). */
  gas?: boolean
}

/** Cells for one card row. Exported so the wizard can reuse the same shape. */
export function cardRowCells(card: CardSummary, nowSeconds: bigint): string[] {
  const remaining =
    card.card.expiry > nowSeconds ? card.card.expiry - nowSeconds : 0n
  return [
    card.id.toString(),
    `${formatUnits(card.card.cap, GUSD_DECIMALS)} ${GUSD_SYMBOL}`,
    card.card.merchantScope,
    remaining === 0n ? 'expired' : formatDuration(remaining),
    card.status,
  ]
}

/**
 * Run `giwacard status`.
 *
 * @returns The process exit code. Always 0 when the vault could be read, even
 * when everything in it is empty — "nothing here yet" is not a failure.
 */
export async function runStatusCommand(
  runtime: CliRuntime,
  options: StatusCommandOptions = {},
): Promise<number> {
  const keystore = await unsealKeystore(runtime)
  const ownerKey = requireKey(keystore, 'ownerPrivateKey')
  const owner = privateKeyToAddress(ownerKey)
  const state = readWizardState(keystore.data)
  const vault = requireVaultAddress(runtime, state.vaultAddress)
  const sessionAddress = keystore.data.sessionPrivateKey
    ? privateKeyToAddress(keystore.data.sessionPrivateKey)
    : null

  const publicClient = runtime.chain.publicClient()
  const nowSeconds = BigInt(Math.floor(runtime.now() / 1000))

  const balances = await readVaultBalances(publicClient, vault, owner)

  runtime.output.panel('Vault', [
    { label: 'Owner', value: owner },
    { label: 'Vault', value: vault },
    {
      label: 'Balance',
      value: `${formatUnits(balances.balance, GUSD_DECIMALS)} ${GUSD_SYMBOL}`,
    },
    {
      label: 'Escrowed',
      value:
        `${formatUnits(balances.escrowed, GUSD_DECIMALS)} ${GUSD_SYMBOL}` +
        ' (locked behind active cards)',
    },
    {
      label: 'Available',
      value:
        `${formatUnits(balances.available, GUSD_DECIMALS)} ${GUSD_SYMBOL}` +
        ' (what a new card can be backed by)',
    },
  ])

  /* ----------------------------------------------------------- session key */

  runtime.output.blank()
  if (sessionAddress === null) {
    runtime.output.emptyState(
      'No session key yet, so no agent can mint anything.',
      'Run `giwacard init` — it resumes at the session-key step.',
    )
  } else {
    const policy = await readSessionPolicy(
      publicClient,
      vault,
      owner,
      sessionAddress,
    )
    runtime.output.panel('Session key', [
      { label: 'Address', value: sessionAddress },
      {
        label: 'Status',
        value: policy.active
          ? 'active'
          : 'REVOKED — it cannot mint. Re-register with `giwacard init`.',
      },
      {
        label: 'Cap per card',
        value: `${formatUnits(policy.capPerCard, GUSD_DECIMALS)} ${GUSD_SYMBOL}`,
      },
      {
        label: 'Daily cap',
        value: `${formatUnits(policy.dailyCap, GUSD_DECIMALS)} ${GUSD_SYMBOL}`,
      },
      { label: 'Max card life', value: formatDuration(policy.maxExpiry) },
    ])
  }

  /* --------------------------------------------------------------- cards */

  runtime.output.blank()
  const active = await readActiveCards(publicClient, vault, owner)
  if (active.cards.length === 0) {
    runtime.output.emptyState(
      'No active cards. Nothing of yours is escrowed right now.',
      'Your agent mints one with the `mint_card` MCP tool.',
    )
  } else {
    runtime.output.line(`Active cards (${active.cards.length})`)
    runtime.output.table({
      head: ['id', 'cap', 'merchant', 'expires in', 'status'],
      rows: active.cards.map((card) => cardRowCells(card, nowSeconds)),
      empty: 'No active cards.',
    })
    if (active.truncated) {
      runtime.output.line(
        `  Showing the most recent ${active.scanned} card ids only. ` +
          'Older cards are in the dashboard.',
      )
    }
  }

  /* ---------------------------------------------------------- approvals */

  runtime.output.blank()
  try {
    const pending = await runtime.daemon().list({ status: 'pending' })
    if (pending.requests.length === 0) {
      runtime.output.emptyState(
        'No pending approvals. Nothing is waiting on you.',
        'Over-policy card requests from your agent show up here.',
      )
    } else {
      runtime.output.line(`Pending approvals (${pending.requests.length})`)
      runtime.output.table({
        head: ['id', 'agent', 'reason', 'expires'],
        rows: pending.requests.map((request) => [
          request.id.slice(0, 8),
          request.agent ?? '(unnamed)',
          (request.reason ?? '').slice(0, 48) || '(none given)',
          formatTimestamp(BigInt(Math.floor(request.expiresAt / 1000))),
        ]),
        empty: 'No pending approvals.',
      })
      runtime.output.line('  Review them with `giwacard approve`.')
    }
  } catch {
    // A dead daemon must not cost the user their balance readout.
    runtime.output.emptyState(
      'Could not reach the local approval daemon, so pending approvals are unknown.',
      'Start it with `giwacard daemon` in another terminal.',
    )
  }

  /* ---------------------------------------------------------- gas budget */

  if (options.gas) {
    runtime.output.blank()
    const submitters = [
      { role: 'owner wallet', address: owner, targetWei: OWNER_GAS_TARGET_WEI },
      ...(sessionAddress
        ? [
            {
              role: 'session key',
              address: sessionAddress,
              targetWei: SESSION_KEY_GAS_TARGET_WEI,
            },
          ]
        : []),
    ]
    const budget = await readGasBudget(publicClient, submitters)
    runtime.output.line('Gas budget by submitting address')
    runtime.output.table({
      head: ['role', 'address', 'balance', 'target', 'state'],
      rows: budget.map(gasBudgetCells),
      empty: 'No submitting addresses configured.',
    })
  }

  runtime.output.blank()
  runtime.output.line(`Explorer: ${giwaSepoliaExplorer.address(owner)}`)
  return 0
}
