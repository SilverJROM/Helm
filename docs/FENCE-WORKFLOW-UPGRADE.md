# Helm — adopting the fence workflow

**Status:** INITIAL DOC (rev 3). Scope and contract, not an implementation plan.
**Date:** 2026-08-08
**Authority for the contract:** `wflow/tokenless_coord/TILLER-USAGE.md` §5.3.
**Why each piece exists:** `FENCE-BUILD-PLAN.md` and the review record `fence-review-*.md` /
`fence-impl-review-*.md` (five adversarial rounds with grok45 and sol).

**Framing (JROM):** *Helm is basically Tiller — but much more deterministic, much more confined, and
with self-hosted prompts.* This doc is written on that basis. Helm is not adopting a foreign workflow;
it is the same contract on a **better substrate**. That matters more than it sounds, and §4 is the
practical consequence: several defects that cost the CLI side five review rounds are **not reachable**
in Helm's architecture, and Helm can enforce things Tiller structurally cannot.

**Caveat:** the CLI side is built and tested; the Helm specifics below come from a shallow survey of
`src/services/` and are marked with confidence. Verify before committing to any of them.

---

## 1. Why this exists

Atomic slicing — small units, each independently gated — bought a fast, frequent quality gate. It also
created a **composition gap**: every unit passes its own narrow test and the assembled behaviour is
still broken. Nothing ever asked *"do these fit together?"*

JROM's framing: an atomic task is only meaningfully testable because it is a **unit inside a declared
functionality**. The functionality — the fence — is what gets proven; the units are its parts.

A first attempt (integration checkpoints as ordinary rows) failed in **two opposite directions**, and
both are why the contract looks the way it does:

- **Vacuous by construction.** Six authored checkpoints pointed at test files that already existed and
  already passed. They would have gone green without one line of integration test being written.
- **Red for the wrong reason.** The obvious fix — "the checkpoint must fail before the work" — accepts
  any non-zero exit. A missing file, a bad import, a wrong CWD and an absent fixture all exit non-zero
  while asserting nothing. The checkpoint then goes green later because somebody fixed an import path.

**Only a named acceptance assertion that ran and failed proves anything.** That sentence is the design.

---

## 2. The contract, condensed

Full mechanics in TILLER-USAGE §5.3. What Helm must satisfy conceptually:

### 2.1 A fence is a functionality with a declared proof

Authored **at plan time, before its units are built**:

| Field | Meaning |
|---|---|
| `integration_cmd` | runs the journey, emits a **neutral machine-readable report** |
| `negative_control_cmd` | stubs ONE constituent; the journey must go red |
| `acceptance_ids` | stable ids tying each acceptance line to an assertion |
| contributing units | exact ids, ceiling of **5** |

Report shape: `{collected[], passed[], failed[{id, kind}]}`, where `kind` separates a real assertion
failure from infrastructure noise. **Never parse console output** — a heuristic reading "Error" as an
assertion failure misclassifies an ImportError, and a check that cannot discriminate looks implemented
forever while proving nothing.

### 2.2 Lifecycle

```
OPEN     run the journey BEFORE the first unit is built.
         Require a PROVING failure. Record which assertion ids failed + the test hash.
         Refuse if the only signal is env / import / not-found.
   ↓
DRAIN    units execute under the ordinary gate.
         A unit whose fence has no baseline is NOT dispatchable.
   ↓
CLOSE    same locked test (added assertions OK; a drop or rename refused)
       + every OPEN-failed id now passes
       + the negative control STILL turns the journey red
         All three mechanical ⇒ close with no reviewer spent.
   ↺
REPAIR   the VALIDATOR authors the unit test for each named failing unit,
         verified red on current HEAD, hash-locked; the implementer then
         iterates against a test it did not write. Max 3 rounds.
```

### 2.3 Routing rules

- **`fault_class=plan` skips the implementer ladder entirely.** Walking L1→L2→L3 on a broken plan burns
  three seats to rediscover the plan is broken.
- **The same seam twice routes to the planner automatically** — no judgement in the hot path. The
  fingerprint must be measured by the *conductor*, never reported by the reviewer: a reviewer emitting a
  fresh string each round would make the rule unreachable.
- **A missing verdict field fails closed**, never "no defect".
- **The planner may overrule the validator**, but must state *what the validator failed to see*, and must
  either name units that now have validator-authored tests or declare the failure plan-level. A bare
  overrule is refused, and it consumes a round.

### 2.4 The rule underneath all of it

