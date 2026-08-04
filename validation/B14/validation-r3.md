# B14 validation R3 — fix2 (fail-closed staging rollback kill on live-replace path)

Validator: claude-opus-5 L3 (rev 3)
Tip: `e170ec5` (`fix(B14-fix2): fail-close staging rollback kill on live-replace path`)
Parent: `7ebc9c8` (R2 tip, **FAIL** on claim 2)
Verdict: **PASS** — the R2 FAIL is closed, and closed without the 409-dispatch regression R2 warned it could cause.

`HELM_SESSION_JANITOR=0` throughout; fake-exec only, no live tmux, no live reap; no product edits
(`git status --short` shows only the untracked `validation/B14/` artifacts at exit).

## Scope

Single question: is `createSessionReplacingLive`'s staging rollback kill genuinely fail-closed at this tip?
Claims 1 (mandatory `onCreate` token) and 3 (`RealTransport` cannot create unhooked) PASSed at R2 and are
untouched by `e170ec5` — re-confirmed present, **not** reopened. Focused tests only; no full suite.

## Verdict by check

| # | Check | Verdict | Evidence |
|---|---|---|---|
| C1 | All three staging branches routed; no residual swallow | **PASS** | `:729` terminate-throws, `:732` CAS-refusal, `:747` rename-fails all call `rollbackOrphanSession`. Structural proof below is stronger than a `.catch(() => {})` grep |
| C2 | Rollback helper cannot fall through | **PASS** | All three exits throw (`:851`, `:853`, `:858`); `sessionExistsTriState` cannot throw; the `never` contract is **compiler-enforced** (TS2534) |
| C3 | Behavioral repro on every branch | **PASS** | Shipped fix2 tests cover CAS-refusal + rename; probe **P2** covers the terminate-throws branch that nothing shipped covers |
| C4 | **409 dispatch not regressed** | **PASS** | Probes **P1** + **P4**: collision identity preserved whenever nothing leaked. Double-failure → clean 500, deliberate |
| C5 | Fail-closed on ambiguity | **PASS** | Probe **P3**: probe `null` → `AggregateError`, not a bare rethrow |
| C6 | Rollback targets `stagingName` only | **PASS** | All three call sites pass `stagingName`; asserted by P1 and by the shipped rename test |
| C7 | Focused regression + typecheck | **PASS** | 58/58 (5 files); `tsc --noEmit` exit 0 project-wide |

## C1 — the swallow is gone, structurally

The three branches now read `await this.rollbackOrphanSession(stagingName, …)` (`tmux-service.ts:729/732/747`).
Rather than rely on grepping for the specific `.catch(() => {})` shape the R2 defect wore, I checked the
two properties that make *any* variant of it impossible in this file:

- **`killSessionRaw` has exactly two call sites** — `:847`, inside `rollbackOrphanSession`, and `:965`,
  inside `terminateSession` (which propagates the rejection to its caller). There is no third raw kill to
  swallow anything with.
- **The file contains zero `.catch(` expressions.** The only textual match is prose inside the
  `rollbackOrphanSession` doc comment at `:834` describing the defect that was removed.

So the fail-closed property is not "the three known sites were patched" — it is that no un-surfaced kill
path remains in `TmuxService` at all. That also covers the fresh-create path (`spawnTaggedSession:795`,
`publishCreatedSession:818/822`), which fix1 had already closed.

## C2 — the "always throws" invariant is enforced, not assumed

`createSessionReplacingLive:728-730` catches, calls the helper, and does **not** rethrow; `:731-740` has no
`else`. Both are correct only if `rollbackOrphanSession` can never complete normally. If it ever did, the
`!closed` branch would fall through to `rename-session` and rename the staging session **over a still-live
old session** — strictly worse than the R2 bug. I therefore treated this as load-bearing rather than style.

- Every exit throws: `:851` (probe proves gone → bare cause), `:853` (`AggregateError`), `:858` (kill
  succeeded → bare cause).
- `sessionExistsTriState:289-313` cannot throw — both the name-validation path and the probe path are
  fully caught, returning `null`/`true`/`false`. So the helper's own `catch` has no escape that returns.
- **The contract is compiler-enforced.** A scratch probe compiled with the project's `tsc` shows a variant
  of the helper with one falling-through path is rejected: `error TS2534: A function returning 'never'
  cannot have a reachable end point.` A future edit that made it return would fail the build.

Nuance recorded as OBS-2: TypeScript's *flow analysis* does not treat `await helper()` as terminating
(the same probe produced `TS2366` for a caller relying on it), so `:728-740` carries no local type-level
guard. Safety rests entirely on TS2534 at the helper's definition. Sound today; a readability point, not a defect.

## C4 — the regression R2 predicted did not happen

R2's implementation note warned that routing the CAS-refusal branch through `rollbackOrphanSession` would
change the thrown type from `SessionNameCollisionError` to `AggregateError` and silently break the B08/B09
409 handling at `index.ts:1124` and `:1355`. This was the likeliest way for fix2 to trade one defect for a
worse one, and neither R3 redteam tested it. Verified by execution against the **exact** predicate from
those two handlers:

- **P1 — CAS refuses, rollback kill succeeds (the common case).** Throws the original
  `SessionNameCollisionError`; `code = SESSION_NAME_COLLISION`, `name = SessionNameCollisionError`,
  `reason = replace_refused`, `sessionName` intact; `indexCollisionDispatch(err) === true` → **409 preserved**.
  Mechanism: `causeErr = cause instanceof Error ? cause : …` (`:845`) and `SessionNameCollisionError extends
  Error` (`:141`), so `throw causeErr` rethrows the *same object*, not a copy.
