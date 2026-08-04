# Briefing packet — `planning-agreement-restructure`

**From** `[north]` `helm-97` · **To** projcore (`codex55`) · **2026-07-30 08:1x PHT**
**JROM greenlit:** *"ok go with all your recommendations go you have greenlight"*

## Identity
- `run_id`: **planning-agreement-restructure** · run prefix **15**
- `run_dir`: `/home/agjrom/websites/Helm/plan/planning-agreement-restructure`
- `repo`: `/home/agjrom/websites/Helm`, branch **`fix/planning-agreement-restructure`**, base `b11ef58`
- `north_author_session`: **`helm-97`** — one-way. I may nudge you; you never drive, capture from, or kill my session.
- `planning_criticality`: **settled.** Scope, waves and safety rules are locked by JROM. Do not re-plan.

## Read in this order, in full
1. `north-star.md` — why this exists; the keystone (no `transport.send`)
2. `og-requirements.md` — **23 ACs.** Scope source of truth
3. **`WAVE-PLAN.md`** — **YOUR EXECUTION ORDER. This supersedes `plan.md`'s dep column.**
4. `PARALLEL-SAFETY.md` — the 6 collision surfaces and why each rule exists
5. `plan.md` — per-slice scope, ACs, tiers (dep column is superseded by #3)
6. `topology.yaml` — **self-validated exit 0** by me
7. `PANEL-SYNTHESIS.md` — the diagnosis, if you want the reasoning

## Scope — 24 slices, NOT 35
**P0 (A0-A6) + P1 (B1-B6) + P2 (C1-C10) + D12.** **D1-D11 are DEFERRED** to a follow-up effort.
Do not build them. Do not "helpfully" include them.

## What this effort is, in one line
**Agreement is a fact the engine establishes, never a claim an agent makes.**

## Why the four prior attempts failed — do not repeat it
Every prior fix was correct and every prior fix changed an agent **brief**. **A brief is not a protocol.**
If a slice's deliverable is "the agent is now told to…", it is wrong. The invariant must live in code.

## THE FIVE STANDING RULES — a seat that breaks one has failed the slice
1. **Never invent a schema version.** Only `C10` has one (`v113`). Need one and unallocated → **halt, ask `[north]`**.
2. **Never edit `src/index.ts` in a build slice.** Three streams need it; all wiring is `I-FINAL`. A slice that thinks it needs an `index.ts` edit has mis-scoped its seam.
3. **Cross-stream type changes are ADDITIVE and OPTIONAL only.** `PlanningResult` has **14 consumers** in `run-orchestrator-service.ts`. New fields optional; never rename, never re-type. Breaking change → integration wave.
4. **Never edit a file another stream owns, even trivially.** → halt, ask.
5. **Your gate is your OWN NEW unit-test file.** `b9-gate-atomic`, `a15-worker-finalize` and `cycle-terminal-on-run-complete` each import 4+ unrelated services — they are **integration-owned**, not yours to satisfy.

## Ordering laws — not negotiable for speed
- **A0 first.** It pins commit `8024452` (proven on run 32) before anything touches code near the gate.
- **A1→A2→A3→A4 is ONE serial chain on ONE seat.** JROM's call: this is the path that already marked a live session reapable; ~25min of parallelism is not worth it.
- **P1 before P2.** Never build convergence on a fail-open gate.
- **C8 is LAST of the round wave.** Removing the honest fail-fast before C3-C7 exist and are green is exactly the mistake made at 04:00 PHT today.
- **C2 runs ALONE** — it spans two files.

## Deploy cadence — JROM's instruction
**Deploy after each phase: I-P0, then I-P1, then I-P2.** `[north]` performs deploys, not you. Ask me;
never run `pm2` yourself. Each phase is a coherent safety improvement and JROM wants to find a problem
after 13 slices rather than after 24.

## HARD SAFETY RULES
1. **`HELM_SESSION_JANITOR` stays `0`.** No batch may set it to `1`. `A3` is merely a precondition for ever reconsidering it.
2. **Commit `8024452` must survive.** `grep -c planMdPathForRaceGuard src/services/planning-phase-service.ts` must stay **3**. `A0` pins it; if it ever reads other than 3, **halt**.
3. **Cycle 13 (memory_mcp "UI Upgrade") is JROM's live test cycle.** Do not mutate its data or canonical folder.
4. **No merge to `main`** — it is at `680b6ca`; promote is JROM's call (**SD10**).
5. `app.js`: `node --check` after ANY edit, then `npm run build` — the tree ships **two copies**.
6. UI proof targets **`:3110` via `playwright.cap.config.ts`**. The default config (`:3111`, fake tmux, scratch DB) is **not evidence**.
7. Run vitest **file-by-file**. A bare full-suite run with extra pool flags hangs.
8. **Never weaken the AC28 provenance guard** to make stale pre-AC28 fixtures pass.

## Known pre-existing failures — leave them unless your change touches them
`pause-after-planning-gate` (3) · `finish-planning-production` (1) · `b25-fix1-orphan-model` (1) ·
`model-service` (1) · `smoke` (1). The first two are stale pre-AC28 provenance fixtures.

## Carry-forward — do not relearn these
- **STANDING AUTO-DRAIN AUTHORITY.** On every VERIFIED, dispatch the next ready row **in the same turn**. Never end a turn whose next action is "await cue". Prior runs dead-turned **six** times. Write a `[hb]` heartbeat every turn carrying facts, never a verdict about your own liveness.
- **ACK every child callback in the turn you consume it.** Un-ACKed callbacks are the guardian's trigger.
- **A mid-run INJECT or SPLIT must write BOTH a plan row AND a queue row, atomically.** A prior run ended queue-25 vs plan-23.
- **A budget nothing enforces is not a budget.** Escalate on exhaustion; if a slice needs two mechanisms, **split it** rather than spend a 4th attempt.
- **Fixtures must be captured from reality.** A prior run passed 31/31 while Discovery was visibly broken, because a pane fixture was hand-authored cleaner than a real agent turn.
- **`plan/` is force-added to git for this effort.** Commit your artifacts.

## Escalation
Tier-3 (requirements / scope / contract / a standing-rule conflict) reaches **`helm-97`** one-way.
Everything else you settle with the panel per JROM's delegation. JROM is reached only on BLOCKED or
completion — he has been awake all night; do not page him for anything I can settle.

## Verification you can re-run
`python3 plan/planning-agreement-restructure/verify-waves.py` → asserts no two concurrent slices write
the same file. Currently **PASS**. If you ever change the wave grouping, it must still pass.