**A cheap implementer is fine. A cheap validator is not — and an implementer must never define its own
success criterion.** Validator-authored repair tests exist for one reason: a failed composition is the
moment an implementer has demonstrated it misunderstood the problem, which is the worst possible moment
to let it write the test deciding whether it is done.

---

## 3. Mapping — same roles, stronger substrate

| Fence concept | Tiller (CLI) | Helm | Confidence |
|---|---|---|---|
| the conductor | `projcore-driver.py` drain loop | `OrchestratorLoop` | high |
| plan + units | `plan.md` pipe table | plancore planning phase | high |
| unit state | `queue.md` row + `advance-*.marker` file | DB rows, cycle/batch state | high |
| phases | implicit in the drain | `discovery → planning → implementation → final_tests → complete` (`cycle-service.ts:19`) | high |
| **OPEN** | driver step before first dispatch | **nothing today** — new gate on `planning`→`implementation` | — |
| **CLOSE** | driver-run probe + report | closest existing: `legd-batch-barrier` | **low — verify** |
| terminal capstone | `capstone()` | `final_tests` phase | medium |
| validator | independent tmux seat | `model-validation-service` | **low — verify** |
| repair re-queue | flip row + retire marker | **unknown — see §4** | — |
| briefs | generated `.md` files per dispatch | **self-hosted prompts** — see §5 | high |

---

## 4. What Helm gets for free — and the one thing it does not

This is the section that changed most once Helm is understood as Tiller-with-a-better-substrate.

### 4.1 Defects that are NOT reachable in Helm

The CLI side spent five review rounds on these. Helm should not re-derive them, and should not port the
workarounds either:

| CLI defect | Why it existed | Why Helm is immune |
|---|---|---|
| Repair undone by the reconciler | Unit state lived in **two places** — an uncommitted `queue.md` edit and an untracked marker file — in different durability domains. A `git reset` in a later park destroyed one and not the other. | One row, one transaction. There is no second artefact to fall out of sync with. |
| Partial multi-unit repair | Authored+requeued unit-by-unit; a failure on the second left the first reopened and the second closed. | Wrap the round in one DB transaction. Atomic by construction. |
| `U12.r1` unparsable as a plan id | Repair identity had to fit a regex shared by two parsers. | Real schema, real foreign keys. |
| Marker retirement subtleties | "Move the file to a subdirectory so a glob stops seeing it." | Not a thing. Set a column. |
| Fingerprint history lost when telemetry demoted | Control input was being read back out of a best-effort log. | Persist it in the row. Never read control state from a metrics sink. |

**The honest read: roughly half the CLI-side complexity is file-system compensation.** Helm should
implement the *contract* and skip the compensation.

### 4.2 The one that does NOT go away

**What does your restart reconciliation do to a unit someone deliberately reopened?**

On the CLI side this killed the repair path silently. The reconciler's rule was *"a completed marker with
an incomplete row means the row lost an edit — force it complete"*, which is correct for its own purpose
and fatal to repair: a reopened unit looks exactly like a lost edit. And restart is not the rare path —
it is *the* path, because a fence failure goes park → escalate → answer → resume.

Helm will have an equivalent: some code that reconciles cycle/batch state on boot or on resume. **Find it
before designing the repair path**, and answer: does it distinguish *"this was reopened on purpose"* from
*"this looks unfinished"*? If not, the repair path is dead on arrival there too, and it will pass its
unit tests while being dead.

### 4.3 What Helm can enforce that Tiller CANNOT

Being more deterministic and confined is not just fewer bugs — it is a stronger contract:

- **A real render gate.** Tiller's known limit is that it accepts `node --check` as proof, which passes
  syntactically-valid but semantically-broken JS; a UI slice can go green having shipped a blank page.
  This is why UI work is not routed to Tiller unattended. Helm has a real browser surface, so the
  rendered-app proof can be a *mechanical gate* rather than an instruction the validator is asked to obey.
- **Atomic phase transitions.** OPEN-before-units is an FSM invariant in Helm, not a hook someone must
  remember to call from the right place. That is exactly the defect that inverted the whole design on the
  CLI side (§6).
- **Prompt versioning.** See §5.

---

## 5. Self-hosted prompts — an advantage, and an obligation

Tiller generates a brief file per dispatch and sends it into a tmux pane. Helm holds its prompts. Three
consequences:

