# plan — planning-agreement-restructure

**Synthesized by** `[north]` `helm-97`, 2026-07-30 07:1x PHT from three independent planner outputs
(`plan-grok45.md` 23 slices/8h15 · `plan-opus5.md` 34/12h22 · `plan-sol.md` 30/12h12).
**Base:** `0a0c883` on `fix/planning-agreement-restructure`. **Contract:** `topology.yaml` (VALID).

## How this was synthesized — and what each planner contributed

**Spine: opus5.** It had the highest mechanism precision and, critically, the right *sequencing*
instinct: **removing the honest fail-fast comes LAST of the round core**, never first. That is exactly
the mistake `[north]` made at 04:00 PHT today.

**Grafted from sol:** the single-`try/finally` terminal-owner discipline (its P0-05/06, P3-09) and the
full normalize-then-transactionally-persist ingest (its P2-10). sol was the only planner to treat
teardown as one owner rather than patching each exit.

**Grafted from grok45:** scope cross-check. Its 8h15 estimate against the others' ~12h flagged where
they over-split; where all three agreed on a slice, it stays.

**Defects only opus5 found, now first-class slices:**
- `generatePanelBrief` passes `planPath: 'plan.json'` (`brief-writer-service.ts:444`) — **the wrong
  path**. This is *why* both runs' partners guessed where the plan was.
- `parseAgreementCallbackLine` (`:844-848`) accepts only `[—-]` — **a colon or en-dash yields no
  verdict at all**, silently.
- Both start-planning guards **fail open** (`src/index.ts:2917-2929`).
- `real-transport.ts:240-241` writes `prompts/${role}.brief.md` and both partners share `role` →
  **brief collision**, the mechanism behind partner-2 never once verdicting.

**Repairs applied to the sources:** opus5 emitted three column-shifted rows (its P0-2, P1-3a, P2-6) —
re-tabulated here. opus5 omitted **AC14**; sol's P2-04 covers it and is adopted.

## Ordering law

**P0 → P1 → P2 → P3, enforced through `deps`.** P0 stops corruption happening today. P1 makes the gate
**fail-CLOSED** — the system becomes *safe while still broken*. Only then does P2 make it *work*.
**A2 is deliberately the last slice of the P2 core:** the fail-fast is removed only once the round
machine that supersedes it exists.

