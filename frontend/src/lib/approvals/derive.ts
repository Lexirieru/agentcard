import { keccak256, stringToHex } from "viem";
import type { BadgeTone } from "@/components/ui";
import type { ApprovalFilter, ApprovalRecord, ApprovalStatus } from "./types";

/**
 * Turning a queue row into something the owner can actually decide on.
 *
 * The daemon stores the agent's request verbatim and schemaless, so this module
 * is where it becomes typed. Everything here is pure: the decision of whether a
 * row is signable, expired, or addressed to a different wallet has to be
 * testable without a daemon, a wallet or a chain.
 */

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

/** A unix-seconds expiry above this is almost certainly milliseconds. */
const MAX_PLAUSIBLE_EXPIRY_SECONDS = 100_000_000_000;

/** The exact terms the owner signs, matching `CardApproval` in CardTypes.sol. */
export interface ApprovalTerms {
  vaultOwner: `0x${string}`;
  agent: `0x${string}`;
  token: `0x${string}`;
  cap: bigint;
  merchantScope: `0x${string}`;
  /** Unix seconds. */
  expiry: bigint;
  approvalId: `0x${string}`;
}

export type BlockedCode =
  | "expired"
  | "resolved"
  | "unreadable"
  | "wrong-owner"
  | "wrong-token"
  | "card-expiry-past"
  | "wallet-disconnected"
  | "vault-unconfigured";

export interface ApprovalBlocked {
  code: BlockedCode;
  message: string;
}

export interface ApprovalView {
  record: ApprovalRecord;
  /** Status with TTL expiry applied, which the daemon also does on read. */
  status: ApprovalStatus;
  expired: boolean;
  label: string;
  tone: BadgeTone;
  terms: ApprovalTerms | null;
  /** Non-null means the approve button is disabled, with this as the reason. */
  blocked: ApprovalBlocked | null;
  /** True only when signing right now would produce a usable approval. */
  actionable: boolean;
  /** True when the signature exists and has not been spent onchain yet. */
  relayable: boolean;
}

export interface EvaluateContext {
  /** Epoch ms. Injected so tests can travel past a TTL. */
  nowMs: number;
  /** Connected wallet, or null when disconnected. */
  ownerAddress: string | null;
  /** `paymentToken()` from the vault, or null while that read is in flight. */
  paymentToken: string | null;
  /** Vault proxy address; null when the app is not configured for a chain. */
  vaultAddress: string | null;
}

/* -------------------------------------------------------------------------- */
/* Approval id                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Derive a single-use `approvalId` from the queue row id.
 *
 * Requests are allowed to omit one — the field is the *vault's* replay guard,
 * not the daemon's — but a signature without it cannot be bound to one use. A
 * deterministic derivation is chosen over a random id so that re-signing the
 * same request twice produces the same id: the vault then rejects the second
 * mint as `ApprovalAlreadyUsed` instead of silently minting a duplicate card.
 */
export function approvalIdFor(recordId: string): `0x${string}` {
  return keccak256(stringToHex(`giwacard-approval:${recordId}`));
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

export type ParseResult =
  | { ok: true; terms: ApprovalTerms }
  | { ok: false; reason: string };

function readAddress(
  source: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && ADDRESS_RE.test(value.trim())) {
      return value.trim();
    }
  }
  return null;
}

/** Accepts a decimal string, a hex string or a safe integer. */
export function readBigInt(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    return BigInt(value);
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return BigInt(trimmed);
  if (/^0x[0-9a-fA-F]+$/.test(trimmed)) return BigInt(trimmed);
  return null;
}

function readBigIntField(
  source: Record<string, unknown>,
  keys: readonly string[],
): bigint | null {
  for (const key of keys) {
    const parsed = readBigInt(source[key]);
    if (parsed !== null) return parsed;
  }
  return null;
}

/**
 * Read the agent's request into the struct the vault verifies.
 *
 * Field aliases are accepted because the requesting side of this protocol is a
 * separate package: `merchant` and `merchantScope` mean the same thing to a
 * human, and rejecting one of them would strand an owner in front of a request
 * they can plainly read but not approve.
 */
