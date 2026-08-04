# plan-opus5 — `plancore-orchestrator-redesign`

**Seat:** opus5 (planner, xhigh). **Authored** 2026-08-01 PHT. **Base commit:** `93d7cd7`, branch
`fix/planning-agreement-restructure`. Worked alone per PLANNER-BRIEF; no other planner's output read.

24 slices, every non-test slice ≤ 28 min, all 25 ACs mapped. Read §1-§4 before the table — §2 and §3
contain findings that change what some slices must do, and §4 is the serialization contract the table's
`deps` column encodes.

---

## 1. What I actually verified in source

Everything below was read directly at `93d7cd7`, not inferred from `og-requirements.md`.

| Mechanism | Verified location | Notes |
|---|---|---|
| `generatePlanningBrief` | `brief-writer-service.ts:268-351` | Sole production caller: `planning-phase-service.ts:433`. 6 test files call it. |
| plancore spawn + retry (POCFIX20) | `planning-phase-service.ts:479-524` | Brief generated `:433-443`, early-written `:444-448`, re-written `:526-528`. |
| `generatePanelBrief` | `brief-writer-service.ts:433-493` | **4** production callers (§2.2). |
| `generateBrainBrief` (mid-impl replan — PRESERVE) | `brief-writer-service.ts:496-560+`; "Wakes plancore to surgically revise THIS slice" at `:523` | Confirmed: different function, Phase C escalation. Untouched. |
| C6 revise actuator | `planning-review-round.ts:311` (brief fn) / `:692` (brief call) / **`:702` (spawn)** | See §2.1. |
| C3 artifact-publication gate | `planning-review-round.ts:175-216`, invoked `:453-464` | Real-mode only. |
| C5 fresh-seats-per-round | `planning-review-round.ts:499-564` (`spawnRoundSeats`), loop `:605-728` | Keystone. |
| C7 reviewer first-callback watchdog | `planning-review-round.ts:395-433`, invoked `:628-660` | |
| C8 typed blocked reasons | `planning-review-round.ts:136-140`, `:730-757` | |
| B5 SHA binding / `waitForAgreement` | `planning-phase-service.ts:1010-1116`; live check `:1092-1106` | The exact mechanism R3.11 re-points. |
| `PLANCORE-DID-NOT-PRODUCE-CANONICAL-PLAN` | `planning-phase-service.ts:689` | 2 consuming tests: `planning-phase-nonconvergence-b6.test.ts:35`, `planning-phase-one-terminal-owner-a6.test.ts:150`. |
| Canonical read/ingest | `planning-phase-service.ts:617-622` (read), `:696-698` (materialize + ingest) | |
| `adaptive_planning` early return | `planning-phase-service.ts:359-365` | |
| Raceguard lock | `grep -c planMdPathForRaceGuard src/services/planning-phase-service.ts` → **3** ✓ | topology safety_note satisfied at base. |
| `HELM_SESSION_JANITOR` | `.env:9` → `0` ✓ | |
| `plancore` label surfaces | `planning-staffing-service.ts` (S05), `cycle-seat-preview.ts` (S06/UI), `guardrails.ts:57` (`AGENT_ROLES`), `index.ts` (×14, `plancore_session`/API/UI), `role-alias.ts:16` (`plancore → helm_pm`) | R1.3 — none renamed or removed. |

---

## 2. Citation discrepancies and gaps in `og-requirements.md` v2

Flagged rather than silently trusted or silently "fixed", per the brief.

### 2.1 Line-number drift (minor — none change the mechanism)

| Cited | Actual | Impact |
|---|---|---|
| `brief-writer-service.ts:268-350` | `268-351` (closing brace at 351) | Off-by-one on the delete range. Deleting through 350 leaves an orphan `}`. |
| `brief-writer-service.ts:433-480` | `433-493` | `:480` lands **inside** the `body` template literal. An implementer editing "433-480" would truncate mid-string. |
| `brief-writer-service.ts:495-524` (`generateBrainBrief`) | fn starts `:496`; the cited range is only its classifier block — the function runs past `:560` | Harmless (out of scope), but the range is not the function. |
| `planning-review-round.ts:692` "(spawn)" | `:692` is the **brief construction** call; `transport.spawn` is at **`:702`** | The revise-actuator re-point (S14) touches both. |

Everything else I checked (`:689`, `:617-689`, `:355-365`, `:311`) is accurate.

### 2.2 R5.17's caller list — verified exhaustively, and R5.18's enum is one member short

`grep -rn generatePanelBrief src/ --include=*.ts` (excluding `.bak-*` and tests) yields **exactly four**
production call sites:

