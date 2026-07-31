<!-- PROJCORE-STATUS-CONTRACT v2 -->
Batch C6: Fix local newest-verdict fail-closed regression

Batch ID: C6
Plan: /home/agjrom/websites/Helm/plan/planning-agreement-restructure/plan.md
Wave plan: /home/agjrom/websites/Helm/plan/planning-agreement-restructure/WAVE-PLAN.md
Branch: fix/planning-agreement-restructure
Requirements assigned: AC11
Lifecycle: pre-live - Deferral policy: OFF.

Estimated duration: SHORT - 18min
Convergence budget:
  max_fix_cycles: 3
  max_wallclock_min: 24
  token_budget: null
  progress_lease: 10min
  new_class_rounds_to_stall: 2
  on_burn: pull_in_coplanner_then_north

Effort tier: L3 / high. Implementer route: codex/sonnet/grok equivalent. Validator: codex55.

Context:
C6 implementation landed but is NOT VERIFIED. Coordinator validation found a local parser regression in `planning-review-round.ts`.

Scope:
Touch only `src/services/planning-review-round.ts`, `src/services/planning-review-round-c6.test.ts`, and C6 artifacts. Do not edit `planning-phase-service.ts`, `brief-writer-service.ts`, schema files, `src/index.ts`, or prior C2-C5 test files.

Defect:
`collectSameShaBrokenEvidence` scans callbacks newest-first, but if the newest raw verdict line for a seat is malformed/unparseable it currently skips it and can fall through to an older parseable `BROKEN`. That violates the B4 fail-closed invariant: each seat is bound to its newest verdict line; malformed newest evidence is not allowed to fall back to older evidence.

Required fix:
- In C6's local callback scan, lock each seat to its newest raw `VERDICT-READY` callback line for that round's `partnerBatchIds` even when the line is malformed/unparseable.
- Only use the newest line if it parses and is same-current-SHA `BROKEN`.
- Add a dedicated C6 test case: older same-SHA `BROKEN`, then newer malformed verdict for the same seat => no revise spawn.
- Remove the accidental duplicate `asynchronously; absence/truncation...` phrase in the C3 blockedReason string if present.
- Preserve the existing four C6 behaviours already tested.
- Rerun C6 own test, C2-C5 regates, raceguard grep, and tsc.

Plan handshake protocol:
1. Read this brief and source.
2. Emit PROPOSED with concrete fix plan.
3. Wait for APPROVED-PLAN before editing.
4. Emit DONE when green.

Streaming-order mandate: Your first tool call MUST be the callback helper below, BEFORE any prose tokens. The callback line template is: [projcore callback] <role> <batch-id> STATUS:

Callback emission:
PROJCORE_CALLBACKS_FILE=/home/agjrom/websites/Helm/plan/planning-agreement-restructure/callbacks.md \
  ~/.codex/skills/projcore/lib/projcore-emit-status.sh implementer C6 PROPOSED "read fix brief; proposing C6 newest-verdict parser fix"

implementer states: PROPOSED | REVISE-PLAN | WORKING | DONE | BLOCKED | NEEDS-INFO
validator states:   WORKING | REPRO-CONFIRMED | REPRO-FAILED | REPRO-CLEARED-ON-LOCAL | REPRO-STILL-PRESENT | BLOCKED | NEEDS-INFO
