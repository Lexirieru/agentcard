# docs

Planning and grant artifacts. No code.

| Path | What it is | Authority |
| --- | --- | --- |
| `brainstorms/2026-08-01-giwa-agent-card-requirements.md` | The Product Contract: R-IDs, actors, flows, acceptance examples. | What to build. |
| `plans/2026-08-01-001-feat-giwacard-mvp-plan.md` | The implementation plan: 18 KTDs, 12 units, verification contract. | How to build it. |
| `grant/gasok-application.md` | GASOK application draft, bilingual. | **Submitted 2026-08-02.** Result 2026-08-14. |
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

## The application is already in

Submitted 2026-08-02 under Track 04 AI/WEB3, with answers written separately from
this file. GIWA treats it as **Phase 3** and decides by **2026-08-14**.

That makes the ~28 remaining `[FILL: ...]` placeholders here **not worth
filling**. No reviewer reads this file; filling them is work nobody sees. Keep
the document truthful as a record — §4.3 now carries the live end-to-end
transactions — and spend the effort on things a reviewer does reach: the repo,
the npm page, the contracts, and the demo recording.

Two claims that must not creep back in: **no affiliation with Y Combinator**, and
**no affiliation with agentcard.sh**. We adapt their MIT-licensed code with
attribution (see `NOTICE`) and say exactly that. The feasibility argument rests
on deployed and verified contracts plus a working payment path — not on a
finished MVP.