| Call site | Semantics | R5.18 purpose |
|---|---|---|
| `planning-review-round.ts:511` | whole-plan review round | replaced by `plan-draft`/`plan-reconcile`/`plan-signature` |
| `planning-phase-service.ts:952` | post-ingest per-task conflict reconvene (A13) | `task-conflict-reconvene` |
| `panel-service.ts:63` (`conveneDeliberationPanel`) | topic-based deliberation — **passes no `implementedDiff`** | *unmapped* |
| `panel-service.ts:123` (`conveneRedTeamPanel`) | adversarial review of an implementation diff — passes `implementedDiff` | `diff-review` |

**Finding:** R5.18 folds `panel-service.ts:63` and `:123` into one `diff-review` member, but `:63` reviews
a *topic*, not a diff — it never receives `implementedDiff`. A purpose enum with "no default" that forces
a topic-deliberation caller to declare itself `diff-review` reintroduces exactly the conflation R5 exists
to remove. **S03 adds a sixth member, `deliberation-topic`**, for `panel-service.ts:63`. This satisfies
R5.18's "at minimum" clause; north should confirm rather than have it absorbed silently.

Four test callers also pass no purpose and must be updated in the same slice or the build breaks:
`brief-writer-focus-contract.test.ts:72,85`, `brief-writer-q11.test.ts:73`,
`brief-writer-panel-plan-contract-b2.test.ts:19,42`, `dispatch-service.test.ts:446`.

### 2.3 `generatePanelBrief` hard-binds canonical `plan.md` — a live breakage no AC names

`brief-writer-service.ts:452-471` unconditionally computes `planMdPath = <root>/plan.md`, calls
`readPlanRevision(planMdPath)`, and — when absent — emits:

> `Expected plan revision: UNAVAILABLE … FAIL CLOSED: do NOT emit a verdict yet`

Under this redesign canonical `plan.md` **does not exist** until R3.14's promotion. So every round-1
draft seat, every proposer, and every signer would be handed a brief instructing it to fail closed and
not act. This is not covered by R2.8, R3.10, or R5.18. **S03 adds an additive-optional `boundArtifactPath`;
S04/S05 point it at the seat-scoped draft/candidate and suppress the revision line entirely for
`plan-draft` (there is nothing to bind to on a blind first draft).** Without this the redesign is inert
on its first real run.

### 2.4 The brief-contract enum is a two-file lockstep nobody has named

`dispatch-service.ts:138-149` (`validateBriefContract`) does an exact `briefText.includes(enumLine)`
against `dispatch-service.ts:191-201` (`getRoleEnumLine`), while the brief is rendered from
`brief-writer-service.ts:246-264` (`getRoleStates`). The two are byte-coupled — the comment at
`dispatch-service.ts:196-197` says "Keep this in lockstep" and it is not enforced by any test.

New STATUS tokens (`DRAFT-SUBMITTED`, `CANDIDATE-SUBMITTED`, `SIGNED`, `OBJECTIONS`) must land in **both**
functions in **one commit**, or every real dispatch throws `BRIEF-CONTRACT-MISSING closed_enum` and 100%
of planning runs die at spawn. **S06 owns this and adds the missing lockstep test.**

### 2.5 R2.6's OS-level enforcement is inert on this deployment today

`strictReadAllow` → `makeStrictReadProfileEnv` → `HELM_SANDBOX_RO_PROFILE=strict` is genuine
Landlock enforcement (`security/landlock-sandbox.ts:40-70`, binary at `tools/helm-sandbox`). But the
value flows from `resolveDeploymentStrictReadAllow(process.env.HELM_STRICT_READ_ALLOW)`
(`run-orchestrator-service.ts:1020,1171`) and **`HELM_STRICT_READ_ALLOW` is not set in `.env`** — verified.
Unset ⇒ `undefined` ⇒ read-all ⇒ no kernel read fence exists on this instance.

Also note every seat runs as the same UID, so POSIX permissions cannot isolate seats from each other;
Landlock is the only OS mechanism available.

