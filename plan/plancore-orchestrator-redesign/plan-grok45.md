# plan-grok45 — plancore-orchestrator-redesign

**Seat:** grok45 (effort planning team A) · **Authored** 2026-08-01 · **Implements nothing**
**Against:** `og-requirements.md` **v2** (25 ACs, R1–R7) · `north-star.md` · `SYNTHESIS.md` · `topology.yaml` rev1
**Base:** `93d7cd7` (`planning-agreement-restructure` I-P2, deployed; not on `main`)
**Contract:** asymmetric candidate + signature, alternating proposer/signer. **No symmetric dual-authorship.**

---

## 1. What this plan is redesigning (mechanism, not aspiration)

Today’s non-adaptive path (`planning-phase-service.ts:355–578`):

1. Engine spawns **plancore** with `generatePlanningBrief` (`brief-writer-service.ts:268–351`, call site `planning-phase-service.ts:433`) → plancore authors **canonical** `plan.md` + `og-requirements.md` → emits `PLAN-READY`.
2. `runReviewRound` (`planning-review-round.ts:435`) **C3-gates** on those canonical paths (`checkArtifactsPublished` `:175–216`, invoke `:451–464`).
3. Co-planners spawn as **reviewers** via `generatePanelBrief` (`:511`) → `VERDICT-READY CLEAN|BROKEN plan=<sha12>`.
4. `waitForAgreement` (`planning-phase-service.ts:1010–1116`) requires brain `PLAN-READY` **plus** every partner CLEAN bound to current plan bytes (B5).
5. On same-plan BROKEN, **C6** spawns **plancore** again (`generatePlanRoundReviseBrief` local at `planning-review-round.ts:311–354`, spawn `:691–726`) to rewrite `plan.md`.

**Target (v2):** engine never spawns a model seat named plancore for whole-plan authoring. Co-planners draft blind → on divergence one **proposes** a single candidate, the other **signs** (or objects) → engine alone promotes to canonical paths. Proposer role **alternates** each round. Mid-implementation `generateBrainBrief` (`brief-writer-service.ts:496–558`, caller `orchestrator-loop.ts:2541`) is **untouched**.

---

## 2. Citation audit (verified against current source 2026-08-01)

| Claim in og-requirements / north-star | Current truth | Plan action |
|---|---|---|
| `generatePlanningBrief` `:268–350` | **`:268–351`** (closes at 351) | Delete in **B4**; treat range as 268–351 |
| `generatePanelBrief` `:433–480` | **`:433–493`** | Re-shape in **B1–B3** |
| `generateBrainBrief` mid-impl at `:495–524` / wrong v1 cite `:523` | Function **`:496–558`**; “Wakes plancore…” text at **`:523`** is **inside** brain brief body (correct that it is *not* whole-plan revise) | **Do not edit** this function |
| Whole-plan revise brief/spawn `:311` / `:692` | Brief **`:311–354`**; spawn **`:691–726`** (reviseBatchId line 691; spawn 702) | Re-point/remove in **RR8** |
| `PLANCORE-DID-NOT-PRODUCE-CANONICAL-PLAN` `:689` | **`:689–690`** exact | Rename in **P2** |
| `adaptive_planning` early return `:355–365` | **`:356–365`** | Pin only in **P4** / **S0** — do not redesign |
| `planMdPathForRaceGuard` count == 3 in PPS | Confirmed **3** (`:1021`, `:1079`, `:1081`); pinned by `a0-convene-race-regression.test.ts:165` | **S0** re-pins; no PPS slice may change that count |
| Seat-scoped `draft-<seatId>.md` | **Does not exist** yet | Greenfield in **D1/D2** |
| `DRAFT-SUBMITTED` / `CANDIDATE-SUBMITTED` | **Absent** from engine | Introduced in **RR2/RR5** + brief purposes |
| Module header of `planning-review-round.ts` says it “never reads plan.md” | **Stale** — C3 reads both artifacts | Do not trust header; re-scope C3 in **RR1** |
| `generatePanelBrief` caller list | **5 production sites:** `planning-review-round.ts:511`, `planning-phase-service.ts:952` (reconvene), `panel-service.ts:63` (delib), `:123` (red-team), + planning path via review-round only for whole-plan | **B1** re-verifies at implement time (R5.17 mandate) |

---

## 3. File ownership (serial vs independent)

