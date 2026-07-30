# test-report.md — Batch C1

**Gate file:** `src/services/real-transport-unique-seat-c1.test.ts`  
**Command:**

```bash
HELM_DB_PATH=/tmp/helm-c1-$$.db npx vitest run src/services/real-transport-unique-seat-c1.test.ts
```

**Result:** PASS — 9/9 tests, 1 file, ~16s wall (spawn stubs include real-transport ready delays)

## Cases

### Pure `resolveSpawnBriefFileName`

| # | Case | Result |
|---|------|--------|
| 1 | role only → `${role}.brief.md` | PASS |
| 2 | same role + distinct partner batchIds → distinct basenames; legacy shared path documented | PASS |
| 3 | seatId + round + attemptId + batchId composition | PASS |
| 4 | attemptId 0 omitted; round 0 → `r0` | PASS |
| 5 | briefFileName override + path sanitization | PASS |
| 6 | sanitizeBriefToken path-hostile strip | PASS |

### RealTransport spawn (stub tmux)

| # | Case | Result |
|---|------|--------|
| 7 | Two deliberation partners, distinct batchIds/seatIds → two brief files; bodies not clobbered | PASS |
| 8 | Bare role (no batchId) still writes legacy `prompts/plancore.brief.md` | PASS |
| 9 | Returned `role` stays external logical role; unique file exists on disk | PASS |

## Outcome

AC13 gate green. Concurrent same-role seats with distinct batch/seat identity cannot collide on the RealTransport brief path.
