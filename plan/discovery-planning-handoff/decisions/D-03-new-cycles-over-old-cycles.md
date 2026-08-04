# D-03 — New cycles are the bar; old cycles are not

**Decided by:** JROM, 2026-07-29 (21:0x PHT) · **Logged by:** `[north]` `helm-97`
**Status:** STANDING STEER — promotion candidate for the project north-star

---

## The decision

> "yes imgedit is a local project and is a throw away, well just fix it later via a new cycle. the goal
> is to get helm to be able to be useable for new cycle, old cycles matter less for me."

**Helm's correctness bar is the NEW-cycle path.** Backward compatibility for cycles created before a
change is explicitly NOT required. When the two conflict, the new path wins and the old cycle is
retired or re-created rather than special-cased.

## What this resolves immediately

**S13's provenance guard needs no grandfather clause.** `assertPlanningProvenanceForImplementation`
refuses any cycle with no provenance row (`if (!prov) return PLANNING_REQUIRED`). Cycle 10
`IMGEDT_Green` is mid-implementation with a `plan.md` and zero provenance, so a fresh Start
Implementation would refuse it.

Under D-03 that is **acceptable and by design**, not a defect. I deliberately did NOT auto-backfill a
provenance row: synthesising one would assert *"Planning agreed with a byte-matching plan and confirmed
seat manifest"* for a cycle that never went through Planning. That is exactly the lie the guard exists
to prevent — a backfill would have made the guard decorative on the first cycle that mattered.

**The three provenance-related test failures are stale fixtures**, not regressions: they construct
pre-AC28 cycles and are correctly refused. They should be updated to record provenance, tracked in
`../_backlog/R-reconcile-provenance-era-tests.md`.

## The corollary JROM asked for in the same breath

If old cycles do not matter, they must be **easy to clear out of the way** — otherwise they clutter the
switcher and the active list forever. Hence the Complete Cycle control (below), shipped the same night.

## Complete Cycle — shipped 2026-07-29 21:2x PHT

> "also if we can add, lets add an option to complete a given cycle so its not stay on the cylce list
> and be on the completed"

**The backend already existed and had NEVER been callable from the UI.** `POST /api/cycles/:id/complete`
(`index.ts:1992` → `cycleService.completeCycle`, B2-T04) moves `cycle/<name>` → `cycle/completed/<name>`
then sets `status='completed'`. Nothing in `app.js` referenced it — grep for the route returned **0**.
That is why cycles 11 `greenfield` and 12 `A8 two-seats` sat at `phase=complete, status=active` forever.

Added in `app.js`:
- `completeCycleAction(cycleId)` — confirm dialog naming the cycle, states the folder moves and that
  artifacts are kept; typed handling for 409 (destination collision, nothing overwritten).
- `Complete cycle` button in the workspace header (`data-testid="ws-complete-cycle"`), hidden once the
  cycle is already `completed`.
- Refreshes `loadCcOverview()` — the active list derives from `ccOvData`, so that is the store that must
  be re-read for the cycle to actually disappear.

**One guard added client-side that the server does not have:** the action refuses while a run is
active. `completeCycle` renames a live directory, so completing a running cycle would move the folder
out from under working agents. The server has no such check; this is enforced at its only caller.
**Server-side guard is the correct home for this** — tracked in
`../_backlog/R-complete-cycle-server-active-run-guard.md`.

## Related

- `D-02-S03-fail-closed-not-recover.md` — the same "refuse rather than fabricate" instinct
- Project north-star `SD10` (git/promote stays manual)
