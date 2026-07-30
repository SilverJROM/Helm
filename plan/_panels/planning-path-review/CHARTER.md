# PANEL CHARTER — Trace the planning path end-to-end and find what we have NOT hit yet

**Commissioned by** JROM, 2026-07-30 05:3x PHT · **Convened by** `[north]` `helm-97`
**Seats:** `grok45`, `sol` (gpt-5.6-sol, xhigh), `opus` (claude-opus-5) — **independent, no cross-talk**
**Repo:** `/home/agjrom/websites/Helm`

> JROM: *"we have had it like 3-4 times trying to fix this, would it pay to check what has been missing
> like consult with a panel of grok45/sol/opus to see what is wrong one and how to fix this once and for
> good? we have like tried 3-4+ times and still having issues on this"*

---

## THE QUESTION YOU ARE ANSWERING

**Not** "is the latest fix correct." **This:**

> Trace the ENTIRE planning path as a design — from Start Planning / handoff confirm through discovery,
> plancore authoring, co-planner deliberation, agreement, ingest, and run terminalisation — and
> enumerate every remaining failure mode **before** we discover it by burning another run.

Then: **is this architecture sound and merely under-tested, or does it need restructuring?** Say so
plainly. If your honest answer is "the design is wrong, stop patching it", say that.

## WHY YOU WERE CONVENED — the pattern

Eight distinct defects have been found in this ONE path, each discovered only by running it. They are
four different KINDS of defect, which is why "one root cause" is not a credible hypothesis:

| # | Defect | How found | Status |
|---|---|---|---|
| 1 | Discovery authored `plan.md` itself, bypassing plancore + both configured planners | JROM noticed a plan he never approved | fixed (15-slice effort) |
| 2 | Configured planner panel ignored — only read when `adaptive_planning=1`, which is OFF | JROM asked "did it use my 2 planners?" | fixed (S05/S06) |
| 3 | **Convene race** — partners spawned while plancore is still authoring; both reported artifacts "absent" as BROKEN; fail-fast blocked the run | run 31 died | fixed, proven on run 32 |
| 4 | **No convergence** — `planning_round_cap=3` is only a timeout multiplier (`effectiveTimeoutMs = PLANNING_TIMEOUT_MS * roundCap`), NOT a retry loop, while `waitForAgreement` aborts on the first BROKEN. Any real critique is fatal. | run 32 died | fix in flight (sonnet5) |
| 5 | **Phantom `ibrain` seat** — `provider=unknown, model=unknown, state=failed`, registered at the exact `ended_at` of runs 31 AND 32 | noticed 2026-07-30, never investigated | **OPEN, unexamined** |
| 6 | plancore emits `PLAN-READY — plan agreed with deliberation` BEFORE any partner verdict exists — a false assertion | run 32 callbacks | fix in flight |
| 7 | `terminalizeCycleAtRunEnd` sets cycle `phase='complete'` on a **failed** run | cycle 13 twice | OPEN |
| 8 | Legacy Start Planning re-spawns a discovery seat and overwrites existing `north-star.md` / `conversation-log.md`, which AC15 forbids for the new bridge | run 31/32 rewrote JROM's docs | OPEN |

## WHERE TO LOOK

- `src/services/planning-phase-service.ts` — plancore dispatch, partner spawn loop (~:509),
  `waitForAgreement` (~:984), artifact poll, ingest
- `src/services/run-orchestrator-service.ts` — seat resolution (~:792-970), `runPlanningPhase` call
  sites (~:1065, :1157), `terminalizeCycleAtRunEnd` (~:616)
- `src/services/planning-staffing-service.ts`, `planner-panel-service.ts` — S05/S06 seat resolution
- `src/services/brief-writer-service.ts` — plancore + panel briefs
- `src/services/planning-provenance-service.ts` — the AC28 Start Implementation gate
- `src/services/discovery-handoff-*.ts` — the new ASK/confirm bridge
- **Real evidence, not hypotheticals:** `data/runs/helm-run-3-rms6jr3eg/` (run 31, failed) and
  `data/runs/helm-run-3-rms6l9kn5/` (run 32, failed) — read their `callbacks.md` in full.
  `plan/_archive/cycle13-run31-failed-*` and `cycle13-run32-failed-*` hold the produced artifacts.
- DB: `data/helm.db` (READ-ONLY — `sqlite3 -readonly`). `runs`, `worker_runtimes`, `cycles`,
  `discovery_handoffs`, `planning_provenance`, `project_planner_panel`.

## SPECIFIC UNANSWERED QUESTIONS — do not stop at these, but do not skip them

1. **What is the `ibrain` seat (defect 5)?** Who registers it, why at run teardown, why
   `provider=unknown`, and what does its failure suppress or corrupt?
2. **Round 2 has never executed.** When plancore revises after a BROKEN and partners re-verdict — what
   breaks? Stale offsets (`agreementFenceOffset`), the `.agreement-fence-<batchId>` sidecar, seat
   reaping mid-revision, `plan.json` derivation from a superseded `plan.md`?
3. **Partner disagreement has never happened.** partner-1 CLEAN + partner-2 BROKEN — what does
   `waitForAgreement` do? Is unanimity actually enforced, or does ordering decide?
4. **partner-2 has never rendered a verdict in any run** — reaped mid-review both times. Is the second
   configured seat ever load-bearing, or is JROM paying for an opinion that is structurally discarded?
5. **Two entry paths** (legacy Start Planning vs the new confirmed handoff) reach planning with
   different preconditions. Can they diverge into inconsistent state? Should the legacy path exist?
6. **Non-convergence.** If plancore never satisfies the partners within budget, what is the operator
   left holding — and is any of it recoverable, or is the cycle wedged (see defect 7)?
7. **`plan.md` byte-identity.** AC28 provenance pins a SHA. Round-2 revision changes those bytes. Does
   the provenance record follow the final agreed plan, or pin a superseded one?

## RULES

- **Read-only. Change NOTHING.** No edits, no commits, no `pm2`, no writes to `data/helm.db`.
  A live planning-adjacent branch is being edited by another seat right now — do not touch `src/`.
- **Mechanism-level or it does not count.** Cite `file:line` and the exact failing sequence. "Probably
  a race" is worthless; "partners spawn at :509 before the artifact write at :580, so X" is the bar.
- **Work independently.** Do not read another panelist's output. Divergence is the point.
- **Rank by: will this bite a real run, how soon, and how badly.** JROM's bar is "usable for NEW
  cycles" — old-cycle compatibility is explicitly NOT required (see
  `plan/discovery-planning-handoff/decisions/D-03-new-cycles-over-old-cycles.md`).
- **Distinguish** "under-tested but sound" from "wrong design". Do not be diplomatic about it.
- Say **"I could not determine"** rather than guessing. A confident wrong answer costs another burned run.

## DELIVERABLE

Write ONE file: `plan/_panels/planning-path-review/findings-<your-model>.md`

```
## VERDICT: SOUND-BUT-UNDERTESTED | NEEDS-RESTRUCTURING  (+ one paragraph, no hedging)

## RANKED FINDINGS
For each: mechanism (file:line + sequence) · trigger · blast radius · fix · confidence (high/med/low)

## THE ONE THING most likely to break the NEXT run

## WHAT I COULD NOT DETERMINE
```

Then print `PANEL-DONE <your-model>` as your final line.
