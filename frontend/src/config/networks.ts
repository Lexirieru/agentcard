import { defineChain } from "@reown/appkit/networks";

/**
 * GIWA Sepolia — the OP Stack L2 testnet this product runs on.
 *
 * Defined here rather than imported from viem because AppKit needs its own
 * network shape. Values must stay identical to giwacard/src/chain/giwaSepolia.ts;
 * the two exist for different consumers, not as independent sources of truth.
 *
 * The public RPC is documented as rate-limited and dev-only.
 */
export const giwaSepolia = defineChain({
  id: 91342,
  caipNetworkId: "eip155:91342",
  chainNamespace: "eip155",
  name: "GIWA Sepolia",
  nativeCurrency: {
    name: "Sepolia Ether",
    symbol: "ETH",
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: ["https://sepolia-rpc.giwa.io"],
    },
  },
  blockExplorers: {
    default: {
      name: "GIWA Explorer",
      url: "https://sepolia-explorer.giwa.io",
    },
  },
  testnet: true,
});
