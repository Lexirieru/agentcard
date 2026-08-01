import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Server-side discovery of the local giwacard daemon.
 *
 * Runs only inside the Next.js server process (the route handler in
 * src/app/api/daemon/[...path]/route.ts). It reads the same two files the CLI
 * and the MCP server read: `~/.giwacard/daemon.json` for the port, and
 * `~/.giwacard/daemon-token` for the per-session CSRF token.
 *
 * Note what this module does *not* touch: no key material, ever. The token is
 * an authorization capability for a localhost queue, not a signing key — the
 * owner's key stays in the browser wallet (KTD-14).
 */

/** Default port from giwacard/src/daemon/server.ts. */
export const DEFAULT_DAEMON_URL = "http://127.0.0.1:47612";

/** Header the daemon expects its CSRF token in. */
export const DAEMON_TOKEN_HEADER = "x-giwacard-token";

/** Option > `$GIWACARD_HOME` > `~/.giwacard`, matching giwacard's own rule. */
export function daemonHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.GIWACARD_HOME?.trim();
  if (override) return override;
  return join(homedir(), ".giwacard");
}

/**
 * Pull the daemon's base URL out of `daemon.json`.
 *
 * Exported separately from the file read so the parsing — the part that can be
 * wrong — is testable without a filesystem.
 */
export function parseDaemonInfoUrl(raw: string | null): string | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const info = parsed as Record<string, unknown>;

  if (typeof info.url === "string" && /^https?:\/\//.test(info.url)) {
    return info.url.replace(/\/+$/, "");
  }
  // A daemon.json written by an older version may only carry host and port.
  if (typeof info.port === "number" && Number.isInteger(info.port)) {
    const host = typeof info.hostname === "string" ? info.hostname : "127.0.0.1";
    return `http://${host === "::1" ? "[::1]" : host}:${info.port}`;
  }
  return null;
}

function readIfPresent(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export interface DaemonTarget {
  baseUrl: string;
  /** Null when the token file could not be read — the UI says so explicitly. */
  token: string | null;
}

/**
 * Resolve where to send a proxied request and how to authenticate it.
 *
 * Env vars win over the files so a dashboard can be pointed at a daemon started
 * with `--port`, or at one running under a different home, without symlinks.
 */
export function resolveDaemonTarget(
  env: NodeJS.ProcessEnv = process.env,
): DaemonTarget {
  const home = daemonHome(env);

  const envUrl = env.GIWACARD_DAEMON_URL?.trim();
  const baseUrl =
    (envUrl ? envUrl.replace(/\/+$/, "") : null) ??
    parseDaemonInfoUrl(readIfPresent(join(home, "daemon.json"))) ??
    DEFAULT_DAEMON_URL;

  const envToken = env.GIWACARD_DAEMON_TOKEN?.trim();
  const fileToken = readIfPresent(join(home, "daemon-token"))?.trim();
  const token = envToken || fileToken || null;

  return { baseUrl, token: token === "" ? null : token };
}

/* -------------------------------------------------------------------------- */
/* Proxy guard                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Whether a request to the proxy may proceed.
 *
 * The daemon defends itself with an Origin allowlist plus a token; putting a
 * proxy in front of it would hand any page in the browser the token's authority
 * if the proxy answered cross-origin calls. So it does not: a request carrying
 * an `Origin` that is not this app's own host is refused outright. A request
 * with no `Origin` is a non-browser caller (curl, a test) and is allowed, which
 * mirrors the daemon's own reasoning.
 */
export function isSameOriginRequest(
  originHeader: string | null,
  hostHeader: string | null,
): boolean {
  if (originHeader === null || originHeader.trim() === "") return true;
  // `Origin: null` is an opaque origin (sandboxed iframe, file://). Never allow.
  if (originHeader.trim().toLowerCase() === "null") return false;
  if (hostHeader === null) return false;
  try {
    return new URL(originHeader).host.toLowerCase() === hostHeader.toLowerCase();
  } catch {
    return false;
  }
}
