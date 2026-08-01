import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  // Next 16 builds with Turbopack by default. The webpack `externals` entry
  // that WalletConnect's setup guide prescribes is not needed here — Turbopack
  // resolves pino-pretty, lokijs and encoding as optional peers on its own —
  // but an explicit turbopack key is required to opt out of the webpack path.
  turbopack: {},
};

export default nextConfig;
