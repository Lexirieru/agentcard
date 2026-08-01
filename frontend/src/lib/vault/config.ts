import { giwaSepolia } from "@/config/networks";

/**
 * Where the dashboard reads onchain truth from.
 *
 * Every value is a build-time `NEXT_PUBLIC_` env var because the vault is one
 * canonical multi-owner deployment per chain, not a per-user contract. There is
 * no runtime discovery to do — and shipping a wrong-but-plausible default
 * address would be worse than rendering an honest "not configured" panel.
 */

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Parse a `0x…40` address from env, returning null for absent or malformed. */
export function parseAddressEnv(raw: string | undefined): `0x${string}` | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (!ADDRESS_RE.test(trimmed)) return null;
  return trimmed as `0x${string}`;
}

/** Parse a non-negative bigint from env, falling back on anything unusable. */
export function parseBigIntEnv(
  raw: string | undefined,
  fallback: bigint,
): bigint {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return fallback;
  return BigInt(trimmed);
}

/** The CardVault proxy. `null` until the deployer sets the env var. */
export const CARD_VAULT_ADDRESS = parseAddressEnv(
  process.env.NEXT_PUBLIC_CARD_VAULT_ADDRESS,
);

/**
 * Block the vault proxy was deployed in. Scanning from 0 on a public RPC is
 * both slow and usually refused, so this is the floor of every log query.
 */
export const CARD_VAULT_DEPLOY_BLOCK = parseBigIntEnv(
  process.env.NEXT_PUBLIC_CARD_VAULT_DEPLOY_BLOCK,
  0n,
);

/**
 * How far back a single history query reaches. Public RPCs cap `eth_getLogs`
 * ranges; 100k blocks is comfortably inside GIWA Sepolia's limit and covers
 * days of history at a 2s block time.
 */
export const LOG_LOOKBACK_BLOCKS = parseBigIntEnv(
  process.env.NEXT_PUBLIC_LOG_LOOKBACK_BLOCKS,
  100_000n,
);

/**
 * Decimals of the vault's payment token.
 *
 * gUSD fixes this at 6 (`decimals()` is `pure` in GUSD.sol, matching USDC), so
 * reading it back per render would be a round trip for a constant.
 */
export const PAYMENT_TOKEN_DECIMALS = Number(
  parseBigIntEnv(process.env.NEXT_PUBLIC_PAYMENT_TOKEN_DECIMALS, 6n),
);

/** Ticker shown next to amounts. */
export const PAYMENT_TOKEN_SYMBOL =
  process.env.NEXT_PUBLIC_PAYMENT_TOKEN_SYMBOL?.trim() || "gUSD";

/** Chain the dashboard reads and writes on. */
export const CHAIN_ID = giwaSepolia.id as number;

/** Block explorer base, used to link out from history rows. */
export const EXPLORER_URL =
  giwaSepolia.blockExplorers?.default.url ?? "https://sepolia-explorer.giwa.io";

/**
 * Lower bound of a log query: never below the deploy block, and never more than
 * `lookback` behind the head. Returned inclusive, as `eth_getLogs` expects.
 */
export function logFromBlock(
  latestBlock: bigint,
  deployBlock: bigint = CARD_VAULT_DEPLOY_BLOCK,
  lookback: bigint = LOG_LOOKBACK_BLOCKS,
): bigint {
  const windowStart = latestBlock > lookback ? latestBlock - lookback : 0n;
  return windowStart > deployBlock ? windowStart : deployBlock;
}
