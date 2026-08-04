# A0 changes.md — Pin the proven convene-before-artifacts fix

**Batch:** A0  
**Branch:** `fix/planning-agreement-restructure`  
**Commit pinned:** `8024452` (convene-race guard)  
**Requirement:** AC23 (convene-before-artifacts historical failure)  
**Scope:** test-only — no production source edits  

## Summary

Added one dedicated unit-test file that pins the `8024452` race guard so later PPS slices cannot silently delete `planMdPathForRaceGuard` or invert its semantics without a red suite.

## Mechanism under test

`waitForAgreement(..., planMdPathForRaceGuard?)` in `src/services/planning-phase-service.ts`:

- When any partner’s latest verdict is `BROKEN` **and** `planMdPathForRaceGuard` is set:
  - missing / empty `plan.md` (`fs.stat` size ≤ 0 or ENOENT) → **non-dispositive** (keep waiting; outer timeout still bounds)
  - non-empty `plan.md` → **dispositive** (`return false` fail-fast)
- Three live source references (param, call site ~L580, `fs.stat` body) must remain exactly **3**.

## Files changed

| Path | Action |
|------|--------|
| `src/a0-convene-race-regression.test.ts` | **ADD** — 5 token-free tests |
| `src/services/planning-phase-service.ts` | **UNTOUCHED** |
| any other `src/**` | **UNTOUCHED** |

## Tests added

1. **Absent plan.md + BROKEN** → does not fail-fast; burns outer timeout → `false`
2. **Present non-empty plan.md + BROKEN** → fail-fast `false` well under timeout
3. **Empty plan.md + BROKEN** → treated as absent (non-dispositive)
4. **Mid-wait plan.md appears** → same BROKEN becomes dispositive without a new verdict
5. **Source pin** → `(src.match(/planMdPathForRaceGuard/g) || []).length === 3`

## Commands run

```bash
HELM_DB_PATH=/tmp/helm-a0-$$.db npx vitest run src/a0-convene-race-regression.test.ts
grep -c planMdPathForRaceGuard src/services/planning-phase-service.ts
```

## Out of scope (intentionally)

- No extraction of race-guard logic into a new module
- No changes to partner brief text (already present from 8024452)
- No round-machine / fail-closed SHA gate work (later slices)
