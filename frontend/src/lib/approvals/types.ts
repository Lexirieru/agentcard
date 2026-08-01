/**
 * Wire shapes of the giwacard daemon's approval queue.
 *
 * Mirrors `toApprovalResponse` in giwacard/src/daemon/server.ts. Declared here
 * rather than imported because the daemon is a separate package that this app
 * does not depend on — it talks to it over HTTP, and a shared type would turn a
 * runtime protocol into a build-time coupling.
 */

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export const APPROVAL_FILTERS = ["pending", "all"] as const;
export type ApprovalFilter = (typeof APPROVAL_FILTERS)[number];

/**
 * The card the agent asked for.
 *
 * Schemaless on the daemon side on purpose: the policy fields belong to the
 * card contracts and the daemon must survive their evolution. The dashboard
 * therefore parses it defensively rather than trusting a shape.
 */
export type OverPolicyCardRequest = Readonly<Record<string, unknown>>;

export interface ApprovalRecord {
  id: string;
  sessionKey: string;
  agent: string | null;
  status: ApprovalStatus;
  reason: string | null;
  request: OverPolicyCardRequest;
  idempotencyKey: string | null;
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms; after this the request reads as `expired`. */
  expiresAt: number;
  resolvedAt: number | null;
  resolvedBy: string | null;
  decisionNote: string | null;
  /** Owner EIP-712 signature; null before approval and after consumption. */
  ownerSignature: string | null;
  signatureConsumedAt: number | null;
  cardId: string | null;
  mintTxHash: string | null;
  signatureConsumed?: boolean;
  terminal?: boolean;
}

export interface ApprovalListResponse {
  requests: ApprovalRecord[];
  count: number;
}

/** `{ error: { code, message } }`, the daemon's only error shape. */
export interface DaemonErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}
