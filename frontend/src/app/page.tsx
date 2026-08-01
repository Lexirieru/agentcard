import type { Metadata } from "next";
import { Dashboard } from "@/components/dashboard/dashboard";

export const metadata: Metadata = {
  title: "Owner dashboard · GiwaCard",
  description:
    "Approve over-policy card requests, watch escrow, and read the vault's own event log.",
};

/**
 * The owner dashboard is the app's only surface, so it sits at the root.
 *
 * A server component wrapper around a client tree: every panel below reads
 * either the connected wallet or a live RPC, neither of which the server has,
 * but keeping the route itself server-rendered means the shell and its metadata
 * still come back in the first response.
 */
export default function Home() {
  return (
    <main className="flex flex-1 flex-col">
      <Dashboard />
    </main>
  );
}