**Consequence for R2.6** ("enforced at the storage layer — not merely 'no brief mentions the other
path'"): the per-seat draft read-fence must be composed **unconditionally for co-planner draft seats**,
independent of the deployment-level flag — blind drafting is a correctness invariant, not a
confidentiality deployment option. **S02 composes the per-seat allowlist itself and merges it with any
deployment allowlist rather than inheriting one.** S02 additionally lands a fail-closed store-API denial
layer so R2.6 has a runnable assertion on a box where the sandbox binary is unavailable.

### 2.6 The seven `planning-review-round-c*.test.ts` suites are ~1,233 lines of uncosted migration

These suites *are* the P0-P2 regression proof, and every one of them asserts the old shape:

| Suite | Coupling that breaks | Owned by |
|---|---|---|
| `c2` (137L) | `partnerBatchIds === ['batch-C2-partner', …]`, spawn role `planner` | S12 |
| `c3` (172L) | `/ARTIFACT-NOT-PUBLISHED/`, `/plan\.md not yet published/` | S11 |
| `c4` (125L) | `/ROUND-CAP-EXHAUSTED/`, `/within 3 round\(s\)/` | S17 |
| `c5` (205L) | `['batch-C5-partner','batch-C5-r2-partner','batch-C5-r3-partner']` + reap-before-spawn order | S14 |
| `c6` (197L) | `['batch-C6-partner','batch-C6-r1-revise','batch-C6-r2-partner']` | S14 |
| `c7` (193L) | `/REVIEWER-NO-FIRST-CALLBACK/`, `batch-C7-partner` | S12 |
| `c8` (204L) | `blockedReasonKind: 'same-plan-broken'` | S17 |

They **must not be deleted** — deleting them silently reopens R6.20/R6.21. They are migrated by the slice
that changes the mechanism they pin, which is also how R6.24's "spread real assertions across the slices
whose mechanism they pin" is satisfied. This is costed in the `est_min` of S11/S12/S14/S17.

### 2.7 Dead code left behind, deliberately

Once the plancore spawn goes (S10), `planning-phase-service.ts:744-849` (`waitForFirstCallback`) has no
caller — C7 already keeps its own reviewer-scoped copy at `planning-review-round.ts:395-433`. `tsconfig.json`
does not set `noUnusedLocals`, so it does not break the build. **Leave it in place** and file it to the
already-deferred D1-D11 legacy-cleanup backlog; removing it is a separate-effort change with its own test
fallout and is out of scope here.

---

## 3. Target mechanism (what the slices build)

```
runDir/
  planning-drafts/
    <seatId>/                       # isolation unit: a directory, so it can be excluded from a read fence
      draft-<seatId>.md             # plan draft        (R2.5 naming honoured)
      draft-<seatId>-req.md         # requirements draft
    candidate-r<N>/
      plan.md  og-requirements.md   # the round's single candidate
    proposer-log.jsonl              # R3.9 audit: both draft SHAs + rule + assignment, per round
    non-convergence-diff.txt        # R3.15
```

**Departure from R2.5's literal path:** the requirement names `draft-<seatId>.md` at the run-directory
level. I nest it one level under `planning-drafts/<seatId>/` because R2.6 demands the storage unit be
un-listable to the other seat, and a Landlock `PATH_BENEATH` grant is directory-scoped — a bare file
sitting in a directory the other seat must read (for `callbacks.md`) cannot be hidden. Filenames are
unchanged. Flagging rather than assuming.

**Round machine:**

1. **R1** — both seats spawn fresh with `plan-draft` purpose, fenced to their own directory, write
   `.tmp` then rename, emit `DRAFT-SUBMITTED — draft=<sha12>`. The engine **ignores the claimed hash**
   and recomputes from the committed file (`readPlanRevision`), recording any mismatch as an audit warning.
2. **Designation** — equal hashes ⇒ agreed, promote. Unequal ⇒ proposer for round 2 is the seat whose
   full `sha256` sorts lexicographically lower; rule + both hashes appended to `proposer-log.jsonl`.
3. **R2+** — proposer (fresh) gets **both** drafts, writes **one** candidate. Signer (fresh) gets **only**
   the candidate and emits either `SIGNED — plan=<sha12>` or `OBJECTIONS — n=<k>; 1. … k. …`.
   **Never a competing draft.**
4. **Agreement** — engine recomputes `readPlanRevision(candidatePath).short12` at check time and compares
   to the signer's stated `plan=<sha12>`. This is B5's comparison verbatim, re-pointed. Missing,
   malformed, or stale ⇒ not agreement (fail-closed, unchanged).
5. **Alternation** — `proposerIndex(round) = (baseIndex + (round - 2)) % 2`. Round 2 A/B, round 3 B/A.
6. **Monotonicity** — declared `n=` must equal the parsed numbered-item count (fail-closed on mismatch);
   round N+1's count must be strictly `<` round N's, else typed BLOCK `objections-not-shrinking`.
7. **Promotion** — engine only, on the signature condition: candidate bytes → `<canonical>/plan.md.tmp`
   → `rename`, same for `og-requirements.md`, then existing `materializeCanonicalArtifactSet` + ingest.
8. **Non-convergence** — visible BLOCKED carrying a real unified diff of the two seats' final positions
   plus the final objection list, not a hash pair.

`planning-review-round.ts` is **rewritten in place**, not forked. Forking would duplicate C5/C7/C8 and let
them drift; rewriting in place is what makes R6.20/R6.21 provably *inherited* rather than reimplemented.

---

## 4. File ownership → serialization

Slices touching the same file **must be serial**; this is what `deps` encodes.

| File | Slices (in order) | Serial? |
|---|---|---|
| `src/services/seat-draft-store.ts` **(new)** | S01 → S02 | **yes** |
| `src/services/brief-writer-service.ts` | S03 → S04 → S05 → S06 → S07 → S10 | **yes** |
| `src/services/planning-review-round.ts` | S11 → S12 → S13 → S14 → S16 → S17 | **yes** |
| `src/services/planning-phase-service.ts` | S03 → S10 → S15 → S18 → S19 → S21 | **yes** |
| `src/services/dispatch-service.ts` | S06 only | n/a |
| `src/services/panel-service.ts` | S03 only | n/a |
| `src/planning-regression-index.test.ts` | S23 → S24 | **yes** |
| brief-writer test files | S08, S09 (disjoint file sets) | independent of each other |

**Genuinely independent, safe to run concurrently:** {S01, S02} ∥ {S03…S07}. **S03 and S10 are
cross-file serialization hubs** — S03 touches four files at once (required param, no default),
S10 touches two. Nothing else may be in flight against `brief-writer-service.ts`,
`planning-phase-service.ts`, `panel-service.ts`, or `planning-review-round.ts` while either runs.

**Migration window (state this to the operator up front):** from S10 through S18 the non-adaptive
planning path does not complete end-to-end. Every intermediate slice compiles and its tests pass, but a
real run BLOCKs with a typed, visible reason (never a silent pass, never corrupt state). **Nothing
deploys until S24 and a full regate.** `adaptive_planning=1` runs are unaffected throughout (S21 proves it).

**On "R1 lands early":** the brief asks for R1 first as the structural signal. I place the deletion at
**S10 — first half of the plan, before any of the new round machinery** — but *after* S04/S05/S06 create
the replacement briefs and S08/S09 migrate the six test files off the old API. Deleting at S01 would
require the same six test files to be migrated to APIs that do not exist yet, i.e. deleted-and-stubbed
rather than deleted-and-replaced. S10 is a genuine deletion with **zero remaining callers**, which is the
"real, not aspirational" property the brief is actually asking for. Every subsequent slice depends on it.

---

## 5. Slice table

| id | scope | acs | tests | est_min | deps | impl_tier | val_tier | deliberation | redteam | budget |
|---|---|---|---|---|---|---|---|---|---|---|
| S01 | NEW `src/services/seat-draft-store.ts`: seat-scoped path composition (`planning-drafts/<seatId>/draft-<seatId>.md`, `-req.md`, `candidate-r<N>/`), atomic publish helper (tmp+rename), and engine-side `recomputeDraftRevision()` that hashes the committed file and never trusts a callback's claimed hash | R2.5, R2.7 | `npx vitest run src/services/seat-draft-store-atomic-s01.test.ts --minWorkers=1 --maxWorkers=4` | 25 | — | L2 | L2 | none | budget | med |
| S02 | `seat-draft-store.ts`: fail-closed cross-seat access API (`readDraft(ownerSeat, requesterSeat)` and `listSeatDir(requesterSeat)` throw `SEAT-DRAFT-ISOLATION` on any cross-seat access before commit) + `composeSeatDraftReadFence(seatId, runDir, deploymentAllow?)` merging the per-seat grant with any deployment allowlist, composed **unconditionally** for draft seats (§2.5) | R2.6 | `npx vitest run src/services/seat-draft-isolation-s02.test.ts --minWorkers=1 --maxWorkers=4` | 28 | S01 | L3 | L2 | standard | standard | high |
| S03 | `generatePanelBrief` gains **required** `purpose` (no default) — `plan-draft`\|`plan-reconcile`\|`plan-signature`\|`task-conflict-reconvene`\|`diff-review`\|`deliberation-topic` (§2.2) — plus additive-optional `boundArtifactPath` (§2.3); update all 4 production callers (`planning-review-round.ts:511`, `planning-phase-service.ts:952`, `panel-service.ts:63`, `panel-service.ts:123`) and all 4 test callers in the same commit | R5.17, R5.18 | `npx vitest run src/services/brief-writer-purpose-discriminant-s03.test.ts src/services/brief-writer-panel-plan-contract-b2.test.ts --minWorkers=1 --maxWorkers=4` | 28 | — | L2 | L2 | none | standard | med |
| S04 | `plan-draft` purpose body: independent blind-authoring instruction; task-JSON schema + `R-XX` requirement-ID contract migrated verbatim out of `generatePlanningBrief` (`brief-writer-service.ts:308-339`); seat's own draft paths only; revision line suppressed (nothing to bind on a first draft); emits `DRAFT-SUBMITTED` | R2.8 | `npx vitest run src/services/brief-writer-plan-draft-s04.test.ts --minWorkers=1 --maxWorkers=4` | 28 | S03 | L2 | L2 | none | budget | med |
| S05 | `plan-reconcile` body (proposer: both drafts in, ONE candidate out, same schema contract, `CANDIDATE-SUBMITTED`) and `plan-signature` body (signer: candidate only; `SIGNED — plan=<sha12>` or `OBJECTIONS — n=<k>; 1. …`; explicitly forbidden from authoring a competing document) | R2.8, R3.10, R3.13 | `npx vitest run src/services/brief-writer-reconcile-signature-s05.test.ts --minWorkers=1 --maxWorkers=4` | 28 | S04 | L3 | L2 | standard | standard | high |
| S06 | Two-file enum lockstep (§2.4): add `DRAFT-SUBMITTED \| CANDIDATE-SUBMITTED \| SIGNED \| OBJECTIONS` to `brief-writer-service.ts:getRoleStates` **and** `dispatch-service.ts:getRoleEnumLine` in one commit; retire `PLAN-READY` as an authorship-completion signal on the planning path; add the missing lockstep-drift test | R3.14 | `npx vitest run src/services/brief-contract-enum-lockstep-s06.test.ts src/services/dispatch-service.test.ts --minWorkers=1 --maxWorkers=4` | 20 | S05 | L2 | L2 | none | budget | low |
| S07 | Render-contract guard: a `diff-review`-purpose brief contains no draft-authoring and no candidate-reconciliation instruction; assert against the pre-change baseline string captured in the test so the "unaffected" claim is provable before and after | R5.19 | `npx vitest run src/services/brief-writer-diff-review-unaffected-s07.test.ts --minWorkers=1 --maxWorkers=4` | 20 | S03 | L1 | L1 | none | budget | low |
| S08 | Rewrite the 3 dedicated `generatePlanningBrief` suites onto the `plan-draft` purpose: `brief-writer-plan-schema.test.ts`, `brief-writer-plan-ready-not-agreement-c9.test.ts`, `src/brief-writer-a12-split-brain.test.ts` — the schema/split-brain/PLAN-READY≠agreement assertions move to where the document is now authored | R1.1 | `npx vitest run src/services/brief-writer-plan-schema.test.ts src/services/brief-writer-plan-ready-not-agreement-c9.test.ts src/brief-writer-a12-split-brain.test.ts --minWorkers=1 --maxWorkers=4` | 25 | S04, S06 | L2 | L1 | none | none | low |
| S09 | Prune the 3 shared-sample suites of their `generatePlanningBrief` sample and add `plan-draft`/`plan-reconcile`/`plan-signature` samples: `brief-writer-q11.test.ts:61`, `brief-writer-focus-contract.test.ts:104`, `dispatch-service.test.ts:505-…` | R1.1 | `npx vitest run src/services/brief-writer-q11.test.ts src/services/brief-writer-focus-contract.test.ts src/services/dispatch-service.test.ts --minWorkers=1 --maxWorkers=4` | 22 | S04, S06 | L2 | L1 | none | none | low |
| S10 | **DELETE** `generatePlanningBrief` (`brief-writer-service.ts:268-351`, note the off-by-one at §2.1) and the plancore spawn path (`planning-phase-service.ts:433-448`, `:479-524`, `:526-528`); engine performs context injection (north-star / conversation-log / decisions paths) directly in code. Leave `waitForFirstCallback` in place per §2.7. New guard test: the method is absent and a fixture planning run spawns **zero** `plancore`-role seats | R1.1, R1.2 | `npx vitest run src/services/plancore-retired-s10.test.ts src/services/planning-phase-service.test.ts --minWorkers=1 --maxWorkers=4` | 28 | S08, S09 | L2 | L2 | standard | standard | high |
| S11 | Re-point C3's gate (`planning-review-round.ts:175-216`): round-2+ spawns gate on the **relevant seat-scoped draft/candidate** existing, non-empty and parseable — never the canonical path (which nothing writes until S18 and which would otherwise block 100% of runs). Migrate `planning-review-round-c3.test.ts` to the new typed reason | R4.16 | `npx vitest run src/services/draft-publication-gate-s11.test.ts src/services/planning-review-round-c3.test.ts --minWorkers=1 --maxWorkers=4` | 25 | S01, S10 | L1 | L2 | none | budget | med |
| S12 | Round 1: spawn both co-planners fresh with `plan-draft` + their own read fence (S02); wait for both `DRAFT-SUBMITTED`; **engine recomputes each hash from the committed file** and logs any claim/actual mismatch. Migrate `planning-review-round-c2.test.ts` (seat ids/roles) and `-c7.test.ts` (watchdog, batch ids) | R2.5, R2.7, R6.20 | `npx vitest run src/services/planning-draft-round-s12.test.ts src/services/planning-review-round-c2.test.ts src/services/planning-review-round-c7.test.ts --minWorkers=1 --maxWorkers=4` | 28 | S02, S04, S11 | L2 | L2 | none | standard | high |
| S13 | Deterministic proposer designation: equal round-1 hashes ⇒ immediate agreement; unequal ⇒ lower full `sha256` becomes round-2 proposer. Append rule + both hashes + assignment to `planning-drafts/proposer-log.jsonl`. Test asserts the assignment is reproducible **from the artifacts alone**, with no slot-order bias (swap the seats, same answer) | R3.9 | `npx vitest run src/services/proposer-designation-s13.test.ts --minWorkers=1 --maxWorkers=4` | 25 | S12 | L2 | L2 | none | standard | med |
| S14 | Proposer/signer rounds with **alternation**: proposer (fresh) receives both documents and writes one candidate; signer (fresh) receives only the candidate. `proposerIndex(round) = (base + round - 2) % 2`. Re-point C6's revise actuator (`planning-review-round.ts:311`/`:692`/**`:702`**) from plancore to the round's proposer. **Dedicated 3-round trace asserting rounds 2 and 3 have swapped roles**, not merely that agreement eventually happens. Migrate `-c5.test.ts` (fresh-seats-per-round, reap-before-spawn ordering) and `-c6.test.ts` (spawn order) | R3.10, R3.12, R6.20 | `npx vitest run src/services/proposer-signer-alternation-s14.test.ts src/services/planning-review-round-c5.test.ts src/services/planning-review-round-c6.test.ts --minWorkers=1 --maxWorkers=4` | 28 | S05, S13 | L3 | L3 | standard | elite | high |
| S15 | `waitForAgreement` → `waitForSignature` (`planning-phase-service.ts:1010-1116`): B5's comparison unchanged, re-pointed from "unanimous CLEAN + PLAN-READY on canonical plan.md" to "signer's `plan=<sha12>` equals `readPlanRevision(candidatePath).short12`, recomputed at check time". Drop the now-unsatisfiable `sawPlanReady` precondition (§2.4 — no seat emits it any more). Missing / malformed / stale-relative-to-current-candidate is never agreement | R3.11, R6.21 | `npx vitest run src/services/candidate-signature-gate-s15.test.ts src/services/planning-phase-current-plan-sha-b5.test.ts src/services/planning-phase-newest-verdict-b4.test.ts --minWorkers=1 --maxWorkers=4` | 28 | S14 | L3 | L3 | standard | elite | high |
| S16 | Objection monotonicity: parse `OBJECTIONS — n=<k>; 1. … k. …`; declared `n` must equal the parsed item count (fail-closed on mismatch — never counted as zero objections); round N+1's count must be strictly `<` round N's or the run typed-BLOCKs `objections-not-shrinking` **early**, without burning the remaining round cap | R3.13 | `npx vitest run src/services/objection-monotonicity-s16.test.ts --minWorkers=1 --maxWorkers=4` | 28 | S15 | L2 | L2 | standard | standard | high |
| S17 | Round-cap exhaustion ⇒ visible BLOCKED carrying a real **unified line diff** of the two seats' final positions (final candidate vs the other seat's last authored document) written to `planning-drafts/non-convergence-diff.txt` and summarized in `blockedReason`, plus the final objection list — never a bare hash pair. Extend `RoundBlockedReasonKind` with the new causes. Migrate `-c4.test.ts` (round-cap message) and `-c8.test.ts` (typed causes) | R3.15 | `npx vitest run src/services/nonconvergence-diff-s17.test.ts src/services/planning-review-round-c4.test.ts src/services/planning-review-round-c8.test.ts --minWorkers=1 --maxWorkers=4` | 28 | S16 | L2 | L2 | standard | standard | med |
| S18 | Engine-only atomic promotion: on S15's signature condition the engine copies the candidate to `<canonicalRoot>/plan.md.tmp` → `rename`, same for `og-requirements.md`, then the existing `materializeCanonicalArtifactSet` + `ingestExecutionPlan` (`planning-phase-service.ts:696-698`) run unchanged. No agent may emit any status meaning "ready to use". Test asserts canonical paths have **zero** non-engine writers across a full fixture run | R3.14, R2.5 | `npx vitest run src/services/candidate-promotion-s18.test.ts --minWorkers=1 --maxWorkers=4` | 28 | S15 | L3 | L3 | standard | elite | high |
| S19 | Rename `PLANCORE-DID-NOT-PRODUCE-CANONICAL-PLAN` (`planning-phase-service.ts:689`) → `NO-AGREED-PLAN-CANDIDATE`; message asserts no agreed candidate exists, naming no agent. Update both consumers: `planning-phase-nonconvergence-b6.test.ts:35`, `planning-phase-one-terminal-owner-a6.test.ts:150` | R1.4 | `npx vitest run src/services/no-agreed-plan-candidate-s19.test.ts src/services/planning-phase-nonconvergence-b6.test.ts src/services/planning-phase-one-terminal-owner-a6.test.ts --minWorkers=1 --maxWorkers=4` | 20 | S18 | L1 | L1 | none | budget | low |
| S20 | Guard test proving the `plancore` **label** survives untouched: `planning-staffing-service.ts` (S05 resolver), `cycle-seat-preview.ts` (S06/UI), `guardrails.ts:57` `AGENT_ROLES`, `role-alias.ts:16`, and `generateBrainBrief`'s mid-implementation replan text at `brief-writer-service.ts:523` ("Wakes plancore to surgically revise THIS slice") — byte-identical to base | R1.3 | `npx vitest run src/services/plancore-label-survives-s20.test.ts src/services/planning-staffing-service.test.ts --minWorkers=1 --maxWorkers=4` | 25 | S10 | L2 | L2 | none | budget | med |
| S21 | Prove `adaptive_planning=1` still early-returns at `planning-phase-service.ts:359-365` **before** any of this machinery, and that R1-R6 govern only the non-adaptive path; add the deferred-reconciliation backlog entry so the divergence is filed, not forgotten | R7.25 | `npx vitest run src/services/adaptive-planning-out-of-scope-s21.test.ts src/services/adaptive-planning-foundation.test.ts --minWorkers=1 --maxWorkers=4` | 20 | S18 | L1 | L1 | none | budget | low |
| S22 | P0-P2 lock guard: `worker-runtime-finalize.ts`, `run-orchestrator-service.ts`'s terminal-owner logic, and the E5-class session-registry path are byte-unchanged vs `93d7cd7`; `HELM_SESSION_JANITOR === '0'`; `grep -c planMdPathForRaceGuard src/services/planning-phase-service.ts === 3` | R6.22, R6.23 | `npx vitest run src/services/p0p2-locks-s22.test.ts src/services/planning-phase-reap-before-finalize-a5.test.ts --minWorkers=1 --maxWorkers=4` | 22 | S18 | L1 | L2 | none | budget | low |
| S23 | Rewrite `src/planning-regression-index.test.ts`: each of the seven historical modes must **resolve to a named, active test that really asserts** — the index imports/locates the resolving spec and fails when a mode is unresolved, skipped, or resolves to a test that only checks existence. Delete the `it.skip` loop and the `pending`/`skipped` state enum | R6.24 | `npx vitest run src/planning-regression-index.test.ts --minWorkers=1 --maxWorkers=4` | 28 | S11, S14, S15, S17, S18, S22 | L3 | L3 | standard | elite | high |
| S24 | Register the five modes this effort introduces into the sweep — blind-draft isolation (S02), proposer/signer role integrity (S14), alternation (S14), objection monotonicity (S16), atomic candidate promotion (S18) — each resolving to its slice's active test. Twelve modes total, zero skipped | R6.24 | `npx vitest run src/planning-regression-index.test.ts --minWorkers=1 --maxWorkers=4` | 25 | S02, S12, S14, S16, S18, S23 | L2 | L2 | none | standard | med |

