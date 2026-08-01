import { describe, expect, test } from "bun:test";
import {
  approvalIdFor,
  countActionable,
  effectiveStatus,
  emptyQueueCopy,
  evaluateApproval,
  parseApprovalTerms,
  readBigInt,
  sortApprovals,
  type EvaluateContext,
} from "./derive";
import type { ApprovalRecord } from "./types";

const OWNER = "0x1111111111111111111111111111111111111111";
const AGENT = "0x2222222222222222222222222222222222222222";
const TOKEN = "0x3333333333333333333333333333333333333333";
const MERCHANT = "0x4444444444444444444444444444444444444444";
const VAULT = "0x5555555555555555555555555555555555555555";

const NOW_MS = 1_800_000_000_000;
const NOW_S = NOW_MS / 1000;

function request(overrides: Record<string, unknown> = {}) {
  return {
    vaultOwner: OWNER,
    agent: AGENT,
    token: TOKEN,
    cap: "5000000",
    merchantScope: MERCHANT,
    expiry: String(NOW_S + 3600),
    approvalId: `0x${"ab".repeat(32)}`,
    ...overrides,
  };
}

function record(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    id: "req_1",
    sessionKey: AGENT,
    agent: "shopping-agent",
    status: "pending",
    reason: "Cart total exceeds the per-card cap",
    request: request(),
    idempotencyKey: null,
    createdAt: NOW_MS - 60_000,
    expiresAt: NOW_MS + 3_600_000,
    resolvedAt: null,
    resolvedBy: null,
    decisionNote: null,
    ownerSignature: null,
    signatureConsumedAt: null,
    cardId: null,
    mintTxHash: null,
    ...overrides,
  };
}

const ctx: EvaluateContext = {
  nowMs: NOW_MS,
  ownerAddress: OWNER,
  paymentToken: TOKEN,
  vaultAddress: VAULT,
};

/* -------------------------------------------------------------------------- */

describe("readBigInt", () => {
  test("accepts decimal strings, hex strings, bigints and safe integers", () => {
    expect(readBigInt("1000")).toBe(1000n);
    expect(readBigInt("0xff")).toBe(255n);
    expect(readBigInt(42)).toBe(42n);
    expect(readBigInt(7n)).toBe(7n);
  });

  test("rejects anything lossy or nonsensical", () => {
    expect(readBigInt(1.5)).toBeNull();
    expect(readBigInt(-1)).toBeNull();
    expect(readBigInt("abc")).toBeNull();
    expect(readBigInt(null)).toBeNull();
    expect(readBigInt(undefined)).toBeNull();
    expect(readBigInt(Number.MAX_SAFE_INTEGER + 2)).toBeNull();
  });
});

