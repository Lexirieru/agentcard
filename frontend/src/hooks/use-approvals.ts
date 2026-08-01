"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useAccount, useSignTypedData, useWriteContract } from "wagmi";
import {
  consumeApproval,
  DaemonRequestError,
  listApprovals,
  resolveApproval,
} from "@/lib/approvals/client";
import type { ApprovalTerms, ApprovalView } from "@/lib/approvals/derive";
import type { ApprovalFilter, ApprovalRecord } from "@/lib/approvals/types";
import {
  CARD_APPROVAL_EIP712_TYPES,
  CARD_VAULT_EIP712_DOMAIN_NAME,
  CARD_VAULT_EIP712_DOMAIN_VERSION,
  cardVaultAbi,
} from "@/lib/vault/abi";
import { CARD_VAULT_ADDRESS, CHAIN_ID } from "@/lib/vault/config";

/**
 * The approval queue, and the two things the owner can do to a row.
 *
 * The signature is produced in the browser wallet and never leaves it as key
 * material — the daemon stores the *signature*, which is exactly the authority
 * to mint one card on terms the owner read (KTD-14).
 */

const QUEUE_KEY = "approval-queue";
const POLL_INTERVAL_MS = 5_000;

export interface ApprovalQueueState {
  records: ApprovalRecord[];
  isLoading: boolean;
  isError: boolean;
  error: DaemonRequestError | Error | null;
  isFetching: boolean;
  refetch: () => void;
}

export function useApprovalQueue(filter: ApprovalFilter): ApprovalQueueState {
  const { data, isLoading, isError, error, isFetching, refetch } = useQuery({
    queryKey: [QUEUE_KEY, filter],
    queryFn: () => listApprovals(filter),
    refetchInterval: POLL_INTERVAL_MS,
    // A daemon that is not running is a normal state of the world here, not a
    // transient blip, so do not hammer it with the default retry ladder.
    retry: false,
  });

  return {
    records: data ?? [],
    isLoading,
    isError,
    error: (error as Error | null) ?? null,
    isFetching,
    refetch: () => void refetch(),
  };
}

/* -------------------------------------------------------------------------- */
/* Actions                                                                    */
/* -------------------------------------------------------------------------- */

export type ApprovalAction = "approve" | "deny" | "relay";

export interface ApprovalActionState {
  /** Row id currently mid-action, or null. */
  busyId: string | null;
  busyAction: ApprovalAction | null;
  /** Row id the last failure belongs to. */
  errorId: string | null;
  error: Error | null;
  approve: (view: ApprovalView) => Promise<void>;
  deny: (view: ApprovalView) => Promise<void>;
  relay: (view: ApprovalView) => Promise<void>;
  dismissError: () => void;
}

/** Bigints are not JSON; the daemon stores decimal strings (see queue.ts). */
export function serializeTerms(terms: ApprovalTerms): Record<string, string> {
  return {
    vaultOwner: terms.vaultOwner,
    agent: terms.agent,
    token: terms.token,
    cap: terms.cap.toString(),
    merchantScope: terms.merchantScope,
    expiry: terms.expiry.toString(),
    approvalId: terms.approvalId,
  };
}

export function useApprovalActions(): ApprovalActionState {
  const queryClient = useQueryClient();
  const { address } = useAccount();
  const { mutateAsync: signTypedData } = useSignTypedData();
  const { writeContractAsync } = useWriteContract();

  const [busyId, setBusyId] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<ApprovalAction | null>(null);
  const [errorId, setErrorId] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: [QUEUE_KEY] });

  async function run(
    view: ApprovalView,
    action: ApprovalAction,
    body: () => Promise<void>,
  ): Promise<void> {
    setBusyId(view.record.id);
    setBusyAction(action);
    setErrorId(null);
    setError(null);
    try {
      await body();
      invalidate();
    } catch (cause) {
      setErrorId(view.record.id);
      setError(cause instanceof Error ? cause : new Error(String(cause)));
    } finally {
      setBusyId(null);
      setBusyAction(null);
    }
  }

  /**
   * Approve: one click, one wallet signature, done.
   *
   * The POST that follows the signature is not a third interaction — it needs
   * no confirmation and cannot fail in a way the owner must answer, so the
   * whole approval costs the two interactions R11 budgets for.
   */
  const approve = (view: ApprovalView) =>
    run(view, "approve", async () => {
      const terms = view.terms;
      if (terms === null) throw new Error("This request has no signable terms.");
      if (CARD_VAULT_ADDRESS === null) {
        throw new Error("No vault address is configured to sign against.");
      }

      const signature = await signTypedData({
        domain: {
          name: CARD_VAULT_EIP712_DOMAIN_NAME,
          version: CARD_VAULT_EIP712_DOMAIN_VERSION,
          chainId: CHAIN_ID,
          verifyingContract: CARD_VAULT_ADDRESS,
        },
        types: CARD_APPROVAL_EIP712_TYPES,
        primaryType: "CardApproval",
        message: terms,
      });

      await resolveApproval(view.record.id, {
        decision: "approve",
        ownerSignature: signature,
        ownerAddress: address ?? null,
        // Always sent, even when nothing was amended: the relay must mint the
        // terms that were signed, not the ones that were asked for. When the
        // request omitted an approvalId we derived one, and this is how the
        // agent learns which id the signature commits to.
        approvedRequest: serializeTerms(terms),
      });
    });

  const deny = (view: ApprovalView) =>
    run(view, "deny", async () => {
      await resolveApproval(view.record.id, {
        decision: "deny",
        ownerAddress: address ?? null,
      });
    });

  /**
   * Optionally relay the signed approval yourself.
   *
   * Anyone may submit a signed `CardApproval`; normally the requesting agent
   * does, as soon as it polls and finds its signature. This exists for the case
   * where the agent has gone away and the owner wants the card minted anyway.
   * It is a separate, opt-in action precisely so that approving stays two
   * interactions.
   */
  const relay = (view: ApprovalView) =>
    run(view, "relay", async () => {
      const terms = view.terms;
      const signature = view.record.ownerSignature;
      if (terms === null || signature === null) {
        throw new Error("This approval has no signature left to relay.");
      }
      if (CARD_VAULT_ADDRESS === null) {
        throw new Error("No vault address is configured.");
      }

      const hash = await writeContractAsync({
        address: CARD_VAULT_ADDRESS,
        abi: cardVaultAbi,
        functionName: "mintCardWithApproval",
        args: [terms, signature as `0x${string}`],
      });

      // The daemon deletes the signature once it is spent (KTD-16). Recorded
      // as soon as the transaction is broadcast, not once it is final: a
      // signature that has been submitted must not be handed out again, and
      // the card's own finality is tracked onchain, not here.
      await consumeApproval(view.record.id, { mintTxHash: hash });
    });

  return {
    busyId,
    busyAction,
    errorId,
    error,
    approve,
    deny,
    relay,
    dismissError: () => {
      setErrorId(null);
      setError(null);
    },
  };
}