Same lesson as `planning-agreement-restructure/WAVE-PLAN.md`: **deps = shared file + genuine semantic order only.**

| Stream | File(s) owned | Slices | Parallelism |
|---|---|---|---|
| **PIN** | new pin test only | S0 | free with everything that does not edit PPS safety lines |
| **DRAFT** | `src/services/seat-draft-store.ts` **NEW** | D1 → D2 | serial within; free vs BRIEF/ROUND until ROUND imports |
| **ROLE** | `src/services/proposer-role.ts` **NEW** | D3 | free until ROUND imports |
| **BRIEF** | `src/services/brief-writer-service.ts` | B1 → B2 → B3 → B4 | **serial on this file only** |
| **ROUND** | `src/services/planning-review-round.ts` | RR1 → … → RR8 | **serial spine** — do not parallelize |
| **PPS** | `src/services/planning-phase-service.ts` | P1 → P2 → P3 → P4 | **serial**; start after B4+RR2 exist enough to not leave a hole |
| **SWEEP** | `src/planning-regression-index.test.ts` (+ pointers into mechanism tests) | X1 | last; consumes registrations from prior slices |

**Collision notes:**

- **B1** must touch call sites in `planning-review-round.ts`, `planning-phase-service.ts`, `panel-service.ts` for the required `purpose` argument — those are **one-line purpose literals only** in non-BRIEF files; ROUND/PPS streams must not rewrite those call sites in the same window as B1. Order: **B1 lands first** (purpose plumbing), then ROUND/PPS own deeper rewrites.
- **P1** removes plancore spawn that today sits **before** `runReviewRound` (`planning-phase-service.ts:480–528`). It **depends** on RR2 being able to produce drafts without a pre-existing canonical plan — else every real run blocks at C3. Order: **RR1 (re-scope gate) + RR2 (blind draft) before or with P1**.
- **P3** rewires `waitForAgreement` (PPS-owned, tested by B3/B4/B5 suites). ROUND injects the bound callback — signature semantics must land in **P3** with ROUND using the new contract in **RR5**. Prefer: **P3 before RR5**, or RR5 lands a local `waitForSignature` and P3 deletes PLAN-READY requirement in the same integration window. **This plan chooses a ROUND-local `waitForCandidateSignature`** so B5’s existing `waitForAgreement` tests stay green until P3 retires the brain PLAN-READY half of the old gate for the non-adaptive path only.
- **Never** edit `worker-runtime-finalize.ts`, terminal-owner structure beyond reusing existing `runPlanningTerminal` (`:472–477`), or E5 session-registry path (R6.22).
- **Do not** change `planMdPathForRaceGuard` occurrence count in PPS.

---

## 4. Ordering law

```
S0 (pins)
  ├─ D1 → D2          (draft store)
  ├─ D3               (proposer pure)
  └─ B1 → B2 → B3 → B4  (briefs; B4 = delete generatePlanningBrief — R1 early signal)

After B2 + D1 + D3 available:
  RR1 → RR2 → RR3 → RR4 → RR5 → RR6 → RR7 → RR8   (round spine, serial)

After RR2 (drafts exist without plancore):
  P1 → P2 → P3 → P4

After all mechanism slices have active tests registered:
  X1 (regression sweep rewrite — fails closed on any remaining skip)

I-FINAL (not a coded slice here): npm run build; no main merge; HELM_SESSION_JANITOR stays 0
```

