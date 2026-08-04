# og-requirements — Planning agreement restructure

**Authored by** `[north]` `helm-97`, 2026-07-30 06:3x PHT
**Source of truth for scope:** `plan/_panels/planning-path-review/` — a 3-seat independent panel
(grok45 · sol · opus), **unanimous verdict `NEEDS-RESTRUCTURING`**, 1,042 lines of findings.
**JROM:** *"no i want to do them all but do them reliably and cleanly"*

---

## 1. Why this effort exists

Helm's planning phase has been fixed **four times** and failed four times. Each fix was correct. Each
was a change to an agent's **brief**. The panel's unanimous diagnosis explains the pattern in one line:

> **The phase shape is right; the protocol between phases is not enforced by anything.**
> Agreement is implemented as prompt instructions to cooperative agents, polled passively by the engine.

So every cooperative assumption — *partners wait, plancore revises, partners re-verdict, "round cap"
means rounds* — is discovered to be false only by burning a real run.

> grok45: *"Until (2)+(4)+(1) land, further brief-only fixes will keep producing 'fixed, proven on
> run N, died on run N+1.'"*

**The architectural fact that makes the fix tractable:** there is **no `transport.send`** in
`planning-phase-service.ts` — only `spawn`, `reap`, `inspectSeat`. `inspectSeat`/`resubmitIfComposerHeld`
is called **only for `brainRole`** (`:461`), never for a partner. A partner whose CLI turn has ended
**cannot be re-engaged by anything**. Therefore **a review round cannot reuse a seat — each round must
spawn a FRESH partner seat against the current plan hash.**

## 2. Evidence base — do not re-derive

| Artifact | What it proves |
|---|---|
| `data/runs/helm-run-3-rms6jr3eg/callbacks.md` | run 31: both partners verdicted BROKEN on **absent** artifacts; fail-fast blocked the run |
| `data/runs/helm-run-3-rms6l9kn5/callbacks.md` | run 32: convene-race fixed (partner polled + waited); died on a **legitimate** BROKEN with no way to converge |
| `plan/_archive/cycle13-run31-failed-*`, `cycle13-run32-failed-*` | the plans actually produced |
| `helm_sessions` row `helm-ibrain-memory_mcp` | `status=idle`, `last_used_at` = run 31's exact `ended_at` — **a failed planning run marked a live session reapable** |
| commit `8024452` | the convene-race fix — **PROVEN on run 32, must survive this effort untouched** |

## 3. Acceptance criteria

Marked **[DB]** need a database assertion; **[UI]** must be shown on the running app at
`http://127.0.0.1:3110` via `playwright.cap.config.ts` (never the default config — `:3111`, fake tmux,
scratch DB — screenshots from it are not evidence).

### P0 — Stop active corruption (independent, no design work)

Both defects corrupt state on **every** failed planning run **today**.

1. **[DB]** Planning-phase teardown terminalizes **only** a `worker_runtimes` row whose primary key is
   linked to **this run** and whose role is genuinely the implementation brain. `assertImplementationBrainComplete`
   (`run-orchestrator-service.ts:390-414`, `:492`) must not run when execution never started.
2. **[DB]** Teardown **never registers-if-missing**. `finalizeBrainSessionRow`
   (`worker-runtime-finalize.ts:168-260`) must not synthesize a runtime, and must never default
   provider/model to `unknown` to do so. Proven: ibrain row count is **unchanged** across a planning block.
3. **[DB]** Teardown **never** reconciles the global session registry **by inferred session name**
   (`worker-runtime-finalize.ts:48-67`). Persistent master-session liveness is separate from per-run
   worker completion. Proven: a live `helm-ibrain-<slug>` session is **not** marked `idle` by a failed
   planning run. *(This is the E5-class path — `session-reconcile-decision.ts:85-92` classifies an idle
   Helm session for reaping and `worker-service.ts:494-547` can terminate it.)*
4. **[DB]** A **failed** planning run does **not** set `cycles.phase='complete'`
   (`terminalizeCycleAtRunEnd`, `run-orchestrator-service.ts:616`), and does not stamp an immutable
   topology freeze. A failed planning cycle lands in a **retryable** state with no manual SQL.
