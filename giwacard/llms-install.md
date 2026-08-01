# GiwaCard — install runbook for a coding agent

Goal: from nothing to a **first minted card** in under 10 minutes. Execute the
steps in order. Every command is copy-pasteable; every verification step has an
expected output you can check.

You are installing two things:

1. `giwacard` — a CLI (for the human) and an MCP server (for the agent), one npm
   package, one binary.
2. the `giwacard` skill — `skill/SKILL.md` in this package, which teaches an agent
   how to use the six tools.

Time budget:

| Step | Who | Minutes |
| --- | --- | --- |
| 1. Install the package | agent | 1–2 |
| 2. Run `giwacard init` | **human, in a terminal** | 3–5 |
| 3. Verify the human side | agent | under 1 |
| 4. Register the MCP server with the host | agent | 1 |
| 5. Verify the agent side | agent | 1 |
| 6. Mint the first card | agent | under 1 |

---

## 0. Prerequisites — read before starting

**Runtime.** `package.json` declares `engines.node: ">=20"`, and that is true of
the CLI and the MCP server. It is **not** enough for the approval daemon: the
daemon stores its queue in SQLite and loads `bun:sqlite` or Node's built-in
`node:sqlite`, which only exists on **Node 22.5 or newer**. On Node 20 or 21 with
no Bun present, in-policy card minting works and the over-policy approval flow
fails with `SqliteUnavailableError`.

```sh
node --version   # want v22.5.0 or newer; v20 works for in-policy mints only
bun --version    # optional; if present, the daemon uses bun:sqlite instead
```

**A funded testnet wallet.** The wizard creates one for you, but two faucets must
be visited before anything can be minted:

| Asset | Where | Limit |
| --- | --- | --- |
| GIWA Sepolia ETH (gas) | https://docs.giwa.io/faucets — a **web page**, not an RPC call, so a human has to click it | roughly 0.005–0.01 ETH per 24h |
| gUSD (the money) | `giwacard faucet`, which calls `GUSD.claimFaucet()` onchain | 100 gUSD per address per 24h |

The wizard funds the session key's gas out of the owner wallet, so only the owner
address needs to visit the ETH faucet.

**Two addresses you must obtain before you start.** There are no defaults, on
purpose — a wrong-but-plausible vault address would send a deposit to a contract
that is not the vault.

| Value | What it is | Where it comes from |
| --- | --- | --- |
| `GIWACARD_VAULT_ADDRESS` | The canonical `CardVault` UUPS proxy on GIWA Sepolia. One instance, multi-owner, keyed by owner address. | The project's deploy output / `smartcontracts/README.md`. Ask the human if it is not recorded there yet. |
| `GIWACARD_MERCHANT_ADDRESS` | The demo merchant to seed into the allowlist. | The merchant operator, or `merchant/`'s `MERCHANT_ADDRESS`. |

The vault's allowlist is **deny-by-default**. A setup that skips the merchant
address looks complete and cannot mint a single usable card — every mint returns
`MERCHANT_OUT_OF_SCOPE`.

**Chain facts** (for sanity-checking anything you configure): GIWA Sepolia, chain
id `91342`, RPC `https://sepolia-rpc.giwa.io` (public and rate-limited, dev only),
explorer `https://sepolia-explorer.giwa.io`. gUSD has **6 decimals** — 1 gUSD is
`1000000` base units.

---

## 1. Install the package

`giwacard` is not published to npm yet, so install from this repository. Once it
is published, step 1 collapses to `npx -y giwacard` and nothing else changes.

```sh
cd giwacard
bun install
bun run build
npm link            # puts `giwacard` on PATH
```

Verify:

```sh
giwacard --version  # -> 0.0.1
```

If you do not want a global link, every `giwacard …` below also works as
`node /ABSOLUTE/PATH/TO/giwacard/dist/cli.js …`.

---

## 2. Run the onboarding wizard — the human does this

```sh
export GIWACARD_VAULT_ADDRESS=0x...      # required
export GIWACARD_MERCHANT_ADDRESS=0x...   # required for the demo loop
giwacard init
```

**This step needs a real terminal and you probably cannot run it.** `giwacard
init` asks for a keystore passphrase with a hidden prompt; when stdin is not a
TTY the CLI refuses rather than hanging, with `giwacard needs an answer to
"Choose a keystore passphrase" but stdin is not a terminal`. Hand this command to
the human and wait. (`$GIWACARD_PASSPHRASE` is honoured when *opening* an existing
keystore, but not when creating the first one.)

