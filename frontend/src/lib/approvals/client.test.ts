import { describe, expect, test } from "bun:test";
import {
  DaemonRequestError,
  describeDaemonError,
  PROXY_ERROR_CODES,
} from "./client";

describe("describeDaemonError", () => {
  test("a stopped daemon is explained as a setup step, not a crash", () => {
    const copy = describeDaemonError(PROXY_ERROR_CODES.unreachable, undefined);
    expect(copy.title).toContain("not running");
    expect(copy.body).toContain("giwacard daemon");
  });

  test("an unreadable token names the file and the fix", () => {
    const copy = describeDaemonError(
      PROXY_ERROR_CODES.tokenUnavailable,
      undefined,
    );
    expect(copy.body).toContain("~/.giwacard/daemon-token");
  });

  test("a rotated token tells the owner to restart the dev server", () => {
    expect(
      describeDaemonError("DAEMON_CSRF_TOKEN_INVALID", undefined).body,
    ).toContain("restarted");
  });

  test("queue-level errors get their own copy", () => {
    expect(describeDaemonError("APPROVAL_REQUEST_EXPIRED", undefined).title).toBe(
      "That request expired",
    );
    expect(
      describeDaemonError("APPROVAL_REQUEST_ALREADY_RESOLVED", undefined).title,
    ).toBe("Already answered");
  });

  test("an unknown code still says something true", () => {
    const copy = describeDaemonError("SOMETHING_NEW", "upstream exploded");
    expect(copy.body).toBe("upstream exploded");
    expect(copy.title.length).toBeGreaterThan(0);
  });

  test("an unknown code with no message never renders undefined", () => {
    expect(describeDaemonError(undefined, undefined).body).not.toContain(
      "undefined",
    );
  });
});

describe("DaemonRequestError", () => {
  test("carries the daemon's stable code alongside the http status", () => {
    const error = new DaemonRequestError("APPROVAL_REQUEST_NOT_FOUND", "gone", 404);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("APPROVAL_REQUEST_NOT_FOUND");
    expect(error.status).toBe(404);
  });
});
