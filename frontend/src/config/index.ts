import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import type { AppKitNetwork } from "@reown/appkit/networks";
import { giwaSepolia } from "./networks";

/**
 * Reown AppKit wiring for the owner dashboard.
 *
 * The dashboard is the only surface that touches the owner's key: it collects
 * the EIP-712 approval signature and submits the mint-on-approve transaction.
 * The daemon never holds a key, so this wallet connection is what makes the
 * over-policy approval flow possible at all.
 *
 * No 'use client' here on purpose — this module is imported by both the server
 * layout and the client provider.
 */
export const projectId =
  process.env.NEXT_PUBLIC_REOWN_PROJECT_ID ??
  // Reown's public localhost-testing id. Replace before deploying anywhere real.
  "b56e18d47c72ab683b10814fe9495694";

export const networks: [AppKitNetwork, ...AppKitNetwork[]] = [giwaSepolia];

export const wagmiAdapter = new WagmiAdapter({
  networks,
  projectId,
  ssr: true,
});

export const metadata = {
  name: "GiwaCard",
  description: "One-time onchain spend cards for AI agents on GIWA",
  url: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
  icons: ["http://localhost:3000/favicon.ico"],
};
