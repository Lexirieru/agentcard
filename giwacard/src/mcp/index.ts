/**
 * `giwacard mcp` — the agent-facing MCP server (KTD-7, KTD-8, R7).
 *
 * Six tools, stdio transport, all signing server-side. The security properties
 * this module exists to hold are, in order of how badly they break things:
 *
 * 1. **No approval-resolving tool.** An agent that could approve its own
 *    over-policy request would defeat the two-tier consent model outright. See
 *    `./tools/index.ts`.
 * 2. **Nothing signable ever reaches the agent.** The session key stays inside
 *    the process; owner signatures are read from the local daemon, relayed, and
 *    deleted. The agent sees an opaque `card_id`. See `./redact.ts`.
 * 3. **Over-policy requests submit no transaction.** They are queued for the
 *    human owner instead. See `./tools/mintCard.ts`.
 *
 * ## Layout
 *
 * - `redact.ts`   — the two-layer redaction boundary (denylist + regex backstop).
 * - `errors.ts`   — the agent-facing error taxonomy and the revert mapping.
 * - `context.ts`  — injected chain clients, narrowed to remove the signing surface.
 * - `approvals.ts`— client for the local approval daemon, with auto-start.
 * - `vault.ts`    — every `CardVault` read and write, plus the KTD-9 pay flow.
 * - `tools/`      — the six R7 tools.
 * - `server.ts`   — registration, stdio transport, `giwacard mcp`.
 */

export * from './redact.js'
export * from './errors.js'
export * from './context.js'
export * from './approvals.js'
export * from './vault.js'
export * from './tools/index.js'
export * from './server.js'
