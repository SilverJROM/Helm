# Parallel safety — the correct decomposition, verified against the code

**By** `[north]` `helm-97`, 2026-07-30 07:4x PHT
**JROM:** *"i dont want to focus on the hours or projected savings i want you to focus on the correct
path on doing the parallel with the least or much more reliable path where we would not have conflict or
collisions as well as dependencies as that would be the part that is most critical"*

opus5's **file-ownership streams** are the right idea. But its partition is **not actually disjoint**.
Six collision surfaces, each verified against the source, plus the fix for each. Correctness only — no
time claims in this document.

---

## The principle that makes this safe

> **Create pure new modules first → build service internals in parallel behind ADDITIVE-ONLY
> signatures → touch shared hosts only inside serialized integration waves.**

A stream is safe to run concurrently **only** if everything it writes is invisible to every other
stream until an integration wave wires it. Three things break that: a shared file, a shared *scarce
identifier*, and a non-additive type change. All three are present.

---

## C-1 — Migration versions are a globally-ordered scarce resource *(highest risk)*

**Verified:** `src/db/schema.ts:5` is `export const SCHEMA_VERSION = 112`, and the file carries **one
ordered migration list** (`v100`, `v104`, `v105`, `v107`, `v109`, `v111 S08`, `v112 S13`).

**Collision:** slices implying new persisted state span **two different streams** —
**C10** (INGEST: transactional ingest) and **D6 / D8 / D9** (HANDOFF: frozen discovery bytes, handoff
state). Each needs "the next version". Two seats both writing `v113` conflicts, and it surfaces **at
merge**, not while either seat is working — the worst possible time.

**FIX — pre-allocate version numbers in the plan.** `[north]` assigns each schema-touching slice its
exact version number **before dispatch**: D6→`v113`, D8→`v114`, D9→`v115`, C10→`v116` (final order set
at handoff). Numbers become owned constants, not a contended counter, so the streams stay concurrent.
`SCHEMA_VERSION`'s final value is bumped **once**, by the integration wave, to the highest allocated.

**Rule:** no slice may invent a version number. A slice that needs one and wasn't allocated one **halts
and asks `[north]`**.

## C-2 — `src/index.ts` is a shared host, not API/UI's file

**Verified — three streams need it:**

| what | line | opus5 stream |
|---|---|---|
| provenance gate call site | `index.ts:2996-2999` | **PROV** (D5) |
| start-planning guards | `index.ts:2909-2922` | **API/UI** (D2) |
| handoff endpoints (4 refs) | — | **HANDOFF** (D8/D9) |

opus5 assigned `index.ts` to API/UI **exclusively**. That is wrong, and it is the file every route
lands in.

**FIX — `index.ts` is not owned by any build stream. It belongs to the integration waves.** Build
streams change *service internals* and export a **stable signature**; the integration wave performs all
`index.ts` wiring, one owner, serialized. A build slice that thinks it needs an `index.ts` edit has
mis-scoped its seam.

## C-3 — Non-additive type changes create invisible compile-time edges

**Verified:** `PlanningResult` is declared at `planning-phase-service.ts:156` (**PPS**), and
`run-orchestrator-service.ts` references it / `planningRes` **14 times** (**RO**).

D4 changes `PlanningResult` to carry the accepted plan bytes + SHA. That is not a file collision — PPS
and RO are different files — but **RO will not typecheck until PPS lands**. A hidden serialization edge
that no file-ownership table shows.

**FIX — every cross-stream type change is ADDITIVE ONLY.** New fields are **optional**
(`acceptedPlan?: {...}`), never required, never renamed, never re-typed. Then RO compiles identically
before and after, and the ordering edge disappears. Consumers start reading the new field in a later
slice or at integration.

**Rule:** a slice that must make a *breaking* signature change is not parallel-safe — it moves into an
integration wave.

## C-4 — The three "stream-owned" capstone tests are not isolated

**Verified imports:**

| test | opus5 owner | actually imports |
|---|---|---|
| `b9-gate-atomic.capstone.test.ts` | PPS | cycle-chat-file, cycle-service, project-docs, project-service |
| `a15-worker-finalize.test.ts` | WRF | lifecycle-cas, project-service, run-artifact, session-registry |
| `cycle-terminal-on-run-complete.test.ts` | RO | agent-assignment, cycle-service, escalation, fake-transport |

None is a unit test of its assigned stream. Each is cross-cutting, so **any** stream's change can break
it — and assigning it to one stream means that stream gets blamed for a break it did not cause. This is
exactly the "surprise at integration" JROM is trying to avoid.

**FIX — these three move to the INTEGRATION waves.** They are integration proofs, not slice gates. Each
build slice instead gets a **new, dedicated unit-test file** it owns outright. That is what makes
"unit-tested before integrating" true rather than nominal.

## C-5 — Build the pure new modules FIRST (they are the only zero-risk work)

**Verified NEW** (no conflict possible): `src/services/plan-revision.ts`,
`src/services/planning-review-round.ts`.

**FIX — these are wave 0, alone.** A pure module with no importers cannot collide with anything, and
once it exists every dependent stream imports a **stable** surface instead of racing a signature. B1
(`plan-revision.ts`) is already shaped this way; extend the pattern — extract a pure helper wherever a
stream would otherwise have to edit a shared file.

## C-6 — `planning-phase-service.ts` has 5 slices and cannot be split by ownership

**Verified:** both grok45 and sol reached this independently. grok45: *"Do not pretend C2–C8
parallelise. That is the remaining serial spine of P2."* sol: *"`planning-phase-service.ts` gets one
integration owner… I1, I2, and I3 are serial and never have concurrent writers."*

**FIX — accept it as serial. Do not engineer around it.** One owner, one seat, in order. The correct
mitigation is C-5: move logic *out* into pure modules so the file becomes a thin host — reducing what
must be serial rather than pretending it isn't.

---

## The corrected partition

**Wave 0 — pure new modules, zero collision risk.** `plan-revision.ts`, `planning-review-round.ts`
skeleton. No shared file, no shared identifier, no type change.

**Build waves — concurrent, each stream owning only files no other stream writes.**
`worker-runtime-finalize.ts` · `brief-writer-service.ts` · `real-transport.ts` ·
`plan-parser-service.ts` · `planning-provenance-service.ts` · `discovery-handoff-*.ts` · `app.js`.
Every slice gated by its **own new** unit-test file. Additive-only signatures. Pre-allocated migration
numbers.

**Serial spine — `planning-phase-service.ts` (A5, A6, B-wire, B6, C2–C8, C7).** One owner, in order.

**Integration waves — the only place these are touched:** `src/index.ts` wiring · the single
`SCHEMA_VERSION` bump · the three cross-cutting capstone tests · consumers adopting additive fields ·
`npm run build` + `:3110` UI proof.

## Standing rules for every seat

1. **Never invent a schema version number.** Unallocated → halt and ask `[north]`.
2. **Never edit `src/index.ts` in a build slice.** Need it wired → it is an integration item.
3. **Cross-stream type changes are additive and optional only.** Breaking change → integration wave.
4. **Never edit a file another stream owns**, even trivially. Need a change there → halt and ask.
5. **Your gate is your own new unit-test file.** The three capstone tests are not yours to satisfy.
6. Ordering laws unchanged: **A0 first · P1 before P2 · C8 last of the P2 core · A1→A6 serial.**
