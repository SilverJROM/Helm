# C9 — test report

## Gate command (per brief)

```
npx vitest run src/services/brief-writer-plan-ready-not-agreement-c9.test.ts
```

Result: **6/6 passed**.

- Does not contain the misleading `"plan agreed with"` literal, for `mode` unset, `'planner'`,
  or `'deliberation'`.
- Does not instruct plancore to gate its own PLAN-READY on whole-plan agreement (`"agreement
  holds"`, `"only after **whole-plan** co-planner agreement"`, `"force PLAN-READY past it"` all
  absent).
- States PLAN-READY means artifacts are ready for engine review, not agreement achieved
  (regex-matched proximity of "PLAN-READY" → "ready for engine review" → "not that agreement
  has been reached").
- States only the engine declares agreement and grants ingest permission (asserted at all
  three rewritten sites: scope, §5 job bullet, §7).
- The literal emitted callback note carries no agreement claim — exact-matches the new
  `STATUS: PLAN-READY — artifacts ready for engine review: og-requirements.md + plan.md
  written` line.
- Still preserves the og-requirements.md + plan.md write contract and the explicit
  `plan.json — DO NOT author` instruction (AC12's "do not tell it to author plan.json"
  requirement).

## Type check

```
npx tsc --noEmit -p tsconfig.json
```

Result: clean, no errors.

## B2 rerun (shared-file requirement)

C9 and B2 both touch `brief-writer-service.ts` (B2 edits `generatePanelBrief`, C9 edits
`generatePlanningBrief` — disjoint methods, but the brief requires a rerun since both land
in the same file before I-P2):

```
npx vitest run src/services/brief-writer-panel-plan-contract-b2.test.ts
```

Result: **2/2 passed** — unaffected, as expected (different method).

## Regression sweep (other tests calling `generatePlanningBrief`)

Ran every existing test file that calls `generatePlanningBrief` directly, to check for
collateral breakage from the wording rewrite:

```
npx vitest run \
  src/brief-writer-a12-split-brain.test.ts \
  src/services/brief-writer-focus-contract.test.ts \
  src/services/brief-writer-q11.test.ts \
  src/services/brief-writer-plan-schema.test.ts \
  src/services/dispatch-service.test.ts
```

Result: **5 files, 40/40 tests passed.** Notably `brief-writer-a12-split-brain.test.ts`
(A12/R1.7 split-brain closure) still passes — its required engine-capability markers
(`helm-algo spawns`, `whole-plan`, `planning_round_cap`, `PLAN-READY`, `og-requirements.md`,
`plan.md`, etc.) are all preserved in untouched text, and none of its forbidden split-brain
phrases were introduced.

Also grepped `src/**/*.test.ts` for hand-written fixture strings containing `"plan agreed
with"` (used to simulate an *already-arrived* plancore callback in orchestration tests, e.g.
`planning-phase-service.test.ts`, `run-orchestrator-service.test.ts`) — these are literal
fixture strings passed to `fs.appendFile`, not assertions against `generatePlanningBrief`'s
output, so they are unrelated to and unaffected by this change.

## Scope verification

`git status` shows `planning-phase-service.ts` and `plan-parser-service.ts` as modified and
`planning-review-round.ts` as untracked — those are pre-existing changes from concurrent
batches on this shared branch (present before this C9 session started; confirmed via
`git diff --stat -- src/services/brief-writer-service.ts`, which shows only the expected
5 insertions / 5 deletions for the four wording sites above). This C9 session did not edit
`planning-review-round.ts`, `planning-phase-service.ts`, `plan-parser-service.ts`, any
schema file, or `src/index.ts` — the only files this session changed/added are
`src/services/brief-writer-service.ts` and the new
`src/services/brief-writer-plan-ready-not-agreement-c9.test.ts`.
