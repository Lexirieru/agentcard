import type {
  ApprovalFilter,
  ApprovalListResponse,
  ApprovalRecord,
  DaemonErrorBody,
} from "./types";

/**
 * Browser-side client for the approval queue.
 *
 * Every call goes to this app's own `/api/daemon/*` route handler rather than
 * to the daemon directly. See src/app/api/daemon/[...path]/route.ts for why —
 * short version: the daemon's CSRF token lives in an 0600 file that a page
 * cannot read, so a same-machine server process has to attach it.
 */

/** Base path of the proxy. Same origin, so no CORS is involved. */
export const DAEMON_PROXY_BASE = "/api/daemon";

/** Error codes this app's proxy adds on top of the daemon's own. */
export const PROXY_ERROR_CODES = {
  /** `~/.giwacard/daemon-token` was not readable. */
  tokenUnavailable: "DAEMON_TOKEN_UNAVAILABLE",
  /** Nothing is listening where the daemon should be. */
  unreachable: "DAEMON_UNREACHABLE",
  /** A cross-origin caller tried to use the proxy. */
  forbidden: "DAEMON_PROXY_FORBIDDEN",
} as const;

export class DaemonRequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "DaemonRequestError";
    this.code = code;
    this.status = status;
  }
}

async function call<T>(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${DAEMON_PROXY_BASE}${path}`, {
      method: init?.method ?? "GET",
      headers:
        init?.body === undefined
          ? undefined
          : { "content-type": "application/json" },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      cache: "no-store",
    });
  } catch (cause) {
    throw new DaemonRequestError(
      PROXY_ERROR_CODES.unreachable,
      cause instanceof Error ? cause.message : "The request could not be sent.",
      0,
    );
  }

  const text = await response.text();
  const parsed = text === "" ? null : safeJson(text);

  if (!response.ok) {
    const body = parsed as DaemonErrorBody | null;
    throw new DaemonRequestError(
      body?.error?.code ?? "DAEMON_HTTP_ERROR",
      body?.error?.message ?? `The daemon replied ${response.status}.`,
      response.status,
    );
  }
  return parsed as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export async function listApprovals(
  filter: ApprovalFilter,
): Promise<ApprovalRecord[]> {
  const result = await call<ApprovalListResponse>(
    `/v1/requests?status=${encodeURIComponent(filter)}&limit=100`,
  );
  return result?.requests ?? [];
}

export interface ResolveApprovalInput {
  decision: "approve" | "deny";
  ownerSignature?: string | null;
  ownerAddress?: string | null;
  note?: string | null;
  /** The terms actually signed, when they differ from what was asked. */
  approvedRequest?: Record<string, unknown> | null;
}

export async function resolveApproval(
  id: string,
  input: ResolveApprovalInput,
): Promise<ApprovalRecord> {
  return call<ApprovalRecord>(`/v1/requests/${encodeURIComponent(id)}/resolve`, {
    method: "POST",
    body: input,
  });
}

export async function consumeApproval(
  id: string,
  input: { cardId?: string | null; mintTxHash?: string | null },
): Promise<ApprovalRecord> {
  return call<ApprovalRecord>(`/v1/requests/${encodeURIComponent(id)}/consume`, {
    method: "POST",
    body: input,
  });
}

/* -------------------------------------------------------------------------- */
/* Error copy                                                                 */
/* -------------------------------------------------------------------------- */

export interface ErrorCopy {
  title: string;
  body: string;
}

/**
 * Turn an error code into something the owner can act on.
 *
 * The two interesting cases are local-setup problems, not protocol problems,
 * and the fix for each is a shell command — so say the command.
 */
export function describeDaemonError(
  code: string | undefined,
  message: string | undefined,
): ErrorCopy {
  switch (code) {
    case PROXY_ERROR_CODES.unreachable:
      return {
        title: "The giwacard daemon is not running",
        body: "Start it with `giwacard daemon` on this machine, then refresh. The approval queue lives there, not in this page.",
      };
    case PROXY_ERROR_CODES.tokenUnavailable:
      return {
        title: "Cannot authenticate to the daemon",
        body: "This app could not read ~/.giwacard/daemon-token. Start the daemon as the same user that runs this dev server, or set GIWACARD_DAEMON_TOKEN.",
      };
    case PROXY_ERROR_CODES.forbidden:
      return {
        title: "Blocked a cross-origin request",
        body: "The daemon proxy only answers same-origin requests from this dashboard.",
      };
    case "DAEMON_CSRF_TOKEN_INVALID":
    case "DAEMON_CSRF_TOKEN_MISSING":
      return {
        title: "The daemon rejected our token",
        body: "The daemon was restarted and issued a new token. Restart this dev server so it re-reads ~/.giwacard/daemon-token.",
      };
    case "DAEMON_ORIGIN_NOT_ALLOWED":
      return {
        title: "The daemon refused this origin",
        body: "Add this app's origin to GIWACARD_DAEMON_ALLOWED_ORIGINS before starting the daemon.",
      };
    case "APPROVAL_REQUEST_NOT_FOUND":
      return {
        title: "That request is gone",
        body: "It was resolved or pruned while this page was open. Refresh the queue.",
      };
    case "APPROVAL_REQUEST_ALREADY_RESOLVED":
      return {
        title: "Already answered",
        body: "Approvals are one-shot. Refresh to see the decision that landed first.",
      };
    case "APPROVAL_REQUEST_EXPIRED":
      return {
        title: "That request expired",
        body: "Its review window closed before the decision arrived. The agent has to ask again.",
      };
    default:
      return {
        title: "The approval queue could not be reached",
        body: message ?? "An unexpected error came back from the daemon.",
      };
  }
}
