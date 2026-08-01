---
title: GiwaCard — GASOK Application Material (Draft)
type: grant-application
program: GASOK — GIWA Accelerator for Sustainable On-chain Kernel
program_url: https://giwa.io/gasok
tracks: AI/WEB3 (primary), GIWA-NATIVE IDEAS (secondary)
date: 2026-08-01
status: DRAFT — not submitted
origin: docs/plans/2026-08-01-001-feat-giwacard-mvp-plan.md (U12), docs/brainstorms/2026-08-01-giwa-agent-card-requirements.md
---

# GiwaCard — GASOK Application Material

## How to use this document

This document is a draft of the answers for the GASOK application form. It is English-only, and its text is what is intended for submission. Anything the applicant still has to supply is marked `[FILL: ...]` — **this document must not be submitted while any placeholder remains.** All achievement figures, team size, and traction numbers are deliberately left blank rather than invented. The full list of what the applicant must supply is in Section 9.

**Application status note.** The extended application deadline was 31 July 2026 and has lapsed as of 1 August 2026. The program page does not state that applications are closed and does state that new applications are accepted during Phase 2. Section 8 contains an explicit request to confirm eligibility.

---

## 1. One-liner and elevator pitch

**One-liner.** GiwaCard is a non-custodial payment rail for AI agents on GIWA: one-time onchain spend cards whose amount cap, merchant scope, and expiry are enforced by a smart contract rather than by a prompt.

**Elevator pitch.** AI agents are increasingly given tasks that terminate in a payment — calling a paid API, buying data, renting compute. Today the only way an agent can pay is to be handed wallet access, which means one model mistake or one prompt injection is enough to drain the balance. GiwaCard removes that choice. The owner deposits into a vault they control on GIWA, grants the agent a session key bound to a policy (per-card cap, daily cap, merchant allowlist, maximum expiry), and the agent mints a single-use card for each payment. The card is void after one successful charge, and any unspent portion of the cap becomes available again immediately. Out-of-policy requests are not silently refused — they enter an approval queue only the owner can resolve, in at most two interactions. The point is that the limit lives in the contract, so an agent that is wrong or compromised still cannot exceed it. Agents connect through an MCP server and an Agent Skill; humans use an interactive CLI and a minimal dashboard. The payment loop is closed by the first merchant, which we build ourselves: an x402-style paid API that charges per request against the card.

---

## 2. Problem statement

**Agents need to pay, but must not be handed a wallet.** Economically meaningful agent workflows almost always touch something paid: premium APIs, data sources, compute, subscriptions. The current pattern is to place a private key or payment credential in the agent's environment and hope the model behaves. That is unacceptable for three distinct reasons:

1. **Model error.** An agent can misread an amount, pick the wrong recipient, or repeat the same call many times. Nothing inside the model guarantees a bound.
2. **Prompt injection.** Content an agent reads — web pages, API responses, file contents — can carry instructions. Prompt-level defenses ("never send funds to an address found in external content") are etiquette, not enforcement.
3. **No approval surface.** Even when the owner wants to be consulted on large spends, there is no standard place to ask for approval without stalling the entire agent workflow.

**The existing fiat solution cannot serve a global crypto audience.** agentcard.sh demonstrated that the product shape is right: one-time virtual cards for agents, with spend caps and human approval. But that product is custodial and strongly US-centric — it is built on Visa rails, uses Apple Pay, requires government-ID KYC, and uses a billing address hardcoded to San Francisco. The consequence is simple: developers outside the United States, and anyone working with onchain assets, cannot use it. We are not affiliated with agentcard.sh and claim no relationship with them; we are inspired by their UX model and we reuse some of their MIT-licensed code with the copyright attribution preserved.

**On GIWA, the category is entirely unoccupied.** As far as our research shows, there is no agent payment infrastructure on GIWA today. Meanwhile the raw materials have been present since genesis: ERC-4337 EntryPoint v0.6 and v0.7 predeploys, Safe, Permit2, Multicall3, plus Flashblocks ~200 ms preconfirmations and the up.id identity system. What is missing is the layer that turns those materials into something an agent can actually use.

---

