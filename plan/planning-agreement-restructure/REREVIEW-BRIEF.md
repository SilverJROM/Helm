# RE-REVIEW BRIEF — isolate-then-integrate, and parallelise

**From** `[north]` `helm-97`, 2026-07-30 07:2x PHT · **To** the three planner seats
**JROM:** *"i want each of the task unit tested before integrating them to the whole system so its much
faster… rereview if we can have some of this unit test/coding be done in parallel so that we can reduce
the total time"* · *"stop the projcore session and have the planners review this first, before starting"*

**Nothing has been implemented.** `src/` is clean at `0a0c883`; no coordinator or execution seat was ever
spawned. This re-review happens **before** any code is written.

## Read first

- `plan/planning-agreement-restructure/plan.md` — **my synthesis of your three plans.** 35 slices,
  859 min, 23/23 ACs, P0→P1→P2→P3 verified. This is what you are re-reviewing.
- Your own `plan-<yourmodel>.md`, plus `og-requirements.md`, `north-star.md`, `topology.yaml`.

## The problem with my synthesis — measured, not guessed

**34 of 35 slices have a single-parent dep. The chain is essentially SERIAL: 859 min ≈ 14h19m
wall-clock**, and this project historically runs ~2× estimate, so 24-30h real. That is the target.

**But naive parallelism will collide.** Slices concentrate on a few files:

| file | slices touching it |
|---|---|
| `planning-phase-service.ts` | **5** |
| `run-orchestrator-service.ts` | 3 |
| `discovery-handoff-owner-bridge.ts` | 3 |
| `brief-writer-service.ts` | 3 |
| `worker-runtime-finalize.ts` | 2 |
| `real-transport.ts` | 2 |
| `app.js` | 2 |

Two concurrent slices editing `planning-phase-service.ts` will conflict, and `app.js` is 560 KB
hand-written with **no build step** — a bad merge there blanks the page silently.

## REQUIREMENT 1 — every slice unit-tested in ISOLATION before integration

Each slice must be **provable on its own**, without the whole system green. Concretely, for every slice:

- Name the **isolated unit test** that proves it — pure function, or a seam with the dependency faked.
  It must **not** need a live run, a real seat, or `:3110`.
- State the **integration proof** separately, and mark it as deferrable to an integration wave.
- Prefer **extracting a pure function** so the logic is testable without the engine. `B1`
  (`plan-revision.ts`) is the model: pure, exhaustively testable, zero I/O.
- If a slice **cannot** be unit-tested in isolation, say so explicitly and explain why. Do not invent a
  test that needs the world.

**Why this speeds things up:** a slice gated by an isolated test does not wait for unrelated work, and a
failure localises to that slice instead of surfacing at integration.

## REQUIREMENT 2 — parallelise, with file ownership respected

Return a **wave structure**:

- **Wave 0**: slices with no dependencies that can start immediately, concurrently.
- **Wave N**: what unblocks once wave N-1 lands.
- For each wave, list slices AND the **files each slice owns exclusively**. **No two slices in the same
  wave may write the same file.** If two want the same file, either serialise them or split by function.
- Give the **critical path** — the longest dependency chain — and the revised wall-clock at your
  recommended concurrency.
- `topology.yaml` implies practical concurrency of ~3-4 execution seats. Do not assume unlimited.

**Be honest where parallelism is unsafe.** Ordering laws that must NOT be broken for speed:
1. **P1 (fail-closed gate) before P2 (convergence).** Never build convergence on a fail-open gate.
2. **C8 (remove the honest fail-fast) stays LAST of the P2 core.** Removing it before C3-C7 exist is
   exactly the mistake made at 04:00 PHT today.
3. **A0 first** — it pins commit `8024452` (proven on run 32) with a token-free test before anything
   touches code near the gate.
4. **A1→A6 order within P0** is semantic, not incidental: A6 is the single terminal owner that A5's
   transport-first cleanup routes through.

If you conclude a wave is genuinely unsafe to parallelise, **say so and keep it serial.** A wrong
parallelisation on the E5-class session path costs more than the hours it saves.

## REQUIREMENT 3 — the target SHAPE, not just fewer hours

JROM, verbatim: *"so that the main time is only for the separate unit tests and integrations hereby
reducing the total time to live"*

So the wall-clock must be dominated by exactly two things:

1. **BUILD waves** — slices coded **and unit-tested in isolation**, as many concurrent as file ownership
   allows. Cheap, parallel, independently gated.
2. **INTEGRATION waves** — a **small number** of explicit points where isolated work is wired together
   and proven end-to-end.

**Separate these two in your plan.** Do not fold integration into every slice — that is what makes the
chain serial today. A slice should land on its isolated unit test; integration is its own scheduled,
named wave with its own proof.

Design toward: **maximum parallel build, minimum serial integration.** If most of the 859 min can move
into 3-4 concurrent build streams and the serial remainder is a handful of integration waves, the
wall-clock collapses even though total effort does not change.

State plainly, per wave: `build_parallel_min` vs `integration_serial_min`, so the split is visible and
we can see where the remaining serial time actually goes.

## Deliverable

`plan/planning-agreement-restructure/rereview-<yourmodel>.md`

```
## VERDICT on the synthesis (adopt / adopt-with-changes / reject + why)

## WAVE PLAN — build waves and integration waves kept SEPARATE
BUILD wave 0: [slices] — files owned per slice — build_parallel_min
BUILD wave 1: ...
INTEGRATION wave I1: [what is wired + the end-to-end proof] — integration_serial_min
...
Critical path: <chain>
Wall-clock at 3 seats: <X>h   ·   at 4 seats: <X>h
Split: total build_parallel_min = <X>   total integration_serial_min = <X>

## PER-SLICE ISOLATED UNIT TEST
| slice | isolated unit test (no live run) | integration proof (deferrable) | extractable pure fn? |

## SLICES THAT CANNOT BE UNIT-TESTED IN ISOLATION (and why)

## WHERE PARALLELISM IS UNSAFE (and why serial wins)

## ANY SLICE I WOULD ADD, SPLIT, MERGE OR DROP
```

Work **alone**; do not read the other seats' re-reviews. End with `REREVIEW-DONE <yourmodel>`.