describe("approvalIdFor", () => {
  test("is deterministic per request id", () => {
    expect(approvalIdFor("req_1")).toBe(approvalIdFor("req_1"));
  });

  test("differs between requests", () => {
    expect(approvalIdFor("req_1")).not.toBe(approvalIdFor("req_2"));
  });

  test("is a 32-byte hex value the contract can take as bytes32", () => {
    expect(approvalIdFor("req_1")).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("parseApprovalTerms", () => {
  const fallbackApprovalId = approvalIdFor("req_1");

  test("reads the CardApproval struct out of a schemaless request", () => {
    const parsed = parseApprovalTerms(request(), { fallbackApprovalId });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.terms.cap).toBe(5_000_000n);
    expect(parsed.terms.expiry).toBe(BigInt(NOW_S + 3600));
    expect(parsed.terms.merchantScope).toBe(MERCHANT);
  });

  test("accepts `merchant` as an alias for `merchantScope`", () => {
    const parsed = parseApprovalTerms(
      request({ merchantScope: undefined, merchant: MERCHANT }),
      { fallbackApprovalId },
    );
    expect(parsed.ok && parsed.terms.merchantScope).toBe(MERCHANT);
  });

  test("an absent merchant scope means any merchant, not a parse failure", () => {
    const parsed = parseApprovalTerms(request({ merchantScope: undefined }), {
      fallbackApprovalId,
    });
    expect(parsed.ok && parsed.terms.merchantScope).toBe(
      "0x0000000000000000000000000000000000000000",
    );
  });

  test("derives an approvalId when the request omits one", () => {
    const parsed = parseApprovalTerms(request({ approvalId: undefined }), {
      fallbackApprovalId,
    });
    expect(parsed.ok && parsed.terms.approvalId).toBe(fallbackApprovalId);
  });

  test("falls back to the connected wallet as vault owner", () => {
    const parsed = parseApprovalTerms(request({ vaultOwner: undefined }), {
      fallbackApprovalId,
      fallbackVaultOwner: OWNER,
    });
    expect(parsed.ok && parsed.terms.vaultOwner).toBe(OWNER);
  });

  test("refuses a request with no cap", () => {
    const parsed = parseApprovalTerms(request({ cap: undefined }), {
      fallbackApprovalId,
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("cap");
  });

  test("refuses a zero cap", () => {
    const parsed = parseApprovalTerms(request({ cap: "0" }), {
      fallbackApprovalId,
    });
    expect(parsed.ok).toBe(false);
  });

  test("refuses a malformed address", () => {
    const parsed = parseApprovalTerms(request({ agent: "0xnope" }), {
      fallbackApprovalId,
    });
    expect(parsed.ok).toBe(false);
  });

  test("survives a record whose request payload is missing entirely", () => {
    for (const payload of [undefined, null, [], "nope"]) {
      const parsed = parseApprovalTerms(
        payload as never,
        { fallbackApprovalId },
      );
      expect(parsed.ok).toBe(false);
    }
  });

  test("refuses an expiry that looks like milliseconds", () => {
    const parsed = parseApprovalTerms(request({ expiry: String(NOW_MS) }), {
      fallbackApprovalId,
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("milliseconds");
  });
});

/* -------------------------------------------------------------------------- */

describe("effectiveStatus", () => {
  test("a pending request past its TTL reads expired", () => {
    expect(effectiveStatus(record(), NOW_MS + 3_600_001)).toBe("expired");
  });

  test("a resolved request keeps its terminal status forever", () => {
    expect(
      effectiveStatus(record({ status: "denied" }), NOW_MS + 10 ** 12),
    ).toBe("denied");
  });
});

describe("evaluateApproval", () => {
  test("a well-formed pending request is actionable", () => {
    const view = evaluateApproval(record(), ctx);
    expect(view.actionable).toBe(true);
    expect(view.blocked).toBeNull();
    expect(view.tone).toBe("pending");
    expect(view.label).toBe("Awaiting you");
    expect(view.terms?.cap).toBe(5_000_000n);
  });

  test("an expired request is rendered with an Expired badge and no action", () => {
    const view = evaluateApproval(record({ expiresAt: NOW_MS - 1 }), ctx);
    expect(view.expired).toBe(true);
    expect(view.status).toBe("expired");
    expect(view.label).toBe("Expired");
    expect(view.tone).toBe("expired");
    expect(view.actionable).toBe(false);
    expect(view.blocked?.code).toBe("expired");
    // It still carries its terms so the owner can see what was asked for.
    expect(view.terms).not.toBeNull();
  });

  test("an approval is never given the settled tone", () => {
    const view = evaluateApproval(
      record({ status: "approved", ownerSignature: "0xdead" }),
      ctx,
    );
    // A signature is not a transaction; only a finalized block earns `settled`.
    expect(view.tone).toBe("neutral");
    expect(view.label).toBe("Approved");
    expect(view.relayable).toBe(true);
  });

  test("a consumed approval reads as minted and is no longer relayable", () => {
    const view = evaluateApproval(
      record({
        status: "approved",
        ownerSignature: null,
        signatureConsumedAt: NOW_MS,
      }),
      ctx,
    );
    expect(view.label).toBe("Minted");
    expect(view.relayable).toBe(false);
  });

  test("a denied request is terminal and tone danger", () => {
    const view = evaluateApproval(record({ status: "denied" }), ctx);
    expect(view.tone).toBe("danger");
    expect(view.blocked?.code).toBe("resolved");
  });

  test("a disconnected wallet blocks signing with a connect prompt", () => {
    const view = evaluateApproval(record(), { ...ctx, ownerAddress: null });
    expect(view.actionable).toBe(false);
    expect(view.blocked?.code).toBe("wallet-disconnected");
  });

  test("a request naming another vault owner cannot be signed", () => {
    const view = evaluateApproval(
      record({ request: request({ vaultOwner: AGENT }) }),
      ctx,
    );
    expect(view.blocked?.code).toBe("wrong-owner");
  });

  test("owner comparison is case-insensitive", () => {
    const view = evaluateApproval(
      record({ request: request({ vaultOwner: OWNER.toUpperCase().replace("0X", "0x") }) }),
      ctx,
    );
    expect(view.actionable).toBe(true);
  });

  test("a request in the wrong settlement token is blocked", () => {
    const view = evaluateApproval(
      record({ request: request({ token: MERCHANT }) }),
      ctx,
    );
    expect(view.blocked?.code).toBe("wrong-token");
  });

  test("the token check is skipped while paymentToken is still loading", () => {
    const view = evaluateApproval(record(), { ...ctx, paymentToken: null });
    expect(view.actionable).toBe(true);
  });

  test("a card that would be born expired is blocked", () => {
    const view = evaluateApproval(
      record({ request: request({ expiry: String(NOW_S - 1) }) }),
      ctx,
    );
    expect(view.blocked?.code).toBe("card-expiry-past");
  });

  test("an unreadable request is blocked with the reason spelled out", () => {
    const view = evaluateApproval(record({ request: { nonsense: true } }), ctx);
    expect(view.blocked?.code).toBe("unreadable");
    expect(view.terms).toBeNull();
    expect(view.actionable).toBe(false);
  });

  test("an unconfigured vault blocks signing", () => {
    const view = evaluateApproval(record(), { ...ctx, vaultAddress: null });
    expect(view.blocked?.code).toBe("vault-unconfigured");
  });

  test("expiry outranks every other blocker", () => {
    const view = evaluateApproval(
      record({ expiresAt: NOW_MS - 1, request: { nonsense: true } }),
      { ...ctx, ownerAddress: null },
    );
    expect(view.blocked?.code).toBe("expired");
  });
});

describe("queue aggregates", () => {
  test("counts only rows still waiting on the owner", () => {
    const views = [
      evaluateApproval(record({ id: "a" }), ctx),
      evaluateApproval(record({ id: "b", status: "denied" }), ctx),
      evaluateApproval(record({ id: "c", expiresAt: NOW_MS - 1 }), ctx),
    ];
    expect(countActionable(views)).toBe(1);
  });

  test("sorts pending first, then newest", () => {
    const views = [
      evaluateApproval(record({ id: "old", status: "denied", createdAt: 1 }), ctx),
      evaluateApproval(record({ id: "new", createdAt: NOW_MS - 10 }), ctx),
      evaluateApproval(record({ id: "newer", createdAt: NOW_MS - 5 }), ctx),
    ];
    expect(sortApprovals(views).map((view) => view.record.id)).toEqual([
      "newer",
      "new",
      "old",
    ]);
  });
});

describe("emptyQueueCopy", () => {
  test("an empty pending list with history says the work is done", () => {
    expect(emptyQueueCopy("pending", 3).body).toContain("been answered");
  });

  test("a genuinely empty queue explains why nothing is here", () => {
    const copy = emptyQueueCopy("pending", 0);
    expect(copy.body).toContain("session policy");
    expect(copy.title.length).toBeGreaterThan(0);
  });

  test("the all filter gets its own copy", () => {
    expect(emptyQueueCopy("all", 0).title).toBe("No requests yet");
  });

  test("no empty state is ever blank", () => {
    for (const filter of ["pending", "all"] as const) {
      for (const total of [0, 5]) {
        const copy = emptyQueueCopy(filter, total);
        expect(copy.title.trim()).not.toBe("");
        expect(copy.body.trim()).not.toBe("");
      }
    }
  });
});