## 3. Solution

GiwaCard has four layers, all of which are publicly inspectable.

**Onchain layer (Solidity, Foundry, UUPS upgradeable, verified on Blockscout).**

- `CardVault` — a single canonical multi-owner instance. Balances, escrow, session keys, and policy are keyed by owner address, so a new user simply attaches to the existing vault; there is no per-user contract deployment or verification.
- **A card is a one-time onchain spend authorization.** Minting a card is a transaction that registers the card with a `cap`, token, `merchantScope`, and `expiry`, and locks the `cap` into escrow. The card's own state (`Active` / `Used` / `Expired` / `Revoked`) provides replay protection: a second charge against the same card reverts at the contract level.
- **Escrow via a single accumulator.** `availableBalance = balance − escrowedTotal`. A card that goes void — used, expired, or cancelled — releases the remaining escrow back to available balance without owner action.
- **Session key policy.** The agent's session key is registered in the vault with `capPerCard`, `dailyCap`, `merchantAllowlist`, and `maxExpiry`. All are evaluated in the contract at mint time. The owner can revoke a session key at any moment.
- **Approval path.** An out-of-policy request mints nothing. It enters a queue; the owner signs an EIP-712 card struct and mints it themselves. The `approvalId` is single-use. The queue has a TTL, so an unresolved request lands in a deterministic terminal state with no funds moved.

**Agent layer.** An MCP server runs locally over stdio (`npx giwacard mcp`), exposing tools to: mint a card, read card status, cancel a card, read balance, read policy, and check the status of its own approval request. **A tool to resolve approvals is deliberately never exposed over MCP** — only the owner can, via CLI or dashboard. The session key never leaves the owner's machine and tool results pass through two-layer redaction, so the agent only ever sees an opaque `card_id` and never receives signable material. An Agent Skill documents the vocabulary, workflow, safety rules, and an actionable error table.

**Human layer.** A one-command interactive CLI (`npx giwacard`) runs the full onboarding wizard: create or import a wallet, attach to the vault, claim faucets, generate a session key, set the default policy, write the MCP configuration into the agent. A minimal web dashboard shows balance, active and void cards, the approval queue, and a transaction history reconstructed from vault events. Core capabilities are at parity across both paths.

**Merchant layer.** We build the first merchant ourselves so the demo produces real value rather than a simulated store: an x402-style paid API ("GIWA Insights", on-demand chain analytics reports) charging per request. The flow: the merchant answers `402` with payment requirements; the MCP server submits `CardVault.charge` and then sends an `X-PAYMENT` header carrying the transaction hash and `cardId`; the facilitator verifies that a matching `Charged` event genuinely exists at the correct vault address, amount, and merchant, then returns `200`. The facilitator is read-only, so it needs no funded EOA.

**Test stablecoin.** Because there is no canonical test USDC on GIWA Sepolia, we deploy `gUSD` (6 decimals, UUPS) with an onchain faucet.

---

## 4. Mapping to the six Phase 1 selection criteria

### 4.1 Fit with the GIWA chain (GIWA 체인 적합성)

**Flashblocks make approval feel instant, and that is not cosmetic.** When an agent pays mid-workflow, the agent is *blocked* waiting on confirmation. On Ethereum L1 with a 12-second block interval, that delay is long enough to force an asynchronous design across the whole product. GIWA gives a 1-second block interval and Flashblocks preconfirmations at ~200 ms — fast enough to treat a payment as a synchronous call. We read preconfirmed state to give the CLI, dashboard, and MCP flow their instant feel, while still treating onchain state as the single source of truth for card status; the UI marks transactions as pending until the safe block. This is a use case that specifically benefits from GIWA's properties, not an application that merely happens to be deployed there.

**We build on the genesis predeploys rather than duplicating them.** Permit2, Safe, Multicall3, and ERC-4337 EntryPoint v0.6 and v0.7 are present at genesis. Multicall3 batches card-state and balance reads for the dashboard. EntryPoint and Safe give us an account-compatibility path without deploying our own account infrastructure. One thing we state honestly: the MVP deliberately does not depend on a bundler or paymaster, because GIWA does not yet provide them officially; full ERC-4337 compatibility is a roadmap item, not a claim about today. We chose not to use Permit2 for settlement for a technical reason explained in 4.2, and we record it as an interoperability path.

