# D3 validator evidence - attempt 1

Scope: validate `src/services/proposer-role.ts` against R3.9 and R3.12.

Verifier != fixer: no product code was written by this seat.

Focused test command run exactly:

```sh
npx vitest run src/services/proposer-role.test.ts --minWorkers=1 --maxWorkers=4
```

Result: PASS.

Observed output summary:

```text
src/services/proposer-role.test.ts (13 tests) passed
Test Files 1 passed (1)
Tests 13 passed (13)
```

Full transcript: `validation/D3/vitest-proposer-role-a1.txt`.

## AC verification

R3.9: deterministic proposer designation and auditable log.

- `designateRound2Proposer` compares `shaA` and `shaB` directly as full hash strings, not their short12 prefixes.
- Equal full hashes break ties by lexicographically lower `seatId`.
- The tests pin lower-hash wins, label swapping, equal-hash tie break, and same-first-12-different-rest behavior.
- `formatProposerLog` includes both seats, both full shas, the selected proposer, and rule name `lower-sha256-of-round1-drafts`.

R3.12: proposer role alternates every round.

- `rolesForRound(2, ...)` returns the designated round-2 proposer and the other seat as signer.
- Round 3 swaps proposer/signer.
- Round 4 swaps again back to the designated proposer.
- Tests cover designated seat A, designated seat B, invalid round 1, invalid designated seat, and a 3-round trace that rejects one-seat-holds-the-pen behavior.

## Red-team adversarial pass - elite tier

Lenses: full-hash integrity, slot-order bias, tie determinism, alternation drift, audit completeness, purity/scope.

- Full-hash integrity: the implementation never slices hashes; the short12 collision test forces a decision from characters after position 12.
- Slot-order bias: lower hash follows the seat holding that hash after A/B labels are swapped.
- Tie determinism: equal full shas select the lexicographically lower seat id independent of A/B position.
- Alternation drift: formula `(round - 2) % 2` yields round 2 designated, round 3 other, round 4 designated; invalid round 1 is rejected.
- Audit completeness: log contains the rule constant, both sha fields, both seat ids, and proposer.
- Purity/scope: module exports only pure helpers/constants and imports no filesystem, path, process, database, or transport APIs.

Residual note: the helper assumes callers provide lowercase full SHA-256 strings as specified by the D3 contract; it does not validate hex length or casing. That is not a D3 failure because the row defines the inputs as lower full sha256 and asks for comparison behavior, documentation, logging, and tests.

Verdict: PASS for R3.9,R3.12.