Eight steps, resumable — progress is committed to the encrypted keystore after
each one, so a Ctrl-C or a faucet wait costs nothing. Re-running `giwacard init`
picks up at the first unfinished step.

| # | Step | What happens |
| --- | --- | --- |
| 1 | Keystore passphrase | Creates `~/.giwacard/keystore.json` (mode 0600). The passphrase is never written anywhere. |
| 2 | Owner wallet | Generates or imports the owner EOA. |
| 3 | Attach to the vault | Attaches to `$GIWACARD_VAULT_ADDRESS` (never deploys) and reads the payment token back from `paymentToken()`. |
| 4 | ETH faucet | Prints the faucet link, then polls the owner's balance until ETH arrives (up to 10 minutes). |
| 5 | gUSD faucet | Calls `claimFaucet()` — 100 gUSD. |
| 6 | Session key | Generates the agent's session key and funds its gas from the owner wallet; prints the per-submitter gas budget. |
| 7 | Policy + allowlist | `registerSessionKey` with the default policy **and the merchant allowlist in the same transaction**. |
| 8 | Agent host config | Writes an `mcpServers` entry into the chosen host's config file (merging, never clobbering). |

Useful flags: `--yes` (accept defaults, no prompts where avoidable), `--host
claude|cursor|gemini`, `--fresh` (ignore recorded progress and re-run every step).

Default policy registered by step 7:

| Field | Value |
| --- | --- |
| `capPerCard` | 10 gUSD (`10000000`) |
| `dailyCap` | 50 gUSD (`50000000`) |
| `maxExpiry` | 86400 s (24 h) |
| merchants | `$GIWACARD_MERCHANT_ADDRESS`, plus anything in `$GIWACARD_MERCHANTS` |

**The passphrase question.** Step 8 asks whether to write the keystore passphrase
into the host config file in plaintext. The default is **no**. If the human
declines (recommended), the MCP server cannot unseal the keystore until
`GIWACARD_PASSPHRASE` is present in the environment the host launches from — every
tool call returns `NOT_CONFIGURED` until it is.

---

## 3. Verify the human side

```sh
giwacard status
```

Expect: exit code 0, the owner and vault addresses, and a balance panel showing
**100 gUSD balance, 0 escrowed, 100 gUSD available**, with "no active cards" and
"no pending approvals". `giwacard status --gas` adds the per-submitter gas table.

If this works, the onchain half is done: funded owner, registered session key,
allowlisted merchant.

---

## 4. Register the MCP server with the agent host

All three hosts use the same `mcpServers` object; only the file location differs.
Step 8 of the wizard writes one of them for you — **including Claude *Desktop*,
which is a different file from Claude *Code***. Write the file yourself if the
host you actually use was not configured.

| Host | File |
| --- | --- |
| Claude Code | `.mcp.json` in the project root |
| Claude Desktop | macOS `~/Library/Application Support/Claude/claude_desktop_config.json`; Windows `%APPDATA%\Claude\claude_desktop_config.json`; Linux `~/.config/Claude/claude_desktop_config.json` |
| Cursor | `~/.cursor/mcp.json` |
| Gemini CLI | `~/.gemini/settings.json` |

The entry, identical in all four files (this is exactly what
`buildMcpServerEntry` produces, with `npx -y giwacard mcp` as the command):

```json
{
  "mcpServers": {
    "giwacard": {
      "command": "npx",
      "args": ["-y", "giwacard", "mcp"],
      "env": {
        "GIWACARD_VAULT_ADDRESS": "0xYourCardVaultProxy",
        "GIWACARD_VAULT_OWNER": "0xYourOwnerAddress",
        "GIWACARD_MERCHANTS": "0xDemoMerchant",
        "GIWACARD_AGENT_LABEL": "giwacard-agent"
      }
    }
  }
}
```

Before publish, `npx -y giwacard` will not resolve. Use the linked binary or an
absolute path instead — everything else is unchanged:

```json
{
  "mcpServers": {
    "giwacard": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/giwacard/dist/cli.js", "mcp"],
      "env": {
        "GIWACARD_VAULT_ADDRESS": "0xYourCardVaultProxy",
        "GIWACARD_VAULT_OWNER": "0xYourOwnerAddress",
        "GIWACARD_MERCHANTS": "0xDemoMerchant",
        "GIWACARD_AGENT_LABEL": "giwacard-agent"
      }
    }
  }
}
```

Every environment variable the MCP server reads:

