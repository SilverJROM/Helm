# SYNTHESIS — Planning path panel (grok45 · sol · opus)

**By** `[north]` `helm-97`, 2026-07-30 06:2x PHT · **Verdict: unanimous `NEEDS-RESTRUCTURING`**
Sources: `findings-grok45.md` (331L), `findings-sol.md` (209L), `findings-opus.md` (502L)

---

## The one-sentence diagnosis all three reached independently

**The phase shape is right; the protocol between phases is not enforced by anything.** Agreement is
implemented as *prompt instructions to cooperative agents*, polled passively by the engine. So every
new cooperative assumption — partners wait, plancore revises, partners re-verdict, "round cap" means
rounds — is discovered to be false only by burning a run.

> grok45: *"a cooperative multi-agent chat with a passive timeout poll, sold as an engine-owned
> agreement protocol… stop patching briefs as the protocol layer."*

**This is the answer to "why have 3-4 attempts failed."** Each fix was correct and each was a brief
change. A brief is not a protocol.

## CONVERGENT — found independently by all three (highest confidence)

| # | Defect | grok45 | sol | opus | Class |
|---|---|---|---|---|---|
| C1 | **Stale CLEAN counts as agreement on a plan that seat never saw.** Verdict callbacks carry no plan SHA, so the gate combines seat-A's CLEAN on revision R1 with seat-B's CLEAN on R2 and ingests R2, which A never reviewed. **Fail-OPEN.** | F1/F9 | #1 | F1 | **DANGEROUS** |
| C2 | **Round 2 has no engine actuator.** `roundCap` is a wall-clock multiplier (`PLANNING_TIMEOUT_MS * roundCap`), not a round machine. There is **no `transport.send`**, and inspect/resubmit runs only for `brainRole` — a partner whose turn ended cannot be re-engaged. | F1/F2 | #3 | F2 | **BLOCKING** |
| C3 | **Phantom `ibrain` idles the REAL brain session.** Planning-block teardown synthesizes `helm-ibrain-<slug>`, defaults provider/model to `unknown`, registers-if-missing, and reconciles the **global** registry **by name** → marks a live persistent session `idle` = the janitor's target. | F4 | #6 | F6 | **DANGEROUS (E5-class)** |
| C4 | **Failed planning marks the cycle `complete`** — wedges the new bridge and (opus) stamps an immutable topology freeze. | F5 | #5 | F5 | BLOCKING |
| C5 | **Legacy Start Planning rewrites Discovery docs** (opus: confirmed by bytes). | F6 | #7 | F8 | **CORRUPTING** |
| C6 | **Provenance pins a different plan than the one ingested** — hashes mutable files after agreement, non-fatal. | F11 | #10 | F7 | DANGEROUS |

## UNIQUE — single-source, high value

- **opus F3: partners are never told where the canonical plan is — both runs' partners *guessed* it.**
- **grok45 F3: both partner seats share `role: deliberation`** → on-disk brief collision; the second seat
  is structurally fragile. **This explains why partner-2 has never once rendered a verdict.**
- **opus F4:** no first-callback/submit watchdog on partner seats (only plancore has one) — a brief stuck
  in a partner's composer is never rescued.
- **sol #2:** a confirmed handoff on an *autonomous* cycle creates an active `executing` run with **no
  execution driver**.
- **sol #4:** planning workers are DB-finalized **before** transport cleanup → sessions leak and poison retries.
- **sol #13:** adaptive planning is a **second planner** with weaker, incompatible agreement semantics.
- **sol #14:** plan ingestion is **non-transactional** → partially executable run.
- **opus F10:** the non-convergence exit can **throw** instead of returning the mechanism-level blocked reason.
- **opus F11:** the 20 ms poll now runs for the full 30 minutes.

## THE PANEL'S PRESCRIPTION (grok45's sketch, corroborated by sol + opus)

1. **One entry.** Confirmed handoff only for cycles that have Discovery docs; **delete rediscovery** on
   Start Planning.
2. **Engine-owned rounds.** artifact-ready → spawn/review → collect verdicts → if BROKEN and
   round < cap: plancore revises (engine waits for a **new plan hash**) → **respawn** partners → else
   BLOCKED. Cap = **integer rounds**, not a time multiplier.
3. **Unique seat identity** on disk and in transport (brief path / role includes seat id).
4. **Terminal policy:** planning failure ≠ cycle `complete` ≠ topology freeze ≠ ibrain finalize.
5. **`PLAN-READY` ≠ agreed.** Only the **engine** emits agreement / ingest permission.
6. **Token-free tests** for: convene-before-artifacts · BROKEN→revise→CLEAN · partner1 CLEAN +
   partner2 BROKEN · partner-2 silent until timeout · legacy path refuses when north-star exists ·
   ibrain row count unchanged on planning block.

> grok45: *"Until (2)+(4)+(1) land, further brief-only fixes will keep producing 'fixed, proven on run
> N, died on run N+1.'"*

**The key architectural consequence of C2:** because a seat's CLI turn *ends* after its verdict and
there is no `send`, a review round cannot reuse a seat. **Each round must spawn a FRESH partner seat
against the current plan hash.** That single realisation makes the round machine implementable.

## `[north]`'s RECOMMENDED SEQUENCING — safety before capability

**P0 — stop active harm (small, independent, no design work).**
C3 ibrain teardown (terminalize only an existing run-linked runtime; never register-if-missing; never
reconcile the global registry by inferred name) + C4 don't mark a cycle `complete` on a failed run.
These corrupt state on **every** failed planning run today. `HELM_SESSION_JANITOR` stays `0` until C3 lands.

**P1 — make failure honest (small, high value).**
C1: put the plan SHA on every verdict callback and refuse agreement unless **every** seat's CLEAN is for
the **current** plan hash. This converts the fail-OPEN gate to fail-closed **before** convergence works —
so the worst case stays "honest failure" instead of "silently shipped an unreviewed plan."

**P2 — the actual restructuring (a real effort, slices + red-team).**
Prescription items 2, 3, 5 + opus F3 (pass the canonical plan path explicitly) + opus F4 (partner
watchdog). This is the engine-owned round machine with fresh seats per round.

**P3 — cleanup.** C5 one entry path, C6 provenance pins the ingested bytes, sol #13 adaptive-planning
divergence, sol #14 transactional ingest.

**Do P1 before P2.** Order matters: P1 makes the system safe while still broken; P2 makes it work.

**Note the counterintuitive corollary:** today's fast-fail is *safer* than the half-fix I had in
flight. Shipping A1 alone would have traded an honest failure for a possible silent bad-plan ingest.
Halting it was correct, and "do nothing" beat "ship half."