export function parseApprovalTerms(
  request: Readonly<Record<string, unknown>> | null | undefined,
  options: { fallbackApprovalId: `0x${string}`; fallbackVaultOwner?: string | null },
): ParseResult {
  // A record that arrived without a `request` object at all is a protocol
  // mismatch, not a crash: render it as unsignable and say so.
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    return { ok: false, reason: "the request payload is missing or malformed" };
  }
  const source = request as Record<string, unknown>;

  const vaultOwner =
    readAddress(source, ["vaultOwner", "owner"]) ??
    (options.fallbackVaultOwner && ADDRESS_RE.test(options.fallbackVaultOwner)
      ? options.fallbackVaultOwner
      : null);
  if (vaultOwner === null) {
    return { ok: false, reason: "no vault owner address in the request" };
  }

  const agent = readAddress(source, ["agent", "sessionKey", "requester"]);
  if (agent === null) {
    return { ok: false, reason: "no agent address in the request" };
  }

  const token = readAddress(source, ["token", "paymentToken"]);
  if (token === null) {
    return { ok: false, reason: "no settlement token in the request" };
  }

  const cap = readBigIntField(source, ["cap", "amount", "capAmount"]);
  if (cap === null) {
    return { ok: false, reason: "no spend cap in the request" };
  }
  if (cap <= 0n) {
    return { ok: false, reason: "the requested cap is zero" };
  }

  // The zero address is legal here: `merchantScope == address(0)` is the vault's
  // "any merchant may charge" card, reachable only through this signed path.
  const merchantScope =
    readAddress(source, ["merchantScope", "merchant"]) ??
    "0x0000000000000000000000000000000000000000";

  const expiry = readBigIntField(source, ["expiry", "expiresAt", "expiresAtSeconds"]);
  if (expiry === null) {
    return { ok: false, reason: "no card expiry in the request" };
  }
  if (expiry > BigInt(MAX_PLAUSIBLE_EXPIRY_SECONDS)) {
    return {
      ok: false,
      reason: "the card expiry looks like milliseconds, not unix seconds",
    };
  }

  const rawApprovalId = source["approvalId"] ?? source["nonce"];
  const approvalId =
    typeof rawApprovalId === "string" && BYTES32_RE.test(rawApprovalId.trim())
      ? (rawApprovalId.trim() as `0x${string}`)
      : options.fallbackApprovalId;

  return {
    ok: true,
    terms: {
      vaultOwner: vaultOwner as `0x${string}`,
      agent: agent as `0x${string}`,
      token: token as `0x${string}`,
      cap,
      merchantScope: merchantScope as `0x${string}`,
      expiry,
      approvalId,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Evaluation                                                                 */
/* -------------------------------------------------------------------------- */

/** Status with the TTL applied — the daemon derives expiry on read, so do we. */
export function effectiveStatus(
  record: ApprovalRecord,
  nowMs: number,
): ApprovalStatus {
  if (record.status !== "pending") return record.status;
  return nowMs >= record.expiresAt ? "expired" : "pending";
}

function badgeFor(
  status: ApprovalStatus,
  record: ApprovalRecord,
): { label: string; tone: BadgeTone } {
  switch (status) {
    case "pending":
      return { label: "Awaiting you", tone: "pending" };
    case "expired":
      return { label: "Expired", tone: "expired" };
    case "denied":
      return { label: "Denied", tone: "danger" };
    case "approved":
      // Never `settled`: an approval is a signature, and a signature is not a
      // transaction. Only a finalized block earns the settled tone (KTD-5).
      return record.signatureConsumedAt !== null
        ? { label: "Minted", tone: "neutral" }
        : { label: "Approved", tone: "neutral" };
  }
}

/**
 * Decide what the owner may do with one queued request.
 *
 * An expired request is evaluated, badged and rendered like any other — it is
 * never dropped from the list. The owner needs to see that an agent asked and
 * that the window closed, not an unexplained gap.
 */
export function evaluateApproval(
  record: ApprovalRecord,
  ctx: EvaluateContext,
): ApprovalView {
  const status = effectiveStatus(record, ctx.nowMs);
  const { label, tone } = badgeFor(status, record);
  const parsed = parseApprovalTerms(record.request, {
    fallbackApprovalId: approvalIdFor(record.id),
    fallbackVaultOwner: ctx.ownerAddress,
  });
  const terms = parsed.ok ? parsed.terms : null;

  const blocked = firstBlocker(record, status, parsed, ctx);

  return {
    record,
    status,
    expired: status === "expired",
    label,
    tone,
    terms,
    blocked,
    actionable: status === "pending" && blocked === null,
    relayable:
      status === "approved" &&
      record.ownerSignature !== null &&
      record.signatureConsumedAt === null &&
      terms !== null,
  };
}

function firstBlocker(
  record: ApprovalRecord,
  status: ApprovalStatus,
  parsed: ParseResult,
  ctx: EvaluateContext,
): ApprovalBlocked | null {
  if (status === "expired") {
    return {
      code: "expired",
      message:
        "This request passed its review window before it was answered. The agent has to ask again.",
    };
  }
  if (status !== "pending") {
    return {
      code: "resolved",
      message: `Already ${status}. Approvals are one-shot — this one cannot be changed.`,
    };
  }
  if (!parsed.ok) {
    return {
      code: "unreadable",
      message: `This request cannot be signed: ${parsed.reason}. Approving it would sign terms you cannot see.`,
    };
  }
  if (ctx.vaultAddress === null) {
    return {
      code: "vault-unconfigured",
      message:
        "No vault address is configured, so there is no EIP-712 domain to sign against.",
    };
  }
  if (ctx.ownerAddress === null) {
    return {
      code: "wallet-disconnected",
      message: "Connect the vault owner's wallet to sign this approval.",
    };
  }
  if (parsed.terms.vaultOwner.toLowerCase() !== ctx.ownerAddress.toLowerCase()) {
    return {
      code: "wrong-owner",
      message:
        "This request names a different vault owner. Connect that wallet to approve it.",
    };
  }
  if (
    ctx.paymentToken !== null &&
    parsed.terms.token.toLowerCase() !== ctx.paymentToken.toLowerCase()
  ) {
    return {
      code: "wrong-token",
      message:
        "The request settles in a token this vault does not custody. The mint would revert.",
    };
  }
  if (parsed.terms.expiry <= BigInt(Math.floor(ctx.nowMs / 1000))) {
    return {
      code: "card-expiry-past",
      message:
        "The card would be born expired, so the vault would reject the mint.",
    };
  }
  void record;
  return null;
}

/* -------------------------------------------------------------------------- */
/* Empty states                                                               */
/* -------------------------------------------------------------------------- */

export interface EmptyCopy {
  title: string;
  body: string;
}

/**
 * What an empty queue means depends on which filter produced it, and "no rows"
 * is never rendered as a blank panel: an owner staring at an empty box cannot
 * tell a quiet agent from a broken daemon.
 */
export function emptyQueueCopy(
  filter: ApprovalFilter,
  totalRecords: number,
): EmptyCopy {
  if (filter === "pending" && totalRecords > 0) {
    return {
      title: "Nothing waiting on you",
      body: "Every request has been answered. Switch to All to review the history.",
    };
  }
  if (filter === "pending") {
    return {
      title: "Nothing waiting on you",
      body: "Agents mint inside their session policy on their own. A request only lands here when one asks to exceed it.",
    };
  }
  return {
    title: "No requests yet",
    body: "Once an agent asks for a card beyond its session policy, it will appear here for you to approve or deny.",
  };
}

/** Rows the owner still has to answer — what the header count reports. */
export function countActionable(views: readonly ApprovalView[]): number {
  return views.reduce(
    (total, view) => (view.status === "pending" ? total + 1 : total),
    0,
  );
}

/** Pending first, then newest first — the owner's work sits at the top. */
export function sortApprovals(views: readonly ApprovalView[]): ApprovalView[] {
  return [...views].sort((a, b) => {
    const aPending = a.status === "pending" ? 0 : 1;
    const bPending = b.status === "pending" ? 0 : 1;
    if (aPending !== bPending) return aPending - bPending;
    return b.record.createdAt - a.record.createdAt;
  });
}