5. **[DB]** Planning workers are **not** DB-finalized before transport cleanup — no leaked sessions that
   poison a retry (sol #4).

### P1 — Make failure honest before making it work (fail-closed)

**The gate is currently fail-OPEN.** This is the highest-severity defect the panel found and it must
land before any convergence work.

6. Every partner verdict callback carries the **SHA-256 of the exact `plan.md` bytes it reviewed**.
7. **[DB]** The agreement gate accepts **only** when every configured seat has a `CLEAN` **for the
   current plan hash**. A `CLEAN` on a superseded revision is **not** agreement.
   Proven by the panel's exact scenario: seat A CLEAN on R1 → plancore writes R2 → seat B CLEAN on R2 →
   the gate **refuses**, because A never reviewed R2.
8. Verdict parsing is **fail-closed on the stale side** — an unparseable or separator-mangled verdict is
   never treated as CLEAN (opus F9).
9. A non-convergence exit **returns** the mechanism-level blocked reason and never throws (opus F10).

### P2 — Engine-owned round machine (the restructuring)

10. `planning_round_cap` becomes **integer rounds**, not a wall-clock multiplier
    (`effectiveTimeoutMs = PLANNING_TIMEOUT_MS * roundCap`, `planning-phase-service.ts:368`).
11. The **engine** drives: artifact-ready → spawn reviewers → collect verdicts → if BROKEN and
    round < cap: instruct plancore to revise, **wait for a new plan hash**, **spawn FRESH reviewer
    seats** → else BLOCKED. Never "emit then hope".
12. **`PLAN-READY` is not agreement.** Only the engine may declare agreement or grant ingest permission.
    plancore must stop emitting `plan agreed with deliberation` before any verdict exists (run 32 did).
13. **Unique seat identity** on disk and in transport. Both partner seats currently share
    `role: deliberation`, colliding on their brief path — **this is why partner-2 has never once
    rendered a verdict in any run** (grok45 F3).
14. Partners are **told explicitly** where the canonical plan is. In both runs the partners **guessed**
    the path (opus F3).
15. Partner seats get a **first-callback / submit watchdog**, as `brainRole` already has
    (`waitForFirstCallback:731-836`) — a brief stuck in a partner's composer is currently never rescued
    (opus F4).
16. **[DB]** Plan ingestion is **transactional** — never a partially executable run (sol #14).

### P3 — Close the divergent paths

17. **One entry.** Confirmed handoff only for cycles that already have Discovery docs. **Delete
    rediscovery on Start Planning** — the legacy path re-authored JROM's `north-star.md` and
    `conversation-log.md` on both runs (opus F8, confirmed by bytes).
18. **[DB]** Provenance pins the **bytes actually ingested** after final agreement, and a mismatch is
    **fatal**, not advisory (C6 / sol #10).
19. **[DB]** Owner confirmation freezes the **discovery bytes** being approved, not only staffing (sol #8).
20. **[DB]** A confirmed handoff on an **autonomous** cycle does not create an `executing` run with no
    execution driver (sol #2).
21. Handoff acquisition/background-execution crash gaps cannot permanently wedge a `starting` handoff or
    leak planning workers (sol #9).
22. **Adaptive planning** (`adaptive_planning=1`) either shares these agreement semantics or is
    explicitly refused — today it is a second planner with weaker, incompatible semantics (sol #13).

### Regression gate — token-free tests (grok45 item 6)

23. Tests that burn **no model tokens**, covering each historical failure:
    convene-before-artifacts · BROKEN→revise→CLEAN · partner1 CLEAN + partner2 BROKEN ·
    partner-2 silent until timeout · legacy path refuses when north-star exists ·
    **ibrain row count unchanged on planning block** · stale-CLEAN rejected across revisions.

## 4. Ordering — non-negotiable

**P0 → P1 → P2 → P3.** P0 stops corruption happening now. **P1 makes the system safe while still
broken**; P2 makes it work. Reversing P1 and P2 means building convergence on top of a fail-open gate.

**Counterintuitive corollary, learned tonight:** the current fast-fail is *safer* than a half-fix.
Removing the fail-fast **alone** would trade an honest failure for a possible silent bad-plan ingest.
"Do nothing" beat "ship half" — and it will again.

## 5. Out of scope

- **Re-enabling `HELM_SESSION_JANITOR`.** It stays `0`. P0.3 is a precondition for ever reconsidering it.
- Merging to `main` — promote is JROM's call (**SD10**).
- The parked UI work: `R-planning-live-panes-side-by-side.md` shipped as `0a0c883`;
  `R-ui-font-size-control.md` and `R-last-sent-strip-invert.md` remain parked.
- Old-cycle compatibility — **D-03**: new cycles are the bar.

## 6. Hard safety rules

1. **`8024452` (convene-race fix) must survive.** It is proven on run 32. `grep -c
   planMdPathForRaceGuard src/services/planning-phase-service.ts` must stay `3`.
2. `app.js` is hand-written browser ESM, 560KB, **no build step** — `node --check` after any edit, then
   `npm run build` (the tree ships two copies).
3. Live DB is `data/helm.db`. Tests never touch it (`src/test-setup.ts` forces a temp path).
   Run vitest **file-by-file**; a bare full-suite run with extra pool flags hangs.
4. **Do not weaken the AC28 provenance guard** to make stale fixtures pass — see
   `plan/_backlog/R-reconcile-provenance-era-tests.md`.
5. Known pre-existing failures, leave unless touched: `pause-after-planning-gate` (3),
   `finish-planning-production` (1), `b25-fix1-orphan-model` (1), `model-service` (1), `smoke` (1).
6. Cycle 13 is JROM's test cycle. Do not mutate its data.
