import { isAddress, type Address } from 'viem'
import { privateKeyToAddress } from 'viem/accounts'

import { cardVaultAbi } from '../../chain/cardVaultAbi.js'
import { GUSD_DECIMALS, GUSD_SYMBOL } from '../../chain/gusdAbi.js'
import { sendTx } from '../chain.js'
import {
  requireKey,
  requireVaultAddress,
  unsealKeystore,
  type CliRuntime,
} from '../context.js'
import { CliError, cancelledError, formatUnits } from '../errors.js'
import { readActiveCards, readCard, readSessionPolicy } from '../vault.js'
import { readWizardState } from '../wizardState.js'

/**
 * `giwacard revoke key <address>` and `giwacard revoke card <id>`.
 *
 * These are two different things and the CLI's job is to make sure nobody
 * confuses them under pressure — which is the only time anyone runs `revoke`.
 *
 * | | `revoke key` | `revoke card` |
 * |---|---|---|
 * | contract call | `revokeSessionKey(key)` | `cancelCard(id)` |
 * | takes effect on | future mints by that key | one specific card |
 * | **leaves alone** | **every card that key already minted — they stay ACTIVE and chargeable** | the session key, which keeps minting |
 * | escrow | untouched | released back to available |
 *
 * The asymmetry is real and comes straight from the contract: `revokeSessionKey`
 * only flips `active = false` on the policy, and `CardVault`'s own comment says
 * "Cards the key already minted stay `Active`". A user who revokes a compromised
 * key and walks away still has live cards. So `revoke key` **enumerates those
 * cards afterwards and names them**, and refuses to let the moment pass quietly.
 *
 * There is no bare `giwacard revoke`: a command whose two meanings differ this
 * much must not have a default.
 */

/** Which object is being revoked. */
export type RevokeSubject = 'key' | 'card'

export interface RevokeCommandOptions {
  subject?: string
  target?: string
  /** Skip the confirmation prompt. */
  yes?: boolean
}

/** The two-line explanation printed before either action. */
export const REVOKE_KEY_MEANING =
  'REVOKE KEY deactivates a session key immediately. Cards it has ALREADY ' +
  'minted stay ACTIVE and can still be charged — revoking the key does not ' +
  'cancel them.'

/** Counterpart for the card path. */
export const REVOKE_CARD_MEANING =
  'REVOKE CARD cancels one card and releases its escrow back to your available ' +
  'balance. The session key that minted it stays active and can mint again.'

/**
 * Parse and validate the `revoke` argv.
 *
 * @throws {CliError} `INVALID_ARGUMENT` with both forms spelled out, because a
 * user who typed the wrong one needs to see the difference, not a usage line.
 */
export function parseRevokeArgs(options: RevokeCommandOptions): {
  subject: RevokeSubject
  target: string
} {
  const subject = options.subject?.toLowerCase()
  if (subject !== 'key' && subject !== 'card') {
    throw new CliError(
      'INVALID_ARGUMENT',
      'giwacard revoke needs to know *what* to revoke, because the two ' +
        'possibilities do different things:\n\n' +
        `  giwacard revoke key <address>   ${REVOKE_KEY_MEANING}\n\n` +
        `  giwacard revoke card <id>       ${REVOKE_CARD_MEANING}`,
      { hint: 'Run `giwacard status` to list your session key and active cards.' },
    )
  }

  const target = options.target?.trim()
  if (!target) {
    throw new CliError(
      'INVALID_ARGUMENT',
      subject === 'key'
        ? 'giwacard revoke key needs the session key address to revoke.'
        : 'giwacard revoke card needs the card id to cancel.',
      {
        hint:
          subject === 'key'
            ? 'Usage: giwacard revoke key 0x…'
            : 'Usage: giwacard revoke card 7',
      },
    )
  }

  if (subject === 'key' && !isAddress(target)) {
    throw new CliError(
      'INVALID_ARGUMENT',
      `"${target}" is not a 0x-prefixed EVM address. ` +
        'Did you mean `giwacard revoke card ' + target + '`?',
      { hint: 'Session keys are addresses; cards are numeric ids.' },
    )
  }

  if (subject === 'card' && !/^\d+$/.test(target)) {
    throw new CliError(
      'INVALID_ARGUMENT',
      `"${target}" is not a card id. ` +
        (isAddress(target)
          ? 'That looks like an address — did you mean `giwacard revoke key ' +
            `${target}\`?`
          : 'Card ids are non-negative integers.'),
      { hint: 'Run `giwacard status` to list your active cards and their ids.' },
    )
  }

  return { subject, target }
}

/**
 * Run `giwacard revoke`.
 *
 * @returns The process exit code.
 */
