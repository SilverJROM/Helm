# WAVE PLAN — the executable parallel decomposition

**By** `[north]` `helm-97`, 2026-07-30 08:0x PHT · derived from `plan.md` (35 slices) +
`PARALLEL-SAFETY.md` (6 collision surfaces) + three independent re-reviews.
**This supersedes `plan.md`'s dep column.** **SCOPE THIS RUN: P0+P1+P2+D12 = 24 slices** (D1-D11 deferred). Slice scope, ACs and tiers in `plan.md` are unchanged.

---

## Why the original dep chain was wrong

`plan.md` had **34 of 35 slices on a single-parent dep**. Most of those were **incidental sequencing,
not semantic dependency**. Example: `B1` (a brand-new pure module, `plan-revision.ts`) was made to
depend on `A6` — but it shares no file, no type and no behaviour with `A6`. It can start immediately.

Deps below are **derived from two things only**: (1) shared file, (2) genuine semantic ordering.

## Verified file ownership — derived from the slice text, not asserted

| slices | file | note |
|---|---|---|
| **10** | `planning-phase-service.ts` | A0 A5 A6 B3 B4 B5 B6 C2 D4 D11 — the serial host |
| **7** | `planning-review-round.ts` **(NEW)** | C2 C3 C4 C5 C6 C7 C8 — the round machine |
| 4 | `run-orchestrator-service.ts` | A1 A4 D1 D8 |
| 3 | `discovery-handoff-owner-bridge.ts` | D7 D9 D10 |
| 2 | `worker-runtime-finalize.ts` | A2 A3 |
| 2 | `brief-writer-service.ts` | B2 C9 |
| 1 each | `plan-revision.ts`(NEW) · `real-transport.ts` · `plan-parser-service.ts` · `planning-provenance-service.ts` · `discovery-handoff-ingress.ts` · `index.ts` · `app.js` · new sweep test | B1 C1 C10 D5 D6 D2 D3 D12 |

**`C2` is the only slice spanning two files** (it extracts from `planning-phase-service.ts` into the new
`planning-review-round.ts`). It therefore runs **alone**, with no concurrent writer to either file.

## Pre-allocated schema versions — C-1 fix

`SCHEMA_VERSION` is currently `112`. **These are owned constants. No seat may invent a version.**

| slice | version | use |
|---|---|---|
| **C10** | **v113** | only if transactional ingest needs new columns — **the only schema slice in this run** |

Deferred with P3, reserved so the follow-up effort does not collide: D6→`v114`, D8→`v115`, D9→`v116`.

`SCHEMA_VERSION`'s constant is bumped **once**, in `I-FINAL`, to the highest version actually used.
A slice needing a version it was not allocated **halts and asks `[north]`**.

---

## WAVE 0 — zero-collision work, 4 seats, nothing shared

| slice | file owned | why safe |
|---|---|---|
| **A0** | new test file only | pins `8024452`; adds a test, modifies no source |
| **B1** | `plan-revision.ts` **(NEW)** | pure, no importers yet |
| **C1** | `real-transport.ts` | unique-seat identity; no other slice touches it |
| **D12-skeleton** | new sweep test | index of the 7 failure modes, skipped until modes exist |

No shared file · no shared type · no schema. **Truly concurrent.**

## WAVE 1 — P0 safety, 3 disjoint chains

Each chain is serial *within itself* (same file, semantic ordering). The three chains share nothing.

| chain | slices | file |
|---|---|---|
| **E5-CHAIN (serial, one seat)** | A1 → A2 → A3 → A4 | `run-orchestrator-service.ts` + `worker-runtime-finalize.ts` |
| **PPS** | A5 → A6 | `planning-phase-service.ts` |

**A2→A3 is serial** (sol): A3 assumes A2's update-only identity on the same safety boundary.
**A5→A6 is serial**: A6 is the single terminal owner that A5's transport-first cleanup routes through.

> **REVISED 2026-07-30, JROM greenlit.** A1∥A2 was `[north]`'s judgement call; sol argued the whole
> A-chain serial. **Serial wins.** A1→A2→A3→A4 now runs as ONE chain on ONE seat. It saves ~25 min to
> parallelise and this is the exact path that already marked JROM's live session reapable. Cleverness
> here is not worth the risk. Only A5→A6 (a different file) runs alongside.

**`I-P0`** — integration: A1-A6 wired, ibrain-row-count-unchanged proof on a real planning block.

## WAVE 2 — P1 fail-closed gate, 1 serial chain + 1 concurrent side stream