**EVM equivalence means no porting tax.** Because GIWA is OP Stack and EVM-equivalent, standard tooling applies end to end: Foundry for contracts, viem with the OP Stack chain configuration for clients, Blockscout for verification. Team time goes into the product, not into working around the chain.

**GIWA Wallet integration path.** The approval surface was designed from the start as a small, self-contained component so it can be embedded inside a wallet. The full argument is in 4.6.

**up.id as the identity roadmap.** Upbit Web3 Names (`up.id`) are KYC-verified and soul-bound. For agent payments that is more than a readable name: merchant allowlists and approval requests become far easier for a human to judge when rendered as `merchant.up.id` instead of a hex address, and the soul-bound plus KYC properties make it a meaningful merchant-reputation primitive. We present this as roadmap, not as an MVP feature.

**Testnet-first follows the state of the chain.** GIWA mainnet is still under development, so our release target is GIWA Sepolia (chain ID 91342), with mainnet launch on the Phase 4 roadmap — in step with the chain's own timeline rather than ahead of it.

---

### 4.2 Originality (독창성)

**The category does not exist on GIWA yet.** As far as our research shows, GiwaCard would be the first agent payment infrastructure on GIWA. We are not relocating an application that already runs on another chain; this product is designed for GIWA's properties.

**The onchain layer is new work, not a port.** Three parts are written from scratch:

1. **An escrow vault with a single accumulator.** Escrow is locked at mint so that available balance always reflects spend already committed to active cards, at constant gas cost — rather than summing over all active cards, whose gas is unbounded. Escrow release for expired cards is permissionless because the EVM has no time-triggered execution; "automatic" here means without owner action, not without a transaction. We state that limitation plainly.
2. **One-time card authorization.** Not a recurring allowance. Each card carries its own merchant scope, amount cap, and expiry, and goes void after a single charge. This differs from the closest prior art we studied: Coinbase spend-permissions and the Safe Allowance Module both grant a spender a recurring allowance over a time window. The card model is stricter, and better suited to agents because leaking one card credential yields nothing beyond a single already-scoped payment.
3. **x402 settlement verified against a vault event.** The common x402 `exact_evm` scheme settles by pulling tokens from the signer's own balance via a signature. In our model that is impossible: the funds sit in escrow inside the vault, and the session key holds no tokens at all. So we use a different settlement shape — the vault performs the charge, and the facilitator verifies a matching `Charged` event against vault address, amount, merchant, and `cardId`. The facilitator becomes read-only and needs no funded EOA. To our knowledge this is an uncommon x402 settlement shape, and it arises directly from the requirements of delegated spending.

**What we reuse, stated precisely.** We reuse MIT-licensed code from agentcard.sh's public repositories — the MCP tool surface, the Agent Skill, and redaction utilities — with the copyright notices preserved in a `NOTICE` file. We are inspired by their UX model. We are **not** affiliated with them and claim no endorsement, partnership, or accelerator relationship of any kind. The entire onchain layer, the escrow model, the card mechanism, and the settlement scheme are our own work.

---

### 4.3 Feasibility (실현 가능성)

**The evidence we submit is inspectable artifacts, not promises.** The evidence milestone for this application is:

