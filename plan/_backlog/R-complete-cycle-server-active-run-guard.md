# R — Complete Cycle needs a SERVER-side active-run guard

**Filed by** `[north]` `helm-97`, 2026-07-29 · **Status: OPEN** · **Severity: real, currently mitigated in UI only**

`POST /api/cycles/:id/complete` (`src/index.ts:1992` → `CycleService.completeCycle`) **renames a live
directory**: `cycle/<name>` → `cycle/completed/<name>`, then sets `status='completed'`.

It has good guards — owner auth, path fencing under `project.directory`, move-before-status with
rollback, 409 on collision without overwrite. **It has no guard against an ACTIVE RUN.** Completing a
running cycle moves the working folder out from under live implementer/validator agents mid-write.

Mitigated today in `app.js` `completeCycleAction()`, which refuses when `ccRunState[cycleId].runActive`.
That is the only caller, so the hole is closed in practice — but a UI-only guard is the wrong home for
a filesystem-safety invariant. Any future caller (script, another surface, a retry) bypasses it.

**Fix:** enforce in `completeCycle` itself — refuse with a typed `CONFLICT` when the cycle has an active
run, before the `fs.rename`. Mirror the existing 409 shape so the UI needs no change.

Related: `../discovery-planning-handoff/decisions/D-03-new-cycles-over-old-cycles.md`
