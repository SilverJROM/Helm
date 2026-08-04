# planning-agreement-restructure

**Status:** SCOPED, not started · **Authored** 2026-07-30 PHT by `[north]` `helm-97`
**Origin:** JROM — *"no i want to do them all but do them reliably and cleanly"*, after planning failed
its 4th consecutive attempt and a 3-seat panel returned unanimous `NEEDS-RESTRUCTURING`.

| File | What it is |
|---|---|
| `og-requirements.md` | **23 acceptance criteria** across P0-P3 + the token-free regression gate. Scope source of truth. |
| `PANEL-SYNTHESIS.md` | The panel's convergent findings (C1-C6), unique findings, and prescription. |
| `TILLER-READINESS.md` | Can Tiller orchestrate this? Verdict + the 2 fixes that would make it testable. |
| `../_panels/planning-path-review/` | Raw panel output: `findings-{grok45,sol,opus}.md`, 1042 lines. |

## The one line

The planning phase has been fixed 4 times and failed 4 times because **agreement is prompt instructions
to cooperative agents, not an engine-enforced protocol.** Brief fixes cannot fix a protocol.

## Ordering is non-negotiable

**P0** stop active corruption (ibrain teardown marks live sessions reapable; failed runs mark cycles
`complete`) → **P1** make the fail-OPEN agreement gate fail-CLOSED (plan-SHA-scoped verdicts) →
**P2** engine-owned round machine with fresh seats per round → **P3** close divergent entry paths.

P1 before P2: P1 makes the system **safe while still broken**; P2 makes it work.

## Must survive this effort

Commit `8024452` — the convene-race fix, **proven on run 32**.
`grep -c planMdPathForRaceGuard src/services/planning-phase-service.ts` must stay `3`.
