"use client";

import { useAppKit } from "@reown/appkit/react";
import { useAccount } from "wagmi";
import { Button } from "@/components/ui";
import { giwaSepolia } from "@/config/networks";
import { shortAddress } from "@/lib/format";

/**
 * The mark from the landing page's logo, kept identical so the dashboard is
 * visibly the same product (KTD-18). Four tiles in a 256-unit square.
 */
const LOGO_PATHS = [
  "M 128 192 L 128 256 L 64.5 256 L 32 223 L 0 192 L 0 128 L 64 128 Z",
  "M 256 192 L 256 256 L 192.5 256 L 160 223 L 128 192 L 128 128 L 192 128 Z",
  "M 128 64 L 128 128 L 64.5 128 L 32 95 L 0 64 L 0 0 L 64 0 Z",
  "M 256 64 L 256 128 L 192.5 128 L 160 95 L 128 64 L 128 0 L 192 0 Z",
];

export function SiteHeader() {
  const { open } = useAppKit();
  const { address, isConnected, isConnecting, isReconnecting, chainId } =
    useAccount();

  const wrongNetwork = isConnected && chainId !== giwaSepolia.id;

  return (
    <header className="flex flex-wrap items-center justify-between gap-4 py-8">
      <div className="flex items-center gap-3">
        <svg
          viewBox="0 0 256 256"
          className="h-7 w-7 shrink-0"
          aria-hidden="true"
        >
          {LOGO_PATHS.map((d) => (
            <path key={d} d={d} fill="currentColor" />
          ))}
        </svg>
        <div className="leading-tight">
          <p className="text-sm font-medium tracking-tight text-ink">GiwaCard</p>
          <p className="text-xs text-ink/50">Owner dashboard</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span
          className={
            wrongNetwork
              ? "inline-flex items-center gap-1.5 rounded-full border border-amber-600/25 bg-amber-500/15 px-3 py-1.5 text-xs font-medium text-amber-800"
              : "inline-flex items-center gap-1.5 rounded-full border border-ink/10 bg-ink/5 px-3 py-1.5 text-xs text-ink/60 backdrop-blur"
          }
        >
          <span
            className={
              wrongNetwork
                ? "h-1.5 w-1.5 rounded-full bg-amber-600"
                : "h-1.5 w-1.5 rounded-full bg-emerald-600"
            }
          />
          {wrongNetwork ? "Wrong network" : giwaSepolia.name}
        </span>

        {isConnected ? (
          <Button variant="ghost" size="sm" onClick={() => void open()}>
            <span className="font-mono text-xs">{shortAddress(address)}</span>
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={() => void open()}
            disabled={isConnecting || isReconnecting}
          >
            {isConnecting || isReconnecting ? "Connecting…" : "Connect wallet"}
          </Button>
        )}
      </div>
    </header>
  );
}
