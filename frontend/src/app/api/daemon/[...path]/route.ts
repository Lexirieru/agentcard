import type { NextRequest } from "next/server";
import {
  DAEMON_TOKEN_HEADER,
  isSameOriginRequest,
  resolveDaemonTarget,
} from "@/lib/daemon/runtime";

/**
 * Proxy from this dashboard to the local giwacard daemon.
 *
 * ## Why this file exists at all — the CSRF token seam
 *
 * The daemon requires a per-session token that it writes to
 * `~/.giwacard/daemon-token` with mode 0600 (giwacard/src/daemon/server.ts,
 * layer 3 of its threat model). That file is deliberately unreadable from a web
 * page: the *whole* security argument is "authority to approve == ability to
 * read an 0600 file in the owner's home directory". A browser cannot read it,
 * and no amount of frontend code changes that.
 *
 * So there are exactly three honest options, and this is the one taken:
 *
 * 1. **A server-side route handler reads the file (this file).** Works with no
 *    setup, because the Next dev server runs on the owner's machine as the
 *    owner's user — the same privilege the token file is gated on. The cost,
 *    stated plainly: the Next.js server process now holds daemon authority for
 *    as long as it runs. Anything that can reach `/api/daemon/*` on this origin
 *    can drive the queue. That is acceptable only because this dashboard is a
 *    localhost-only MVP surface (KTD-14, "auth is localhost-only for MVP"), and
 *    it would NOT be acceptable if this app were ever deployed to a host the
 *    owner does not control. Deploying it remotely must be paired with real
 *    auth, or with option 2.
 * 2. **The owner pastes the token into the page.** No server process holds it,
 *    but the daemon also has to be started with
 *    `GIWACARD_DAEMON_ALLOWED_ORIGINS=http://localhost:3000` or its Origin
 *    guard rejects the browser, and the owner has to re-paste after every
 *    daemon restart. Worse ergonomics, better isolation.
 * 3. **Serve the dashboard from the daemon itself.** Correct end state, out of
 *    scope for this unit.
 *
 * Two properties keep option 1 from being a hole in the daemon's defences:
 *
 * - **Same-origin only.** A request arriving with a foreign `Origin` is refused
 *   here ({@link isSameOriginRequest}), so a random page cannot borrow the
 *   token by pointing `fetch` at this route.
 * - **JSON only on writes.** Forwarding preserves `application/json`, which a
 *   cross-site `<form>` post cannot produce; such a request needs a preflight,
 *   and the preflight has no CORS headers to satisfy it because none are sent.
 */

export const runtime = "nodejs";
/** Never cached: this is the owner's live approval queue. */
export const dynamic = "force-dynamic";

function errorResponse(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status });
}

async function forward(
  request: NextRequest,
  segments: string[],
): Promise<Response> {
  if (
    !isSameOriginRequest(
      request.headers.get("origin"),
      request.headers.get("host"),
    )
  ) {
    return errorResponse(
      "DAEMON_PROXY_FORBIDDEN",
      "The daemon proxy only answers same-origin requests.",
      403,
    );
  }

  const { baseUrl, token } = resolveDaemonTarget();
  if (token === null) {
    return errorResponse(
      "DAEMON_TOKEN_UNAVAILABLE",
      "Could not read the daemon CSRF token from ~/.giwacard/daemon-token. " +
        "Start the daemon with `giwacard daemon` as this user, or set GIWACARD_DAEMON_TOKEN.",
      503,
    );
  }

  const path = segments.map(encodeURIComponent).join("/");
  const target = `${baseUrl}/${path}${request.nextUrl.search}`;

  const headers = new Headers({ [DAEMON_TOKEN_HEADER]: token });
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const body = hasBody ? await request.text() : undefined;

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body,
      cache: "no-store",
      // No `Origin` is sent from here, which the daemon reads as a non-browser
      // caller and lets through to the token check. That is intentional: the
      // browser-facing Origin check already happened above.
    });
  } catch (cause) {
    return errorResponse(
      "DAEMON_UNREACHABLE",
      `No giwacard daemon answered at ${baseUrl}. ` +
        `Start it with \`giwacard daemon\`. (${
          cause instanceof Error ? cause.message : "connection failed"
        })`,
      503,
    );
  }

  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
    },
  });
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path } = await context.params;
  return forward(request, path);
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path } = await context.params;
  return forward(request, path);
}