| stream | slices | file |
|---|---|---|
| **PPS (serial)** | B3 → B4 → B5 → B6 | `planning-phase-service.ts` |
| BRIEF | B2 | `brief-writer-service.ts` |

*(PROV `D5` and INGRESS `D6` were here; both deferred with P3.)*

B2 is a *generated-contract* change consumed by the gate — it is additive, so it may build concurrently
and is adopted at `I-P1`.

**`I-P1`** — integration: **the fail-closed gate proof.** Seat A CLEAN on revision R1 → plancore writes
R2 → seat B CLEAN on R2 → **gate refuses**. This is the single most important proof in the effort.

## WAVE 3 — the round machine. Serial spine, side work hidden alongside.

**`C2` runs ALONE** (spans both files). Then:

| stream | slices | file |
|---|---|---|
| **ROUND (serial)** | C3 → C4 → C5 → C6 → C7 → C8 | `planning-review-round.ts` **(NEW)** |
| BRIEF | C9 | `brief-writer-service.ts` |
| INGEST | C10 **(v113)** | `plan-parser-service.ts` |

*(API `D2` and UI `D3` were here; both deferred with P3.)*

**Do not attempt to parallelise C3→C8.** grok45 and sol reached this independently; it is the
irreducible spine. The mitigation is structural, not scheduling: after `C2` the round machine lives in
its **own** file, so `planning-phase-service.ts` becomes a thin host and stops being contended.

**C8 is last of this wave, always.** Removing the honest fail-fast before C3–C7 exist and are green is
exactly the 04:00 PHT mistake.

**`I-P2`** — integration: BROKEN → revise → fresh seats → CLEAN converges, with `roundCap` as integer
rounds. Plus the three cross-cutting capstone tests (C-4 fix): `b9-gate-atomic`, `a15-worker-finalize`,
`cycle-terminal-on-run-complete`.

## WAVE 4 — P3 — **DEFERRED, NOT IN THIS RUN**

| chain | slices | file |
|---|---|---|
| **HANDOFF** | D7 → D9 **(v115)** → D10 | `discovery-handoff-owner-bridge.ts` — serial, same file |
| **RO** | D1 → D8 **(v114)** | `run-orchestrator-service.ts` — serial, same file |
| PPS | D4 → D11 | `planning-phase-service.ts` — serial, same file |

**DEFERRED by JROM 2026-07-30.** Scope for this run is **P0 + P1 + P2 + D12 = 24 slices**. D1-D11 move
to a follow-up effort: nothing in P0-P2 depends on them, they are the least dangerous third of the work,
and cutting them removes a third of the risk surface from what is already attempt three.

**D12 is KEPT** and moves into `I-P2`: its sweep names the seven historical failure modes, and all seven
live in P0-P2. It is the anti-recurrence enforcer, so it ships with the work it guards.

When D1-D11 are picked up, their ordering above still holds — sol: *acquisition, immutable-input
consumption and terminal cleanup must not be concurrently edited*, hence D7→D9→D10 serial.

## I-FINAL — the only place shared hosts are touched

1. **All `index.ts` wiring** (C-2 fix) — D2's guards, the provenance call site, handoff endpoints. One owner.
2. **The single `SCHEMA_VERSION` bump** to the highest allocated version actually used.
3. **Consumers adopt the additive fields** (C-3 fix) — e.g. RO reading `PlanningResult.acceptedPlan?`.
4. **D12 sweep activated** — fails if any of the 7 historical failure modes is unrepresented.
5. `npm run build` · `node --check src/web/public/app.js` · UI proof on `:3110` via `playwright.cap.config.ts`.

---

## Standing rules for every seat

1. **Never invent a schema version.** Unallocated → halt and ask `[north]`.
2. **Never edit `src/index.ts` in a build slice.** Wiring is `I-FINAL` only.
3. **Cross-stream type changes are ADDITIVE and OPTIONAL only.** Breaking → integration wave.
4. **Never edit a file another stream owns, even trivially.** Halt and ask.
5. **Your gate is your own new unit-test file.** The three capstone tests are integration-owned, not yours.
6. Ordering laws: **A0 first · P1 before P2 · C8 last of the round wave · A2→A3 and A5→A6 serial.**

## Unchanged safety rules

`HELM_SESSION_JANITOR` stays `0` · commit `8024452` must survive (`grep -c planMdPathForRaceGuard` == 3)
· no merge to `main` (SD10) · cycle 13 untouched · vitest file-by-file · never weaken the AC28
provenance guard.
