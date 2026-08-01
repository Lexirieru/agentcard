import { describe, expect, test } from "bun:test";
import {
  cardIdsFromMintLogs,
  describeEntry,
  historyFromLogs,
  sortHistory,
  type HistoryEntry,
} from "./history";

const OWNER = "0x1111111111111111111111111111111111111111" as const;
const AGENT = "0x2222222222222222222222222222222222222222" as const;
const MERCHANT = "0x4444444444444444444444444444444444444444" as const;
const TOKEN = "0x3333333333333333333333333333333333333333" as const;
const TX = "0xabc" as `0x${string}`;

describe("historyFromLogs", () => {
  test("a mint locks its cap in escrow and leaves the balance alone", () => {
    const [entry] = historyFromLogs({
      minted: [
        {
          args: {
            cardId: 1n,
            vaultOwner: OWNER,
            agent: AGENT,
            token: TOKEN,
            cap: 5_000_000n,
            merchantScope: MERCHANT,
            expiry: 1_800_000_000n,
          },
          blockNumber: 10n,
          transactionHash: TX,
          logIndex: 0,
        },
      ],
    });

    expect(entry).toBeDefined();
    expect(entry!.kind).toBe("minted");
    expect(entry!.amount).toBe(5_000_000n);
    expect(entry!.escrowDelta).toBe(5_000_000n);
    expect(entry!.balanceDelta).toBe(0n);
    expect(entry!.counterparty).toBe(AGENT);
  });

  test("a charge spends part of the cap and releases the rest", () => {
    const [entry] = historyFromLogs({
      charged: [
        {
          args: {
            cardId: 1n,
            vaultOwner: OWNER,
            merchant: MERCHANT,
            amount: 3_000_000n,
            released: 2_000_000n,
          },
          blockNumber: 11n,
          transactionHash: TX,
          logIndex: 1,
        },
      ],
    });

    expect(entry!.kind).toBe("charged");
    expect(entry!.amount).toBe(3_000_000n);
    expect(entry!.released).toBe(2_000_000n);
    expect(entry!.balanceDelta).toBe(-3_000_000n);
    // The whole cap leaves escrow: spent portion settles, remainder returns.
    expect(entry!.escrowDelta).toBe(-5_000_000n);
    expect(entry!.counterparty).toBe(MERCHANT);
  });

  test("a cancellation returns escrow without moving the balance", () => {
    const [entry] = historyFromLogs({
      cancelled: [
        {
          args: { cardId: 2n, vaultOwner: OWNER, released: 1_000n },
          blockNumber: 12n,
          transactionHash: TX,
          logIndex: 0,
        },
      ],
    });
    expect(entry!.kind).toBe("cancelled");
    expect(entry!.balanceDelta).toBe(0n);
    expect(entry!.escrowDelta).toBe(-1_000n);
    expect(entry!.counterparty).toBeNull();
  });

  test("an expiry release records who reaped it", () => {
    const [entry] = historyFromLogs({
      expired: [
        {
          args: {
            cardId: 3n,
            vaultOwner: OWNER,
            caller: MERCHANT,
            released: 7n,
          },
          blockNumber: 13n,
          transactionHash: TX,
          logIndex: 0,
        },
      ],
    });
    expect(entry!.kind).toBe("expired");
    expect(entry!.counterparty).toBe(MERCHANT);
    expect(entry!.escrowDelta).toBe(-7n);
  });

  test("all four streams fold into one ledger, newest first", () => {
    const entries = historyFromLogs({
      minted: [
        {
          args: { cardId: 1n, cap: 10n },
          blockNumber: 5n,
          transactionHash: TX,
          logIndex: 0,
        },
      ],
      charged: [
        {
          args: { cardId: 1n, amount: 4n, released: 6n },
          blockNumber: 9n,
          transactionHash: TX,
          logIndex: 2,
        },
      ],
      cancelled: [
        {
          args: { cardId: 2n, released: 3n },
          blockNumber: 9n,
          transactionHash: TX,
          logIndex: 5,
        },
      ],
    });

    expect(entries.map((entry) => entry.kind)).toEqual([
      "cancelled",
      "charged",
      "minted",
    ]);
  });

  test("logs missing a card id are dropped rather than rendered blank", () => {
    const entries = historyFromLogs({
      minted: [{ args: { cap: 1n }, blockNumber: 1n }],
      charged: [{ args: { cardId: 1n }, blockNumber: 1n }],
    });
    expect(entries).toHaveLength(0);
  });

  test("ids are unique per log so React keys do not collide", () => {
    const entries = historyFromLogs({
      minted: [
        { args: { cardId: 1n, cap: 1n }, transactionHash: TX, logIndex: 0 },
        { args: { cardId: 2n, cap: 1n }, transactionHash: TX, logIndex: 1 },
      ],
    });
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(2);
  });

  test("no logs at all is an empty ledger, not a throw", () => {
    expect(historyFromLogs({})).toEqual([]);
  });
});

describe("sortHistory", () => {
  function entry(
    blockNumber: bigint | null,
    logIndex: number | null,
  ): HistoryEntry {
    return {
      id: `${blockNumber}-${logIndex}`,
      kind: "minted",
      cardId: 1n,
      amount: 0n,
      released: null,
      balanceDelta: 0n,
      escrowDelta: 0n,
      counterparty: null,
      blockNumber,
      txHash: null,
      logIndex,
    };
  }

  test("an unmined entry sorts above every mined one", () => {
    const sorted = sortHistory([entry(10n, 0), entry(null, null), entry(20n, 0)]);
    expect(sorted[0]!.blockNumber).toBeNull();
    expect(sorted[1]!.blockNumber).toBe(20n);
  });

  test("within a block, the later log index comes first", () => {
    const sorted = sortHistory([entry(10n, 1), entry(10n, 4)]);
    expect(sorted.map((item) => item.logIndex)).toEqual([4, 1]);
  });
});

describe("describeEntry", () => {
  const base: HistoryEntry = {
    id: "x",
    kind: "charged",
    cardId: 1n,
    amount: 1n,
    released: 0n,
    balanceDelta: -1n,
    escrowDelta: -1n,
    counterparty: null,
    blockNumber: 1n,
    txHash: null,
    logIndex: 0,
  };

  test("a full-cap charge is described differently from a partial one", () => {
    expect(describeEntry(base)).toContain("full cap");
    expect(describeEntry({ ...base, released: 5n })).toContain("remainder");
  });

  test("every kind has copy", () => {
    for (const kind of ["minted", "charged", "cancelled", "expired"] as const) {
      expect(describeEntry({ ...base, kind }).length).toBeGreaterThan(0);
    }
  });
});

describe("cardIdsFromMintLogs", () => {
  test("returns unique ids, newest first", () => {
    const ids = cardIdsFromMintLogs([
      { args: { cardId: 2n } },
      { args: { cardId: 9n } },
      { args: { cardId: 2n } },
      { args: {} },
    ]);
    expect(ids).toEqual([9n, 2n]);
  });
});
