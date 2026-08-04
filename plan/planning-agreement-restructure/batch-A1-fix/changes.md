# A1 fix-cycle changes.md

Date: 2026-07-30

## Scope

Fix A1 false green only.

Files changed:
- `src/services/run-orchestrator-service.ts`

Files intentionally not changed:
- `src/services/run-orchestrator-planning-terminal-a1.test.ts`
- `src/services/worker-runtime-finalize.ts`
- `src/index.ts`
- schema files

## Mechanism

A1's own regression tests proved the pre-terminal `executionStarted` predicate was not enough by itself. The executing-failure paths still called `assertImplementationBrainComplete`, but after A2 made `finalizeBrainSessionRow` update-only there was no run-linked ibrain row for the finalizer to transition.

The fix keeps `finalizeBrainSessionRow` update-only. At the true terminal assertion boundary, `assertImplementationBrainComplete` now:
- resolves the concrete ibrain `provider` and `model` from explicit args or the existing project role binding;
- creates one real non-terminal run-linked `worker_runtimes` row for the named ibrain session only when no row exists;
- then calls the update-only finalizer to transition that row.

Planning-only paths still skip `assertImplementationBrainComplete` entirely, so they create no ibrain row.

## Gate Defect

A1 was green when first verified. A2 later changed the brain finalizer contract to update-only, which invalidated A1's own regression file. I marked P0 ready without rerunning A1's slice-owned test after A2/A4 landed. That was the gate defect. Future boundary checks must rerun every affected prior slice-owned gate, not only the latest slice's own file.
