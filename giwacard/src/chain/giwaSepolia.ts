import { defineChain } from 'viem'
import { chainConfig } from 'viem/op-stack'

/**
 * GIWA Sepolia is an OP Stack L2 that settles to Ethereum Sepolia, so the
 * chain definition spreads `chainConfig` from `viem/op-stack` (deposit-tx
 * formatters + serializers + the standard L2 predeploys) exactly the way
 * viem's own `baseSepolia` definition does.
 */
const sourceId = 11_155_111 // sepolia

/** Chain ID of GIWA Sepolia. */
export const GIWA_SEPOLIA_ID = 91_342 as const

/** Public, rate-limited standard RPC. Dev/testnet use only. */
export const GIWA_SEPOLIA_RPC_URL = 'https://sepolia-rpc.giwa.io' as const

/**
 * Public, rate-limited Flashblocks RPC. Serves preconfirmation state via
 * `blockTag: 'pending'` roughly every 200ms, ahead of the sequencer block.
 */
export const GIWA_SEPOLIA_FLASHBLOCKS_RPC_URL =
  'https://sepolia-rpc-flashblocks.giwa.io' as const

/** Blockscout explorer. The REST API lives under the `/api` suffix. */
export const GIWA_SEPOLIA_EXPLORER_URL =
  'https://sepolia-explorer.giwa.io' as const

/** Blockscout REST/verification API base (the `/api` suffix is mandatory). */
export const GIWA_SEPOLIA_EXPLORER_API_URL =
  'https://sepolia-explorer.giwa.io/api' as const

/**
 * Where a human gets GIWA Sepolia **ETH** — the gas asset.
 *
 * A web page, not an RPC call: nothing in this package can claim it, and no CLI
 * command can either. `giwacard faucet` claims **gUSD**, which is the money, not
 * the gas — so a gas shortfall must never be answered with that command. This
 * constant lives beside the chain facts because both the CLI and the MCP error
 * taxonomy need it and neither should import the other.
 *
 * The docs index rather than a specific faucet host: GIWA's faucet endpoints
 * have moved during testnet, and a stale hard-coded URL sends users to a 404 at
 * the exact moment they are stuck.
 */
export const GIWA_SEPOLIA_ETH_FAUCET_URL = 'https://docs.giwa.io/faucets' as const

/**
 * Advertised Flashblocks preconfirmation interval, in milliseconds.
 *
 * KTD-5: preconfirmation state is a UX affordance only. Onchain state remains
 * the source of truth for card status; anything read at this latency must be
 * surfaced as "pending" until it lands in a safe block.
 */
export const GIWA_SEPOLIA_PRECONFIRMATION_TIME_MS = 200 as const

/**
 * GIWA Sepolia (chain ID 91342), the OP Stack testnet this package targets.
 *
 * `rpcUrls.default` is the standard endpoint. `rpcUrls.flashblocks` is the
 * preconfirmation endpoint; prefer {@link giwaSepoliaFlashblocks} when you want
 * a chain object whose default transport already points at Flashblocks.
 */
export const giwaSepolia = /*#__PURE__*/ defineChain({
  ...chainConfig,
  id: GIWA_SEPOLIA_ID,
  name: 'GIWA Sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: {
      http: [GIWA_SEPOLIA_RPC_URL],
    },
    flashblocks: {
      http: [GIWA_SEPOLIA_FLASHBLOCKS_RPC_URL],
    },
  },
  blockExplorers: {
    default: {
      name: 'GIWA Sepolia Explorer',
      url: GIWA_SEPOLIA_EXPLORER_URL,
      apiUrl: GIWA_SEPOLIA_EXPLORER_API_URL,
    },
  },
  contracts: {
    ...chainConfig.contracts,
  },
  testnet: true,
  sourceId,
})

/**
 * Same chain, but with the Flashblocks endpoint as the default RPC and the
 * preconfirmation interval advertised to viem.
 *
 * Mirrors viem's `baseSepoliaPreconf`. Use it for reads that want
 * preconfirmation state (`blockTag: 'pending'`); never for deciding that a card
 * is final (KTD-5).
 */
export const giwaSepoliaFlashblocks = /*#__PURE__*/ defineChain({
  ...giwaSepolia,
  experimental_preconfirmationTime: GIWA_SEPOLIA_PRECONFIRMATION_TIME_MS,
  rpcUrls: {
    ...giwaSepolia.rpcUrls,
    default: {
      http: [GIWA_SEPOLIA_FLASHBLOCKS_RPC_URL],
    },
  },
})

/** Explorer link helpers, so nothing downstream hand-builds explorer URLs. */
export const giwaSepoliaExplorer = {
  tx: (hash: string) => `${GIWA_SEPOLIA_EXPLORER_URL}/tx/${hash}`,
  address: (address: string) =>
    `${GIWA_SEPOLIA_EXPLORER_URL}/address/${address}`,
  block: (block: bigint | number | string) =>
    `${GIWA_SEPOLIA_EXPLORER_URL}/block/${block}`,
} as const
