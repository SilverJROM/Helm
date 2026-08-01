# S11 Independent Validation

Validator: L2 independent, verifier != fixer
HEAD: f2e0025066ed299fbc0248c6c83c486498855805
Brief: plan/discovery-planning-handoff/prompts/S11-val-brief.md
Verdict: PASS

## Scope Checked

- ACs 13-17, 24, 29-30 from the S11 validator brief.
- No implementation changes made.
- `HELM_SESSION_JANITOR=0` used for the targeted test run.
- No pm2 or live DB used.

## Evidence

### Targeted Tests

Command:

```bash
HELM_SESSION_JANITOR=0 npx vitest run src/s11-owner-bridge.test.ts
```

Result:

```text
Test Files  1 passed (1)
Tests       6 passed (6)
```

### TypeScript

Command:

```bash
npx tsc --noEmit
```

Result: PASS, exit 0.

## Acceptance Validation

- Owner confirm creates one durable planning run, records the run id on the handoff, and a double confirm returns the same run without a second S10 call.
- In-flight `starting` without `planning_run_id` is refused as `CAS_LOST`, with no second durable run and no S10 call.
- Concurrent confirm from `pending` yields exactly one run and one S10 call.
- Decline transitions the handoff to `declined`, starts no run, and permits a fresh pending handoff.
- Unauthenticated, non-owner, callback-token misuse, bodyless/direct `start-planning`, non-loopback confirm, bad expected digest, and tampered frozen manifest are refused.
- Source read confirmed `confirmDiscoveryHandoff` revalidates docs, phase, active run, frozen/live manifest digest, consumes by CAS `pending -> starting`, creates the durable run before S10, and returns the 202-ready result from the durable run path.
- Production route registration uses owner + loopback guards for confirm/decline, and `start-planning` rejects a live `pending` or `starting` handoff with `HANDOFF_CONFIRM_REQUIRED`.

## Residual Risk

This pass validates the targeted S11 owner bridge behavior and project typecheck only. It does not run the full test suite or exercise a live browser/DB environment, per brief constraints.
