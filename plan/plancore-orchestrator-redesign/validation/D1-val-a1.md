# D1 validator evidence - attempt 1

Scope: validate `src/services/seat-draft-store.ts` against R2.5 and R2.7.

Focused test command run exactly:

```sh
npx vitest run src/services/seat-draft-store.test.ts --minWorkers=1 --maxWorkers=4
```

Result: PASS.

Observed output summary:

```text
src/services/seat-draft-store.test.ts (13 tests) passed
Test Files 1 passed (1)
Tests 13 passed (13)
```

Red-team standard pass:

- Lens 1 path contract: draft helpers produce seat-scoped `draft-<seat>.md` and `draft-<seat>-req.md`; candidate helpers produce shared `candidate-plan.md` and `candidate-req.md`.
- Lens 2 canonical artifact separation: module exports only draft/candidate helpers, `atomicWriteFile`, and `hashDraft`; no canonical `plan.md` or `og-requirements.md` promotion helper is present.
- Lens 3 atomic publish semantics: write uses a temp sibling in the target directory, then `renameSync`; parent directories are created and failed writes attempt temp cleanup.
- Lens 4 hash trust boundary: `hashDraft` delegates to `readPlanRevision`, recomputing from disk and not accepting callback-claimed hashes.

Verdict: PASS for R2.5,R2.7.
