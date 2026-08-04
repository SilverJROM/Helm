# test-report.md — B1

## Command

```bash
HELM_DB_PATH=/tmp/helm-b1-$$.db npx vitest run src/services/plan-revision-b1.test.ts
```

## Result

```
✓ src/services/plan-revision-b1.test.ts (10 tests) 6ms

Test Files  1 passed (1)
     Tests  10 passed (10)
```

**Exit code:** 0  
**Duration:** ~150ms  
**Date:** 2026-07-30

## Coverage of acceptance criteria

| AC / criterion | Evidence |
|----------------|----------|
| `planRevision(bytes) → { sha256, short12 }` | tests: known fixture, string/Buffer parity, deterministic |
| SHA-256 (64 hex) | assert `/^[a-f0-9]{64}$/` + independent `createHash` cross-check |
| `short12` = first 12 hex of `sha256` | dedicated test + empty-digest fixture |
| Different bytes → different digests | explicit inequality test |
| `readPlanRevision` absent → null | missing path test |
| `readPlanRevision` unreadable → null | directory path test |
| `readPlanRevision` existing → same as hashing bytes | temp `plan.md` round-trip |
| Empty bytes well-formed | NIST empty SHA-256 `e3b0c442…` |

## Out of gate (intentionally not run)

Full suite, e2e, production importers — out of B1 scope.
