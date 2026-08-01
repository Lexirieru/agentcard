# GiwaCard owner dashboard

The human surface of GiwaCard: the over-policy approval queue, the card list,
the vault balance, and the transaction history rebuilt from vault event logs.

Next.js 16 (App Router, Turbopack, React Compiler), React 19, Tailwind v4,
wagmi + Reown AppKit.

## Getting started

```bash
bun install
bun run dev     # http://localhost:3000
bun test src    # pure-logic unit tests
bun run build   # production build (typechecks)
```

## Configuration

All chain configuration is build-time `NEXT_PUBLIC_` env. There are no
plausible-looking defaults for the vault address on purpose: a wrong address
would render wrong balances instead of an honest "not configured" panel.

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_CARD_VAULT_ADDRESS` | yes | — | CardVault proxy on GIWA Sepolia |
| `NEXT_PUBLIC_CARD_VAULT_DEPLOY_BLOCK` | no | `0` | Floor for `eth_getLogs` queries |
| `NEXT_PUBLIC_LOG_LOOKBACK_BLOCKS` | no | `100000` | How far back history reaches |
| `NEXT_PUBLIC_PAYMENT_TOKEN_DECIMALS` | no | `6` | gUSD is fixed at 6, like USDC |
| `NEXT_PUBLIC_PAYMENT_TOKEN_SYMBOL` | no | `gUSD` | Ticker beside amounts |
| `NEXT_PUBLIC_REOWN_PROJECT_ID` | no | public test id | Reown/WalletConnect project |

## Talking to the giwacard daemon

The approval queue lives in the local `giwacard` daemon, not in this app. The
daemon requires a per-session CSRF token that it writes to
`~/.giwacard/daemon-token` with mode 0600 — a browser page cannot read that
file, and that is the whole point of it (it is the daemon's only notion of
"the owner").

So the browser never calls the daemon directly. It calls
`/api/daemon/*` on this app, and the Next.js **server** process reads the token
file and attaches the header. That works with zero setup because the dev server
runs on the owner's machine as the owner's user — the same privilege the token
file is gated on.

The cost, stated plainly: while this app is running, anything that can reach
`/api/daemon/*` on its origin has the daemon's authority. The proxy refuses
cross-origin requests, so that means local processes and this page. **This is
only acceptable for a localhost MVP** (KTD-14). Do not deploy this app to a
shared host without replacing the proxy with real auth, or switching to the
paste-the-token model below.

Env overrides for the proxy (server-side, not `NEXT_PUBLIC_`):

| Variable | Meaning |
| --- | --- |
| `GIWACARD_HOME` | Directory holding `daemon.json` / `daemon-token` (default `~/.giwacard`) |
| `GIWACARD_DAEMON_URL` | Override the daemon base URL from `daemon.json` |
| `GIWACARD_DAEMON_TOKEN` | Supply the CSRF token directly instead of reading the file |

The alternative design — the owner pastes the token into the page — keeps the
token out of any server process, but needs the daemon started with
`GIWACARD_DAEMON_ALLOWED_ORIGINS=http://localhost:3000` and a re-paste after
every daemon restart. See the comment block in
`src/app/api/daemon/[...path]/route.ts` for the full trade-off.

## Finality

A Flashblocks preconfirmation is **not** settlement. Nothing in this UI is
labelled `Settled` unless its block is at or below the chain's `finalized`
head; if the RPC will not answer for `finalized` (or `safe`), every row stays
`Pending` and the history panel says why. Onchain state is truth; the
preconfirmation is a UX affordance only (KTD-5).