export async function runRevokeCommand(
  runtime: CliRuntime,
  options: RevokeCommandOptions = {},
): Promise<number> {
  const { subject, target } = parseRevokeArgs(options)

  const keystore = await unsealKeystore(runtime)
  const ownerKey = requireKey(keystore, 'ownerPrivateKey')
  const owner = privateKeyToAddress(ownerKey)
  const state = readWizardState(keystore.data)
  const vault = requireVaultAddress(runtime, state.vaultAddress)

  const publicClient = runtime.chain.publicClient()
  const wallet = runtime.chain.wallet(ownerKey)

  return subject === 'key'
    ? revokeKey(runtime, {
        vault,
        owner,
        sessionKey: target as Address,
        publicClient,
        wallet,
        yes: options.yes ?? false,
      })
    : revokeCard(runtime, {
        vault,
        owner,
        cardId: BigInt(target),
        publicClient,
        wallet,
        yes: options.yes ?? false,
      })
}

interface RevokeContext {
  vault: Address
  owner: Address
  publicClient: ReturnType<CliRuntime['chain']['publicClient']>
  wallet: ReturnType<CliRuntime['chain']['wallet']>
  yes: boolean
}

/**
 * `revoke key` — deactivate a session key, leaving its cards alone.
 *
 * The post-action enumeration is the point of this function. Anything else here
 * is one `writeContract`.
 */
async function revokeKey(
  runtime: CliRuntime,
  context: RevokeContext & { sessionKey: Address },
): Promise<number> {
  const policy = await readSessionPolicy(
    context.publicClient,
    context.vault,
    context.owner,
    context.sessionKey,
  )

  if (!policy.active) {
    runtime.output.line(
      `Session key ${context.sessionKey} is already inactive for this vault. ` +
        'Nothing to do, and nothing was sent.',
    )
    // Still show the live cards: "already revoked" is precisely the state in
    // which a user is most likely to wrongly assume the cards went with it.
    await reportSurvivingCards(runtime, context)
    return 0
  }

  // Read the cards *before* the transaction, so the warning is about cards that
  // demonstrably exist rather than a generic caveat.
  const before = await readActiveCards(
    context.publicClient,
    context.vault,
    context.owner,
  )
  const minted = before.cards.filter(
    (card) => card.card.agent.toLowerCase() === context.sessionKey.toLowerCase(),
  )

  runtime.output.panel('Revoke session key', [
    { label: 'Session key', value: context.sessionKey },
    { label: 'Vault', value: context.vault },
    { label: 'Effect', value: 'the key can no longer mint, immediately' },
    {
      label: 'NOT affected',
      value:
        minted.length === 0
          ? 'it has no active cards right now'
          : `${minted.length} card(s) it already minted stay ACTIVE and chargeable`,
    },
  ])
  runtime.output.line(REVOKE_KEY_MEANING)

  if (minted.length > 0) {
    runtime.output.blank()
    runtime.output.line('Cards that will survive this revocation:')
    runtime.output.table({
      head: ['card id', 'cap', 'merchant', 'cancel with'],
      rows: minted.map((card) => [
        card.id.toString(),
        `${formatUnits(card.card.cap, GUSD_DECIMALS)} ${GUSD_SYMBOL}`,
        card.card.merchantScope,
        `giwacard revoke card ${card.id}`,
      ]),
      empty: 'none',
    })
  }

  if (!context.yes && runtime.prompter.interactive) {
    const go = await runtime.prompter.confirm({
      message: `Revoke session key ${context.sessionKey}?`,
      initialValue: false,
    })
    if (!go) throw cancelledError('Session key not revoked.')
  }

  const spinner = runtime.prompter.spinner()
  spinner.start('Revoking the session key')
  try {
    const outcome = await sendTx({
      publicClient: context.publicClient,
      wallet: context.wallet,
      preconfClient: runtime.chain.preconfClient(),
      role: 'owner wallet',
      address: context.vault,
      abi: cardVaultAbi,
      functionName: 'revokeSessionKey',
      args: [context.sessionKey],
      faucetUrl: runtime.config.ethFaucetUrl,
      onPhase: (event) => spinner.message(event.message),
    })
    spinner.stop(
      outcome.safe ? 'Session key revoked.' : 'Session key revoked (not yet safe).',
    )
    runtime.output.line(`Transaction: ${outcome.explorerUrl}`)
    if (!outcome.safe) {
      runtime.output.line(
        '  Included but not yet in a safe block — it can still be reorged.',
      )
    }
  } catch (error) {
    spinner.stop('Revocation failed.', 1)
    throw error
  }

  if (minted.length > 0) {
    runtime.output.blank()
    runtime.output.line(
      `${minted.length} card(s) minted by that key are STILL ACTIVE. Cancel each ` +
        'one you do not want charged:',
    )
    for (const card of minted) {
      runtime.output.line(`  giwacard revoke card ${card.id}`)
    }
  } else {
    runtime.output.line('That key had no active cards, so nothing survives it.')
  }
  return 0
}