**Total:** 24 slices, 615 min of atomic work. Longest slice 28 min; none exceeds 30.

---

## 6. AC coverage matrix — all 25 mapped

| AC | Requirement (short) | Slices |
|---|---|---|
| R1.1 | delete `generatePlanningBrief` | S08, S09, **S10** |
| R1.2 | no model call for plancore in initial authoring | **S10** |
| R1.3 | plancore survives as label + mid-impl replan | **S20** |
| R1.4 | rename `PLANCORE-DID-NOT-PRODUCE-CANONICAL-PLAN` | **S19** |
| R2.5 | seat-scoped draft paths; canonical engine-only | **S01**, S12, S18 |
| R2.6 | blind drafting enforced at the storage layer | **S02** |
| R2.7 | atomic publish + engine recomputes the hash | **S01**, S12 |
| R2.8 | schema contract moves to draft + reconcile briefs | **S04**, S05 |
| R3.9 | deterministic, logged proposer designation | **S13** |
| R3.10 | proposer authors one candidate; signer sees only it | S05, **S14** |
| R3.11 | agreement = signer SHA vs candidate bytes (B5) | **S15** |
| R3.12 | proposer role alternates every round | **S14** |
| R3.13 | objection monotonicity | S05, **S16** |
| R3.14 | engine-only promotion; `PLAN-READY` retired | S06, **S18** |
| R3.15 | BLOCKED reports a diff, not hash pairs | **S17** |
| R4.16 | C3 gate re-scoped to seat-scoped artifacts | **S11** |
| R5.17 | re-verify `generatePanelBrief` call sites | **S03** (§2.2) |
| R5.18 | exhaustive `purpose`, no default | **S03** |
| R5.19 | diff-review verified unaffected | **S07** |
| R6.20 | fresh seats per round, all round types | S12, **S14** |
| R6.21 | fail-closed SHA | **S15** |
| R6.22 | A1-A6 / E5 path untouched | **S22** |
| R6.23 | `HELM_SESSION_JANITOR` stays 0 | **S22** |
| R6.24 | regression sweep asserts real behavior | S11, S12, S14, S15, S17, **S23**, **S24** |
| R7.25 | adaptive planning explicitly out of scope | **S21** |

