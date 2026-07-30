# B2 — canonical panel-brief plan contract

## Root cause (mechanism)

`BriefWriterService.generatePanelBrief` (`src/services/brief-writer-service.ts`) hardcoded
`planPath: 'plan.json'` and `runDir: '.'` when building every panel/red-team/deliberation
seat brief, and named no `og-requirements.md` path and no plan revision at all. The base
template emits a literal `Plan: plan.json` line from that value. Partner seats spawned via
`panel-service.ts` (`conveneDeliberationPanel`, `conveneRedTeamPanel`) and
`planning-phase-service.ts` (whole-plan partner spawn + per-task reconvene) received this
false contract and had to guess where the real `plan.md`/`og-requirements.md` lived and
what revision they were meant to review — exactly the failure AC14 describes ("In both runs
the partners guessed the path"), and the gap AC6 requires closed ("Agreement is bound to the
exact plan revision reviewed").

## Fix

`src/services/brief-writer-service.ts`, `generatePanelBrief` only:

1. Added one new **optional** param `canonicalArtifactRoot?: string` to the method's params
   type. Additive-only — none of the four existing call sites pass it, so their behavior is
   otherwise unchanged; a future call-site update (out of B2 scope) can supply it directly
   for cycle-backed workspaces with no further change here.
2. Derive an absolute root: `params.canonicalArtifactRoot` →
   `path.dirname(params.callbacksFile)` → `params.projectDir` → `'.'`, then
   `path.resolve(...)`. Every current caller builds `callbacksFile` as
   `path.join(runDir, 'callbacks.md')`, and `planning-phase-service.ts`'s own
   `canonicalArtifactRoot` defaults to `runDir` when not explicitly overridden — so this
   recovers the true canonical root in the default (non-cycle-override) case without editing
   any caller.
3. `planMdPath = path.join(root, 'plan.md')`, `ogReqPath = path.join(root,
   'og-requirements.md')`. `planMdPath` is now passed as `generateBrief`'s `planPath` (kills
   the `Plan: plan.json` line at its source) and as `runDir`.
4. `revision = readPlanRevision(planMdPath)` — reuses B1's existing pure, non-throwing
   `plan-revision.ts` reader (no hashing logic duplicated).
5. New `## Canonical plan contract (AC6 / AC14 — do not guess the path)` block injected into
   the panel body, immediately after the seat/role intro line:
   - Always states the absolute `plan.md` and `og-requirements.md` paths.
   - If `revision` is present: states `sha256=<full>` and `short12=<12>`, and instructs the
     seat that its verdict is bound to that exact revision — a hash mismatch means stop and
     report, not review.
   - If `revision` is `null` (plan.md missing/unreadable at spawn time — the documented
     spawn-before-plancore-writes race): states `Expected plan revision: UNAVAILABLE` and an
     explicit `FAIL CLOSED` instruction not to emit a verdict until the plan is actually
     readable. This is the fail-closed text mandated by the brief: no bare CLEAN-able brief
     is emitted with an unbound revision.

No other `generate*Brief` method touched (`generateBrainBrief` / `generatePlanReviseBrief`
still use `'plan.json'` — out of B2's scope per the plan row). No schema version invented.
No changes to `planning-phase-service.ts`, `src/index.ts`, or any schema file, and no
importer call site edited.

## Files changed

- `src/services/brief-writer-service.ts` (edited)
- `src/services/brief-writer-panel-plan-contract-b2.test.ts` (new — gate)

PLAN-CONTRADICTION: none.
