# GiwaCard

**One-time onchain spend cards for AI agents, on GIWA.**

An AI agent that has to pay for something today gets handed a wallet, and one
model mistake or one prompt injection empties it. GiwaCard removes that choice.
You keep your funds in a vault only you control, give an agent a scoped session
key, and the agent mints a single-use card for each purchase. The card carries a
cap, a merchant it may pay, and an expiry — enforced by the contract, not by the
prompt. Anything outside those limits stops and waits for you.

Built for [GIWA](https://giwa.io) Sepolia (chain id 91342). Testnet only —
GIWA mainnet is not live yet.

---

## For humans

```bash
npx giwacard          # wizard: wallet, vault, faucets, session key, policy
giwacard status       # balance, escrow, cards, pending approvals
giwacard approve      # review and sign an over-policy request
giwacard revoke key <address>   # kill a session key immediately
giwacard revoke card <id>       # cancel one card
```

There is also a web dashboard (`frontend/`) for the approval queue, cards,
balance and history. It connects your wallet through Reown AppKit; approving is
one click and one signature.

## For agents

The MCP server and the Agent Skill install together:

```jsonc
// .mcp.json  (Claude Code) — full host matrix in giwacard/llms-install.md
{
  "mcpServers": {
    "giwacard": { "command": "npx", "args": ["-y", "giwacard", "mcp"] }
  }
}
```

The agent gets tools to mint a card, check it, cancel it, read the balance and
policy, poll an approval, and pay a merchant. It does **not** get a tool to
approve anything — an agent that could approve its own over-policy request would
make the whole model pointless, and a test asserts that tool can never appear.

`giwacard/skill/SKILL.md` teaches the vocabulary and the error table;
`giwacard/llms-install.md` is a runbook a coding agent can execute itself.

---

## How it works

```
owner ──deposit──▶ CardVault ◀──charge── merchant
                      ▲
                   mint │ (session key, within policy)
                        │
                      agent ──X-PAYMENT(cardId)──▶ merchant's paid API
```

1. You deposit gUSD into the vault and register a session key with a policy:
   cap per card, daily cap, allowed merchants, maximum expiry.
2. Within policy, the agent mints a card itself. The cap is escrowed — your
   available balance drops by the cap, not by what is eventually spent.
3. The agent hands the merchant a card id. **The merchant charges the card**,
   the same way a real card works. It can take at most the cap, and only if it
   is the merchant the card was scoped to.
4. The card dies on first use. The unspent remainder returns to you.
5. Outside policy, nothing happens onchain. The request queues for your
   approval, and the agent picks up the result later — it does not need to still
   be running when you approve.

## Repo

| Path | |
| --- | --- |
| `smartcontracts/` | `CardVault.sol`, `GUSD.sol` — Foundry, UUPS upgradeable |
| `giwacard/` | the npm package: CLI, MCP server, approval daemon, skill |
| `merchant/` | demo paid API and its x402 facilitator |
| `frontend/` | owner dashboard (Next.js, Reown AppKit) |
| `landingpage/` | marketing page |
| `docs/` | product contract, implementation plan, demo runbook, grant material |

Contributor notes, including the traps worth knowing before changing anything,
are in [`CLAUDE.md`](./CLAUDE.md). The demo choreography is
[`docs/demo.md`](./docs/demo.md).

## Development

```bash
cd smartcontracts && forge clean && forge test
cd giwacard  && bun test && bun run typecheck && bun run build
cd merchant  && bun test && bun run typecheck && bun run build
cd frontend  && bun test src && bun run build
```

Node 22.5+ (the approval daemon needs `node:sqlite`), or Bun.

## Credits

The product shape — one-time cards for agents, with caps and human approval —
was demonstrated by [agentcard.sh](https://www.agentcard.sh/) in the fiat world.
GiwaCard is not affiliated with them; it reuses some of their MIT-licensed code
with attribution, and replaces the custodial card rails with an onchain vault.
See [`NOTICE`](./NOTICE) for exactly what was adapted from where.
