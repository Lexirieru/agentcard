# GiwaCard

One-time onchain spend cards for AI agents on GIWA Sepolia. An owner funds a
vault they control, registers a scoped session key for an agent, and the agent
mints single-use cards the contract enforces limits on. Requests outside policy
stop and wait for the owner.

## Repo layout

Each directory has its own `CLAUDE.md` with the traps specific to it. Read that
one before working there; this file only carries what crosses boundaries.

| Path | What it is |
| --- | --- |
| `smartcontracts/` | Foundry. `CardVault.sol` (the core), `GUSD.sol` (test stablecoin + faucet). Both UUPS. |
| `giwacard/` | The only published npm package: CLI, MCP server, approval daemon, agent skill. |
| `merchant/` | Demo paid API + x402 facilitator. Operator-run, not published. |
| `frontend/` | Next.js owner dashboard. Reown AppKit for wallet. |
| `landingpage/` | Vite marketing page. Source of the shared visual language. |
| `docs/` | `brainstorms/` (product contract), `plans/` (implementation plan), `grant/` (GASOK application). |
| `references/` | Local study material, gitignored. Not part of the build. |

## Not done yet

State this accurately; several of these look finished from the code alone.

- **The grant application has ~58 unfilled placeholders.** See `docs/CLAUDE.md`.
- **The demo has a script but no recording.** `docs/demo.md` has now been
  executed once against the live testnet, but nothing has been filmed.
- **Nobody outside this repo has ever used it.** Zero external users, one
  merchant, and that merchant is ours.

## What the first live run proved, and what it broke

The end-to-end loop ran on GIWA Sepolia on 2026-08-06 — onboarding, mint, a
merchant-submitted charge, the report, and escrow release. Transactions are in
`docs/grant/gasok-application.md` §4.3. Four things it found, none of which the
960 tests could have:

- **`giwacard init` cannot complete without a terminal.** The first-run branch
  prompts for the passphrase unconditionally and ignores `$GIWACARD_PASSPHRASE`,
  which the help text advertises for exactly this case. Only the *resume* branch
  honours it. CI, containers and headless hosts all dead-end here.
- **Onboarding finishes with an empty vault and no way to fill it.** There is no
  `deposit` in the CLI or in the MCP tools — only in the dashboard — yet the
  wizard signs off with "ask your agent to buy something". The agent cannot buy
  anything; available balance is zero.
- **Read-after-write against the public RPC is stale for about a second.** The
  escrow moment, which is the whole point of the mint, reads as zero if you look
  immediately. Poll, or read Flashblocks. Do not screenshot the first response.
- **One address in the docs carried a bad EIP-55 checksum** and viem rejected
  it, so anyone copy-pasting the README env block hit a crash on their first
  command. Fixed. Checksum every address you paste into a doc.

## Commands

```bash
# contracts — run forge clean first after editing a contract, or the
# OZ upgrades plugin trips on multiple build-info entries for one name
cd smartcontracts && forge clean && forge test

cd giwacard  && bun test && bun run typecheck && bun run build
cd merchant  && bun test && bun run typecheck && bun run build
cd frontend  && bun test src && bun run build
```

## Things that will bite you

**The payment direction is merchant-pull.** `CardVault.charge` requires
`msg.sender == card.merchantScope` and pays out to `msg.sender`. The agent does
not submit the charge; it sends the merchant a `cardId` and the merchant charges
it, exactly like handing over a card. An earlier design had the agent pushing
payment — it could never have worked, and the mistake survived in three places
before anything forced the two sides to meet.

**A preconfirmation is not final.** GIWA's Flashblocks endpoint answers `latest`
with preconfirmed state in ~200ms. Every surface must distinguish preconfirmed
from safe, and no funds decision may rest on a preconfirmation. The dashboard
reads the `finalized` tag, falling back to `safe`, and understates finality when
neither answers.

**Escrow is released by a transaction, not by time.** The EVM has no timer, so an
expired card still reads `Active` onchain until someone calls the permissionless
`releaseExpired`. Available balance is `balance − escrowedTotal`, tracked by an
accumulator — never by summing active cards, which is unbounded gas.

**The agent must never be able to approve its own request.** There is no
approval-resolving MCP tool, and `giwacard/src/mcp/surface.test.ts` asserts that
against a live `tools/list` response rather than against the tool array, so a
tool added by any other path still trips it. Do not weaken that test to make
room for a new tool.

**Secrets must not reach a model.** `giwacard/src/mcp/redact.ts` runs a
field-name denylist and a regex backstop, because either alone fails open. Note
the hard case: a private key and a transaction hash are both `0x` plus 64 hex,
so shape cannot separate them — the backstop uses the surrounding field name and
fails closed on anything it does not recognise.

**The merchant allowlist is deny-by-default.** An empty allowlist means the
session key can mint nothing. `giwacard init` seeds the demo merchant; skip that
step and the purchase flow simply does not work.

**Node 22.5+ is required**, not 20. The daemon needs `bun:sqlite` or
`node:sqlite`.

**The dashboard's daemon proxy holds daemon authority.** A browser cannot read
the 0600 token file, so a same-origin Next.js route reads it server-side. While
that app runs, anything reaching `/api/daemon/*` on its origin can drive the
approval queue. Fine for a localhost MVP; not for a shared host.

## Conventions

- TypeScript is ESM-only, no `any`, typed error classes, JSDoc on exports.
- Solidity uses custom errors rather than require-strings, NatSpec on public and
  external functions, and events on every state change.
- `frontend/` runs Next 16 with Turbopack and the React Compiler. Read
  `node_modules/next/dist/docs/` before writing code there; APIs differ from
  older Next, a webpack config breaks the build, and hand-rolled `useMemo` is
  usually unnecessary.
- Attribution for adapted MIT code lives in `NOTICE`. Keep it accurate.
