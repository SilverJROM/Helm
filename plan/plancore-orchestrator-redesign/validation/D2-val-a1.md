# D2 validator evidence — attempt 1

Scope: validate `src/services/seat-draft-store.ts` (commit `8905059`) against **R2.6** — blind round-1
drafting enforced at the storage layer / OS layer, not merely "the brief omits the path."

Verifier ≠ fixer: no product code was written by this seat.

## Focused test — run exactly as written in the D2 slice row

```sh
npx vitest run src/services/seat-draft-store-isolation.test.ts --minWorkers=1 --maxWorkers=4
```

Result: **PASS** — `Test Files 1 passed (1) / Tests 13 passed (13)`, exit 0.
Full verbose transcript: `validation/D2/vitest-isolation-a1.txt` (13 named tests, zero skipped —
`grep` for `.skip/.only/.todo` in the spec returns nothing).

Regression (not requested by the row, run as containment insurance — all green, exit 0):

| Suite | Result | Why run |
|---|---|---|
| `src/services/seat-draft-store.test.ts` (D1) | 13/13 PASS | D2 re-homed every draft path under `planning-drafts/<seatId>/` |
| `src/services/plancore-redesign-safety-pins.test.ts` (S0) | 4/4 PASS | run-level safety pins |
| `npx tsc -p tsconfig.json --noEmit` | exit 0 | new product code compiles |

`grep -rn seat-draft-store src/` shows **no consumer outside its own two specs**, so the path-nesting
change cannot have orphaned a flat-path caller.

## AC verification (R2.6)

R2.6 requires: seat-private storage a co-drafting seat *cannot read or list* before commit, **enforced at
the storage layer**, **proven by a test that attempts a cross-seat read/list and asserts denial**.

| Brief clause | Mechanism | Evidence |
|---|---|---|
| Own draft dir + read-only context only | `composeSeatDraftReadAllow` returns `[ownDir, ...contextInputs, ...deploymentAllow]`; peer dirs are never added | isolation spec tests 1–7 |
| Peer dir outside the allowlist *entirely* | `assertNoPeerDraftAccess` — bidirectional overlap check (`grantOverlapsTarget`) + widening block on `runDir` / `planning-drafts/` | tests 2–6 |
| Typed BLOCK before any tmux side effect | `SeatDraftIsolationError{code:'SEAT-DRAFT-ISOLATION'}` thrown by the pure composer, which runs *before* `transport.spawn`; `RealTransport` additionally composes `strictEnv` at `real-transport.ts:230` **before** `createSession` | tests 8–10 assert `createSession`/`sendCommand` call counts are 0 |
| Compiled sandbox proves process-level denial | `helm-sandbox` (Landlock ABI v4, `HELM_SANDBOX_RO_PROFILE=strict`) | tests 11–12 + independent probe below |
| Engine (outside sandbox) reads both once committed | `publishDraft(runDir, seatId)` re-reads disk via `readPlanRevision` | test 13 |

Isolation unit is nested one level (`<runDir>/planning-drafts/<seatId>/`) precisely so Landlock
`PATH_BENEATH` can grant one seat's directory without the grant recursively covering its peer.

**Deployment-inertness trap (`plan-opus5.md:99-115`) is closed.** `HELM_STRICT_READ_ALLOW` is unset on
this box, so a seat that *inherited* the deployment default would run read-all and R2.6's OS layer would
be inert. `composeSeatDraftReadAllow` does not read that env var — it composes the per-seat fence
**unconditionally** and merges any deployment list in as an optional extra. Blindness is a correctness
invariant here, not a deployment option. Confirmed by reading the composer, not inferred.

## Red-team adversarial pass — elite tier

Lenses: (1) vacuous-pass, (2) kernel bypass, (3) test-integrity, (4) scope/regression, (5) trust boundary.

**Lens 1 — is the PASS vacuous?** No. The spec's `beforeAll` *throws* (does not skip) if the binary is
absent; the binary exists at `dist/tools/helm-sandbox`, built 2026-07-31 03:15, **newer** than
`tools/helm-sandbox.c` (2026-07-27 01:12), so it is not a stale artifact. Every denial assertion is
paired with a positive control (own draft readable, exit 0, `OWN-DRAFT-A-OK` in stdout), so a
blanket-deny fence or a failed launch would fail the suite rather than pass it.

