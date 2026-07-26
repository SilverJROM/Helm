# Helm hardening — follow-up tracker (durable; replaces the CLI task list)

Owner: opus (by-hand engine work). Deploy target: :3114 (cards2-ibrain.db, v90).
Updated as work lands. This file, not the CLI task tool, is the source of truth.

## Constraint (JROM-locked 2026-07-20)
grok now force-logs-out every ~6h and needs a MANUAL relogin. Codex + Claude tokens are low, so we
do NOT fail over to them when grok drops. Rule: **if a grok seat loses auth, PAUSE the run resumably,
notify JROM, hold until he relogins — never advance the ladder to codex/claude on an auth fault.**

## The seven

| # | Item | Tier | Status |
|---|------|------|--------|
| 52 | Paused run recorded as status='failed' (contradicts its own completion summary) | 1 | DONE — v91 migration adds status='paused'; transitionRunToBlocked(kind); deploy+final-test config pauses now 'paused'; resume accepts paused. 48/48 green, migration verified on live-DB copy (24 runs preserved, FK clean, idempotent) |
| 53 | Non-retryable fault class — unifies auth(#47) / fence-git(#49) / env-exit127. Includes the grok-logout resumable-pause | 1 | CORE DONE — fault-class.ts classifier (9 tests); loop pauses (status=paused, no failover) on grok auth logout AND on env gate faults (exit127/missing-deps); RUN_PAUSED_NONRETRYABLE event + paused-awaiting-operator.md remedy. 170 tests green. classifyGitFault present; fence-git worker-output wiring (#49) still to hook |
| 48 | Model binding: 4 precedence layers silently diverge; SSOT or startup consistency check | 1 | DONE — model-binding-check.ts flags set-but-ignored layers at startup (names which GOVERNS); claude-sonnet-5 eligibleRoles += discovery/plancore/ibrain. 5 tests, providers.b02 still green |
| 46 | Run artifacts under os.tmpdir() → reboot loses a client's run paperwork; durable run root | 2 | DONE — run-paths.ts single resolver replaces 5 copy-pasted formulas; HELM_RUN_ROOT opt-in for durable (pairs with sandbox allowlist); default unchanged. 3 tests |
| 49 | Write-fence blocks git when gitdir outside projectDir + worker did `git init` surgery | 2 | DONE — implementer brief now forbids repo-level surgery (git init/re-clone/.git delete) → report BLOCKED with the git error; classifyGitFault() available in fault-class.ts for output-based detection. Deep worker-output auto-classification left as optional |
| 51 | cards2 pusoy seat pods overlap card-count labels (cosmetic) | 3 | DONE — nowrap badge + flex-column max-width containment on .seat__hands; committed to durable branch feat/pusoy-ui-fix (86c4238). Pixel confirmation deferred to a browser pass (cards2 = test vehicle) |
| 50B | Wake ibrain on a PASS that carries a PLAN-CONTRADICTION marker (deferred design) | 3 | BOUNDED DONE — completion-summary now has a "Plan Contradictions (surfaced)" section listing PLAN_CONTRADICTION events (visibility). Full wake-ibrain-on-PASS still DEFERRED pending JROM design nod (churn risk on false positives) |

## Order (all landed)
52 → 53 → 48 → 46 → 49 → 51 → 50B. All deployed to :3114 (v91).

## Test ledger
- unit/leg (fork-capped vitest, zero model tokens): 182 pass / 12 suites, tsc clean. New: fault-class (9), model-binding-check (5), run-paths (3), escalation-decision-edgeclass (12), pause machinery (1). v91 migration verified on a live-DB copy.
- deploy: :3114 rebuilt, DB auto-migrated v90→v91 on startup; model-binding check fired live and caught a real discovery-binding divergence (since cleared → 0 divergences).
- one short live cards2 cycle: DONE (run 26, cycle 9, 2 tasks). Both tasks passed on the hardened build (no core-loop regression), then hit the final-tests gate with no config and reported status='paused' (NOT 'failed') — #52 confirmed LIVE. completion-summary status:complete + FAILED:(none) + the new "Plan Contradictions" section present; final-tests-paused.md written; seats cleaned up. The run is resumable (resume path accepts 'paused').
