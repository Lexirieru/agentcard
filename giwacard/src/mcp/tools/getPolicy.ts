import { z } from 'zod'

import { sessionAddress } from '../context.js'
import { isMerchantAllowed, readPolicy } from '../vault.js'
import { defineTool } from './define.js'

/**
 * `get_policy` — the limits this agent is spending under.
 *
 * Worth calling before `mint_card`: an agent that reads the policy first can
 * size a card to fit and avoid a round trip through the owner's approval queue
 * entirely. `remaining_today` is the number that decides that.
 *
 * The merchant allowlist is a Solidity `mapping` and cannot be enumerated
 * onchain, so `merchants` reports the allow-state of the merchants this server
 * was configured with rather than pretending to be exhaustive. The
 * `merchants_enumerable: false` flag says so explicitly, because an agent that
 * treated an empty list as "no merchants allowed" would be wrong.
 */

const inputSchema = z.object({})

export const getPolicyTool = defineTool({
  name: 'get_policy',
  title: 'Get session policy',
  description:
    'Read the spending policy attached to this agent\'s session key: the ' +
    'per-card cap, the daily cap and how much of it is left today, and the ' +
    'longest card lifetime allowed. A card that fits this policy mints ' +
    'immediately; one that does not needs the owner\'s approval. Read-only.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  inputSchema,
  async handler(_args, context) {
    const snapshot = await readPolicy(context)
    const known = context.knownMerchants ?? []
    const merchants = await Promise.all(
      known.map(async (address) => ({
        address,
        allowed: await isMerchantAllowed(context, address),
      })),
    )

    return {
      active: snapshot.policy.active,
      session_key: sessionAddress(context),
      vault: context.vaultAddress,
      vault_owner: context.vaultOwner,
      cap_per_card: snapshot.policy.capPerCard.toString(),
      daily_cap: snapshot.policy.dailyCap.toString(),
      minted_today: snapshot.mintedToday.toString(),
      remaining_today: snapshot.remainingToday.toString(),
      max_expiry_seconds: Number(snapshot.policy.maxExpiry),
      merchants,
      merchants_enumerable: false,
      message: snapshot.policy.active
        ? `Cards up to ${snapshot.policy.capPerCard} mint immediately; ` +
          `${snapshot.remainingToday} of today's daily cap is left. Anything ` +
          "larger needs the owner's approval."
        : 'This session key is not active. It was revoked or never registered, ' +
          'so no card can be minted with it.',
    }
  },
})
