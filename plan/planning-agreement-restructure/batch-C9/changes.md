# C9 — PLAN-READY != agreement

## Root cause (mechanism)

`BriefWriterService.generatePlanningBrief` (`src/services/brief-writer-service.ts`) — the
method that generates the prompt text sent to the plancore/`helm_pm` planning role — told
plancore, in four separate places, that its own `PLAN-READY` emission constituted or
required whole-plan agreement:

1. `scope:` field passed into the base template: "...emit PLAN-READY only after both
   artifacts written **and whole-plan agreement holds**."
2. §5 "Co-planner agreement" job bullet: "→ **one PLAN-READY gate**" (framing the round-cap
   gate itself as the PLAN-READY moment) and "...then emit PLAN-READY **when whole-plan
   agreement holds** and both docs are on disk."
3. §7 "Artifact verification + PLAN-READY": "Emit PLAN-READY only after **whole-plan**
   co-planner agreement (engine gate) AND both artifact writes succeed. A BROKEN/negative
   partner verdict fails the gate — do not force PLAN-READY past it." (this last sentence
   also implied plancore sees and judges partner verdicts before emitting PLAN-READY).
4. The literal callback template: `STATUS: PLAN-READY — plan agreed with ${params.mode ||
   'planner'}; see og-requirements.md + plan.md`.

This conflates two distinct events — plancore finishing its artifacts vs. the engine
(helm-algo) running the actual co-planner agreement gate after PLAN-READY — and let
plancore self-declare agreement instead of the engine. Per AC12, only the engine may
declare agreement and grant ingest permission.

## Fix

`src/services/brief-writer-service.ts`, `generatePlanningBrief` only (all four sites above):

1. `scope:` — now: emit PLAN-READY once both artifacts are written and readable; this
   signals "ready for engine review," not that agreement has been reached; helm-algo then
   spawns co-planners and runs the whole-plan agreement gate itself; only the engine
   declares agreement and grants ingest permission.
2. §5 last bullet — replaced the agreement-gated instruction with "**Your job ends at
   artifact readiness:**" — plancore authors the two artifacts then emits PLAN-READY once
   both are written and readable; explicitly states it must not wait for or declare
   whole-plan agreement itself. Also reworded the `→ one PLAN-READY gate` phrase to
   `→ one engine-run agreement gate` so PLAN-READY is no longer described as being the
   agreement gate.
3. §7 — reworded to: emit PLAN-READY as soon as both artifact writes succeed and the JSON
   parses; PLAN-READY means the artifacts are ready for engine review, not that agreement
   has been reached; plancore must not wait for, judge, or declare co-planner/whole-plan
   agreement — the engine runs partner review and the agreement gate and only the engine
   grants ingest permission. Dropped the "do not force PLAN-READY past it" sentence, since
   it implied plancore inspects partner verdicts before its own PLAN-READY — under the
   corrected model plancore never does that.
4. Callback template — now: `STATUS: PLAN-READY — artifacts ready for engine review:
   og-requirements.md + plan.md written`. The "plan agreed with `<mode>`" literal is gone.

Untouched, per scope: §1-4 (derive-order, og-requirements.md, plan.md schema, the explicit
"plan.json — DO NOT author" instruction), the round-cap/engine-spawn description, and the
post-PLAN-READY "STOP COMPLETELY" guard. No other `generate*Brief` method touched (e.g.
`generatePlanReviseBrief`'s separate per-task-revise PLAN-READY usage is untouched — no
"agreed"/"agreement holds" language there to begin with, and it is a different, single-task
semantics out of this plan row's scope).

## Files changed

- `src/services/brief-writer-service.ts` (edited)
- `src/services/brief-writer-plan-ready-not-agreement-c9.test.ts` (new — gate)

PLAN-CONTRADICTION: none.
