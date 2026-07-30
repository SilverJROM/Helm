# D-02 — S03: the guard fails closed; it does not attempt recovery

**Effort:** `discovery-planning-handoff` · **Decided by:** `[north]` `helm-97`, 2026-07-29 03:5x
**Authority:** JROM's standing delegation — *"you settle any decisions with grok45 or sol"*, TG only on
blocker/completion. Escalation `S03-CONVERGENCE-STALL-FINAL.md` named JROM as `blocker_owner`; that is
**reassigned to `[north]`.** JROM is not being woken for this.

---

## The situation

S03 (role-aware current-cycle document guard) burned **5/5 fix cycles**. Each cycle closed one
filesystem-tampering class and the next red-team round found the next one:

| # | Class closed | Commit |
|---|---|---|
| 1 | leaf directory replace | `e268aa0` |
| 2 | leaf non-regular / symlink | `e0cab6d` |
| 3 | leaf chmod0 / EACCES | `7339112` |
| 4 | parent dir chmod0 | `e9c9f87` |
| 5 | parent as plain file (ENOTDIR) | `b728f2c` |
| **6** | **parent as symlink — OPEN CRITICAL** | — |

Open finding: swap the bound `cycle/<folder>` parent for a symlink; the content-mismatch **restore
write follows it and writes outside the project fence**, and the parent is never restored.

Tests: `src/s03-discovery-doc-ownership.test.ts` 17/17 green (does not cover parent-symlink).

## The diagnosis the fix cycles kept missing

**This is whack-a-mole because the guard is trying to REPAIR anomalous filesystem states.** Every new
class comes from the *recovery* path — `removePathWithoutFollowing` → `mkdirSync(recursive)` →
`writeFileSync` — being driven through a path shape the agent controls.

The structural problem, stated once:

> The guard runs **unsandboxed** in the Helm harness process. The Discovery agent runs **sandboxed**
> inside the project fence. Letting the guard perform writes through path structures the agent can
> reshape makes the guard a **confused deputy** — an unsandboxed writer taking direction from a
> sandboxed process. Handling one more errno does not change that; it just moves the boundary.

Note also `enforceProtectedEntry`'s bare `catch {}` swallowed a real `EEXIST` in class 5. A recovery
path that silently absorbs its own failures cannot be reasoned about.

## The decision

**Fix cycle 6 is authorized — but as a change of failure mode, not another errno patch.**

The guard **fails closed**. It must never write unless the path shape is provably exactly what it
expects. Mandated mechanism:

1. **No-follow resolution.** Resolve the protected path without following symlinks at any segment
   (`lstat` each ancestor, or `openat` with `O_NOFOLLOW|O_DIRECTORY`).
2. **Containment assertion before ANY write.** Every ancestor from fence root to leaf parent must be a
   *real directory*, and the resolved parent must be inside the fence.
3. **On assertion failure: do nothing.** No `unlink`, no `mkdir`, no `writeFileSync`. Record a
   tampering event, surface it, and stop guarding that path. **Refusing loudly beats repairing blindly.**
4. **No bare `catch {}` on the restore path.** Every swallowed error becomes an explicit, logged branch.

**Fail-closed is strictly safer than today's behaviour in every open class.** Right now an anomalous
state either silently does nothing (class 5, swallowed `EEXIST`) or writes outside the fence (class 6).
Both are worse than a loud refusal.

## Hard cap — this is S03's last fix cycle

If red-team R2 is not clean after fix 6:

- **S03 ships as-is** (5 classes closed + fail-closed semantics + 17/17 green).
- The residual hardening splits to a new slice **S03b**, appended **after S14**, with its own ACs.
- **`S04` auto-drains immediately either way.** The run does not park again on S03.

## Why not block the effort on this

The product requirement — *Discovery cannot create/replace/unlink/rename `og-requirements.md`,
`plan.md`, `plan.json`* under normal operation — **is met and proven**. The residual requires a
**deliberately hostile** agent performing directory-swap tampering to escalate through the guard.

That is a genuine hardening gap and it is tracked, not dismissed. But it is **not the defect this
effort exists to fix** — that defect is Discovery authoring a plan and skipping the planners — and
**11 slices are parked behind it**, including the two JROM actually asked for: the ask-first bridge
(S10-S12) and configured-planner staffing (S05-S06). Blocking those on an exotic tamper class is the
wrong trade.

## Rejected options (from the escalation)

- **"Settle COSMETIC / force VERIFIED"** — refused. The finding is real; a fence-escaping write is not
  cosmetic. Marking a known CRITICAL as verified is how `janitor-consent-redesign` earned a NOT-SAFE
  audit. Never force a gate green.
- **"Abort S03"** — refused. Five closed classes and the core requirement are real, working value.
- **"Open-ended fix cycles"** — refused. Five cycles produced five classes; there is no evidence the
  enumeration terminates. Change the mechanism or split, do not keep patching.

## Process gaps this exposed (fixed separately)

1. **No watcher caught a 28-minute park.** Both key on `STATUS: BLOCKED|URGENT`; this escalation said
   *"JROM decision required"*. The watchdog read the coordinator writing an escalation as activity and
   returned HEALTHY — it measures **liveness, not progress**.
2. **The status reporter reported `0/0` twice to JROM** — it parsed `queue.md` for numeric batch ids
   when this effort's table is `plan.md` with `S01`-`S14` ids. The watchdog shares the defect
   (`batches_verified=0`).

Both are `[north]` defects. Fix: watchers must trigger on **verified-count not advancing**, not on
liveness or a magic status string.

## Related

- `escalations/S03-CONVERGENCE-STALL-FINAL.md` — the escalation this answers
- `validation/S03/redteam-r2-findings.md` — the finding
- `D-01-planning-start-is-manual-confirm-only.md`
