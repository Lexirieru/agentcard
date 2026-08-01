import { z } from 'zod'

import { CardStatus, cardStatusName } from '../../chain/cardVaultAbi.js'
import { nowSeconds } from '../context.js'
import { McpToolError } from '../errors.js'
import { readCard } from '../vault.js'
import { cardIdSchema, defineTool } from './define.js'

/**
 * `get_card_status` — read one card's lifecycle state.
 *
 * The agent's way to answer "did my mint land?", "can I still use this?" and
 * "was it charged?" without holding any state of its own. Read-only: it never
 * sends a transaction, so it is safe to poll.
 *
 * The card record onchain also carries `vaultOwner` and `agent`. Neither is
 * returned: the agent has no use for them and a narrower result is a narrower
 * thing to get wrong.
 */

const inputSchema = z.object({
  card_id: cardIdSchema.describe('Card id returned by mint_card.'),
})

export const getCardStatusTool = defineTool({
  name: 'get_card_status',
  title: 'Get card status',
  description:
    'Look up a card by id: whether it is still active, its cap, the merchant ' +
    'it is scoped to, and when it expires. Read-only.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  inputSchema,
  async handler(args, context) {
    const cardId = BigInt(args.card_id)
    const card = await readCard(context, cardId)

    if (card.status === CardStatus.None) {
      throw new McpToolError(
        'CARD_NOT_FOUND',
        `No card with id ${args.card_id} exists in this vault. Check the ` +
          'card_id, or mint a new card.',
        { details: { cardId: args.card_id } },
      )
    }

    const status = cardStatusName(card.status)
    const now = nowSeconds(context)
    // A card past its expiry is still stored as `Active` until somebody reaps
    // it, so "active" alone would tell the agent it can spend when it cannot.
    const pastExpiry = card.expiry < now
    const chargeable = card.status === CardStatus.Active && !pastExpiry

    return {
      card_id: args.card_id,
      status,
      chargeable,
      amount: card.cap.toString(),
      merchant: card.merchantScope,
      token: card.token,
      expires_at: Number(card.expiry),
      expired: pastExpiry,
      message: chargeable
        ? `Card ${args.card_id} is active and can be charged once, up to ` +
          `${card.cap}, by ${card.merchantScope}.`
        : status === 'used'
          ? `Card ${args.card_id} has already been charged. Mint a new one to pay again.`
          : pastExpiry && status === 'active'
            ? `Card ${args.card_id} passed its expiry and can no longer be charged; ` +
              'its escrow is releasable by anyone.'
            : `Card ${args.card_id} is ${status} and cannot be charged.`,
    }
  },
})
