import type { ToolDefinition } from './define.js'
import { cancelCardTool } from './cancelCard.js'
import { checkApprovalStatusTool } from './checkApprovalStatus.js'
import { getBalanceTool } from './getBalance.js'
import { getCardStatusTool } from './getCardStatus.js'
import { getPolicyTool } from './getPolicy.js'
import { mintCardTool } from './mintCard.js'
import { payMerchantTool } from './payMerchant.js'

/**
 * The complete agent-facing tool surface (R7, R14/R15). Seven tools, no more.
 *
 * ## What is deliberately not here
 *
 * There is **no tool that resolves an approval.** Not `resolve_approval`, not
 * `approve`, not a `decision` argument smuggled onto `check_approval_status`.
 *
 * The two-tier consent model has exactly one load-bearing assumption: an agent
 * that cannot fund a card within its policy must go and ask a human. An agent
 * able to call an approval tool — even one that "only" forwards a decision — is
 * an agent that can approve its own over-policy spend, and the entire model
 * collapses to "the agent can spend anything". Approval is owner-only, through
 * the CLI or the dashboard, both of which authenticate by reading a 0600 file
 * this process never hands out.
 *
 * ## Why the seventh tool does not weaken that
 *
 * `pay_merchant` spends, but it cannot spend anything `mint_card` could not:
 * it mints through the identical policy fork, and an over-policy price queues
 * an approval and pays nothing. What it adds is the other half of the loop —
 * the 402 exchange — and it adds it *server-side*, which is the direction that
 * makes R10b true rather than aspirational. The alternative was every host
 * assembling `X-PAYMENT` headers itself.
 *
 * `src/mcp/surface.test.ts` asserts all of this against the live `tools/list`
 * response, not against this array, so adding a tool anywhere still trips the
 * guard.
 */
export const GIWACARD_TOOLS: readonly ToolDefinition[] = [
  mintCardTool,
  payMerchantTool,
  getCardStatusTool,
  cancelCardTool,
  getBalanceTool,
  getPolicyTool,
  checkApprovalStatusTool,
]

/** The tool names R7 specifies, in registration order. */
export const GIWACARD_TOOL_NAMES: readonly string[] = GIWACARD_TOOLS.map(
  (tool) => tool.name,
)

/**
 * Name fragments that would indicate an approval-resolving tool.
 *
 * Used by the security test rather than by any runtime path — a denylist cannot
 * stop someone determined to add such a tool, but it does mean they have to
 * delete a failing test that says why not.
 */
export const APPROVAL_RESOLVING_NAME_FRAGMENTS: readonly string[] = [
  'resolve',
  'approve',
  'approval_decision',
  'deny',
  'authorize',
  'authorise',
  'sign',
  'grant',
]

export {
  cancelCardTool,
  checkApprovalStatusTool,
  getBalanceTool,
  getCardStatusTool,
  getPolicyTool,
  mintCardTool,
  payMerchantTool,
}
export * from './define.js'
export { resolveMintRequest, type MintDecision, type MintRequestInput } from './mintCard.js'
export { DEFAULT_PAYMENT_CARD_TTL_SECONDS } from './payMerchant.js'