| Variable | Required | Purpose |
| --- | --- | --- |
| `GIWACARD_VAULT_ADDRESS` | yes | The deployed `CardVault` proxy. |
| `GIWACARD_VAULT_OWNER` | yes | The owner whose balance backs the cards. |
| `GIWACARD_PASSPHRASE` | yes | Unseals `~/.giwacard/keystore.json`. Put it in the host's launch environment, not in a committed file. |
| `GIWACARD_MERCHANTS` | no | Comma-separated addresses reported by `get_policy`. Does not change the onchain allowlist. |
| `GIWACARD_AGENT_LABEL` | no | Label the human sees on approval requests. Defaults to `mcp-agent`. |
| `GIWACARD_RPC_URL` | no | Dedicated RPC. Set this if the public one throttles you. |
| `GIWACARD_HOME` | no | Keystore and daemon directory. Defaults to `~/.giwacard`. |
| `GIWACARD_ENABLE_OWNER_ACTIONS` | no | `1` lets `cancel_card` submit as the vault owner. Off by default: it loads the owner key into an agent-facing process, widening the blast radius from one session key's policy to the whole vault. |

Do **not** commit a file containing `GIWACARD_PASSPHRASE`. `.mcp.json` in
particular is usually checked in.

Then reload: restart Claude Desktop; Cursor reloads from Settings → MCP; the next
`gemini` invocation picks it up; Claude Code re-reads `.mcp.json` on restart.

---

## 5. Verify the agent side

**5a — the server starts.** Independent of any host:

```sh
giwacard mcp >/dev/null 2>/tmp/giwacard-mcp.log &
MCP_PID=$!
sleep 2
kill $MCP_PID
cat /tmp/giwacard-mcp.log
```

Expect the first line to be `giwacard mcp v0.0.1 ready on stdio`. It is on
**stderr** by design: stdout is the JSON-RPC channel and a single stray byte there
drops the host connection. A trailing `Detected unsettled top-level await` warning
after the kill is harmless and only appears in this manual smoke test.

**5b — the host sees exactly six tools.** In your host's MCP panel (`/mcp` in
Claude Code), the `giwacard` server should be connected and advertise:

```
mint_card   get_card_status   cancel_card   get_balance   get_policy   check_approval_status
```

Six, no more. If you see a seventh — anything that resolves, approves or denies an
approval — something is wrong with your install; that tool does not exist in this
product and a test asserts its absence.

**5c — a read-only tool answers.** Call `get_policy`. Expect:

```json
{
  "ok": true,
  "active": true,
  "cap_per_card": "10000000",
  "daily_cap": "50000000",
  "remaining_today": "50000000",
  "max_expiry_seconds": 86400,
  "merchants": [{ "address": "0xDemoMerchant", "allowed": true }],
  "merchants_enumerable": false
}
```

`active: true` and `allowed: true` are the two fields that matter. If `active` is
`false`, step 7 of the wizard did not run. If `allowed` is `false`, the merchant
was not seeded into the allowlist.

Then call `get_balance` and expect `available: "100000000"` (100 gUSD),
`escrowed: "0"`.

---

## 6. Mint the first card

Call `mint_card`:

```json
{
  "amount": "1000000",
  "merchant": "0xDemoMerchant",
  "expires_in_seconds": 600,
  "reason": "install verification"
}
```

Expect `status: "minted"`, a `card_id`, a `mint_tx_hash`, and
`path: "in_policy"`. 1 gUSD is well inside the 10 gUSD per-card cap, so no human
is involved.

Confirm with `get_card_status` on that `card_id`: `status: "active"`,
`chargeable: true`, `merchant` equal to what you asked for. `get_balance` now
reports `escrowed: "1000000"` and `available: "99000000"`.

**The install is done.** The card is real: it can be charged once, by that
merchant only, for at most 1 gUSD, until it expires.