**Lens 2 — kernel bypass.** I did not trust the implementer's harness. I rebuilt the fixture from scratch
and attacked the fence directly with the compiled binary
(`validation/D2/redteam-probe-a1.sh`, transcript `validation/D2/redteam-probe-a1.txt`).
Seat A's fence = own draft dir + `/usr:/lib:/lib64:/bin:/etc`. **13/13 attack vectors denied, 2/2 positive
controls allowed**, and an unsandboxed control read proves the secret really is on disk (so the denials
are not denials-of-nothing):

| Vector | Result |
|---|---|
| `cat` peer draft (absolute) | denied rc=1, EACCES |
| `ls` peer dir / `planning-drafts` root / `runDir` | denied rc=2 |
| relative `../seat-b/` traversal | denied rc=1 |
| **symlink** own→peer, then read through it | denied (Landlock resolves at access time) |
| **hardlink** peer draft into own dir (`FS_REFER`) | denied at `ln` |
| `cp` peer draft into the writable fence dir | denied at open-for-read |
| `grep -r` / `find` over runDir | denied rc=2/1 |
| `realpath` then `cat` | denied rc=1 |
| `tar` peer dir to stdout | denied rc=2, zero bytes of secret |
| **write**: clobber peer draft | denied rc=1 |

The symlink and hardlink rows matter most — they are the classic ways an allowlist that is validated
with `path.resolve` (lexical) rather than `realpath` gets bypassed. The kernel closes both regardless of
what the JS composer believes, because Landlock evaluates the resolved path at access time.

**Lens 3 — test integrity.** No `.skip`/`.only`/`.todo`. The D1 spec was *adapted*, not weakened: its
exact export-surface pin `expect(names).toEqual([...])` survives and was **extended** with the five new
symbols, so surface creep still fails the suite. Assertions moved from `path.join(runDir, …)` to
`path.join(seatDir, …)` — that tracks the real path change, it does not loosen anything.

**Lens 4 — scope/regression.** Diff is 3 files, all in the D2 blast radius: the store + its two specs.
No canonical-path writer was introduced (`plan.md` / `og-requirements.md` absence still asserted). Round-1
spawn wiring is *not* in this diff — correctly so: the brief's own test line scopes D2 to the composer,
the transport seam, the kernel proof and `publishDraft`, and `plan.md:48` assigns "spawn both co-planner
seats with **isolation allowlists from D2**" to slice R2. D2 supplies the API R2 consumes.

**Lens 5 — trust boundary.** `publishDraft` never accepts a callback-claimed hash; it re-reads disk via
`readPlanRevision` on the engine side, outside any sandbox. Verified by test 13 (distinct sha256 per seat)
and by the D1 spoofed-claim test.

Verdict: survives the pass. Three residuals recorded below — none contradicts R2.6, all belong to the
consuming slice.

## Residuals for slice R2 (round-1 spawn wiring) — NOT D2 defects

1. **`peerSeatIds: []` disarms the guard.** With an empty peer list the overlap *and* widening checks
   both no-op, so a caller could compose a fence covering `runDir`. The field is type-required, so this
   needs a deliberate empty array — but R2 must pass the full co-planner roster at every draft spawn.
2. **Compose validates lexically (`path.resolve`), not `realpath`.** An engine-supplied `contextInputs`
   entry that is a *symlink* to a peer draft dir would evade the typed BLOCK and the binary would then
   realpath it into a real grant. Context inputs are engine-controlled (north-star, decisions/), so this
   is not seat-reachable — and the seat-side symlink attack is kernel-denied (probed above) — but R2
   should `realpath` context inputs before composing.
3. **Cross-seat *write* is not an R2.6 property.** `HELM_RUN_ROOT` is unset here so the whole runDir is
   unwritable and my clobber probe was denied. On a deployment that sets it,
   `makeRunRootWriteAllowEnv` grants the seat its entire runDir, which contains the peer's draft dir —
   blind-write corruption without read. R2's "seat-scoped write targets" should narrow that grant.

## Verdict

**PASS** for R2.6.
