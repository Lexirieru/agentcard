import { z } from 'zod'

import { CardStatus, cardStatusName } from '../../chain/cardVaultAbi.js'
import { McpToolError, cardAlreadyUsedError } from '../errors.js'
import { cancelCard, readCard } from '../vault.js'
import { cardIdSchema, defineTool } from './define.js'

/**
 * `cancel_card` — release an unused card's escrow back to the vault.
 *
 * The state is read before the write so the agent gets the specific reason a
 * cancel is impossible (AE3 already-used, already-cancelled, never-minted)
 * instead of a generic revert.
 *
 * Onchain this is an owner action: `CardVault.cancelCard` checks
 * `msg.sender == card.vaultOwner`, and a session key is never the vault owner.
 * When this server was configured with an owner wallet the cancel goes through;
 * otherwise it reports `OWNER_ACTION_REQUIRED` and names the CLI command. That
 * is a deliberate refusal to escalate a session key's authority — even though
 * cancelling only ever *returns* funds, the key that can cancel is the key that
 * can withdraw.
 */

const inputSchema = z.object({
  card_id: cardIdSchema.describe('Card id to cancel.'),
})

export const cancelCardTool = defineTool({
  name: 'cancel_card',
  title: 'Cancel a card',
  description:
    'Cancel an active, uncharged card and release its escrowed funds back to ' +
    'the vault owner\'s available balance. Cards that were already charged ' +
    'cannot be cancelled.',
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  inputSchema,
  async handler(args, context) {
    const cardId = BigInt(args.card_id)
    const card = await readCard(context, cardId)

    if (card.status === CardStatus.None) {
      throw new McpToolError(
        'CARD_NOT_FOUND',
        `No card with id ${args.card_id} exists in this vault.`,
        { details: { cardId: args.card_id } },
      )
    }
    if (card.status === CardStatus.Used) {
      throw cardAlreadyUsedError(args.card_id)
    }
    if (card.status !== CardStatus.Active) {
      const status = cardStatusName(card.status)
      throw new McpToolError(
        'CARD_NOT_ACTIVE',
        `Card ${args.card_id} is already ${status}; there is nothing to ` +
          'cancel and its escrow is already released.',
        { details: { cardId: args.card_id, status } },
      )
    }

    const txHash = await cancelCard(context, cardId)

    return {
      card_id: args.card_id,
      status: 'revoked',
      released: card.cap.toString(),
      cancel_tx_hash: txHash,
      message:
        `Card ${args.card_id} is cancelled and ${card.cap} returned to the ` +
        "vault's available balance.",
    }
  },
})