---

## 7. verifier ≠ fixer — verified against `topology.yaml`

Implementer set `{L1 spark, L2 grok45, L3 sonnet5}`; validator set `{L1 codex55, L2 codex55, L3 opus5}`.
**Intersection is empty at every tier**, so *every* `(impl_tier, val_tier)` pair in §5 satisfies
verifier ≠ fixer. I checked all 24 rows individually; no row pairs a model against itself, and no row
assigns `sol` or `opus5` to implementation (standing project rule).

**One thing north should decide:** validator L1 and L2 are **the same model** (`codex55` at both tiers).
So `tier_guidance`'s "validator L2 minimum" for the R3 safety-critical slices is a no-op unless it means
L3. I assigned **L3 (opus5)** to the four genuinely load-bearing rows — S14 (alternation), S15 (fail-closed
signature), S18 (atomic promotion), S23 (regression sweep) — plus S02 and S05 at L3 implementer for the
same reason, and left L2 elsewhere to satisfy the letter of the guidance without spending opus5 on
mechanical wiring. If north wants the guidance read literally, S13/S16/S17 move to val L3 too.

---

## 8. Gate discipline and standing locks

- **No merge to `main`** (SD10). `main` is at `680b6ca`; work stays on `fix/planning-agreement-restructure`.
- **`HELM_SESSION_JANITOR` stays `0`** — asserted by S22, not merely intended.
- **Do not touch** `worker-runtime-finalize.ts`, the terminal-owner logic in `run-orchestrator-service.ts`,
  or the E5-class session-registry path (R6.22) — asserted by S22.