Optional next step — spend it against the demo merchant (`merchant/`, default
`http://localhost:4021/insights`, 1 gUSD per request): request the resource, read
the `402`, then re-request with an `X-PAYMENT` header naming the card. The skill's
"Pay a paid API or merchant, end to end" workflow has the exact header. Note that
the MCP surface has **no payment tool** — presenting a card is a plain HTTP
request, and the merchant is the party that charges it.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Every tool returns `NOT_CONFIGURED` naming a variable | The host launched the server without that variable. `details.variable` says which. | Add it to the `env` block of the `mcpServers` entry and restart the host. Config changes are not hot-reloaded. |
| `NOT_CONFIGURED`: "the giwacard keystore could not be opened" | `GIWACARD_PASSPHRASE` is missing or wrong, or `giwacard init` never ran. | Export the passphrase in the environment the host launches from, or re-run `giwacard init`. |
| `giwacard faucet` fails with a cooldown message | `GUSD.claimFaucet` is once per address per 24 h. The CLI reads the cooldown *before* submitting, so you are not paying gas to be refused. | The message says when it unlocks. Wait, or use a different owner address. The vault only needs enough gUSD to back your cards — 1 gUSD is enough to test. |
| Step 4 of the wizard polls forever | The ETH faucet is a web page and nobody claimed. | The human must open https://docs.giwa.io/faucets and claim for the owner address the wizard printed. The poll times out after 10 minutes; re-running `giwacard init` resumes at the same step. |
| `NO_GAS` | The session key has no ETH. | Send testnet ETH to the session key address (`get_policy` reports it as `session_key`), or re-run `giwacard init`, whose step 6 tops it up from the owner wallet. Note the error text suggests `giwacard faucet`, which claims **gUSD**, not ETH. |
| `RATE_LIMITED` with `scope: "rpc"`, or intermittent `RPC_UNAVAILABLE` | The public GIWA Sepolia RPC is rate-limited and documented as dev-only. | Set `GIWACARD_RPC_URL` to a dedicated endpoint in both the shell and the `mcpServers` env block. The clients already retry with backoff; a dedicated RPC is the real fix. |
| `RATE_LIMITED` with `scope: "approvals"` | More than 20 over-policy requests from one session key in an hour. | Wait `details.retryAfterMs`. Better: size cards to fit the policy so they never queue. |
| `RPC_UNAVAILABLE`: "the local giwacard approval daemon is unavailable" | The daemon could not be auto-started. | Run `giwacard daemon` in a terminal and read its output. It binds `127.0.0.1:47612`, writes `~/.giwacard/daemon.json` (port/pid) and `~/.giwacard/daemon-token` (mode 0600). Only over-policy flows need it; in-policy mints do not. |
| Daemon exits with "needs an embedded SQLite driver and found none" | Node older than 22.5 and no Bun. | Upgrade Node to 22.5+, or run the daemon under Bun. |
| First `mint_card` returns `MERCHANT_OUT_OF_SCOPE` | The merchant is not in the onchain allowlist — the deny-by-default trap. Adding it to `GIWACARD_MERCHANTS` does **not** change the allowlist; that variable only affects what `get_policy` reports. | The owner must register it onchain. Re-run `giwacard init --fresh` with `GIWACARD_MERCHANT_ADDRESS` set so step 7 runs `registerSessionKey` again with the merchant included. (The error text suggests `giwacard merchants add`; that command does not exist in this build.) |
| `SESSION_KEY_REVOKED` | The owner revoked the key, or the MCP server's `GIWACARD_VAULT_OWNER` does not match the owner who registered it. | Check `GIWACARD_VAULT_OWNER` against the owner address `giwacard status` prints. Re-register with `giwacard init`. |
| `INSUFFICIENT_AVAILABLE_BALANCE` on a small card | Earlier cards are still escrowing their caps. `available` is `balance - escrowed`, not `balance`. | `giwacard status` lists active cards. Cancel one (`giwacard revoke card ID`), or wait for expiry. |
| Host shows the server as failed with no message | Something wrote to stdout on the MCP path and corrupted the JSON-RPC stream. | Check the host's MCP log. Nothing under `giwacard mcp` may print to stdout; diagnostics go to stderr. |
| `cancel_card` returns `OWNER_ACTION_REQUIRED` | Cancelling is an owner action onchain and the server holds a session key. | Expected. The human runs `giwacard revoke card CARD_ID`. Setting `GIWACARD_ENABLE_OWNER_ACTIONS=1` enables it, at the cost of loading the owner key into the agent-facing process. |
| The agent asks the human to approve its own over-policy request via a tool | There is no such tool, by design. | The human runs `giwacard approve` (or `giwacard approve --id ID`), or resolves it in the dashboard. |

---

## What this runbook cannot do for you

- **`giwacard init` requires a human at a terminal.** Hidden passphrase prompts,
  and a web faucet that needs a click. Everything after step 3 is fully automatable.
- **It cannot deploy contracts.** `CardVault` is one canonical multi-owner proxy;
  the wizard attaches to it. If nobody has deployed one, see
  `smartcontracts/README.md` and stop here.
- **It cannot approve an over-policy request.** That is the product's central
  guarantee, not an installation gap.
