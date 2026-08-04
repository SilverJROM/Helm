# R5 implementer — attempt 2 correction (signature grammar boundary)

2026-08-01 10:28 PHT (02:28 UTC)

## The validator's finding (the ONLY thing fixed here)

`[VERDICT-V1] ... verdict=FAIL defect_class=SIGNATURE_GRAMMAR_FAIL_OPEN gate=G6`
> `src/services/planning-review-round.ts:694` uses `SIGNED_RE = ... plan=([0-9a-f]{12})?` without an
> end-of-token boundary after the captured short SHA. `STATUS: SIGNED plan=<current12>XYZ` is accepted
> as `signed-agreed`. Expected `signed-mismatched`.

Confirmed as stated: the capture had no trailing anchor, so any claim that merely **started with** the
candidate's current short12 agreed — fail-open, the exact case R6.21 forbids.

## Mechanism of the fix

`SIGNED_RE` is now **identity-only** — it says "this line is a signature decision" and hands the
remainder of the line to a separate, doubly-anchored claim matcher:

```ts
const SIGNED_RE = /^\[(?:helm|projcore) callback\]\s+(\S+)\s+(\S+)\s+STATUS:\s+SIGNED\b(.*)$/;
const SIGNED_CLAIM_RE = /^\s+plan=([0-9a-f]{12})\s*$/;   // anchored at BOTH ends
```

`waitForCandidateSignature` extracts the claim with `SIGNED_CLAIM_RE` instead of reading the old
group 3. Anything that is not the bare grammar token yields **no claim**, and the existing
`agreed = !!candidatePlan && !!claimedShort12 && claimedShort12 === candidatePlan.short12` check then
resolves `signed-mismatched` — fail-closed. Splitting identification from the claim keeps the
attempt-1 behaviour that a malformed signature line is still *resolved* (bounded `signed-mismatched`),
never silently ignored into a timeout.

Nothing else changed: no new agreement path, no touch to `waitForAgreement`, `runProposerSignerRound`,
or the brief-writer grammar (which already emits the bare token and instructs STOP after it).

## Evidence — the real, unmocked code path

Every test drives the exported `waitForCandidateSignature` against a real temp run-dir, a real
callbacks file, and a real candidate written through `atomicWriteFile`. No mock, stub, or spy of the
function under test.

1. **Validator's probe, re-run verbatim** — `redteam-probe-a2.ts` / `redteam-probe-a2.txt`:
   `SIGNED plan=d81b83a40517XYZ` → **was** `{ok:true, kind:"signed-agreed"}`, **now**
   `{ok:true, kind:"signed-mismatched", claimedShort12:null}` (exit 0).
2. **Focused row tests** — `focused-vitest-a2.txt`: 2 files / **21 tests pass** (was 14). Seven new
   cases, all fail-closed except the last:
   - fused suffix `plan=<current12>XYZ` (the validator's line)
   - longer hex run `plan=<current12>ab` (all-hex — only an end anchor rejects it)
   - fused prefix `plan=ff<current12>`
   - token smuggling `plan=<current12>XYZ plan=<current12>` (a second, valid token must not rescue it)
   - uppercase `plan=<CURRENT12>`
   - trailing prose `plan=<current12> — looks good to me`
   - the instructed grammar with varied surrounding whitespace still **agrees** (no over-tightening)
3. **Neighbour regression** — `neighbor-vitest-a2.txt`: R3 proposer/signer + R4 alternation specs,
   19/19 pass; the exchange still reaches `agreed:true` on the real grammar.
4. `npm run typecheck` clean.

## Test commands run

```
npx vitest run src/services/planning-review-round-signature-gate.test.ts src/services/planning-phase-current-plan-sha-b5.test.ts --minWorkers=1 --maxWorkers=4     # 21/21 PASS
npx vitest run src/services/planning-review-round-proposer-signer.test.ts src/services/planning-review-round-alternation.test.ts --minWorkers=1 --maxWorkers=4     # 19/19 PASS
npx tsx plan/plancore-orchestrator-redesign/validation/R5/redteam-probe-a2.ts                                                                                      # exit 0
```