- **P4 — kill fails but the probe proves the session gone (benign race).** Also throws the bare collision
  error → 409 preserved. fix2 does not over-escalate a case where nothing actually leaked.
- **Double failure (kill failed *and* session live/unknown).** Throws `AggregateError`, which fails all three
  disjuncts at `:1124`/`:1355`, then fails the `'not validated'` check, and lands on
  `reply.code(500).send({ error: e.message })`. That is a clean 500 whose message names the surviving staging
  session — not a crash, not an unhandled rejection. It matches the commit message's stated intent (a
  compounded failure must not be softened into a retry-me 409) and I agree with the trade: a 409 tells the
  caller "retry", which is exactly wrong when a live orphan is holding the name's neighbourhood.

## C3/C5 — behavioral evidence

Shipped fix2 coverage is genuine: `create-session-safe-replace.test.ts:347` (CAS-refusal) and `:403`
(post-old-close rename) both force a failing staging kill and assert `AggregateError`, both causes, a
still-live **and still `@helm_child`-tagged** staging orphan, and final-name protection. I re-ran them
rather than reading them only.

Three gaps remained, which my probes close:

- **P2 — terminate-throws branch (`:728-730`)**, covered by no shipped test. `redteam-sol-r3` noted the gap
  and reasoned it safe by inspection; I verified by execution. Result: `AggregateError` carrying both
  failures, message naming the staging session, orphan confirmed live + tagged.
- **P3 — unknown-probe fail-closed.** Shipped tests exercise only `stillThere === true`. With an ambiguous
  probe failure (`null`), fix2 still throws `AggregateError` — unknown is treated as "may still be live",
  which is the whole point of fail-closed.
- **P4 — no over-escalation** (above).

```
[P1] ctor = SessionNameCollisionError   reason = replace_refused   index 409 dispatch = true
[P2] ctor = AggregateError   inner = ['kill-session boom (helm-w-r3-p2)',
                                      'kill-session boom (helm-w-r3-p2-stg-ms517uyr6cg2a1)']
[P3] ctor = AggregateError   probe result = null
[P4] ctor = SessionNameCollisionError   probe result = false   index 409 dispatch = true
```

## Runs

```
HELM_SESSION_JANITOR=0 npx vitest run \
  src/tmux/tmux-helm-child-tag.test.ts src/tmux/session-registry-hook.test.ts \
  src/tmux/create-session-safe-replace.test.ts src/tmux/terminate-cas-order.test.ts \
  src/services/real-transport-lifecycle-cas.test.ts
→ 58/58 passed (5 files)   [R2 was 56/56; fix2 added the 2 staging-rollback tests]

HELM_SESSION_JANITOR=0 npx tsc --noEmit → exit 0, project-wide

Validator probes (temporary, removed from src/ after execution; sources + run output preserved here):
  r3-probes.test.ts.txt / r3-probes-run.txt → 4/4 passed (P1 409-identity, P2 terminate-throws,
                                                          P3 unknown-probe, P4 proven-gone)
```

Full suite **not** run, per brief.

## Independence from the redteams

`redteam-sol-r3.md` and `redteam-codex55-r3.md` both returned CLEAN on this tip. Both are static-only; neither
executed the 409-identity path (C4), the unknown-probe path (C5), or the terminate-throws branch (C3). I read
them for coverage but verified every claim first-hand. My PASS rests on the probes above, not on their agreement.

## Residuals (not blocking, recorded)

- **OBS-1 — dropped `lastPaneSnapshots.delete` in rollback** (carried from R2, unchanged by fix2). `killSessionRaw`
  does not clear the S09 pane-snapshot baseline the way `terminateSession` does. Inert in practice; costs at most
  one suppressed or spurious `touchSession` on a future same-name session.
- **OBS-2 — `never` contract is non-local** (see C2). Enforced by TS2534 at the helper, invisible at the three
  call sites. An explicit `throw await …` would make the invariant local. Cosmetic.
- **OBS-3 — old-name orphan on the terminate-throws branch (NEW, surfaced by P2, out of B14 scope).** `terminateSession`
  performs the registry CAS (`markReaped`) *before* `killSessionRaw` (`:947-965`). If that kill fails, the **old**
  name is left registry-reaped but physically live — a second orphan, on a different name than the staging one, from
  the same failure. fix2 behaves correctly here (the `AggregateError` surfaces the compound failure), and the
  ordering is deliberate and **pre-existing**: introduced by `280bd7f fix(B02): CAS markReaped before kill-session`,
  untouched by all three B14 commits. Flagging for a follow-up ticket, not for this fix cycle — B14's staging scope
  is closed.
- **Disclosed fix1 collateral still open, unchanged by fix2.** The mandatory-token tightening still breaks real-tmux
  suites that build a bare `new TmuxService()` (~20 unhooked constructions across `p1-5a`, `p1-5b`, `p1-6a`, `p1-6b`,
  `run-orchestrator-service`). Test-harness debt from a correct product tightening; `changes.md` discloses it accurately.

## Conclusion

The R2 FAIL is closed. Every post-tag failure branch on both create paths now surfaces a failed rollback kill
instead of hiding it, the fail-closed reading holds on the ambiguous (`null`) probe as well as the live one, and
the collision→409 contract that R2 flagged as the trap survives intact in every case where nothing actually leaked.
AC19's create-path ownership guarantee is fully closed at `e170ec5`.

**No further fix cycle required for B14.**

---
*Artifact location note: R1/R2 reports live in `plan/janitor-audit-remediation/validation/B14/`; the R3 redteams and
this report were written to `./validation/B14/` per the R3 dispatch instruction. Worth consolidating at batch close.*
