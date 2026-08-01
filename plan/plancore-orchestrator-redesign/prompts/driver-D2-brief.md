# [driver] Slice D2 — deterministic brief (run plancore-orchestrator-redesign)

## Scope (verbatim from hardened plan row — do ONLY this)
**Blind isolation, OS-enforced (R2.6):** wire round-1 draft spawns through the existing process-level sandbox — `src/security/landlock-sandbox.ts:28-69,157-198`, `src/services/real-transport.ts:169-238` (`strictReadAllow` param, confirmed wired at :185/:233), `src/services/fake-transport.ts:10-53` — so a co-drafting seat's own tmux process cannot `cat`/`ls` the other seat's draft path, not merely "the brief omits it." A drafting seat's allowlist covers only its own draft dir + read-only context inputs; the other seat's dir is outside the allowlist entirely until the engine marks round-1 committed. Test: compiled sandbox proves seat A's process cannot read/list seat B's draft; overlapping/widening allowlist requests typed-BLOCK before any tmux side effect; engine (outside the sandbox) reads both via `publishDraft(seatId)` once committed.

## Acceptance criteria (ACs)
R2.6

## Focused tests (the row's acceptance)
`npx vitest run src/services/seat-draft-store-isolation.test.ts --minWorkers=1 --maxWorkers=4`

## Contract
- estimate: 26min · deps: D1 · impl_tier=L2 · val_tier=L3 · budget=30
- Verifier ≠ fixer. Do NOT widen scope beyond the row (any widen = re-plan/EDGE).
- End your terminal DONE callback with the VERDICT-V1 line (see design/VERDICT-V1.md).
