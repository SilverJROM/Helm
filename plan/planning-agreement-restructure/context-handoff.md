# Context Handoff

Effort `planning-agreement-restructure` on branch `fix/planning-agreement-restructure`, HEAD/base `e461468`.
Run directory is this plan folder. Lifecycle is `pre-live`; deferral is OFF except D1-D11, which JROM explicitly deferred out of this effort.

North-star: agreement is engine-established state, not an agent claim. Prior attempts failed because they changed briefs instead of code-level protocol.

Hard gates: no invented schema versions; no `src/index.ts` edits in build slices; cross-stream types additive/optional only; never edit another stream's file; each slice gate is its own new unit-test file.

Execution order follows `WAVE-PLAN.md`, superseding `plan.md` deps. Active scope is P0 A0-A6, P1 B1-B6, P2 C1-C10, plus D12. D1-D11 are deferred and must not be built.