- `gUSD` and `CardVault` deployed on GIWA Sepolia (chain ID 91342) and **verified** on `sepolia-explorer.giwa.io` (implementation and proxy), so a reviewer can read the source and call read functions directly from the explorer. Deployed and verified on 2 August 2026, solc 0.8.28:
  - `CardVault` proxy [`0xD89395Df78aaFdF86b330899d1C6189211e88750`](https://sepolia-explorer.giwa.io/address/0xD89395Df78aaFdF86b330899d1C6189211e88750), implementation [`0x0D7766158f14ad7bB82d9FD8A47734e801E3F5B8`](https://sepolia-explorer.giwa.io/address/0x0D7766158f14ad7bB82d9FD8A47734e801E3F5B8)
  - `gUSD` proxy [`0xADa0466303441102cb16F8Ec1594C744d603F746`](https://sepolia-explorer.giwa.io/address/0xADa0466303441102cb16F8Ec1594C744d603F746), implementation [`0x29faf6cAFA4BeA1dC7c232f0a1818d4da6b724DD`](https://sepolia-explorer.giwa.io/address/0x29faf6cAFA4BeA1dC7c232f0a1818d4da6b724DD)
- **An agent payment path that is built and tested, but not yet exercised end to end on the live chain.** The path is: agent requests a card → card is minted with escrow → the merchant charges it against the paid API → the report is returned → the card goes void and the remaining escrow is released. Every step of it is covered by the test suite (960 tests across the four packages), and the contracts it runs against are deployed and verified. What we cannot yet show you is a transaction trace of the whole loop on GIWA Sepolia, because we have not run it there yet. We would rather say so than describe a rehearsal as a performance. Once it is run: `[FILL: mint tx link]`, `[FILL: charge tx link]`.

**We do not claim a finished MVP.** As of the date of this application, the components not yet complete are `[FILL: components still in progress — e.g. dashboard, CLI wizard, npm publication]`. We say so explicitly, because an unverifiable readiness claim would undermine the credibility of the entire application.

**Why the scope is realistic.** Our architectural decisions deliberately remove the dependencies that most often kill a schedule:

- **No custody.** Funds stay in the owner's vault. There is no user balance to hold, no reconciliation obligation, and at the testnet stage no KYC or compliance surface.
- **No bundler, no paymaster.** Mint and charge are ordinary transactions from clearly identified EOAs. There is no dependency on ERC-4337 infrastructure GIWA does not yet provide.
- **No fiat rails.** No card network, no payment provider, no third-party agreement to wait on.
- **A single stack.** Contracts in Foundry/Solidity; every other component is TypeScript inside one published package (`giwacard`) containing the CLI, MCP server, skill, and approval-queue daemon.
- **A single canonical vault.** New users attach rather than deploy. There is no per-user deployment and verification burden.

**Risks we know about, and their mitigations.** We list them up front so the reviewer knows we have measured them:

| Risk | Mitigation |
|---|---|
| GIWA Sepolia public RPC is rate-limited and documented as development-only | Retry with backoff in every client; a backup RPC reserved for the demo; demo rehearsals at off-peak hours |
| ETH faucet is capped at 0.005–0.01 ETH per 24 hours | Gas budget computed up front and displayed by the wizard per submitting address; the mint+charge volume needed for the demo is far below that cap at L2 gas prices; ETH accumulated over several days before the demo |
| Blockscout verification on OP Stack is known to be flaky | Manual verification fallback via standard JSON input through the explorer UI; verification outcome recorded in the README |
| GIWA mainnet is not yet available | Release targets testnet; mainnet launch sits in Phase 4 and follows the chain's own timeline |
| An L1 Sepolia basefee spike raises data costs | ETH reserve above nominal need; budget re-tested close to the demo |

**Team capacity** is addressed in 4.5 and must be filled in by the applicant before submission.

---

### 4.4 Market demand and growth (시장성)

**Demand comes from the growth of agent tooling, not from speculation.** Coding agents and autonomous agents are now routinely installed into production workflows through MCP and skill systems. The more an agent is trusted to complete a task without step-by-step supervision, the more often that task ends in something paid. The need is not "let agents spend money" — it is "let an agent spend this much, at this place, once."

**Evidence of category demand from a party unaffiliated with us.** agentcard.sh's public testimonials return repeatedly to one theme: narrowly scoped spend limits are what make autonomous workflows safe to run unattended. We cite that theme as evidence that the category has real demand from paying users, not as a claim of any relationship with that company — we are not affiliated with them.

**Two distinct sides of demand.**

- **Agent developers** want a rail they can hand a limit to, not a wallet they must trust. For them GiwaCard's value is auditable risk reduction: the limit lives in the contract, and a leaked card credential is worth nothing.
- **API operators and merchants** want machine-payable endpoints without building invoicing, subscriptions, and user accounts. The x402 pattern provides that; what is missing is a payer side that is safe to delegate to an agent. GiwaCard is that payer side.

**Why crypto rails specifically, and why that is a GIWA-shaped opportunity.** Fiat card issuing is jurisdiction-bound: government-ID KYC, billing address, card network rules. That is precisely why the existing solution cannot serve developers outside the United States. An onchain card has no such gate — global from day one, usable by anyone with a wallet. For GIWA, this is an application category that produces high-frequency, low-value transactions, exactly the traffic profile that benefits from 1-second blocks and ~200 ms preconfirmations.

**The honesty boundary.** We have no users, revenue, or traction yet. The market argument above is qualitative and structural. If the reviewer wants market-size figures, we will include them only with a citable source: `[FILL: market size figure with source, if the applicant chooses to include one]`.

---

### 4.5 Team capability (팀 구성 역량)

> **WARNING: THIS ENTIRE SUBSECTION IS A PLACEHOLDER AND MUST BE FILLED IN PERSONALLY BY THE APPLICANT.**
> No names, roles, histories, or achievements are invented here. Do not submit in this state.

**Team composition.**

| Name | Role | Time commitment | Location / timezone | GitHub / X | Relevant shipped work |
|---|---|---|---|---|---|
| `[FILL: name]` | `[FILL: role, e.g. contracts, TypeScript, product]` | `[FILL: full-time / part-time, hours per week]` | `[FILL]` | `[FILL: link]` | `[FILL: project name, link, what you did]` |
| `[FILL: add rows to match team size]` | | | | | |

**Team size:** `[FILL: number of members]`.

**Why this team can execute this project:** `[FILL: 3-5 sentences. State only what is verifiable — contracts deployed and their addresses, packages published, products shipped, Solidity/TypeScript/MCP experience, hackathons entered and their outcomes.]`

**Evidence of execution on this project:** `[FILL: public repo link]`, `[FILL: commit or contribution history link]`, `[FILL: verified contract addresses]`.

**Gaps we are aware of and how we plan to close them:** `[FILL: e.g. UI design, business development, security audit — and the plan for each]`

**Hiring plan if selected:** `[FILL: roles to add, or state none]`

---

### 4.6 Potential to be embedded in GIWA Wallet (GIWA 월렛 내 탑재 가능성)

This is not a claim added after the fact. It is a design constraint we set at the start and recorded as a product requirement.

**The entire owner surface fits on one screen.** All a wallet needs to render is one request card containing: which agent asked (session key), amount and token, merchant address, expiry, why the request fell outside policy, and the available balance after approval. Below it, two buttons: approve or deny.

**At most two interactions.** Our product requirements state that the owner must be able to approve or deny in at most two interactions. That requirement exists precisely because a flow needing more than two steps does not belong inside a wallet.

**The primitive is one every wallet already has.** Approving means signing an EIP-712 struct and sending one transaction. Nothing exotic: no custody, no keys of ours inside the wallet, no long-lived session for the wallet to maintain. If a wallet can already sign EIP-712 and send a transaction, it can already run the entire GiwaCard approval flow.

**No indexer required.** Card status, balance, and escrow are read from a single contract. History is reconstructed from vault events. The wallet does not need to run or subscribe to any indexing infrastructure to display correct state.

**Approval is decoupled from the agent session.** The approval queue does not depend on a live agent session: the owner may approve an hour later and the card still mints; the agent discovers it through a stateless status check. This matters for a mobile wallet, because a wallet user cannot be required to approve within seconds while a terminal waits.

**The integration shape we propose.** An "Agent Requests" tab inside GIWA Wallet showing the request queue; deep links from the CLI and dashboard into that screen; and, in a later stage, rendering the requesting agent and the merchant with up.id names instead of hex addresses. We are willing to adapt the shape to the GIWA Wallet team's integration guidelines — the request for a technical contact for this is in Section 8.

---

## 5. Two-track application rationale

The program allows applying to more than one track, with a maximum of three teams per track. We apply to two.

**AI/WEB3 — primary track.** This is the product's identity. GiwaCard is not an application that happens to use AI; it is infrastructure whose existence only makes sense because autonomous agents spend money. Its primary surface is an MCP server and an Agent Skill, and the threats it addresses — model error and prompt injection — are AI-specific threats. If agents did not exist, this product would not exist.

**GIWA-NATIVE IDEAS — secondary track.** We apply here because the GIWA features we use are load-bearing, not decorative. Flashblocks determine whether agent payment can be designed synchronously; the genesis predeploys determine how much infrastructure we do not have to build; the GIWA Wallet integration path shaped the approval surface from the start; up.id offers a merchant-reputation path unavailable on other chains. This idea grew out of GIWA's properties and would not have the same shape if moved elsewhere.

**We are not applying** to DEFI/RWA, CONSUMER/SOCIAL, or MASS ADOPTION. This product is not a DeFi protocol, not a consumer application, and at this stage it targets developers rather than mass users. Applying there would be a dishonest claim.

---

## 6. Roadmap mapped to the program phases

**A note on our entry timing.** We are applying after the 31 July 2026 extended deadline, relying on the program page's statement that new applications are accepted during Phase 2. That means we enter mid-cycle and our Phase 2 is genuinely compressed. We state that plainly, and plan to catch up rather than to appear already level.

| Program phase | Program schedule | What we do | Inspectable output |
|---|---|---|---|
| Phase 1 — screening | May 2026 | This application; core contracts deployed and verified on GIWA Sepolia; the agent payment path built and covered by tests, pending its first live run | Verified contract addresses; the public repo and its test suite; mint and charge transactions on the explorer once the loop has been run |
| Phase 2 — MVP build | Jun–Jul 2026 | Complete the MVP: MCP server and Agent Skill, CLI wizard, approval-queue daemon, paid merchant API, test stablecoin + faucet | `npx giwacard` runs onboarding through to the first card; E2E demo runs with no intervention beyond owner approval |
| Phase 3 — productize | Aug–Sep 2026 | Dashboard at a UI/UX quality fit for real use; sub-10-minute coding-agent onboarding; npm package publication; two-path documentation (for humans / for agents); first users and their feedback | Public package in the registry; onboarding test records; first-user count with the counting method stated |
| Demoday | October 2026, Korea Blockchain Week | Live demo: an agent pays a paid API on GIWA, an out-of-policy approval resolved live on stage, and a prompt-injection attempt that the contract still rejects | Live demo + video + public repo + one-command install from the registry |
| Phase 4 — growth | Post-Demoday, KPI-driven | B2B multi-tenant issuing (organizations issuing cards for their users' agents); mainnet launch once GIWA mainnet is available; GIWA Wallet integration; up.id for merchants and agents; ERC-4337 compatibility using the genesis EntryPoint; gas sponsorship via a paymaster | KPIs in Section 7 |

**The three largest Phase 4 items, briefly.**

- **B2B multi-tenant issuing.** Today a single owner manages their own agents. The commercial shape is an organization issuing scoped cards for its users' agents, with tiered policy and reporting. This is an extension of the same vault model, not a new product.
- **Mainnet launch.** Waiting on GIWA mainnet. Prerequisites we have already imposed on ourselves: upgrade ownership moved to a multisig with a timelock, and a security audit `[FILL: audit plan — self-funded, grant-funded, or through the program]`.
- **GIWA Wallet integration.** In the shape described in 4.6, following the GIWA Wallet team's guidelines.

---

## 7. KPI proposal for the bonus grant tier

**Principle.** The bonus is tied to transaction volume, TVL, and user acquisition. We will say one thing directly: while GIWA mainnet is not yet available, TVL and real-value transaction volume are not honest metrics for this product. So we propose two KPI sets — a testnet set that applies until mainnet, and a mainnet set that replaces it from mainnet launch day. Every number below is a **target we are proposing and are willing to negotiate**, not an achievement. We have no users yet.

**Set A — until GIWA mainnet launch.**

| Metric | Precise definition | Measurement source | Proposed target |
|---|---|---|---|
| Agent-initiated payments | Count of successful `Charged` events on `CardVault` | Onchain event logs, reproducible by anyone | `[FILL: e.g. 1,000 within 90 days of Demoday]` |
| Active owner wallets | Unique owner addresses with ≥1 card minted in a rolling 30 days | Onchain `Minted` events | `[FILL: e.g. 50]` |
| Funded vaults | Unique owner addresses with deposit balance > 0 | Onchain state | `[FILL: e.g. 100]` |
| Integrated agent hosts | Number of distinct MCP hosts that pass our install runbook (e.g. Claude Code, Cursor, Gemini CLI) | Reproduced test records | `[FILL: e.g. 3]` |
| Merchant endpoints | Number of third-party paid endpoints accepting GiwaCard settlement | Public list + verification transactions | `[FILL: e.g. 3]` |
| Package downloads | Weekly downloads of `giwacard` on the npm registry | Public registry statistics | `[FILL: e.g. 200/week]` |
| Onboarding time | Time for a coding agent that has never seen this project to reach its first card | Recorded onboarding test | < 10 minutes |
| Request-to-response latency | Median time from agent request to merchant response, using preconfirmations | Client instrumentation, reported with distribution | `[FILL: e.g. < 1.5 s median]` |

**Set B — effective once GIWA mainnet is available.**

| Metric | Precise definition | Measurement source | Proposed target |
|---|---|---|---|
| Transaction volume | Total value charged through `CardVault.charge` on mainnet | Onchain event logs | `[FILL: 90-day target]` |
| TVL | Deposit balance plus escrow held in `CardVault` | Onchain state | `[FILL: 90-day target]` |
| User acquisition | Unique owner addresses funding a vault on mainnet | Onchain state | `[FILL: 90-day target]` |
| B2B customers | Organizations issuing cards for their users' agents | Contracts/agreements, reported separately | `[FILL]` |

**A note on metric integrity.** Every Set A and Set B metric except package downloads and B2B customers is verifiable directly from onchain state and events — a third party can recompute them without trusting us. We will publish the computation scripts alongside the reports. To prevent self-inflated metrics, we propose that team-owned wallets and addresses be excluded from the counts and registered in advance.

---

## 8. What we are asking for

**From the program's grant structure.**

- The initial grant of approximately $20,000 on completing the program. To be used for `[FILL: allocation — e.g. developer time, security audit, RPC/hosting infrastructure, Demoday costs]`.
- Eligibility for the KPI-linked bonus tier of up to $80,000, with the KPIs proposed in Section 7 and open to negotiation.
- Consideration for in-app listing in GIWA Wallet, in the integration shape described in 4.6.
- Introductions to top-tier VCs, if the team is judged ready for that.

We understand the grants are taxable and account for that in our planning; `[FILL: confirm how the applicant handles the tax obligation in their jurisdiction]`.

**Non-financial support, which for this product matters most.**

1. **Reliable RPC access.** The GIWA Sepolia public RPC is rate-limited and documented as development-only. An endpoint with raised limits, or an allowlisted API key, would substantially de-risk live demos and load testing.
2. **A larger faucet allowance for demo wallets.** The 0.005–0.01 ETH per 24 hours cap limits how many demo wallets we can run at once. A dedicated allocation for a handful of demo addresses would be enough.
3. **A technical contact for GIWA Wallet integration.** We want to align the approval surface with the GIWA Wallet team's guidelines as early as possible, not after it is built.
4. **Clarity on the GIWA mainnet timeline.** Our mainnet launch and the Set B KPIs depend on it.
5. **Feedback on our settlement scheme.** We chose to diverge from x402 `exact_evm` for the technical reason given in 4.2. We would welcome input from the GIWA team, particularly if there is an interoperability direction the ecosystem wants to push.
6. **Confirmation of application eligibility.** We are applying after the 31 July 2026 extended deadline, relying on the program page's statement that new applications are accepted during Phase 2. We ask for explicit confirmation that this application will be reviewed, and if not, guidance on the next cycle.

---

## Appendix A — Technical claims and how to verify them

This table exists so a reviewer can check every technical claim in this document without trusting us. Rows containing placeholders must be completed by the applicant before submission.

| Claim | How to verify |
|---|---|
| GIWA is an OP Stack, EVM-equivalent L2 | https://docs.giwa.io |
| GIWA Sepolia chain ID 91342 | https://docs.giwa.io — connect-to-giwa page |
| Genesis predeploys: ERC-4337 EntryPoint v0.6 and v0.7, Safe, Permit2, Multicall3 | https://docs.giwa.io — contracts page; the predeploy addresses can be opened directly in the explorer |
| Flashblocks ~200 ms preconfirmations; 1-second block interval | https://docs.giwa.io — flashblocks page |
| Public RPC is rate-limited and development-only | https://docs.giwa.io — connect-to-giwa page |
| Faucet gives 0.005–0.01 ETH per 24 hours | https://docs.giwa.io — faucets page |
| up.id is KYC-verified and soul-bound | https://docs.giwa.io — up.id page |
| GIWA mainnet is still under development | https://docs.giwa.io |
| GASOK grant structure, tracks, selection criteria, and schedule | https://giwa.io/gasok |
| `CardVault` deployed and verified | https://sepolia-explorer.giwa.io/address/0xD89395Df78aaFdF86b330899d1C6189211e88750 |
| `gUSD` deployed and verified | https://sepolia-explorer.giwa.io/address/0xADa0466303441102cb16F8Ec1594C744d603F746 |
| Successful card mint and charge transactions | `[FILL: transaction links]` |
| Full source code, license, and MIT attribution | `[FILL: public repo URL]` + the `NOTICE` file inside it |
| We reuse MIT-licensed code from agentcard.sh's public repositories with attribution | The `NOTICE` file in our repo + the `LICENSE` file in the upstream repositories |
| We are not affiliated with agentcard.sh or with any accelerator | No affiliation claim is made in this document; no such claim may be added |

---

## 9. TODO — what the applicant must supply before submitting

> This document **must not be submitted** until every box below is checked and every `[FILL: ...]` in this document is gone.

**Team and identity**

- [ ] Full name, role, and time commitment for each team member (Section 4.5)
- [ ] Team size
- [ ] GitHub and X/Twitter links for each member
- [ ] Relevant shipped work with verifiable links — must not be invented
- [ ] The "why this team" paragraph
- [ ] Capability gaps and the plan to close them
- [ ] Hiring plan if selected, or a statement that there is none
- [ ] Legal entity name if any, and country of incorporation
- [ ] How the tax obligation on the grant is handled (Section 8)

**Contact**

- [ ] Primary email address for the application
- [ ] Backup contact (Telegram/Discord/KakaoTalk per the GIWA team's preference)
- [ ] Timezone and availability for interviews

**Links and artifacts**

- [ ] Public repository URL
- [x] Deployed `CardVault` and `gUSD` addresses, plus explorer links showing Verified status — supplied in Section 4.3 and Appendix A
- [ ] Example mint and charge transaction links
- [ ] Landing page or project site, if one exists
- [ ] npm package name and publication status
- [ ] List of components not yet complete as of the submission date (Section 4.3) — must be accurate

**Demo material**

- [ ] Demo video (screen recording): onboarding → agent pays the paid API → out-of-policy approval → card goes void
- [ ] Publicly accessible, non-expiring video link
- [ ] Slide deck if the form asks for one

**Numbers and targets**

- [ ] Set A KPI targets (Section 7) — pick numbers that are ambitious but defensible
- [ ] Set B KPI targets (Section 7)
- [ ] Allocation of the $20,000 grant (Section 8)
- [ ] Pre-mainnet security audit plan (Section 6)
- [ ] Market size figures with sources, if you want to include them (Section 4.4) — only with citations

**Final checks before submitting**

- [ ] Search the whole document for `[FILL:` — must return zero results
- [ ] Confirm there is no claim of affiliation with Y Combinator, agentcard.sh, or any accelerator
- [ ] Confirm there are no user, revenue, or traction numbers that cannot be evidenced
- [ ] Confirm every contract address in the document really shows Verified on the explorer
- [ ] Confirm application eligibility with GIWA via the official contact on the GASOK page, before or alongside submitting
- [ ] Decide the submission language (English or Korean) and prepare a translation if the form requires Korean