/** Print the cards a given session key still has alive. */
async function reportSurvivingCards(
  runtime: CliRuntime,
  context: RevokeContext & { sessionKey: Address },
): Promise<void> {
  const active = await readActiveCards(
    context.publicClient,
    context.vault,
    context.owner,
  )
  const minted = active.cards.filter(
    (card) => card.card.agent.toLowerCase() === context.sessionKey.toLowerCase(),
  )
  if (minted.length === 0) {
    runtime.output.line('It has no active cards either.')
    return
  }
  runtime.output.line(
    `It still has ${minted.length} ACTIVE card(s) — revoking a key never cancels them:`,
  )
  for (const card of minted) {
    runtime.output.line(`  giwacard revoke card ${card.id}`)
  }
}

/** `revoke card` — cancel one card, leaving the session key alone. */
async function revokeCard(
  runtime: CliRuntime,
  context: RevokeContext & { cardId: bigint },
): Promise<number> {
  const summary = await readCard(context.publicClient, context.vault, context.cardId)

  if (summary.status === 'none') {
    throw new CliError(
      'NOT_FOUND',
      `No card with id ${context.cardId} has ever been minted in this vault.`,
      { hint: 'Run `giwacard status` to list your active cards and their ids.' },
    )
  }

  if (summary.card.vaultOwner.toLowerCase() !== context.owner.toLowerCase()) {
    throw new CliError(
      'NOT_FOUND',
      `Card ${context.cardId} belongs to a different vault owner ` +
        `(${summary.card.vaultOwner}), so you cannot cancel it.`,
      { hint: 'Run `giwacard status` to list the cards that are yours.' },
    )
  }

  if (summary.status !== 'active') {
    runtime.output.line(
      `Card ${context.cardId} is already ${summary.status}. There is nothing to ` +
        'cancel and nothing was sent.',
    )
    if (summary.status === 'used') {
      runtime.output.line('  A card can be charged exactly once; this one has been.')
    }
    return 0
  }

  runtime.output.panel('Cancel card', [
    { label: 'Card', value: context.cardId.toString() },
    {
      label: 'Cap',
      value: `${formatUnits(summary.card.cap, GUSD_DECIMALS)} ${GUSD_SYMBOL}`,
    },
    { label: 'Merchant', value: summary.card.merchantScope },
    { label: 'Minted by', value: summary.card.agent },
    {
      label: 'Effect',
      value: `releases ${formatUnits(summary.card.cap, GUSD_DECIMALS)} ${GUSD_SYMBOL} back to available`,
    },
    {
      label: 'NOT affected',
      value: `session key ${summary.card.agent} stays active and can mint again`,
    },
  ])
  runtime.output.line(REVOKE_CARD_MEANING)
  runtime.output.line(
    `To stop that key minting at all, run: giwacard revoke key ${summary.card.agent}`,
  )

  if (!context.yes && runtime.prompter.interactive) {
    const go = await runtime.prompter.confirm({
      message: `Cancel card ${context.cardId}?`,
      initialValue: false,
    })
    if (!go) throw cancelledError('Card not cancelled.')
  }

  const spinner = runtime.prompter.spinner()
  spinner.start('Cancelling the card')
  try {
    const outcome = await sendTx({
      publicClient: context.publicClient,
      wallet: context.wallet,
      preconfClient: runtime.chain.preconfClient(),
      role: 'owner wallet',
      address: context.vault,
      abi: cardVaultAbi,
      functionName: 'cancelCard',
      args: [context.cardId],
      faucetUrl: runtime.config.ethFaucetUrl,
      onPhase: (event) => spinner.message(event.message),
    })
    spinner.stop(outcome.safe ? 'Card cancelled.' : 'Card cancelled (not yet safe).')
    runtime.output.line(`Transaction: ${outcome.explorerUrl}`)
    if (!outcome.safe) {
      runtime.output.line(
        '  Included but not yet in a safe block — it can still be reorged.',
      )
    }
  } catch (error) {
    spinner.stop('Cancellation failed.', 1)
    throw error
  }

  runtime.output.line(
    `Escrow released. Session key ${summary.card.agent} is untouched and can ` +
      'still mint within its policy.',
  )
  return 0
}
