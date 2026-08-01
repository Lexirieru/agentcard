import { z } from 'zod'

import { readBalances, readPaymentToken } from '../vault.js'
import { defineTool } from './define.js'

/**
 * `get_balance` — what the vault can actually back a new card with.
 *
 * Three numbers, and the one that matters is `available`. Agents reliably
 * mistake `balance` for spendable money and then hit AE5 on the next mint, so
 * the result leads with `available` and the message says out loud that escrow
 * is not spendable.
 */

const inputSchema = z.object({})

export const getBalanceTool = defineTool({
  name: 'get_balance',
  title: 'Get vault balance',
  description:
    'Read the vault balance backing this agent: total deposited, the amount ' +
    'escrowed behind still-active cards, and the available balance that a new ' +
    'card can actually be minted against. Read-only.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  inputSchema,
  async handler(_args, context) {
    const [balances, token] = await Promise.all([
      readBalances(context),
      readPaymentToken(context),
    ])

    return {
      available: balances.available.toString(),
      balance: balances.balance.toString(),
      escrowed: balances.escrowed.toString(),
      token,
      vault: context.vaultAddress,
      message:
        `${balances.available} available to mint against. ${balances.escrowed} ` +
        'is escrowed behind active cards and cannot be spent until those cards ' +
        'are charged, cancelled or expire.',
    }
  },
})
