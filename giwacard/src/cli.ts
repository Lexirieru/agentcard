#!/usr/bin/env node
/**
 * The `giwacard` bin entry.
 *
 * Three surfaces share one executable, and the dispatch order below is the whole
 * of this file's logic:
 *
 * - `giwacard daemon` — the approval queue (U8). Loaded lazily so the common
 *   paths never pay for Hono and a SQLite driver.
 * - `giwacard mcp` — the MCP server (U5). Also lazy, and with one hard rule:
 *   **nothing on this path may write to stdout**, because an MCP host is
 *   speaking JSON-RPC over that pipe and a single stray byte drops the
 *   connection.
 * - everything else — the interactive CLI (U7): the banner, the onboarding
 *   wizard, `status`, `approve`, `revoke` and `faucet`.
 *
 * The interactive CLI is loaded lazily too, so `giwacard mcp` never pulls in
 * figlet, boxen or clack.
 */
const argv = process.argv.slice(2)

if (argv[0] === 'daemon') {
  const { runDaemonCommand } = await import('./daemon/server.js')
  process.exitCode = await runDaemonCommand(argv.slice(1))
} else if (argv[0] === 'mcp') {
  const { runMcpCommand } = await import('./mcp/server.js')
  process.exitCode = await runMcpCommand()
} else {
  const { runCli } = await import('./cli/index.js')
  process.exitCode = await runCli({ argv })
}
