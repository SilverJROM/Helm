# side-skill: atomic-task-rule

> Helm toolkit body. Attach to: projcore, coord. Distilled from `~/.claude` projcore §1.4c.

A task is **atomic** when it is a single vertical slice you can dispatch, gate, and verify in
one short sitting:
- Tight diff (one concern), ~1-3 tests, no sprawling cross-cutting edits.
- Verifiable by one gate run + one observation.

**95/5 rule:** ~95% of tasks fit the atomic window. The <5% exceptions are the rare full
end-to-end capstone or an unavoidably large module test — flag those explicitly.

**Split trigger:** if a non-test task can't be verified in one gate, it's too big — split it
into atomic slices before dispatch. A big task hidden as one item defeats the per-task gate
cadence (the whole point: a full gate lands every short interval, so drift is caught fast).