1. **The fence work adds prompts, not just code**: the OPEN authoring brief, the repair-test authoring
   brief (§2.4), and the fence-verdict contract. On the CLI side these are f-strings in a 3,000-line
   Python file — which is exactly why one of them silently briefed the wrong product for months (the
   capstone was hardcoded to one repo's file names). Helm should treat them as versioned, testable
   artefacts.
2. **The verdict contract is a schema, not a text convention.** `[FENCE-VERDICT-V1]` exists because a
   tmux pane can only carry text. Helm can require a structured response and reject a malformed one at
   the boundary — but the rule must survive the translation: **a missing field fails closed, never
   "no defect."**
3. **Prompt changes are behaviour changes.** If prompts are self-hosted and versioned, a fence's OPEN
   baseline should record which prompt version produced it, or a prompt edit silently changes what a
   recorded baseline meant.

---

## 6. The transferable lesson — read this before writing any of it

Across the CLI build, **eight** defects had the identical shape:

> Correct logic, fully unit-tested, **called by nothing** — or called from the wrong place.

Including the central one. The OPEN gate ran *after* all its units, because the hook sat where the
integration row got selected — and that only happens once every unit is already done. The invariant the
whole design rests on was inverted, and the reducer's unit test passed happily, because the reducer was
right. Both external reviewers found it independently; neither the author nor the test suite did.

Three sub-patterns, all worth watching for:

- **No caller at all.** Five helpers were written, tested, and never invoked: the repair-test authoring
  step, the hash-lock check, the plan-overrule validator, the context-timing parser, the contract cleaner.
- **Wrong caller.** The OPEN hook, placed one selection too late.
- **The test verifies the helper, not the call site.** The test written *specifically to catch* the
  wrong-caller bug still exercised the helper directly, so an implementation that never called it from
  the loop passed the entire file. The fix drives the real loop and asserts the **order** of calls.

And one more, cheap to avoid and expensive to find:

- **A comment asserting a behaviour the code does not have.** The plan-overrule path was documented as
  "counts as a repair round" and did not, so it was unbounded. A wrong comment is worse than none: it
  stops the next reader from checking.

**Budget review time accordingly.** The algorithms in this contract are simple. Nearly every hour of
review should go to *"can this fire, from where it is actually called?"* — in Helm's case, *"is this an
FSM invariant, or a function someone has to remember to call?"* Prefer the former every time; that
choice is most of what "more deterministic" buys.

---

## 7. What NOT to copy from the CLI side

- **Concurrency.** Tiller runs strictly one fence at a time and always will — its engine is single-writer
  by construction, and roughly half of last month's defects came from that assumption breaking. Helm has
  real transactions and may do better, but it should be designed for Helm, not ported.
- **File-based state mechanics** — markers, glob-based retirement, queue/marker reconciliation. §4.1.
- **The flag-gated cohort machinery** (`TILLER_SUITE_TIERS`, `TILLER_ATOMICITY`). That measures one open
  question about unit size; it is not part of the fence contract.
- **`legacy-v0` grandfathering.** That exists because two drains were live mid-run when the contract
  landed. Helm's equivalent question is its own.
- **`[FENCE-VERDICT-V1]` as a text line.** Keep the semantics (§5.2), drop the transport.

---

## 8. Open questions — answer before implementing

1. **Where does OPEN live in the phase model?** A gate on `planning`→`implementation`, a new phase, or a
   per-fence sub-state? This decides the FSM blast radius. Prefer whichever makes it an **invariant**
   rather than a call someone must remember (§6).
2. **What reconciles cycle/batch state on restart, and what does it do to a deliberately reopened unit?**
   §4.2 — the single highest-risk unknown.
3. **What is the report boundary?** Does Helm impose the report shape on project test commands, or own a
   runner adapter? (A runner adapter is the more Helm-shaped answer.)
4. **Can `model-validation-service` author a test, or only judge one?** §2.4 does not work if the answer
   is "only judge".
5. **Does `final_tests` already prove composition across fences,** or only within the last one? Two
   individually green fences can still fail where they interact — per-fence closure moves the gap up one
   level, it does not remove it.
6. **Render gate** (§4.3): make rendered-app proof a mechanical gate at the fence boundary? This is the
   clearest capability Helm has that Tiller does not.
7. **Prompt versioning in the OPEN baseline** (§5.3).

---

## 9. THIS EFFORT IS BUILT BY TILLER (JROM 2026-08-08)

The fence-enabled Tiller is the implementation pipeline for the Helm upgrade. north authors the effort,
projcore coordinates, Tiller drains it — against this repo. **So the Helm fence work is also the first
real fence run**, which is the deliberately-broken first fence recommended below, done on real work
rather than a toy.

That is the right call, and it has four preconditions that are not optional.

### 9.1 Keep "Tiller is broken" separable from "Helm is broken"

Tiller's fence support has **never executed**. If it is building Helm's fence support, a Tiller defect
and a Helm defect look identical from the outside — a parked slice with a confusing reason.

Mitigation: the Helm effort's own plan is fence-structured, so **every fence exercises Tiller's fence
path on work whose correctness is independently checkable**. When a fence behaves oddly, check
`<run>/dispatch/telemetry.jsonl` and `fence-open.*.marker` FIRST — if the OPEN baseline or the fingerprint
looks wrong, it is Tiller, not Helm, and it belongs in `wflow`, not in a Helm correction slice.

### 9.2 THE UI CONSTRAINT — this is the binding one

**Tiller has no render gate.** It accepts `node --check` as proof, which passes syntactically-valid but
semantically-broken JS; a UI slice can go green having shipped a blank page. The standing rule is: *do
not route UI/front-end-heavy slices to Tiller unattended.*

Helm is a UI-carrying app, and part of this upgrade touches the planner panel and discovery surfaces. So:

| Slice class | Route |
|---|---|
| FSM, plancore, schema, services, orchestrator loop | **Tiller, unattended** — this is most of the effort and it is exactly what Tiller is good at |
| anything that renders | **attended**, or held for a `/fast_lead` pass |

Split the plan on that line at authoring time. Do not discover it mid-drain.

Note the pleasing loop: §4.3 proposes Helm build the render gate Tiller lacks. Until it exists, Tiller's
own limitation constrains how it can build it.

### 9.3 helm-harness runs FROM this repo — that is a live conflict

`helm-harness` (pm2 id 12, up 2 days) serves from `/home/agjrom/websites/Helm`, and Tiller will be
committing into that same working tree. Standing rules that now bind this effort:

- **NEVER `pm2 restart helm-harness` while a Helm cycle has `status='active'`** — the engine auto-resumes
  on boot and corrupts in-flight runs.
- The Helm suite must stay **fork-capped and pointed at a temp DB**. `.tiller/suite-cmd.sh` already does
  both, and both are load-bearing, not tidiness: uncapped vitest spawns one fork per core, browser tests
  hit ~3.5GB per fork, and the box OOMs — killing every tmux session, including the drain doing the work.
- `.tiller/side-effect-probe.sh` is already present and reads `schema_version`, so a park that silently
  migrated the live DB is reported rather than hidden. Keep it.

### 9.4 Repo state before launch

- `.tiller/suite-cmd.sh` and `.tiller/side-effect-probe.sh` — **present**. `suite-cmd.sh` is currently
  **untracked**; commit it, or a run's pre-dispatch product-clean check has to reason about it.
- `.tiller/capstone-brief.md` — **absent**. Optional; add it if `final_tests` needs Helm-specific
  criteria beyond the now-project-generic capstone.
- `<run-dir>/fence-contract.json` — **required at `start`** once the plan has any `INTEGRATION:` row.
  north authors it; a fence with no `negative_control_cmd` is refused.

---

## 10. Suggested sequencing

1. Answer §8.1 and §8.2 — they set the schema and the FSM blast radius.
2. Fence object in the plan schema + a planning-phase refusal when a fence has no negative control.
3. OPEN gate, **as an FSM invariant**, with a test that drives the real transition and asserts ordering.
4. CLOSE: report + locked test + negative control.
5. Repair path last — hardest, and worth having everything else working so a round can be watched
   end to end.
6. Then instrumentation. Per §9 the effort IS the first fence run, so the deliberately-failing fence
   is real work rather than a rehearsal.

**No fence has executed anywhere yet** — not on the CLI side either. Both systems are adopting a
mechanism that is designed, reviewed and tested but not proven in anger. Worth stating plainly, and worth
making Helm's first fence a deliberately-failing one.

---

## Appendix — pipeline status at time of writing

| Component | State |
|---|---|
| Tiller engine + 5 modules | built, 22 test files green, `wflow` @ `e8e1785` |
| `TILLER-USAGE.md` §5.3 | the contract authority, `e1fc601` |
| north (Claude / codex / grok) | done — one symlinked neutral core reaches all three |
| projcore (Claude / codex / grok) | done — three pointers to §5.3, `f2eff80`. Deliberately **not** three copies: the same rule written three times is how UI-PROOF ended up present in two runtimes and absent in the third |
| Live drains | untouched, still on pre-fence code; they land in the frozen `legacy-v0` lane on restart |
| Outstanding | grok45/sol have not yet verified the last round of fixes |
