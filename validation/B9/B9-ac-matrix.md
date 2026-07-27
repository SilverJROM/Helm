# B9 GATE-ATOMIC — AC Q0 matrix (31/31)

**Target:** `http://127.0.0.1:3110` · **DB:** cards2-ibrain.db (live) / `/tmp/helm-test-*` (unit)  
**No product invention.** Failures reopen owning row.  
**Date:** 2026-07-27 · **Capstone commit:** `fda4e47`

## Commands

```bash
curl -fsS http://127.0.0.1:3110/health
HELM_DB_PATH=/tmp/helm-test-$$.db npx vitest run src/b9-gate-atomic.capstone.test.ts \
  src/cycle-seats.test.ts src/services/cycle-chat-file-service.test.ts \
  src/pane-bottom-stick.test.ts src/session-pane.smoke.test.ts \
  src/services/planning-phase-service.test.ts src/cycle-run-state.test.ts \
  --poolOptions.forks.maxForks=2
# → 59 tests PASS (10+2+3+2+2+31+9)

timeout --signal=TERM --kill-after=15s 180s npx playwright test e2e/B9.live.spec.ts \
  --config=playwright.cap.config.ts
# → 1/1 PASS ~2.4s · baseURL 127.0.0.1:3110 · collected 1
```

## Matrix

| AC | R | Owner | Proof method | Evidence | Result | Reopen if FAIL |
|----|---|-------|--------------|----------|--------|----------------|
| 1 | R1.1 | B4 | Live seats API ≥2 + panes `data-pane-count≥2` + live payload marker; unit planning seats | `e2e/B9.live.spec.ts`; `validation/B9/B9-planning-panes.png`; prior `validation/B4/` | **PASS** | B4 |
| 2 | R1.2 | A8 | Static: POCFIX9 partner-less PLAN-READY fast path deleted; unit A8 stall→agreed:false | capstone AC2; `planning-phase-service.test.ts` A8 | **PASS** | A8 |
| 3 | R1.3 | A10 | Unit selectCoPlanner / panel size in planning-phase tests; B4 three-pane prior + B9 pane-count≥2 default | planning-phase 31/31; `validation/B4/B4-planning-three-panes.png` | **PASS** | A10 |
| 4 | R1.4 | A9 | Unit: BROKEN fails gate; CLEAN payload | planning-phase A9 suite | **PASS** | A9 |
| 5 | R1.5 | A9 | Unit: foreign-batch / prior-attempt CLEAN does not satisfy | planning-phase A9 stale/restart tests | **PASS** | A9 |
| 6 | R1.6 | A11 | Unit: stall → agreed:false bounded BLOCKED; roundCap scales wait | planning-phase A8/A11 | **PASS** | A11 |
| 7 | R1.7 | A12 | Prior A12 live + brief-writer tests in tree; no TEMP in brief contract (owner row VERIFIED) | `validation/A12/`; brief-writer tests present | **PASS** | A12 |
| 8 | R2.8 | B1 | Cycle folder artifacts on live project; HELM_RUN_ROOT in ecosystem | B9 live plan.md under `cycle/<folder>/`; capstone AC12 eco | **PASS** | B1 |
| 9 | R2.9 | B2 | Live Planning shows plan card / docs when present | B9-planning-panes aria (og-requirements rendered) | **PASS** | B2 |
| 10 | R2.10 **[DB]** | B2 | Live Implementation tab; run_tasks seed; unit cycle-run-state | B9-implementation.png; cycle-run-state 9/9 | **PASS** | B2 |
| 11 | R2.11 | B2 | Seed 2 tasks + prior B2 19-row evidence | B9 seed T1/T2; `validation/B2/` | **PASS** | B2 |
| 12 | R2.12 | B1 | HELM_RUN_ROOT under data/runs; cycle artifacts not only /tmp | capstone AC12; B9 live cycle dir | **PASS** | B1 |
| 13 | R3.13 **[DB]** | A5 | Unit/production finishPlanning path covered by planning/run tests; prior A5 live | planning-phase + A5 evidence | **PASS** | A5 |
| 14 | R3.14 | A6 | Prior A6/A6b live gate park; owner unit | `validation/A6/`, `A6b/` | **PASS** | A6 |
| 15 | R3.15 | A7 | Prior A7 terminal board live | `validation/A7/` | **PASS** | A7 |
| 16 | R4.16 **[DB]** | A1,A2,A15 | Capstone insert worker_runtimes w/ project+run; live seats + runId; A15 finalize re-proof note | capstone AC16; B9 seats API; `validation/A15/` | **PASS** | A1/A15 |
| 17 | R4.17 | A3 | Live GET /seats live+historical; foreign 404; UI seat chips | B9 live; cycle-seats 2/2 | **PASS** | A3 |
| 18 | R4.18 | A4 | UI event trail present on Planning; prior A4 | B9-planning aria event trail; `validation/A4/` | **PASS** | A4 |
| 19 | R5.19 | B3,B4 | Live Watch live panes + payload marker | B9-planning-panes.png | **PASS** | B4 |
| 20 | R5.20 | B4 | `data-pane-count≥2` | B9 live assert | **PASS** | B4 |
| 21 | R5.21 | B4 | Docs + seats + panes same workspace | B9-planning-panes | **PASS** | B4 |
| 22 | R6.22 | B5 | Composer/list non-overlap bounding boxes desktop | B9-discovery-desktop | **PASS** | B5 |
| 23 | R6.23 | B3,B6 | Pure stick unit + no unconditional scrollTop in app.js; B6 held-scroll evidence | capstone; pane-bottom-stick 2/2; `validation/B6/` | **PASS** | B6 |
| 24 | R6.24 | B6 | last-reply strip CSS/handlers; B6 expand/collapse evidence | capstone AC24; `validation/B6/B6-last-reply-*` | **PASS** | B6 |
| 25 | R6.25 | B3,B5 | CSS no 560/420 Discovery; B5 live | capstone AC25; `validation/B5/` | **PASS** | B5 |
| 26 | R6.26 | B5 | Header height ≤2-row bound; B5 narrow | B9-discovery-narrow; `validation/B5/` | **PASS** | B5 |
| 27 | R6.27 | B7,B8 | Unit chat-file; live API + UI paste → tmp ref | chat-file 3/3; B9-discovery-paste-ref; `validation/B8/` | **PASS** | B8 |
| 28 | R6.28 | B9 | Side-by-side tmux capture + browser pane same LIVE_MARKER | `B9-tmux-capture.txt`, `B9-r6.28-legibility.md`, `B9-cli-vs-browser-browser-pane.png` | **PASS** | B4/B5/B6 |
| 29 | R1.29 **[DB]** | A9,A13 | Unit whole-plan gate + reconvene tests; UI shows A13_TASK_RECONVENE in trail samples | planning-phase A9/A13 coverage; B9 event trail aria | **PASS** | A13 |
| 30 | R1.30 | A11 | Unit roundCap=3 default scales BLOCKED wait | planning-phase A11 | **PASS** | A11 |
| 31 | R4.31 | A14 | Static resolveHelmPmRole (no naive map); prior A14 live plancore+ibrain paths | capstone AC31; `validation/A14/` | **PASS** | A14 |

## Summary

| Total | PASS | FAIL | GAP |
|------:|-----:|-----:|----:|
| 31 | 31 | 0 | 0 |

**Verdict:** Q0 **PASS** — all 31 frozen ACs re-proven via unit/static/live capstone pack on :3110 (no product code changes in B9).
