# R — Autonomous planning start (Helm starts on Discovery's ask, no owner click)

**Filed by** `[north]` `helm-97`, 2026-07-29 · **Status: HELD — deliberately deferred, not rejected**
**Source:** JROM, 2026-07-29 · **Blocked on:** one clean manual run of `discovery-planning-handoff`

---

## The request

> "i can either start the planning manually **or** discovery can ask helm (algo) himself to start the
> planning but only helm can do it not discovery agent"

Two modes. The second — Helm starts planning off Discovery's ready callback with **no owner click** —
was deferred when JROM chose **"ok let make it manual for now."**

## Why it was deferred

See `../discovery-planning-handoff/decisions/D-01-planning-start-is-manual-confirm-only.md`.

Short version: `discovery-planning-handoff` exists because planning started without telling JROM. An
auto-start path shipped in that same change is **observationally identical to the bug** — both produce a
planning run he did not click — so the first test run could not tell a working gate from a repeat
bypass. Manual first establishes the baseline that makes the autonomous mode measurable.

## The invariant this must preserve

**Discovery may only ever request. Helm-algo actuates.** Autonomy changes *who confirms*, never *who
starts*. The discovery agent's callback credential must remain unable to reach the Planning starter
(current **AC29**), and rendered pane prose must remain inert (**AC11**). An autonomous mode that
weakens either of those is the original defect wearing a config flag.

## Design notes for whoever builds it

- **No existing switch fits.** `cycles.autonomy` is exactly
  `autonomous_after_discovery | pause_after_planning`, and `autonomous_after_discovery` already means
  *auto-start **implementation** when a valid plan exists and no run is active*
  (`src/services/cycle-auto-start.ts:76`). It governs a different transition. **Do not overload it** —
  one flag meaning two transitions is how the phase machinery got ambiguous in the first place.
  Add a third enum value or a separate per-cycle flag.
- **Additive, not a rewrite.** The confirm path stays as the default. The autonomous mode layers a
  loopback auto-confirm on top of the same S08 handoff record and the same CAS transition — it must
  consume a pending handoff through the identical code path, not a parallel shortcut.
- **Still one live handoff per cycle**, still credential-bound, still manifest-digest revalidated
  immediately before run creation (**AC24**).
- **Visibility is the point.** Even when Helm starts autonomously, the chat must show that it happened
  and why — an autonomous start that is silent recreates the complaint that opened this effort.

## Acceptance sketch (to be authored properly when unblocked)

1. A per-cycle setting selects manual-confirm (default) or autonomous start.
2. With autonomous ON, a valid ready callback creates the pending handoff **and** Helm consumes it via
   loopback, with the same validation as an owner confirm.
3. With autonomous OFF, behaviour is byte-identical to today's AC13.
4. The discovery credential still cannot reach the starter in **either** mode.
5. An autonomous start is visibly recorded in the chat and durably attributed to Helm, not Discovery.

## Related

- `R-discovery-handoff-confirm.md` — the originating manual-confirm request
- `R-configured-planners-must-be-used.md` — the staffing half of the same complaint
- `SOL-discovery-planning-bypass.md` — the diagnosis
