"use client";

import { useAppKit } from "@reown/appkit/react";
import { useAccount } from "wagmi";
import { Button, Panel, Stagger } from "@/components/ui";

/**
 * What the dashboard is before a wallet is connected.
 *
 * Not a disabled copy of the real thing: with no owner address there is no
 * vault to read, no queue to answer and nothing truthful to put in the numbers.
 * The connect step is also the security story — the owner's key never leaves
 * the browser wallet (KTD-14) — so it is worth stating rather than hiding
 * behind a button.
 */
export function ConnectPrompt() {
  const { open } = useAppKit();
  const { isConnecting, isReconnecting } = useAccount();
  const restoring = isConnecting || isReconnecting;

  return (
    <Stagger delay={0.1}>
      <Panel className="px-6 py-14 sm:px-12 sm:py-20">
        <div className="mx-auto max-w-xl text-center">
          <h1
            className="font-light tracking-tight text-ink"
            style={{ fontSize: "clamp(2rem, 6vw, 3.25rem)", lineHeight: 1.05 }}
          >
            Connect your wallet
            <br />
            to open the vault
          </h1>
          <p className="mx-auto mt-6 max-w-md text-[15px] leading-relaxed text-ink/65">
            This dashboard reads your balance, cards and approval queue against
            the address you connect. Approvals are signed in your wallet — no
            key material ever reaches a server.
          </p>
          <div className="mt-8 flex justify-center">
            <Button onClick={() => void open()} disabled={restoring}>
              {restoring ? "Restoring session…" : "Connect wallet"}
            </Button>
          </div>
          <p className="mt-6 text-xs text-ink/45">
            Any wallet on GIWA Sepolia. Read-only until you approve something.
          </p>
        </div>
      </Panel>
    </Stagger>
  );
}
