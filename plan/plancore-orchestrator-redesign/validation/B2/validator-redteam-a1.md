B2 validator red-team a1

Verdict: PASS

Focused test:
- `npx vitest run src/services/brief-writer-plan-draft-purpose.test.ts --minWorkers=1 --maxWorkers=4`
- Result: 6/6 tests passed.

Acceptance check:
- R2.8 PASS: `plan-draft` includes the R-XX/task JSON schema contract, lane enums, effort enum, type enum, string batch warning, and example task.
- R2.5 PASS: `plan-draft` uses params/default seat draft paths and explicitly forbids canonical `plan.md` / `og-requirements.md` writes.
- R2.7 PASS: `plan-draft` requires temp sibling + rename atomic publish, self-hash of committed plan draft, and `DRAFT-SUBMITTED plan=<sha12>` with non-authoritative engine rehash wording.
- R1.1 PASS: context is constrained to absolute `north-star.md`, `conversation-log.md`, and `decisions/` paths.

Adversarial lenses:
- Grammar contamination: the `plan-draft` branch returns before default verdict body generation; `diff-review` remains verdict-oriented and does not inherit draft authoring grammar.
- Canonical write risk: draft paths are resolved from explicit params or `seat-draft-store`; canonical names are forbidden in the body.
- State machine risk: the terminal line is `DRAFT-SUBMITTED`, while `VERDICT-READY` and `PLAN-READY` are explicitly forbidden for this purpose.
- Hash trust risk: the brief labels the seat hash as non-authoritative and tells the worker the engine recomputes from committed bytes.

Residual risk:
- The example task mirrors the existing planning brief contract and does not include every optional/newer field listed nearby; that is pre-existing contract text, not a B2 regression.
