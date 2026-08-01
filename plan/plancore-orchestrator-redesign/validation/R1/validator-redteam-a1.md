# Validator Red-Team R1 A1

Verdict: PASS
Commit reviewed: 6c0c2338d2a110806c5df4b836483df0d6495d9e
Req: R4.16

## Scope Check

- `src/services/planning-review-round.ts` no longer imports or derives canonical `og-requirements.md` for the C3 pre-spawn gate.
- The new `PublicationArtifactSpec` contract lets callers point the gate at seat-scoped draft or candidate paths.
- `validateExecutionPlan` is applied only when `validateAsPlan` is true, preserving requirements-side existence/non-empty checks.
- The empty/omitted `publicationArtifacts` mode is round-1 behavior: `runDir` plus optional `contextInputPaths`; it does not require canonical `plan.md` or `og-requirements.md`.
- `isFake` still exempts the gate.

## Adversarial Lenses

1. Canonical-path regression: no gate branch synthesizes or requires canonical `plan.md` / `og-requirements.md` before promotion. The focused tests explicitly prove missing canonical files do not block round 1 and canonical files alone do not satisfy a seat-draft gate.
2. Fail-open artifact readiness: missing, empty, and unparseable plan artifacts return `artifact-not-published`, `roundsAttempted: 0`, and spawn no seats. Requirements artifacts are checked for non-empty content.
3. Candidate/plan parsing: candidate and draft plan specs marked `validateAsPlan` go through `validateExecutionPlan`; malformed fenced JSON blocks before spawn.
4. Real/fake split: real-mode gate remains active; fixture `isFake: true` bypass remains covered.
5. Transition caller behavior: current production caller omits `publicationArtifacts`, which intentionally maps to round-1 mode for this slice. Later RR slices can pass draft/candidate descriptors without reintroducing canonical gating.

Focused tests passed: 14/14.
