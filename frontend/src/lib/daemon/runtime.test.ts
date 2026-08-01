import { describe, expect, test } from "bun:test";
import {
  daemonHome,
  DEFAULT_DAEMON_URL,
  isSameOriginRequest,
  parseDaemonInfoUrl,
  resolveDaemonTarget,
} from "./runtime";

describe("parseDaemonInfoUrl", () => {
  test("prefers the url the daemon advertises", () => {
    expect(
      parseDaemonInfoUrl(
        JSON.stringify({ url: "http://127.0.0.1:51234", port: 51234 }),
      ),
    ).toBe("http://127.0.0.1:51234");
  });

  test("strips a trailing slash so paths join cleanly", () => {
    expect(parseDaemonInfoUrl(JSON.stringify({ url: "http://a:1/" }))).toBe(
      "http://a:1",
    );
  });

  test("rebuilds the url from host and port when there is none", () => {
    expect(
      parseDaemonInfoUrl(JSON.stringify({ hostname: "localhost", port: 47612 })),
    ).toBe("http://localhost:47612");
  });

  test("brackets an IPv6 loopback host", () => {
    expect(parseDaemonInfoUrl(JSON.stringify({ hostname: "::1", port: 1 }))).toBe(
      "http://[::1]:1",
    );
  });

  test("returns null for absent or unusable json", () => {
    expect(parseDaemonInfoUrl(null)).toBeNull();
    expect(parseDaemonInfoUrl("not json")).toBeNull();
    expect(parseDaemonInfoUrl("[]")).toBeNull();
    expect(parseDaemonInfoUrl(JSON.stringify({}))).toBeNull();
  });

  test("ignores a url that is not http", () => {
    expect(parseDaemonInfoUrl(JSON.stringify({ url: "file:///etc/passwd" }))).toBeNull();
  });
});

describe("daemonHome", () => {
  test("honours GIWACARD_HOME", () => {
    expect(daemonHome({ GIWACARD_HOME: "/tmp/gw" })).toBe("/tmp/gw");
  });

  test("falls back to a directory under the user's home", () => {
    expect(daemonHome({})).toContain(".giwacard");
  });
});

describe("resolveDaemonTarget", () => {
  test("env vars win over the files on disk", () => {
    const target = resolveDaemonTarget({
      GIWACARD_HOME: "/nonexistent-giwacard-home",
      GIWACARD_DAEMON_URL: "http://127.0.0.1:9999/",
      GIWACARD_DAEMON_TOKEN: "  tok  ",
    });
    expect(target.baseUrl).toBe("http://127.0.0.1:9999");
    expect(target.token).toBe("tok");
  });

  test("reports a null token when nothing can supply one", () => {
    const target = resolveDaemonTarget({
      GIWACARD_HOME: "/nonexistent-giwacard-home",
    });
    expect(target.baseUrl).toBe(DEFAULT_DAEMON_URL);
    expect(target.token).toBeNull();
  });
});

describe("isSameOriginRequest", () => {
  test("allows a request from this app's own origin", () => {
    expect(isSameOriginRequest("http://localhost:3000", "localhost:3000")).toBe(
      true,
    );
  });

  test("refuses another site borrowing the proxy", () => {
    expect(isSameOriginRequest("https://evil.example", "localhost:3000")).toBe(
      false,
    );
  });

  test("refuses an opaque origin", () => {
    expect(isSameOriginRequest("null", "localhost:3000")).toBe(false);
  });

  test("allows a non-browser caller that sends no Origin", () => {
    // Mirrors the daemon's own reasoning: no Origin means no browser.
    expect(isSameOriginRequest(null, "localhost:3000")).toBe(true);
    expect(isSameOriginRequest("", "localhost:3000")).toBe(true);
  });

  test("refuses when the Origin is unparseable or the Host is missing", () => {
    expect(isSameOriginRequest("not a url", "localhost:3000")).toBe(false);
    expect(isSameOriginRequest("http://localhost:3000", null)).toBe(false);
  });
});
