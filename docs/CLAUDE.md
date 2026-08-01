# docs

Planning and grant artifacts. No code.

| Path | What it is | Authority |
| --- | --- | --- |
| `brainstorms/2026-08-01-giwa-agent-card-requirements.md` | The Product Contract: R-IDs, actors, flows, acceptance examples. | What to build. |
| `plans/2026-08-01-001-feat-giwacard-mvp-plan.md` | The implementation plan: 18 KTDs, 12 units, verification contract. | How to build it. |
| `grant/gasok-application.md` | GASOK application draft, bilingual. | Not yet submitted. |
| `demo.md` | The recorded-demo choreography. | — |

## How to use these

**The Product Contract is the authority on behaviour.** If code and an R-ID
disagree, that is a finding, not a licence to change the requirement quietly.

**The plan's KTDs are the authority on technical decisions**, and several were
corrected during implementation because the code proved them wrong. KTD-9 is the
cautionary one: it originally had the agent submitting the charge, which the
contract makes impossible. The correction landed in KTD-9 first and the diagram,
U5 and U9 stayed stale for a while — **a half-corrected plan is worse than an
uncorrected one**, because the next reader trusts whichever section they open. If
you correct a decision, grep the whole file for the old description.

**Neither document tracks progress.** Whether something shipped is derived from
git. There is no status field and no checkboxes to tick.

## Before submitting the grant application

`grant/gasok-application.md` is a draft with ~58 explicit `[ISI: ...]` /
`[FILL: ...]` placeholders — team, contact, links, deployed addresses, demo
video. They are blank deliberately rather than invented. Section 9 is the
checklist.

Two claims that must not creep back in: **no affiliation with Y Combinator**, and
**no affiliation with agentcard.sh**. We adapt their MIT-licensed code with
attribution (see `NOTICE`) and say exactly that. The feasibility argument rests
on deployed and verified contracts plus a working payment path — not on a
finished MVP.
