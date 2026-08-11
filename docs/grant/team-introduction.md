# GiwaCard — Team Introduction

**GASOK application · question 3 of 12**

---

## Team size

**One.** GiwaCard is built and maintained by a single developer. Everything in
this application — the contracts, the CLI, the MCP server, the merchant service,
the dashboard, and the site — is the work of one person, and the git history is
a single author throughout.

I state that plainly rather than padding a roster, because a reviewer can check
it in thirty seconds and a padded team is the fastest way to lose their trust.
GASOK accepts individual applicants, and the question worth answering is not how
many of us there are but whether one person can carry this to Demoday. The
evidence for that is below.

---

## Member

### Axel Urwawuska Atar Ubby

| | |
| --- | --- |
| **Role** | Founder and sole engineer — protocol, tooling, backend, frontend |
| **Nationality** | Indonesian |
| **Based in** | Yogyakarta, Indonesia |
| **GitHub** | [@Lexirieru](https://github.com/Lexirieru) |
| **Email** | axelmatsama@gmail.com |
| **X / Telegram** | [@lexirieru](https://x.com/lexirieru) · [@lexirieru](https://t.me/lexirieru) |
| **Availability** | Full-time on GiwaCard through the programme |

#### What I built for this application

Every layer of GiwaCard, shipped and verifiable:

- **Smart contracts** — `CardVault` and `gUSD`, both UUPS-upgradeable, deployed
  and source-verified on GIWA Sepolia. 78 tests covering the acceptance
  examples, the revoke/charge race, daily-cap window rollover, cross-owner
  isolation, and a V1→V2 upgrade that asserts storage survives.
- **`giwacard`** — published on npm. One package carrying an interactive CLI, an
  MCP server with seven agent-facing tools, a local approval daemon, and an
  Agent Skill. 542 tests.
- **Merchant service** — a paid API and its x402-style facilitator, live on
  Railway, settling real charges against the vault. 215 tests.
- **Owner dashboard** — Next.js with Reown AppKit, live on Vercel. 125 tests.
- **Landing page** — live on Vercel.

Roughly 40,000 lines across Solidity and TypeScript, 994 tests passing, and
every contract published for reading rather than described.

#### Core strengths

**I ship the whole stack.** A protocol is not a product until someone can
install it, and this one goes from `npx giwacard` to a paid API call without a
second person in the loop. Solidity, TypeScript, contract deployment and
verification, CLI ergonomics, MCP integration, and frontend all sit inside one
head, which removes the coordination cost that usually slows a small team down.

**I design against the failure, not the demo.** The parts of GiwaCard I am most
confident about are the ones that say no: an agent has no tool that can approve
its own overspend, and a test asserts that against the live tool list rather
than a constant. Card limits are enforced by the contract, so a prompt-injected
agent cannot argue its way past them. Secrets are redacted in two independent
layers because either alone fails open.

**I correct my own architecture when the code disagrees with the plan.** The
payment direction in this project was originally wrong — the design had the
agent pushing payment when the contract requires the merchant to pull it. It
would never have worked. Rather than patch around it I reversed the direction
across three packages and corrected the planning document, including the parts
that had already been written down. The repository records that decision and its
reasoning.

**I document for the next reader, including when the next reader is a machine.**
Every directory carries its own notes on the traps that cost real time to find,
and the install runbook is written to be executed by a coding agent rather than
read by a human.

#### Background

Second-year Information Engineering student at **Universitas Gadjah Mada** in
Yogyakarta, consistently ranked among Indonesia's three leading universities.

**AI Engineer at [IDN Financials](https://www.idnfinancials.com)**, an Indonesian
stock-market news publication, where I work on the AI systems behind its
coverage. That job is the reason the engineering here looks the way it does:
shipping systems that other people depend on daily is a different discipline
from shipping a demo, and it is where the habits in this codebase came from —
tests that assert the thing you are afraid of, documentation aimed at whoever
arrives next, and the willingness to reverse a design when the code proves it
wrong.

**Onchain.** GiwaCard is the first protocol I have designed and shipped end to
end on my own — the contracts, their deployment and verification, the tooling,
the services, and the four live surfaces. I am early in my onchain career and I
would rather say so than dress it up, because everything I am claiming in this
application is already onchain and readable, and a reviewer who checks it will
find exactly what is described. Deployed, source-verified, upgradeable contracts
with an upgrade test that asserts storage survives is not the work of someone
learning Solidity during the application.

---

## Why one person is enough to reach Demoday

The scope that remains is deliberately narrow. The contracts are deployed and
verified, the package is published, and all four surfaces are live. What is left
before Demoday is an end-to-end run on the live chain, the B2B issuing surface,
and gas sponsorship — extensions of what already exists rather than new
foundations.

If the programme's support makes it sensible to grow the team, the first hire
would be someone working on merchant integration and developer relations, not a
second protocol engineer. The bottleneck ahead of GiwaCard is not building — the
contracts and the tooling already exist and I can extend them — it is that a
payment rail is worth nothing until there are places to spend it, and getting
merchants and agent developers to adopt an SDK is a different job from writing
one, done in parallel rather than after.

---

## Verify any of this

| Claim | Where to check |
| --- | --- |
| Contracts live and verified | [CardVault](https://sepolia-explorer.giwa.io/address/0xD89395Df78aaFdF86b330899d1C6189211e88750) · [gUSD](https://sepolia-explorer.giwa.io/address/0xADA0466303441102cb16F8eC1594C744d603f746) |
| Package published | [npmjs.com/package/giwacard](https://www.npmjs.com/package/giwacard) |
| Source and history | [github.com/Lexirieru/agentcard](https://github.com/Lexirieru/agentcard) |
| Landing page | https://agentcard-eta.vercel.app |
| Owner dashboard | https://agentcard-fe.vercel.app |
| Demo merchant | https://agentcard-production.up.railway.app |

---

*Complete. Export to PDF or share the Google Doc with "Anyone with the link can
view", then paste the link into question 3 of the GASOK form.*