| id | scope | acs | tests | est_min | deps | impl_tier | val_tier | deliberation | redteam | budget |
|---|---|---|---|---|---|---|---|---|---|---|
| A0 | **Pin the working fix before touching anything near it.** Token-free convene-before-artifacts regression over `planning-phase-service.ts:1026-1041`, asserting a BROKEN is non-dispositive while `plan.md` is absent and dispositive once present. Proves `8024452` survives every later slice. | 23 | 2 | 20 | none | L2 | L2 | no | budget | 25 |
| A1 | Capture pre-terminal run state (`runs.phase` + run_task count) **before** the blocked UPDATE at `run-orchestrator-service.ts:371-377`; skip `assertImplementationBrainComplete` (`:390-414`, `:492`) entirely when execution never started. | 1, 23 | 3 | 26 | A0 | L3 | L2 | yes | elite | 30 |
| A2 | `finalizeBrainSessionRow` (`worker-runtime-finalize.ts:168-260`) becomes **update-only**: require an existing non-terminal run-linked runtime; delete the register-if-missing insert and the `unknown` provider/model defaults. | 2, 23 | 3 | 24 | A1 | L3 | L2 | yes | elite | 30 |
| A3 | **E5-class.** `assertRegistryIdle` (`worker-runtime-finalize.ts:48-68`, called `:91-93`) joins `helm_sessions` on **name alone**. Bind it to the run-owned runtime id; a failed planning run must never mark a live `helm-ibrain-<slug>` idle. | 3, 23 | 3 | 28 | A2 | L3 | L2 | yes | elite | 32 |
| A4 | A run that failed **in planning** must not terminalize its cycle. Gate `terminalizeCycleAtRunEnd` (`run-orchestrator-service.ts:393`, impl `:601-620`) on genuine execution success; no `phase='complete'`, no topology freeze. Cycle lands retryable with no manual SQL. | 4 | 3 | 28 | A3 | L3 | L2 | yes | elite | 32 |
| A5 | Retain each seat's `spawned.handle` (`planning-phase-service.ts:454`, `:536-549` — discarded today) and `await transport.reap(handle, …)` **before** any DB finalize. Transport cleanup precedes terminalization; cleanup is idempotent. | 5, 23 | 3 | 28 | A4 | L3 | L2 | yes | elite | 32 |
| A6 | **One terminal owner** (sol). Route success, blocked and thrown planning exits through a single transport-first `try/finally`; delete the legacy single-brain-only cleanup asymmetry. No exit path bypasses A5. | 5 | 3 | 26 | A5 | L3 | L2 | yes | elite | 30 |
| B1 | New pure module `src/services/plan-revision.ts`: `planRevision(bytes) → {sha256, short12}` and `readPlanRevision(path)` returning either null or a revision. No I/O beyond one read. Pure, so it is cheap to test exhaustively. | 6 | 3 | 15 | A6 | L2 | L2 | no | elite | 20 |
| B2 | **The panel brief currently lies.** `generatePanelBrief` (`brief-writer-service.ts:431-470`) passes `planPath:'plan.json'` (`:444`) — not the canonical `plan.md`. Pass the **absolute** canonical `plan.md` + `og-requirements.md` paths and the expected SHA. Partners stop guessing. | 6, 14 | 3 | 22 | B1 | L2 | L2 | yes | elite | 26 |
| B3 | `parseAgreementCallbackLine` (`planning-phase-service.ts:844-848`) accepts only `[—-]`, so a **colon or en-dash yields no verdict** and the seat reads as silent. Widen the separator set and add the `plan=<sha12>` field to the verdict grammar. | 6, 8 | 3 | 20 | B2 | L2 | L2 | no | elite | 24 |
| B4 | **Fail-closed on the stale side.** At `:1010-1018` the `!verdicts.has(id)` + `if (verdictMatch)` pair walks *past* an unparseable newest line to an older parseable one. Take each seat's **newest** line and fail closed if it is malformed. | 8 | 3 | 26 | B3 | L3 | L2 | yes | elite | 30 |
| B5 | **THE FAIL-CLOSED GATE.** `:1041` accepts a bare enum with no binding to bytes. Store per-seat `{verdict, planSha}`; accept only when **every** configured seat is CLEAN **for the current** `plan.md` SHA. A CLEAN on a superseded revision is not agreement. | 7, 23 | 4 | 28 | B4 | L3 | L2 | yes | elite | 34 |
| B6 | Non-convergence must **return**, not throw (`waitForAgreement` false at `:580` falls into the plan read). Check non-agreement **before** canonical-plan polling and return one typed mechanism-level blocked reason. | 9 | 2 | 25 | B5 | L3 | L2 | yes | elite | 28 |
| C1 | **Unique seat identity.** `real-transport.ts:240-241` writes `prompts/${role}.brief.md` and both partners spawn with the same `role` → collision. Include attempt/round/seat id in the transport role and brief path. **This is why partner-2 has never verdicted.** | 13 | 3 | 22 | B6 | L2 | L2 | yes | elite | 26 |
| C2 | Behaviour-preserving refactor: extract the partner spawn loop (`:491-562`) + the single `waitForAgreement` call (`:580`) into one `runReviewRound()`. **No semantic change** — pure seam creation, so the next slices are reviewable. | 11 | 3 | 28 | C1 | L3 | L2 | no | elite | 32 |
| C3 | Engine **artifact-publication gate**: the current attempt's `plan.md` **and** `og-requirements.md` must both exist, be non-empty and parse before any reviewer is spawned. Removes the convene race structurally rather than by brief. | 11, 23 | 3 | 24 | C2 | L3 | L2 | yes | elite | 28 |
| C4 | `roundCap` becomes **rounds**. Delete `effectiveTimeoutMs = PLANNING_TIMEOUT_MS * roundCap` (`:368`); wrap `runReviewRound` in a bounded integer loop with a per-round deadline. | 10 | 3 | 26 | C3 | L3 | L2 | yes | elite | 30 |
| C5 | **Keystone.** Each round **reaps** the prior round's reviewer seats and **spawns fresh ones** with round-scoped batch ids. A seat's turn ends and there is no `transport.send`, so a round can never reuse a seat. | 11, 13 | 4 | 28 | C4 | L3 | L2 | yes | elite | 34 |
| C6 | **The revise actuator.** New `generatePlanRoundReviseBrief`; on a BROKEN round aggregate same-SHA defects, engine-spawn a fresh uniquely-named plancore revision turn, and **wait for a new plan hash** before re-review. | 11 | 3 | 28 | C5 | L3 | L2 | yes | elite | 34 |
| C7 | Generalize plancore's spawn / first-callback / submit watchdog (`waitForFirstCallback:731-836`) to **reviewer** seats, with bounded retry and a blocked reason naming the stuck seat. Today only `brainRole` is rescued. | 15, 23 | 3 | 28 | C6 | L2 | L2 | yes | elite | 32 |
| C8 | **Remove the honest fail-fast — deliberately LAST of the round core.** `waitForAgreement` returns a typed result; the BROKEN short-circuit is replaced by the round loop. Doing this before C3-C7 exist is exactly the 04:00 PHT mistake. | 11, 23 | 4 | 24 | C7 | L3 | L2 | yes | elite | 30 |
| C9 | `PLAN-READY` ≠ agreement. Rewrite `brief-writer-service.ts:288`, `:340` (§7) and the literal `plan agreed with deliberation` at `:345`. Only the **engine** declares agreement and grants ingest permission. | 12 | 3 | 26 | C8 | L2 | L2 | yes | elite | 30 |
| C10 | **Transactional ingest** (sol). `plan-parser-service.ts:169-197` inserts tasks one at a time, then the artifact row, then enqueues. Normalize + validate fully, then persist plan snapshot, tasks, deps and artifact metadata in **one transaction**. | 16 | 3 | 28 | C9 | L3 | L2 | yes | elite | 32 |
| D1 | **Delete rediscovery.** The legacy interview branch (`run-orchestrator-service.ts:1532-1566`) spawns a discovery seat and re-authors `north-star.md` / `conversation-log.md` — it overwrote JROM's docs on both runs. | 17, 23 | 3 | 26 | C10 | L2 | L2 | yes | standard | 30 |
| D2 | Both start-planning guards **fail open**: the handoff-store check (`src/index.ts:2917-2929`) and the active-run check. Make both fail closed; a cycle with Discovery docs may plan **only** from a confirmed frozen handoff. | 17 | 3 | 18 | D1 | L2 | L2 | no | standard | 22 |
| D3 | UI: `app.js` renders Start/Re-run Planning and calls a rerun "interview + planning". Reflect the single confirmed-handoff entry; remove the legacy action for cycles holding Discovery docs. | 17 | 2 | 22 | D2 | L1 | L2 | no | budget | 26 |
| D4 | `PlanningResult` (`planning-phase-service.ts:156-174`) exposes `planMdPath` but not the accepted bytes or digest. Carry the exact accepted in-memory plan buffer + SHA from agreement through ingestion. | 18 | 2 | 20 | D3 | L2 | L2 | no | standard | 24 |
| D5 | Provenance must pin what was **ingested**, fatally. `planning-provenance-service.ts:145-152` re-reads mutable `plan.md` **after** agreement and is non-fatal. Bind provenance to the accepted attempt/SHA; mismatch is fatal on both paths. | 18 | 3 | 26 | D4 | L2 | L2 | yes | standard | 30 |
| D6 | Freeze the discovery **bytes**, not just staffing. `discovery-handoff-ingress.ts:55-95` checks only presence/non-emptiness. Snapshot exact north-star + conversation-log bytes and SHA at handoff readiness. | 19 | 3 | 26 | D5 | L2 | L2 | yes | standard | 30 |
| D7 | Enforce the freeze. Owner confirm (`discovery-handoff-owner-bridge.ts:244-300`) and the planning read verify and consume the **frozen manifest bytes**, not later mutable files; mismatch rejects. | 19 | 3 | 24 | D6 | L2 | L2 | no | standard | 28 |
| D8 | Never persist `executing` without a driver. The confirmed path sets `phase='executing'` and returns; an autonomous confirmed handoff must install an execution driver **before** persisting that state. | 20 | 3 | 26 | D7 | L2 | L2 | yes | standard | 30 |
| D9 | Close the acquisition crash gap. `discovery-handoff-owner-bridge.ts:303-362` CASes `pending→starting`, creates the run, then links `planning_run_id` — make it one idempotent transaction so a crash cannot wedge `starting`. | 21 | 3 | 24 | D8 | L2 | L2 | yes | standard | 28 |
| D10 | The detached failure catch (`discovery-handoff-owner-bridge.ts:373-395`) hand-updates `runs` and leaks planning workers. Route the whole confirmed/background body through one `try/finally` terminal owner that reaps transports first. | 21 | 3 | 26 | D9 | L2 | L2 | yes | standard | 30 |
| D11 | `adaptive_planning=1` (`planning-phase-service.ts:338-344`) delegates wholesale to a second planner with weaker, incompatible agreement semantics. **Fail closed** before any seat spawn until it shares the common attempt/round contract. | 22 | 2 | 18 | D10 | L1 | L2 | no | standard | 22 |
| D12 | **AC23 completion sweep.** One `planning-regression-index.test.ts` naming all seven historical failure modes and **failing if any is unrepresented**. This is the anti-recurrence enforcer, not a formality. | 23 | 7 | 25 | D11 | L1 | L2 | no | standard | 30 |

## Totals

**35 slices · 870 min estimated (~14h30m).** Every slice ≤ 28 min. **23/23 ACs mapped, no orphans.**
Historical pace on this project runs ~2× estimate, so **plan for 24-30h wall-clock**, not 14.

## Tier rationale

P0 (A1-A6) and the gate (B4-B6, C3-C8, C10) run **impl L3 / val L2 minimum / elite red-team** — these
touch the E5-class session path and the agreement gate. Only A0, D3, D11 and D12 take L1. `deliberation`
is set where a design choice is genuinely open, not on mechanical slices.

## Standing rules for every slice

1. **`HELM_SESSION_JANITOR` stays `0`.** A3 is a precondition for ever reconsidering it.
2. **`8024452` must survive.** `grep -c planMdPathForRaceGuard src/services/planning-phase-service.ts` == `3`. A0 pins it.
3. **No merge to `main`** (SD10). **Cycle 13 untouched** — JROM's test cycle.
4. `app.js`: `node --check` after any edit, then `npm run build` (two copies ship).
5. UI proof on `:3110` via `playwright.cap.config.ts` only.
6. vitest **file-by-file**. Never weaken the AC28 provenance guard for stale fixtures.
