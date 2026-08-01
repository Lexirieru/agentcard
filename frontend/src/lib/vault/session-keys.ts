import type { Address } from "viem";

/**
 * Session-key state assembled from logs.
 *
 * The vault has no way to list an owner's keys or a key's merchants — both are
 * mappings, and a mapping cannot be enumerated onchain. So this is rebuilt from
 * `SessionKeyRegistered` / `SessionKeyMerchantSet` / `SessionKeyRevoked` logs,
 * which means it is only as complete as the block range that was queried. Every
 * surface that shows it has to say so; presenting a derived list as if it were
 * authoritative is how someone ends up believing a merchant is blocked when it
 * is not.
 */
export type SessionKeyView = {
  address: Address;
  /** Base units of the payment token. */
  capPerCard: bigint;
  dailyCap: bigint;
  /** Seconds. The furthest expiry a card minted by this key may carry. */
  maxExpiry: bigint;
  active: boolean;
  /** Merchants seen allowed, minus any later denied. Derived, not exhaustive. */
  merchants: Address[];
  /** Cards this key minted that are still chargeable. */
  activeCards: number;
};

type RegisteredLog = {
  sessionKey: Address;
  capPerCard: bigint;
  dailyCap: bigint;
  maxExpiry: bigint;
  blockNumber: bigint;
  logIndex: number;
};

type MerchantLog = {
  sessionKey: Address;
  merchant: Address;
  allowed: boolean;
  blockNumber: bigint;
  logIndex: number;
};

type RevokedLog = {
  sessionKey: Address;
  blockNumber: bigint;
  logIndex: number;
};

/** Sort key so later events win regardless of the order logs arrive in. */
function ordinal(log: { blockNumber: bigint; logIndex: number }): bigint {
  return log.blockNumber * 100_000n + BigInt(log.logIndex);
}

function lower(address: Address): string {
  return address.toLowerCase();
}

/**
 * Fold the three log streams into one view per key.
 *
 * Registration and revocation both write `active`, so the *later* of the two
 * decides: re-registering a revoked key brings it back, and revoking after a
 * re-registration kills it again. Ordering by block-then-index rather than by
 * array position matters because the three queries return independently.
 */
export function deriveSessionKeys(input: {
  registered: RegisteredLog[];
  merchants: MerchantLog[];
  revoked: RevokedLog[];
  /** Active card counts by the key that minted them. */
  activeCardsByKey?: Record<string, number>;
}): SessionKeyView[] {
  const byKey = new Map<
    string,
    {
      address: Address;
      capPerCard: bigint;
      dailyCap: bigint;
      maxExpiry: bigint;
      lastPolicyAt: bigint;
      activeAt: bigint;
      active: boolean;
      merchants: Map<string, { address: Address; allowed: boolean; at: bigint }>;
    }
  >();

  for (const log of input.registered) {
    const key = lower(log.sessionKey);
    const at = ordinal(log);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        address: log.sessionKey,
        capPerCard: log.capPerCard,
        dailyCap: log.dailyCap,
        maxExpiry: log.maxExpiry,
        lastPolicyAt: at,
        activeAt: at,
        active: true,
        merchants: new Map(),
      });
      continue;
    }
    if (at >= existing.lastPolicyAt) {
      existing.capPerCard = log.capPerCard;
      existing.dailyCap = log.dailyCap;
      existing.maxExpiry = log.maxExpiry;
      existing.lastPolicyAt = at;
    }
    if (at >= existing.activeAt) {
      existing.active = true;
      existing.activeAt = at;
    }
  }

  for (const log of input.revoked) {
    const entry = byKey.get(lower(log.sessionKey));
    if (!entry) continue;
    const at = ordinal(log);
    if (at >= entry.activeAt) {
      entry.active = false;
      entry.activeAt = at;
    }
  }

  for (const log of input.merchants) {
    const entry = byKey.get(lower(log.sessionKey));
    if (!entry) continue;
    const at = ordinal(log);
    const slot = entry.merchants.get(lower(log.merchant));
    if (!slot || at >= slot.at) {
      entry.merchants.set(lower(log.merchant), {
        address: log.merchant,
        allowed: log.allowed,
        at,
      });
    }
  }

  return [...byKey.values()]
    .map((entry) => ({
      address: entry.address,
      capPerCard: entry.capPerCard,
      dailyCap: entry.dailyCap,
      maxExpiry: entry.maxExpiry,
      active: entry.active,
      merchants: [...entry.merchants.values()]
        .filter((m) => m.allowed)
        .map((m) => m.address),
      activeCards: input.activeCardsByKey?.[lower(entry.address)] ?? 0,
    }))
    .sort((a, b) => {
      // Live keys first — the ones an owner might need to kill.
      if (a.active !== b.active) return a.active ? -1 : 1;
      return a.address.localeCompare(b.address);
    });
}

/** Result of validating one policy form. */
export type PolicyDraft = {
  capPerCard: bigint;
  dailyCap: bigint;
  maxExpiry: bigint;
};

export type PolicyFormInput = {
  /** Whole-token amount as typed, e.g. "10" or "2.5". */
  capPerCard: string;
  dailyCap: string;
  /** Hours, as typed. */
  maxExpiryHours: string;
};

/**
 * Parse a decimal amount into base units without going through a float.
 *
 * `Number("0.1") * 1e6` is 100000.00000000001; money must not be rounded into
 * existence, so the string is split and padded instead.
 */
export function parseTokenAmount(input: string, decimals: number): bigint | null {
  const trimmed = input.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;

  const [whole = "0", fraction = ""] = trimmed.split(".");
  if (fraction.length > decimals) return null;

  const padded = fraction.padEnd(decimals, "0");
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || "0");
}

/** Longest expiry we let a form set, in hours. Matches the CLI's ceiling. */
export const MAX_EXPIRY_HOURS = 24 * 30;

export function validatePolicyForm(
  input: PolicyFormInput,
  decimals: number,
): { ok: true; value: PolicyDraft } | { ok: false; error: string } {
  const capPerCard = parseTokenAmount(input.capPerCard, decimals);
  if (capPerCard === null) return { ok: false, error: "Per-card limit is not a number." };
  if (capPerCard <= 0n)
    return { ok: false, error: "Per-card limit must be more than zero." };

  const dailyCap = parseTokenAmount(input.dailyCap, decimals);
  if (dailyCap === null) return { ok: false, error: "Daily limit is not a number." };
  if (dailyCap <= 0n) return { ok: false, error: "Daily limit must be more than zero." };

  if (dailyCap < capPerCard) {
    return {
      ok: false,
      error: "Daily limit is below the per-card limit, so only one card could ever be made.",
    };
  }

  const hours = Number(input.maxExpiryHours.trim());
  if (!Number.isFinite(hours) || !Number.isInteger(hours)) {
    return { ok: false, error: "Card lifetime must be a whole number of hours." };
  }
  if (hours <= 0) return { ok: false, error: "Card lifetime must be at least an hour." };
  if (hours > MAX_EXPIRY_HOURS) {
    return { ok: false, error: `Card lifetime cannot exceed ${MAX_EXPIRY_HOURS} hours.` };
  }

  return {
    ok: true,
    value: { capPerCard, dailyCap, maxExpiry: BigInt(hours * 3600) },
  };
}
