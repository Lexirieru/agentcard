# giwacard

The only package published to npm. One binary, four surfaces.

| Path | What it is |
| --- | --- |
| `src/cli/` | `npx giwacard` — the human entry point. Wizard, status, approve, revoke, faucet. |
| `src/mcp/` | `giwacard mcp` — the agent entry point. Seven stdio tools. |
| `src/daemon/` | `giwacard daemon` — the local approval queue. Auto-starts on demand. |
| `src/chain/` | Chain definition, viem clients, encrypted keystore, ABIs. |
| `skill/SKILL.md` | The Agent Skill. Shipped in the tarball. |
| `llms-install.md` | Machine-executable install runbook. Shipped in the tarball. |

```bash
bun test && bun run typecheck && bun run build
npm pack --dry-run    # skill/SKILL.md and llms-install.md must appear
```

ESM only, no `any`, typed error classes, JSDoc on exports. **Node 22.5+** — the
daemon needs `bun:sqlite` or `node:sqlite`.

## Things that will bite you

**Two tests are load-bearing. Do not weaken them to make room for a change.**

- `src/mcp/surface.test.ts` asserts the advertised tool surface against a live
  `tools/list` response, not against the `GIWACARD_TOOLS` array — a tool
  registered by any other path still trips it. It bans approval-resolving tools
  by name fragment *and* by decision-shaped input, because authority can be
  smuggled through a parameter on a read-shaped tool.
- `src/package.test.ts` asserts every tool the shipped docs name is one the
  server advertises. It has already caught the docs drifting.

**There is no approval-resolving tool, by design.** An agent that could approve
its own over-policy request collapses the two-tier model to "the agent can spend
anything". Approval is owner-only, authenticated by reading a 0600 file this
process never hands out.

**Redaction runs in two layers and either alone fails open.** A name denylist
misses unknown names; a regex misses unknown shapes. The hard case: a private key
and a transaction hash are both `0x` plus 64 hex, so shape cannot separate them —
the backstop parks hashes sitting under known-public field names, redacts
everything else, then restores them. Signatures (130 hex) are matched first,
since they contain 64-hex substrings. Note `token` is deliberately absent from the
denylist: on a card result it is a public ERC-20 address the agent needs.

**Write actions are never auto-retried.** `withRetryingActions` proxies reads
through backoff and passes `sendTransaction`/`writeContract`/`signMessage`
through untouched — a retried submit can broadcast the same intent twice.

**The daemon binds loopback only** and refuses other hostnames outright. Every
state-changing route validates `Origin` against an allowlist and requires a CSRF
token from a 0600 file, sent in a custom header so a browser is always forced to
preflight. This is what stops any page in the owner's browser driving the queue.

**Approval expiry is derived on read**, not swept by a timer. A timer that is not
running while the daemon is down would leave requests wrongly pending forever.

**Error messages may only name commands that exist.** The real surface is
`init | status | approve | revoke key|card | faucet | daemon | mcp`. `src/mcp/errors.ts`
records that list as a contract with tests asserting it — three phantom commands
shipped before that existed. Two easy mistakes: `giwacard faucet` claims **gUSD**,
so it is never the answer to a gas shortfall; and cancelling is
`giwacard revoke card <id>`, there is no `giwacard cancel`.

**The banner must degrade.** Plain uncoloured text under `NO_COLOR`, a non-TTY
stdout, or a terminal under 60 columns. `gradient-string` runs its own colour
detection that overrode ours, so ours is authoritative.

**`figlet` must stay external in the bundle** — it loads font files from disk.

**The keystore holds both keys** (owner wallet and session key) under a
passphrase-derived key that is never persisted. `chmod` explicitly: the `mode:`
argument to `writeFileSync` and `mkdir` is masked by the umask.