**Why R1 (B4) is early but not first:** schema/task-JSON instructions currently live **only** inside `generatePlanningBrief` (`:308–328`). Deleting before **B2** moves that contract into `plan-draft` / `plan-reconcile` briefs orphans the format (SYNTHESIS finding #2). B1→B2→B3→B4 is the minimum chain that makes deletion a real structural signal rather than a silent schema loss.

---

## 5. Slice table

Every `tests` cell is a **literal** command Tiller can run. Every non-test slice `est_min` < 30.  
`impl_tier` ∈ {L1=spark, L2=grok45, L3=sonnet5}; `val_tier` ∈ {L1/L2=codex55, L3=opus5} — **empty intersection with implementers** at every row (verifier ≠ fixer holds).

| id | scope | acs | tests | est_min | deps | impl_tier | val_tier | deliberation | redteam | budget |
|---|---|---|---|---|---|---|---|---|---|---|
| S0 | **Safety pins before any redesign edit.** Token-free assertions: (1) `grep -c planMdPathForRaceGuard src/services/planning-phase-service.ts` == 3 (8024452 / A0 survival); (2) `HELM_SESSION_JANITOR` is not enabled in project defaults / stays `0` wherever this repo pins it; (3) `generateBrainBrief` still exists at `brief-writer-service.ts:496` and still contains the Phase-C “Wakes plancore to surgically revise THIS slice” line (~`:523`) — **presence pin, not edit**; (4) no new production import of `worker-runtime-finalize.ts` from new modules. New test file only — no production edits. | R6.20,R6.22,R6.23,R1.3 | `npx vitest run src/services/plancore-redesign-safety-pins.test.ts --minWorkers=1 --maxWorkers=4` | 18 | none | L1 | L1 | no | budget | 22 |
| D1 | **NEW pure-ish module** `src/services/seat-draft-store.ts`: path helpers `draftPlanPath(runDir, seatId)`, `draftReqPath(runDir, seatId)`, `candidatePlanPath(runDir)`, `candidateReqPath(runDir)`; `atomicWriteFile(path, bytes)` = write temp sibling + `rename` (R2.7); `hashDraft(path)` reuses `readPlanRevision` from `plan-revision.ts:35` (engine recomputes; never trusts callback claim). Canonical `plan.md` / `og-requirements.md` helpers **not** written here — promotion stays engine-side in P2. | R2.5,R2.7 | `npx vitest run src/services/seat-draft-store.test.ts --minWorkers=1 --maxWorkers=4` | 22 | S0 | L2 | L1 | no | standard | 26 |
| D2 | **Blind isolation at storage layer** (R2.6): seat-private directory or allowlist such that a co-drafting seat cannot `read`/`list` the other seat’s draft paths until the engine marks round-1 committed. Enforce in the store API used by tests + by ROUND when wiring `strictReadAllow` / fence lists — not “hope the brief omits the path.” Test: open round-1 window for seat A, attempt cross-seat read/list of seat B → assert denial; after engine `publishDraft(seatId)` both hashes readable by engine. | R2.6 | `npx vitest run src/services/seat-draft-store-isolation.test.ts --minWorkers=1 --maxWorkers=4` | 26 | D1 | L2 | L2 | yes | elite | 30 |
| D3 | **NEW pure** `src/services/proposer-role.ts`: `designateRound2Proposer({seatA, shaA, seatB, shaB})` → lower full `sha256` (not short12) wins proposer for round 2; tie-break: lexicographically lower `seatId` (document + test). `rolesForRound(round, round2ProposerSeat, seatA, seatB)` → round 2 as designated; round 3 **swaps**; round 4 swaps again. `formatProposerLog(...)` returns auditable string including both shas + rule name `lower-sha256-of-round1-drafts`. No I/O. | R3.9,R3.12 | `npx vitest run src/services/proposer-role.test.ts --minWorkers=1 --maxWorkers=4` | 20 | S0 | L2 | L1 | no | elite | 24 |
| B1 | **`generatePanelBrief` gains required exhaustive `purpose` with no default** (`brief-writer-service.ts:433`). Union at minimum: plan-draft, plan-reconcile, plan-signature, task-conflict-reconvene, diff-review. **Re-verify callers at implement time** (R5.17): today `planning-review-round.ts:511`, `planning-phase-service.ts:952`, `panel-service.ts:63`, `panel-service.ts:123`. Migrate reconvene→task-conflict-reconvene and both panel-service sites→diff-review (bodies unchanged). ROUND temporarily uses diff-review (empty implementedDiff) so current verdict text survives until RR2/B3. Typecheck must fail if a caller omits purpose. | R5.17,R5.18,R5.19 | `npx vitest run src/services/brief-writer-panel-purpose-b1.test.ts src/services/brief-writer-panel-plan-contract-b2.test.ts --minWorkers=1 --maxWorkers=4` | 28 | S0 | L2 | L2 | yes | elite | 32 |
| B2 | **Purpose `plan-draft`:** move the **schema / R-XX / task-JSON contract** currently living in `generatePlanningBrief` (`brief-writer-service.ts:308–328`, also og-requirements order `:308–312`) into the draft brief. Instruct: write **only** seat-scoped paths from params (never canonical `plan.md` / `og-requirements.md`); emit `DRAFT-SUBMITTED plan=<sha12>` after atomic self-hash (non-authoritative). Context injection: absolute paths to north-star.md, conversation-log.md, decisions/ only. No “agree with partner,” no verdict grammar. | R2.8,R2.5,R2.7,R1.1 | `npx vitest run src/services/brief-writer-plan-draft-purpose.test.ts --minWorkers=1 --maxWorkers=4` | 28 | B1 | L2 | L2 | yes | elite | 32 |
| B3 | **Purposes `plan-reconcile` + `plan-signature`.** Reconcile: receives **both** round-1 draft paths + defect list (if any); authors **one** candidate at candidate path; emit `CANDIDATE-SUBMITTED plan=<sha12>`; includes same task-JSON schema as B2 (R2.8). Signature: receives **only** candidate path + expected short12 line (mirror B5 bind style at current `generatePanelBrief` `:469–471`); may `SIGNED plan=<sha12>` **or** numbered bounded objection list — **never** a competing draft; **never** `PLAN-READY` as agreement. R5.19: existing `diff-review` render-contract test asserts **no** draft-authoring / reconcile instructions. | R2.8,R3.10,R3.11,R3.14,R5.19 | `npx vitest run src/services/brief-writer-plan-reconcile-signature.test.ts src/services/brief-writer-diff-review-unaffected.test.ts --minWorkers=1 --maxWorkers=4` | 28 | B2 | L3 | L2 | yes | elite | 34 |
| B4 | **Delete `generatePlanningBrief` entirely** (`brief-writer-service.ts:268–351`) — not repurposed (R1.1). Update/remove tests that call it (`brief-writer-a12-split-brain.test.ts`, `brief-writer-plan-ready-not-agreement-c9.test.ts`, `brief-writer-plan-schema.test.ts`, `dispatch-service.test.ts` planning clause, `brief-writer-q11.test.ts`, `brief-writer-focus-contract.test.ts` planning cases). **Do not touch** `generateBrainBrief` (`:496–558`). Token-free: `rg generatePlanningBrief src/` returns only historical comments or zero production defs. Structural signal that plancore is not an authoring seat. | R1.1,R1.3 | `npx vitest run src/services/brief-writer-planning-brief-deleted.test.ts src/services/brief-writer-q11.test.ts --minWorkers=1 --maxWorkers=4` | 24 | B3 | L2 | L2 | no | elite | 28 |
| RR1 | **Re-scope C3, do not delete** (`checkArtifactsPublished` `planning-review-round.ts:175–216`, gate `:451–464`). Round-2+ (and post-draft gates) check **relevant seat-scoped draft or candidate** exists, non-empty, and candidate/plan side parses via `validateExecutionPlan` when the artifact is a plan document — **never** require canonical `plan.md`/`og-requirements.md` before promotion (those stay absent until P2). Round-1 pre-spawn gate: only that runDir + context inputs exist (or no artifact gate). Real-mode only / fake exempt preserved. | R4.16 | `npx vitest run src/services/planning-review-round-c3.test.ts src/services/planning-review-round-gate-rescoped.test.ts --minWorkers=1 --maxWorkers=4` | 26 | B2,D1 | L2 | L2 | yes | elite | 30 |
| RR2 | **Round 1 = dual blind draft, not review.** Replace reviewer-only `spawnRoundSeats` path for the initial draft phase: spawn **both** configured co-planner seats (`coPlannerSeats` / partnerCount logic at `:476–481`) with `purpose:'plan-draft'`, seat-scoped write targets, isolation allowlists from D2. Wait for each `DRAFT-SUBMITTED` (or first-callback + file commit); **engine recomputes** hashes via D1. C5 fresh seats (R6.20). **No** write to canonical plan/req. Extends C7 watchdog to draft seats. Register regression mode `blind-draft-isolation`. | R2.5,R2.6,R2.7,R6.20,R6.24 | `npx vitest run src/services/planning-review-round-blind-draft.test.ts --minWorkers=1 --maxWorkers=4` | 28 | RR1,D2,B2,D3 | L3 | L2 | yes | elite | 34 |
| RR3 | **Divergence → asymmetric proposer/signer (not dual reconcile).** On round-1 hash mismatch: call D3 designate; log rule; fresh-spawn proposer with `plan-reconcile` + **both** drafts; fresh-spawn signer with `plan-signature` + **only** candidate (R3.10). On round-1 hash **match**: engine may set candidate = that byte content without a model reconcile, still requiring a signature round **or** document auto-agree only when both drafts’ engine hashes are equal (prefer **signature still required** for one uniform promotion path — implement auto-agree only if tests prove no loss of R3.11). Remove any path that asks both seats to each author a new full draft. | R3.9,R3.10,R3.11 | `npx vitest run src/services/planning-review-round-proposer-signer.test.ts --minWorkers=1 --maxWorkers=4` | 28 | RR2,D3,B3 | L3 | L2 | yes | elite | 34 |
| RR4 | **Alternation + explicit 3-round role-swap test (R3.12).** Wire `rolesForRound` into the round loop (`:605+`). **Mandatory test:** fixture with forced non-signature for rounds 2 and 3; assert round-2 proposer seat id == designate(round1); round-3 proposer == the other seat; round-4 == round-2’s proposer again. Fail if one seat holds the pen every round. Register sweep mode `proposer-signer-alternation`. | R3.12,R6.20,R6.24 | `npx vitest run src/services/planning-review-round-alternation.test.ts --minWorkers=1 --maxWorkers=4` | 26 | RR3 | L3 | L2 | yes | elite | 32 |
| RR5 | **Agreement = signature on candidate bytes (B5 re-point).** New `waitForCandidateSignature` (ROUND-local or PPS helper used only by new path): signer’s `SIGNED plan=<sha12>` (or agreed grammar) must equal `readPlanRevision(candidatePath).short12` recomputed at check time; missing/malformed/stale SHA never agrees (R6.21). Engine sets `agreed:true` only here — seats never emit a status meaning “plan ready to use” (R3.14). Retire use of brain `PLAN-READY` inside this path. Keep old `waitForAgreement` intact for tests until P3. | R3.11,R3.14,R6.21 | `npx vitest run src/services/planning-review-round-signature-gate.test.ts src/services/planning-phase-current-plan-sha-b5.test.ts --minWorkers=1 --maxWorkers=4` | 28 | RR3,B3 | L3 | L2 | yes | elite | 34 |
| RR6 | **Objection monotonicity (R3.13).** Parse bounded numbered defect list from signer rejection; store count per round; if round N+1 defect count is **not strictly smaller** than round N’s against the revised candidate → typed BLOCK early (`blockedReasonKind: 'objection-not-monotone'`) without burning remaining cap. Register sweep mode `objection-monotonicity`. | R3.13,R6.24 | `npx vitest run src/services/planning-review-round-objection-mono.test.ts --minWorkers=1 --maxWorkers=4` | 26 | RR5 | L2 | L2 | yes | elite | 30 |
| RR7 | **Non-convergence = visible BLOCKED + diff, not bare hash pairs (R3.15).** On cap exhaustion / monotone fail: `blockedReason` includes a **textual diff** (or structured hunk summary) between final candidate and signer’s last objection set / last draft positions — operator-legible. Extend `RoundBlockedReasonKind` if needed. `[DB]`-shaped fields remain on `PlanningResult`. | R3.15 | `npx vitest run src/services/planning-review-round-block-diff.test.ts --minWorkers=1 --maxWorkers=4` | 24 | RR6 | L2 | L2 | no | standard | 28 |
| RR8 | **Retire plancore whole-plan revise actuator.** Delete/stop calling `generatePlanRoundReviseBrief` (`:311–354`) and the C6 spawn block (`:690–726`) that uses `brainRole` / `planningBrainModel` for mid-round plancore rewrite. Reconcile rounds **are** the revise path (proposer co-planner only). Preserve C8 same-plan-broken classification concepts where they still apply to signature refusals, or map them onto objection evidence. Update `planning-review-round-c6.test.ts` to expect proposer reconcile, not plancore. Register `role-integrity` sweep mode. | R3.10,R3.14,R1.2,R6.20 | `npx vitest run src/services/planning-review-round-c6.test.ts src/services/planning-review-round-no-plancore-revise.test.ts --minWorkers=1 --maxWorkers=4` | 28 | RR5,B4 | L3 | L2 | yes | elite | 34 |
| P1 | **PPS: no model call for plancore during initial whole-plan authoring (R1.2).** Remove `generatePlanningBrief` call (`:433–443`), plancore spawn-retry loop (`:480–524`), and `writeBrief(..., 'plancore', ...)` as an authoring seat (`:447`, `:528`). Engine injects context paths into ROUND options (north-star / conversation-log / decisions already read at `:394–411`). Keep `brainRole` / `plancore` **label** in logs, staffing (S05/S06), topology — no renames (R1.3). Terminal owner `runPlanningTerminal` (`:472–477`) still reaps whatever ROUND pushed into `partnerHandles` / `partnerRuntimeIds` — **do not** restructure A5/A6. | R1.2,R1.3 | `npx vitest run src/services/planning-phase-no-plancore-author.test.ts src/services/planning-phase-service.test.ts --minWorkers=1 --maxWorkers=4` | 28 | B4,RR2 | L3 | L2 | yes | elite | 34 |
| P2 | **Promotion + failure rename.** On `agreed` from ROUND: engine **atomically** copies candidate → canonical `plan.md` + `og-requirements.md` under `canonicalArtifactRoot` (only writer of those paths — R2.5, R3.14). Rename throw at `:689–690` from `PLANCORE-DID-NOT-PRODUCE-CANONICAL-PLAN` → `NO-AGREED-PLAN-CANDIDATE` (or equivalent candidate/signature-shaped token) (R1.4). Keep B6 discipline: non-agreement returns **before** poll/ingest (`:583–611`). `planMdPathForRaceGuard` count stays 3. | R1.4,R2.5,R3.14 | `npx vitest run src/services/planning-phase-candidate-promote.test.ts src/services/planning-phase-nonconvergence-b6.test.ts --minWorkers=1 --maxWorkers=4` | 28 | P1,RR5 | L3 | L2 | yes | elite | 34 |
| P3 | **Fail-closed signature path on PPS boundary + legacy gate hygiene.** Ensure production non-adaptive path no longer requires brain `PLAN-READY` for agreement (`waitForAgreement` `:1047–1048`, `:1087` brain half). Either: (a) non-adaptive path never calls old `waitForAgreement`, only ROUND’s signature wait; or (b) extend `waitForAgreement` with a mode that skips PLAN-READY when `signatureOnly:true`. Stale/missing SHA still fail closed (R6.21). Update fixtures that seed plancore PLAN-READY lines for non-adaptive unit tests that now exercise the new path. **Do not** loosen B5. | R3.11,R6.21,R3.14 | `npx vitest run src/services/planning-phase-current-plan-sha-b5.test.ts src/services/planning-phase-signature-path.test.ts --minWorkers=1 --maxWorkers=4` | 28 | P2,RR5 | L3 | L2 | yes | elite | 34 |
| P4 | **R7 explicit scope pin — adaptive untouched.** Assert `runPlanningPhase` still early-returns at `:356–365` when `adaptivePlanning` truthy **before** any new draft/signature code. Add a short code comment at that branch citing R7 / deferred backlog. No behavioral change to `adaptive-planning-phase.js`. File backlog note under `plan/plancore-orchestrator-redesign/decisions/` or effort decisions: reconcile adaptive co-author contract later. | R7.25 | `npx vitest run src/services/planning-phase-adaptive-scope-pin.test.ts src/services/adaptive-planning-foundation.test.ts --minWorkers=1 --maxWorkers=4` | 18 | P1 | L1 | L1 | no | budget | 22 |
| X1 | **R6.24 regression sweep rewrite — not a skip skeleton.** Replace `src/planning-regression-index.test.ts` so every historical mode **and** new modes resolve to at least one **active** behavioral test (import or subprocess), not `it.skip`. Historical seven (from prior AC23): convene-before-artifacts; BROKEN→revise→CLEAN (now BROKEN→reconcile→SIGNED); partner1 CLEAN + partner2 BROKEN (re-point to dual-signer impossibility / dual-draft mismatch); partner silent until timeout; legacy path refuses when north-star exists; ibrain row count unchanged on planning block; stale-CLEAN/SIGNED rejected across revisions. **New modes:** blind-draft-isolation; proposer-signer-role-integrity; alternation; objection-monotonicity; atomic-candidate-promotion. Unresolved/skipped entry → **fail** the suite. Spread registration is done in RR2/RR4/RR6/RR8/P2; X1 only enforces. | R6.24,R6.20,R6.21 | `npx vitest run src/planning-regression-index.test.ts --minWorkers=1 --maxWorkers=4` | 28 | RR8,P3,P4 | L2 | L2 | no | elite | 32 |

---

## 6. AC coverage matrix (no orphans)

| AC | Title (short) | Slice(s) |
|---|---|---|
| R1.1 | Delete `generatePlanningBrief` | B4 (prep B2/B3) |
| R1.2 | No plancore model call on initial whole-plan authoring | P1, RR8 |
| R1.3 | plancore label + brain brief survive | S0, P1, B4 |
| R1.4 | Rename PLANCORE-DID-NOT… → candidate/signature failure | P2 |
| R2.5 | Seat-scoped drafts; engine-only canonical | D1, RR2, P2 |
| R2.6 | Blind isolation storage-enforced | D2, RR2 |
| R2.7 | Atomic publish + engine rehash | D1, RR2, B2 |
| R2.8 | Schema contract moves to draft/reconcile briefs | B2, B3 |
| R3.9 | Deterministic proposer designation + log | D3, RR3 |
| R3.10 | Proposer gets both drafts; signer only candidate | B3, RR3, RR8 |
| R3.11 | Signature == candidate short12 fail-closed | RR5, P3 |
| R3.12 | Alternation every round + explicit 3-round test | D3, **RR4** |
| R3.13 | Objection monotonicity | RR6 |
| R3.14 | Engine-only promotion; no agent “ready to use” | B3, RR5, RR8, P2, P3 |
| R3.15 | BLOCKED with diff | RR7 |
| R4.16 | C3 re-scoped to seat-scoped artifacts | RR1 |
| R5.17 | Re-verify generatePanelBrief callers | B1 |
| R5.18 | Exhaustive purpose, no default | B1 |
| R5.19 | diff-review unaffected | B1, B3 |
| R6.20 | Fresh seats all round types | S0, RR2, RR4, RR8, X1 |
| R6.21 | Fail-closed SHA | RR5, P3, X1 |
| R6.22 | No touch finalize / terminal-owner / E5 | S0 (+ standing rule) |
| R6.23 | HELM_SESSION_JANITOR stays 0 | S0 |
| R6.24 | Behavioral regression sweep | RR2, RR4, RR6, RR8, P2, **X1** |
| R7.25 | adaptive_planning out of scope | P4 |

**25/25 ACs mapped.**

---

## 7. Totals and tiers

| Metric | Value |
|---|---|
| Slice count | **21** (S0, D1–D3, B1–B4, RR1–RR8, P1–P4, X1) |
| Sum `est_min` | **538 min (~9h)** pure implement time |
| Max `est_min` | **28** (all < 30) |
| Historical 2× wall-clock expectation | **~18–20h** attended Tiller drain |

**Tiering (per `topology.yaml` routing_notes):**

- **Elite + impl L3 / val L2:** RR2–RR5, RR8, P1–P3, B3 — agreement mechanism + authoring retirement.
- **Elite + impl L2 / val L2:** D2, B1, B2, B4, RR1, RR6, X1.
- **L1 allowed:** S0, P4, D3 (pure), D1 (mechanical store) — still val L1/L2 codex55 only.

**Deliberation `yes`** only where a real design fork remains (isolation mechanism shape; auto-agree on identical R1 hashes; waitForAgreement vs waitForCandidateSignature ownership). Mechanical deletes/pins are `no`.

---

## 8. Standing rules for implementers

1. **Re-verify every `file:line` before edit** — citations above were true on 2026-08-01; drift is expected under parallel seats.
2. **No symmetric dual-authorship** in any brief or spawn path (v1 defect).
3. **Do not touch** `generateBrainBrief`, `worker-runtime-finalize.ts`, E5 session-registry, or re-enable `HELM_SESSION_JANITOR`.
4. **`planMdPathForRaceGuard` count remains 3** in `planning-phase-service.ts`.
5. **No merge to `main`** (SD10). Base stays off-main feature branch.
6. **vitest always** `--minWorkers=1 --maxWorkers=4`.
7. **Verifier ≠ fixer:** never assign impl tier models {spark, grok45, sonnet5} as validators.
8. Prefer **new unit test files** per slice gate; X1 only indexes them.
9. When editing `brief-writer-service.ts` or `planning-review-round.ts` or `planning-phase-service.ts`, **one stream owner at a time** per §3.

---

## 9. Explicit non-goals (do not sneak into slices)

- Re-litigating P0–P2 teardown / B5 fail-closed *strength* (re-point only).
- Discovery→handoff bridge.
- D1–D11 deferred from planning-agreement-restructure.
- Unifying `adaptive_planning=1` with this contract (R7 — backlog only).
- Enabling session janitor; merging to main.

---

PLAN-DONE grok45
