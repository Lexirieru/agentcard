# giwacard

**Give your AI agent a card, not your wallet.**

One-time onchain spend cards for AI agents on [GIWA](https://giwa.io) Sepolia. You
fund a vault you control, register a scoped session key for your agent, and the
agent mints single-use cards that the contract enforces limits on. Anything
outside those limits stops and waits for you.

The limits are not a prompt. They are a `revert`.

```bash
npx giwacard        # wallet, vault, session key, policy, agent config
```

Requires **Node 22.5+**. Testnet only — gUSD is a test token with an open faucet
and no value.

---

## Why

An agent that can pay for things needs spending authority, and the usual answers
are both bad: hand it a wallet and it can drain you, or hand it nothing and it
stops every time a task costs money.

A card is the third answer, and it is an old one. You give it a cap, a merchant
it works at, and an expiry. It works once. Losing it costs you the cap, not the
account.

`CardVault` enforces all four onchain. A compromised agent cannot argue with a
contract.

## Quick start

```bash
npx giwacard                 # 8-step wizard, resumable
giwacard deposit 50          # cards are backed by the vault, not your wallet
giwacard status              # balance, escrow, cards, pending approvals
```

Then ask your agent to buy something. The wizard writes the MCP server config
into your agent host, so it already has the tools.

**Onboarding claims gUSD into your wallet, not into the vault.** `giwacard
deposit` is the step that makes an agent able to spend; skip it and the first
mint fails on an available balance of zero.

## For humans — the CLI

| Command | What it does |
| --- | --- |
| `giwacard` / `init` | Wizard: wallet, vault, faucets, session key, policy, agent config |
| `giwacard deposit <amount>` | Move gUSD from your wallet into the vault |
| `giwacard status` | Balance, escrowed, available, active cards, pending approvals |
| `giwacard approve` | Review an over-policy request and sign or deny it |
| `giwacard revoke key <address>` | Kill a session key instantly. Cards it minted stay active |
| `giwacard revoke card <id>` | Cancel one card and release its escrow |
| `giwacard faucet` | Claim 100 gUSD into your wallet (once per address per 24h) |
| `giwacard daemon` | Run the local approval queue in the foreground |
| `giwacard mcp` | Run the MCP server on stdio (your agent host spawns this) |

## For agents — the MCP tools

Seven stdio tools. `mint_card`, `pay_merchant`, `cancel_card`, `get_balance`,
`get_card_status`, `get_policy`, `check_approval_status`.

**There is no tool that resolves an approval**, and there never will be. An agent
that could approve its own over-policy request collapses the whole model to "the
agent can spend anything". Approval is owner-only and authenticated by reading a
`0600` file the MCP process never hands out.

The package also ships an [Agent Skill](./skill/SKILL.md) and a
machine-executable [install runbook](./llms-install.md).

## How a payment runs

1. Your agent asks the merchant for something. It answers **HTTP 402** with its
   price and the address it wants the card scoped to.
2. The agent calls `mint_card`. Escrow moves by the **cap**, not the price.
3. The agent hands the merchant the card id in an `X-PAYMENT` header.
4. **The merchant charges the card.** `CardVault.charge` requires
   `msg.sender == card.merchantScope` — the agent never submits the payment, it
   only presents a card, exactly as a person would.
5. The unspent remainder returns to your available balance and the card is spent.

Over policy, step 2 becomes an approval request and **nothing is submitted
onchain** until you sign.

## Deployed contracts

GIWA Sepolia, chain `91342`. Both verified on Blockscout.

| Contract | Address |
| --- | --- |
| `CardVault` | [`0xD89395Df78aaFdF86b330899d1C6189211e88750`](https://sepolia-explorer.giwa.io/address/0xD89395Df78aaFdF86b330899d1C6189211e88750) |
| `gUSD` | [`0xADA0466303441102cb16F8eC1594C744d603f746`](https://sepolia-explorer.giwa.io/address/0xADA0466303441102cb16F8eC1594C744d603f746) |

The vault is one canonical multi-owner instance. Clients attach to it; they never
deploy their own.

## Things worth knowing

- **A preconfirmation is not final.** GIWA's Flashblocks endpoint answers in
  ~200ms, and every surface here distinguishes preconfirmed from safe. No funds
  decision rests on a preconfirmation.
- **The merchant allowlist is deny-by-default.** An empty allowlist mints
  nothing.
- **Expired escrow needs a transaction.** The EVM has no timer, so an expired
  card reads `Active` until someone calls the permissionless `releaseExpired`.
- **Secrets never reach a model.** Tool output runs through a field-name denylist
  and a regex backstop that fails closed on anything it does not recognise.

## Links

[Source](https://github.com/Lexirieru/agentcard) ·
[Dashboard](https://agentcard-fe.vercel.app) ·
[Landing page](https://agentcard-eta.vercel.app) ·
[GIWA docs](https://docs.giwa.io)

## Licence

MIT — see [`LICENSE`](./LICENSE). Adapted third-party code is credited in
[`NOTICE`](https://github.com/Lexirieru/agentcard/blob/main/NOTICE) at the
repository root; those notices are theirs, not this package's grant.