- **Do not weaken B5** — S15 re-points the identical comparison; the fail-closed branches
  (`planning-phase-service.ts:1093-1106`) are moved, not relaxed.
- **`brief-writer-service.ts:496-560` (`generateBrainBrief`) is untouched** — S20 asserts it byte-for-byte.
- **Citation discipline:** every implementer re-verifies `file:line` against current source before
  editing. Line numbers in §5 are accurate at `93d7cd7` and will drift as slices land; the *mechanism
  names* in each scope cell are the durable reference.
- **`--minWorkers=1 --maxWorkers=4` on every vitest command** — uncapped vitest OOMs the box and kills
  live tmux sessions. Every `tests` cell above carries it. Invocation form verified working
  (`npx vitest run <file> --minWorkers=1 --maxWorkers=4` → 10 passed, 150 ms).
- **Full regate before deploy:** `npm run typecheck && npm run build && npx vitest run --minWorkers=1
  --maxWorkers=4` after S24, then staged deploy — same discipline as P0-P2. Nothing deploys mid-migration
  (§4).

---

## 9. Open questions for north

1. **§2.2** — accept `deliberation-topic` as the sixth `purpose` member? Without it, `panel-service.ts:63`
   must lie about being a `diff-review` caller, which is the conflation R5 exists to remove.
2. **§2.5** — confirm the per-seat draft read fence is composed unconditionally rather than inheriting the
   (currently unset) deployment-level `HELM_STRICT_READ_ALLOW`. If it inherits, R2.6's OS layer is inert on
   this instance and only the store-API layer binds.
3. **§3** — accept nesting the R2.5-named draft files under `planning-drafts/<seatId>/` so the isolation
   unit is a directory (a bare file in a shared directory cannot be made unlistable).
4. **§7** — read "validator L2 minimum" as literal L2 (≡ L1's model) or as L3 for the R3 slices?
5. **§4** — confirm the S10→S18 migration window (planning non-functional end-to-end, every slice green,
   no deploy until S24) is acceptable, versus a longer plan that keeps the old path alive behind a flag.

PLAN-DONE opus5
