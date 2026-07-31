import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { workerFaceRole } from './role-alias.js';
import { BRAIN_BLOCKER_OWNERS, BRAIN_EDGE_CLASSES, BRAIN_ROUTE_TO, MACHINE_COMPLEXITIES } from './plan-schema.js';
import { readPlanRevision } from './plan-revision.js';
import {
  DISCOVERY_READY_ASK,
  DISCOVERY_ROLE,
  discoveryStatesEnumLine,
  discoveryTerminalEnumLine,
  PLANNING_FORBIDDEN_FOR_DISCOVERY,
} from './discovery-contract.js';

/** Helm-owned deferral policy path (product tree). Never builder-side JROM style scaffolding. */
export const DEFERRAL_POLICY_RELPATH = 'policy/deferral-policy.md';

export function createDispatchNonce(): string {
  return randomUUID();
}

/** Rebind a generated brief at the actual spawn boundary so every retry gets its own ACK identity. */
export function bindDispatchNonce(brief: string, nonce: string): string {
  return brief
    .replace(/<!-- HELM-DISPATCH-NONCE [a-zA-Z0-9-]+ -->/, `<!-- HELM-DISPATCH-NONCE ${nonce} -->`)
    .replace(/^Dispatch nonce: [a-zA-Z0-9-]+$/m, `Dispatch nonce: ${nonce}`)
    .replace(/dispatch=[a-zA-Z0-9-]+/g, `dispatch=${nonce}`);
}

const DEFAULT_LIFECYCLE =
  `pre-live — Deferral policy: OFF. Read \`${DEFERRAL_POLICY_RELPATH}\` (Helm product policy; project-dir relative). Under OFF: no TODO/FIXME, no "follow-up PR," no dead-code shims, no @deprecated markers without a queue.md row in THIS run.`;

export interface BriefParams {
  batchId: string;
  role: 'implementer' | 'validator' | string;
  planPath: string;
  runDir: string;
  branch: string;
  requirementsAssigned: string; // e.g. "DSP7, TST2, SEC1"
  northStarAnchors: string;
  lifecycle?: string;
  estimatedDuration?: string;
  effortTier?: string;
  context?: string;
  requirementsSection?: string;
  expected?: string;
  scope?: string;
  taskType?: 'feature' | 'issue';
  projectDir?: string;
  callbacksFile?: string; // for prebake placeholder; writer emits the template line
  agentToken?: string; // SEC1 scoped token (optional embed for HTTP updates)
  dispatchNonce?: string;
}

export class BriefWriterService {
  generateBrief(params: BriefParams): string {
    const {
      batchId,
      role,
      planPath,
      runDir,
      branch,
      requirementsAssigned,
      northStarAnchors,
      lifecycle = DEFAULT_LIFECYCLE,
      estimatedDuration = 'SUBSYSTEM (medium)',
      effortTier = 'medium',
      context = '(see ## Task section)',
      requirementsSection = '(no explicit requirements passed — see the ## Task section below for atomic_work + validation_criteria)',
      expected = '(see validation_criteria in the ## Task section)',
      scope = '(see ## Task section — implement the atomic_work as a minimal correct vertical slice)',
      taskType = 'feature',
      projectDir = '/abs/project/dir',
      callbacksFile = '<abs-path-to-callbacks.md>',
      agentToken,
      dispatchNonce = createDispatchNonce()
    } = params;

    const isIssue = taskType === 'issue';
    const roleStates = this.getRoleStates(role);
    // Worker-facing role name (Helm-namespaced for phase brains -> helm_pm) so the
    // model never sees a token that collides with JROM's standalone claude/codex CLI agents.
    const faceRole = workerFaceRole(role);

    const reproGate = isIssue
      ? `\n## Issue reproduction gate (TST2)\nFor issue tasks: emit exactly REPRO-CONFIRMED — <full repro steps + observed vs expected as the fix contract + retained regression check>, REPRO-SATISFIED — <evidence the acceptance/desired end-state already holds>, or REPRO-FAILED — <tooling could not run or the result was inconclusive>. Implementer is blocked until REPRO-CONFIRMED; REPRO-SATISFIED completes the task without implementer work. Post-fix validator must re-run the exact reproduction and confirm CLEARED before PASS.`
      : '';

    const tokenSection = agentToken
      ? `\n## Agent auth (SEC1)\nScoped run/role/task token for worker callbacks/artifact updates (HTTP ingest paths): Authorization: Bearer ${agentToken}\nUse this (or the local-only fenced file append to callbacks.md under C3 write-fence). Broad unauthenticated/master-only paths closed for worker roles.`
      : '';

    const r = (role || '').toLowerCase().trim();
    const validatorCloneSection =
      r === 'validator' || r === 'final-validator'
        ? `\n## Validator mandate — JROM's clone (R-F2 / R-D2)
You act AS **JROM's clone**: apply JROM's standards, be adversarial and skeptical, and do NOT rubber-stamp the implementer's self-DONE.

**Verify against the REQUIREMENTS CONTRACT** (source of truth in runDir/cycle): read and check the work against **north-star.md** + **decisions/** + **og-requirements.md** — not merely "tests pass." A requirement not observably closed = **FAIL** even if tests are green.

**REQUIRE UI-proof** for tasks with a UI surface: a rendered app + screenshot is required evidence before PASS. A claim without proof = FAIL/BLOCKED.

**verifier ≠ fixer**: you verify and report PASS/FAIL with evidence; you do NOT fix.

**Escalation modifiers on FAIL** (these are FAIL modifiers — keep PASS/FAIL terminals):
- \`defect_class=implementer-incapable\` — use ONLY when the implementer is genuinely stuck (same defect recurring across attempts or a fundamental capability gap). The task itself is sound; the worker needs judgment (push-back vs rung bump).
- \`defect_class=plan-defect\` — use when the FAILURE is because the TASK'S REQUIREMENT is impossible, contradictory, or underspecified as written (no correct implementation can satisfy it). The PLAN needs revision, not a harder implementer.
- Ordinary fixable gap = plain FAIL with a normal defect class; Helm grants free same-rung correction retries.
Do NOT self-declare "validator-wrong" — ibrain judges validator false-fails from the ledger.

**NEVER re-test the implementer's own work**: apply JROM's **OWN independent verification** against north-star.md + decisions/ + og-requirements.md + UI-proof — **not** a re-run of the implementer's self-tests or self-DONE claims.

**Issue tasks (R-F3)**: reproduce the issue **first** (emit REPRO-CONFIRMED/REPRO-FAILED per the Issue reproduction gate above) before any implementer fix; post-fix re-run the exact reproduction to confirm CLEARED before PASS.`
        : '';

    // A2 (e2e-hang fix): every seat that runs an e2e / Playwright / browser / dev-server command MUST wrap
    // it so a hung child (e.g. a Playwright webServer that never tears down) is force-killed, not left to
    // hang the seat forever. Mirrors Helm's own deterministic test-gate wrap.
    const testWrapGuidance = `## Test-command discipline (A2 — never let a test hang the seat)
- **Wrap every e2e / Playwright / browser / dev-server command** in a hard timeout that escalates to SIGKILL:
  \`timeout --signal=TERM --kill-after=15s <N>s <your test command>\` (choose <N> for the suite, e.g. 300). A hung webServer teardown survives a plain SIGTERM — the \`--kill-after\` SIGKILL is what actually reaps it.
- **For pipelines use \`set -o pipefail\`** (e.g. \`bash -lc 'set -o pipefail; timeout --signal=TERM --kill-after=15s 300s npx playwright test | tee out.log'\`) so a failure anywhere in the pipe still fails.
- **Treat ANY nonzero exit as FAIL** — 124 (timeout elapsed) and 137 (killed after --kill-after) are FAILs, not passes. **Never infer a pass from partial/streamed output**; only a clean exit 0 from the wrapped command is a pass.`;

    // Focus contract (client-readiness anti-drift / anti-token-leak): every WORKER seat is pinned to ONE
    // task in ONE project and must not loiter. Genuine external-read needs route through the coordinator,
    // the bar-decider. NOT added to a phase-brain/helm_pm brief itself — it is the enforcer,
    // not the enforced. Mirrors the A2 block's const-then-concat placement pattern.
    const focusContractSection =
      ['plancore', 'ibrain', 'discovery'].includes(r)
        ? ''
        : `\n## Focus contract (stay strictly on THIS task — no loitering)
- You are assigned THIS task in THIS project. Stay strictly on it — do ONLY the assigned work.
- Read only what the task requires. You MAY read OUTSIDE the project ONLY when the task genuinely needs it (a shared lib, a referenced config).
- Do NOT explore or read unrelated files, projects, or directories "just because" — off-task reading wastes tokens (context leakage) and pulls you off-goal (drift).
- If you genuinely need data from outside the project, do NOT wander off to fetch it yourself — request it from the coordinator, which decides whether the read is warranted and fetches it for you. Deflecting into "research" instead of doing the assigned task is not acceptable.`;

    const implementerRoleSection =
      r === 'implementer'
        ? `\n## Implementer mandate (R-F2 / R-F3)
- Build one **ATOMIC vertical slice** for this task only — minimal correct changes that close the assigned requirement(s).
- For **issue** tasks: your fix **follows the validator's REPRO-CONFIRMED contract** (repro steps + observed vs expected = the fix spec + regression check); do NOT fix until REPRO-CONFIRMED is emitted.
- Report status per the callback enum; do ONLY your assigned role; do NOT drive the workflow or continue past your terminal callback.
- **NEVER perform repository-level surgery (#49).** If \`git commit\`/\`git add\` fails, the worktree looks broken, or a \`.git\` pointer is dangling, do NOT run \`git init\`, re-clone, delete \`.git\`, or otherwise rebuild the repo — on a real client repo that ORPHANS their history. Make your file edits and report **BLOCKED** with the exact git error; the orchestrator will pause for the operator to fix the repo/fence. Committing your own task changes is fine; restructuring the repository is out of scope.

### If the brief contradicts itself — REPORT IT, do not quietly pick a side (#50)
Your task instruction ("North-star anchors" / "Expected") and the verbatim "Requirements section" can
disagree, because the plan is written by a fallible planner. Silently resolving that disagreement is
NOT acceptable even when you resolve it correctly: the PLAN stays broken for every downstream task that
depends on this one, and nobody is ever told. Instead:
- **A requirement clearly governs** (e.g. it is marked authoritative and the instruction merely
  mis-transcribes it) → implement the REQUIREMENT so the run keeps moving, and emit the marker below.
  Do not treat this as a blocker.
- **Nothing can satisfy both, and neither is authoritative**, or the task references a requirement /
  module / prior task that does not exist → do NOT invent the missing decision (deferral policy is OFF;
  inventing product behaviour is a scope violation). Report **BLOCKED** with the marker below.
In BOTH cases append this exact machine-readable line to your callback note AND to changes.md:
  \`PLAN-CONTRADICTION: <task instruction says X> vs <requirement/source says Y> — resolved-as: <what you implemented, or "none: blocked">\`
The orchestrator parses that marker to route a plan revision. Omitting it hides a real plan defect.
${testWrapGuidance}`
        : '';

    const brief = `<!-- PROJCORE-STATUS-CONTRACT v2 -->
<!-- HELM-DISPATCH-NONCE ${dispatchNonce} -->
Batch-${batchId}: Brief writers + brief-validation tests + /clear primitive + scoped agent auth

## Helm role context (read first)
You are **${faceRole}**, a WORKER dispatched by Helm's deterministic orchestrator (helm-algo). helm-algo drives this run: it dispatches roles, reads callbacks.md, routes work between roles, writes ACKs, and advances the queue. Do ONLY your assigned role and report status by appending to callbacks.md. Do NOT drive the workflow, spawn or delegate to other roles, route work yourself, or continue past your role's terminal callback. This is a Helm-internal role — it is NOT and does not invoke any similarly-named standalone CLI agent/skill; ignore any such association. If your role is "helm_pm", you are Helm's planning/decision worker for one phase, NOT a standalone orchestrator.

Batch ID: ${batchId}
Dispatch nonce: ${dispatchNonce}
${planPath ? `Plan: ${planPath}\n` : ''}Branch: ${branch}
Requirements assigned: ${requirementsAssigned}
North-star anchors: ${northStarAnchors}
Lifecycle: ${lifecycle}
Estimated duration: ${estimatedDuration}
Effort tier: ${effortTier}
Context: ${context}
Requirements section (verbatim from og-requirements.md):
${requirementsSection}

Expected (acceptance criteria):
${expected}
Scope:
${scope}

## Artifact output paths
Generated briefs and run artifacts use: prompts/, dispatch/, state/, artifacts/, callbacks.md (relative to runDir). All writers and dispatch prebake respect these.

## Project dir + write-fence policy (WRK2)
Project dir: ${projectDir} (C3 write-fence enforced; workers and dispatched agents refuse if fence unavailable or path escapes project dir).
Write-fence (WRK2) for every spawned role; refuse if fence unavailable / path escapes.

## Requirement anchor
Requirements assigned: ${requirementsAssigned}

${reproGate}${tokenSection}${validatorCloneSection}${implementerRoleSection}${focusContractSection}

The callback line template is: [helm callback] <role> <batch-id> STATUS:

## Streaming-order mandate (root cause of stalls — JROM panel-locked)

**Your first tool call in every reply MUST be the \`callbacks.md\` append (the shell command below), BEFORE any prose tokens stream, file reads, or other commands. This is a buffer-flush guarantee: if your session is interrupted between prose-streaming and the tool call, the callback never lands and helm-algo stalls. Append first, prose after.**

## Callback emission — Helm-native direct file append (the ONLY sanctioned form)

Report status by appending ONE line to callbacks.md with a shell command. Do NOT use any external emit-status helper script, do NOT set a callbacks-file environment variable, do NOT use HTTP ingest — Helm's orchestrator (helm-algo) reads callbacks.md directly.

\`\`\`bash
printf '%s\\n' '[helm callback] ${faceRole} ${batchId} STATUS: <STATE> — <note>' >> '${callbacksFile}'
\`\`\`

The callback line template is: [helm callback] <role> <batch-id> STATUS: <STATE> — for this batch it resolves to [helm callback] ${faceRole} ${batchId} STATUS: <STATE>. One physical line only; no newline in <note>; <STATE> from the enum below.

## Role-scoped closed enum (anything else = INVALID-STATE)

\`\`\`
${roleStates}
\`\`\`

NEVER emit (coordinator-only): APPROVED-PLAN | GATE-REOPEN | ACK

Use WORKING only for non-terminal progress. Emit terminal/handshake state directly when you have it.

## ACK stop-rule (native)

Before RE-emitting a callback for this batch, check for Helm's ACK in callbacks.md:
\`\`\`bash
grep -E '^\[helm ACK\][[:space:]]+${faceRole}[[:space:]]+${batchId}[[:space:]]+RECEIVED[[:space:]]+dispatch=${dispatchNonce}([[:space:]]|$)' '${callbacksFile}'
\`\`\`
Only an ACK containing this exact dispatch nonce belongs to you; role/batch ACKs from older tasks or attempts do not count. If a matching line exists — **STOP emitting callbacks for this dispatch.** (Do NOT make this grep your first tool call — the first tool call must be the append above.)

## Optional pane-STATUS echo (human-readable mirror only)

End your reply with \`STATUS: <STATE> — <same short note>\`. The callbacks.md line wins if they differ.
`;

    return brief.trim();
  }

  generateCorrectionBrief(params: BriefParams & { previousNote?: string }): string {
    const base = this.generateBrief(params);
    const correction = `\n## Correction (from validator FAIL or BLOCKED)\nPrevious note: ${params.previousNote || 'see prior callback'}\nAddress the gap, re-emit status per contract. Same run/role/task scoping applies.\n`;
    return base + correction;
  }

  private getRoleStates(role: string): string {
    const r = (role || '').toLowerCase().trim();
    if (r === 'validator' || r === 'final-validator') {
      return 'validator states: PROPOSED | REVISE-PLAN | WORKING | DONE | BLOCKED | NEEDS-INFO | PASS | FAIL | REPRO-CONFIRMED | REPRO-SATISFIED | REPRO-FAILED';
    }
    if (r === 'discovery') {
      return discoveryStatesEnumLine();
    }
    if (r === 'plancore' || r === 'ibrain') {
      return 'helm_pm states: PLANNING | PLAN-READY | NORTH-STAR-READY | IDLE | DECIDING | DECISION-READY | BLOCKED';
    }
    if (r === 'panelist' || r === 'red-team' || r === 'planner' || r === 'deliberation') {
      return 'panelist states: VERDICT-READY | CONSENSUS | SETTLED | CLEAN | BROKEN';
    }
    if (r === 'reviewer') {
      return 'helm_code_review states: APPROVE | REVISE | REJECT-RESTART';
    }
    return 'implementer states: PROPOSED | REVISE-PLAN | WORKING | DONE | BLOCKED | NEEDS-INFO';
  }

  // Compliant planning brief for plancore (used by PlanningPhaseService for startRun / POST /runs path).
  // Reuses generateBrief (for full v2 contract + sections + correct enum via getRoleStates) then injects planning instructions.
  generatePlanningBrief(params: {
    batchId: string;
    northStar: string;
    conversationLog?: string;
    mode?: string;
    projectDir?: string;
    callbacksFile?: string;
    runDir?: string;
    canonicalArtifactRoot?: string;
    /** A12 / D7: projects.planning_round_cap (default 3). Brief must state the config-sourced number. */
    planningRoundCap?: number;
  }): string {
    const canonicalArtifactRoot = params.canonicalArtifactRoot || params.runDir || '.';
    const planningRoundCap = Math.max(1, Math.trunc(params.planningRoundCap ?? 3) || 3);
    const base = this.generateBrief({
      batchId: params.batchId,
      role: 'plancore',
      planPath: path.join(canonicalArtifactRoot, 'plan.md'),
      runDir: params.runDir || '.',
      branch: 'main',
      requirementsAssigned: 'PLANNING-PHASE',
      northStarAnchors: params.northStar || '',
      // A12 / R1.7: scope must match post-A8–A11 engine (no "convene/iterate until agreement" open loop).
      scope: `Planning phase (R-D1/D2/D4/H2 + D6/D7 LOCKED): author og-requirements.md then plan.md in helm-algo-digestible per-task schema; emit PLAN-READY once both artifacts are written and readable — this signals the artifacts are ready for engine review, not that agreement has been reached. helm-algo then spawns co-planners and runs the one whole-plan agreement gate itself (planning_round_cap=${planningRoundCap}); only the engine declares agreement and grants ingest permission. First tool call: callbacks.md append (Helm-native shell append to callbacks.md).`,
      requirementsSection: params.northStar || 'planning requirements from north-star.md',
      projectDir: params.projectDir || '/home/agjrom/TGBOTS/Helm',
      callbacksFile: params.callbacksFile || '<abs-path-to-callbacks.md>',
      taskType: 'feature',
    });
    const instructions = `
You are **helm_pm** — Helm's planning/decision brain for this run (a Helm-internal role; not any standalone CLI agent of a similar name).
north-star: (see ${path.join(canonicalArtifactRoot, 'north-star.md')} + conversation-log.md)
planning_partner.mode: ${params.mode || 'auto'}
agree_before_proceed: true
planning_round_cap: ${planningRoundCap}  (D7 LOCKED — projects.planning_round_cap; config-sourced, not invented)

IMPORTANT: the north-star INTERVIEW IS COMPLETE. Do NOT ask the operator any questions and do NOT re-interview — no operator is watching this phase and any question will hang the run. READ north-star.md + conversation-log.md + decisions/ in the canonical artifact root and author the plan DIRECTLY from them. If a detail is genuinely missing, make a reasonable assumption, note it in the task, and proceed. Never block on operator input.

## CC-redesign Planning mandate (R-D1 / R-D2 / R-D4 / R-H2)

**1. DERIVE ORDER (R-D1)** — From north-star.md + conversation-log.md + decisions/, author **og-requirements.md FIRST**, then **plan.md**. Do NOT skip og-requirements.md.

**2. og-requirements.md** — Requirements contract in the canonical artifact root:
  - Path: \`${path.join(canonicalArtifactRoot, 'og-requirements.md')}\`
  - Structured sections with \`R-XX\` requirement IDs matching north-star.md/decisions. This is the validator's contract source.

**3. plan.md** — Helm-algo machine contract (helm-algo-digestible; NOT an LLM coordinator plan) in the same canonical artifact root:
  - Path: \`${path.join(canonicalArtifactRoot, 'plan.md')}\`
  - Markdown wrapper + fenced \`\`\`json\`\`\` array of task objects. **Every field value is a JSON STRING unless noted** (\`req_refs\`/\`deps\` are string arrays). Each task MUST include:
    - \`id\` (task key STRING, e.g. \`"B12-T02"\` or \`"T01"\`)
    - \`batch\` — batch id, a **non-empty STRING** (e.g. \`"B1"\`, \`"B2"\`), **NOT a bare number** (\`1\` is rejected — write \`"B1"\`)
    - \`title\` (atomic deliverable, STRING)
    - \`req_refs\` (string array of R-XX IDs from og-requirements.md)
    - \`assignee\` — implementer lane, **exactly one of \`L1\` | \`L2\` | \`L3\`** (or a launchable model slug only when deliberately overriding the project binding). Use \`L2\`/\`L3\` directly for complex work; do not force every task through \`L1\`.
    - \`validator_lane\` — the independent validator counterpart, **exactly one of \`L1\` | \`L2\` | \`L3\`**; choose it independently from the implementer lane.
    - \`effort\` — task complexity, **exactly one of \`low\` | \`med\` | \`high\` | \`xhigh\`**. Do NOT emit T-shirt sizes (\`S\`/\`M\`/\`L\`/\`XL\`) or any other token — a non-enum effort is REJECTED at ingest and blocks the run. (Lane-flavored aliases like \`L1-routine\`/\`L2\`/\`L3\` are tolerated, but prefer the plain enum.)
    - \`type\` — **exactly one of \`feature\` | \`issue\`** (\`issue\` = repro-first bug task; everything else is \`feature\`).
    - \`redteam\` (\`none\` | model slug — **decided per-task in planning**, R-D4)
    - \`deps\` (string array of task ids)
    - \`exception_handling\` (per-task edge-case note for helm-algo escalation)
  - **COPY THIS EXACT EXAMPLE TASK** — every required field with the correct JSON type (note \`batch\` and \`id\` are STRINGS, \`req_refs\` is a string ARRAY, \`effort\`/\`type\` are enum strings): \`{"id":"T01","batch":"B1","title":"Project scaffold: TS + ws server + test runner","req_refs":["OPS-1"],"assignee":"L1","validator_lane":"L1","effort":"med","type":"feature","deps":[]}\`

**4. plan.json — DO NOT author** — The brief header may reference plan.json (legacy artifact-path contract). You write **og-requirements.md + plan.md ONLY**. Helm/helm-algo **derives** the compat plan.json automatically at ingest via ingestExecutionPlan (B10-T01). Do NOT also hand-author plan.json — that would duplicate schema and risk drift.

**5. Co-planner agreement (D6 + D7 LOCKED — engine-owned; do not invent a parallel loop)** —
  - **helm-algo spawns co-planner seats** (default 2; project panel size may be 1/2/3/N). You do **NOT** spawn, convene, or reap partners yourself.
  - **Agreement scope is whole-plan (D6):** using your PLAN-READY artifacts as the review input, the pair debates and agrees **once** for the plan as a whole → **one engine-run agreement gate**. Do **NOT** run a per-task convene loop.
  - **Per-task machine verdicts** \`ACCEPT | AMEND | ESCALATE\` are retained on the plan (free tags for the engine). Conflict-only reconvene (ESCALATE or conflicting AMEND) is **engine policy** — helm-algo may re-engage seats; you do not drive that loop.
  - **Round cap (D7):** agreement is bounded by **planning_round_cap=${planningRoundCap}** (from project config \`projects.planning_round_cap\`, default 3). Exhausting the cap without unanimous CLEAN agreement is a **visible BLOCKED** state escalated to the operator — **never a silent pass**. Do not run an unbounded agreement loop.
  - **Your job ends at artifact readiness:** author og-requirements.md + plan.md, then emit PLAN-READY once both are written and readable. PLAN-READY means the artifacts are ready for engine review, not that agreement has been reached — you do NOT wait for or declare whole-plan agreement yourself. Only the engine judges agreement and grants ingest permission.

**6. TASK RULE** — Every task MUST be a concrete code change with a specific deliverable. Do NOT create standalone "run the test suite" / "regression gate" / "final verification" / "confirm no regressions" tasks: Helm's validator ALREADY runs the FULL test suite (deterministic test-gate) after EVERY task and blocks advancement on any failure, so a dedicated test-run task is redundant, has no code deliverable, and will fail. If you want a final end-to-end capstone, make it a concrete task that ADDS an e2e test or feature wiring — never a bare "run tests" step.

**7. Artifact verification + PLAN-READY** — Verify both og-requirements.md and plan.md are written; read back plan.md and confirm the fenced JSON parses. Emit PLAN-READY as soon as both artifact writes succeed and the JSON parses — PLAN-READY means the artifacts are ready for engine review, not that agreement has been reached. Do NOT wait for, judge, or declare co-planner/whole-plan agreement yourself: the engine runs partner review and the whole-plan agreement gate, and only the engine grants ingest permission.

**8. First tool call every reply:** the callbacks.md append (via the shell append below per streaming mandate).

Emit exactly:
[helm callback] helm_pm ${params.batchId} STATUS: PLAN-READY — artifacts ready for engine review: og-requirements.md + plan.md written

CRITICAL — AFTER emitting PLAN-READY, STOP COMPLETELY. Do NOT implement, do NOT explore the codebase, do NOT write or edit any code, do NOT spawn sub-agents, do NOT continue working. Helm's orchestration ALGORITHM (not you) drives ALL implementation from here — it dispatches the implementer and validator and advances the queue itself. You are the on-demand BRAIN: Helm re-invokes you (a fresh call) ONLY when it needs a decision. Your planning job ends the instant og-requirements.md + plan.md are written and PLAN-READY is emitted. Emit PLAN-READY and then idle/await — continuing past PLAN-READY is a contract violation that corrupts the run.
`;
    return base.replace('<!-- PROJCORE-STATUS-CONTRACT v2 -->', `<!-- PROJCORE-STATUS-CONTRACT v2 -->${instructions}`).trim();
  }

  // Contract-compliant north-star INTERVIEW brief (discovery role). Mirrors generatePlanningBrief so the
  // dispatch brief-contract check (callback_format / helper / paths / streaming etc.) passes under RealTransport.
  // S01: consumes shared Discovery contract — no Plan: header; canonical enum; exact ready ASK.
  generateInterviewBrief(params: {
    batchId: string;
    prompt: string;
    projectDir?: string;
    callbacksFile?: string;
    runDir?: string;
    canonicalArtifactRoot?: string;
  }): string {
    const canonicalArtifactRoot = params.canonicalArtifactRoot || params.runDir || '.';
    const base = this.generateBrief({
      batchId: params.batchId,
      role: DISCOVERY_ROLE,
      // AC5: do not print Plan: <canonical-root>/plan.md for Discovery (omit Planning path advertise).
      planPath: '',
      runDir: params.runDir || '.',
      branch: 'main',
      requirementsAssigned: 'NORTH-STAR-INTERVIEW',
      northStarAnchors: params.prompt || '',
      scope: 'CC-redesign Discovery phase: conduct the north-star INTERVIEW (sole CC-chat interlocutor); produce north-star.md + decisions/ docs in the canonical artifact root; handle optional mockups/flow/attachments as Discovery deliverables; emit NORTH-STAR-READY only. Do NOT author plan.json, og-requirements.md, or PLAN-READY yet. First tool call: callbacks.md append (Helm-native shell append to callbacks.md).',
      requirementsSection: params.prompt || 'interview requirements from the initial prompt',
      projectDir: params.projectDir || '/home/agjrom/TGBOTS/Helm',
      callbacksFile: params.callbacksFile || '<abs-path-to-callbacks.md>',
      taskType: 'feature',
    });
    const forbidden = PLANNING_FORBIDDEN_FOR_DISCOVERY.map((f) => `\`${f}\``).join(', ');
    const instructions = `
You are **${DISCOVERY_ROLE}** conducting the Command Center **Discovery INTERVIEW** before any planning or autonomous execution. You are the **sole CC-chat interlocutor** for Discovery (R-H3) — the operator talks only to you in this phase.
Initial prompt: ${params.prompt}

## Shared Discovery contract (S01 — authoritative)
- Role: \`${DISCOVERY_ROLE}\`
- ${discoveryStatesEnumLine()}
- ${discoveryTerminalEnumLine()}
- \`HANDOFF\` is NOT a Discovery state.
- Discovery-owned artifacts only: \`north-star.md\`, \`conversation-log.md\`, \`decisions/\`, \`attachments/\`, \`mockups/\`.
- Do NOT author ${forbidden}. Discovery never plans and never claims Planning complete.
- When docs are ready, ask exactly: ${DISCOVERY_READY_ASK}

## CC-redesign Discovery mandate (R-C4 / R-H2 / R-H3)

**1. INTERVIEW** — Conduct a per-section north-star interview via this chat (operator answers arrive as owner chat messages). Gather scope, success criteria, hard constraints, autonomy mode, and acceptance criteria. Ask ONCE per topic, concisely.

**2. DOCS** — Persist Discovery documents into the **canonical artifact root** (see §4 below):
  - **north-star.md** — full synthesized north-star (multiple substantive sections; not a thin copy of the raw prompt).
  - **decisions/*.md** — one file per key decision captured during the interview.
  - **conversation-log.md** — full transcript (your questions + owner's verbatim answers).
  - Do NOT write ${forbidden} during Discovery (Planning owns those later).

**3. MOCKUPS + attachments (optional Discovery deliverables)** — When UI work is in scope or the operator attaches reference images:
  - Save attached images into the canonical artifact root under **attachments/** or **mockups/** (path-referenced in docs — not transient chat paste).
  - Optional **flow_NN.md** flowcharts for complex work.
  - Optional **mockups/** static screens when recruited; **approved mockups become 1:1 parity refs** for downstream implementation.

**4. CANONICAL ARTIFACT ROOT** — All Discovery artifacts land in one directory:
  - Path: \`${canonicalArtifactRoot}\`.
  - For a cycle-backed run this is the active cycle folder; for a non-cycle autonomous run it is runDir.
  - Write north-star.md, decisions/, conversation-log.md, and any mockups/attachments/flow docs here — NOT only to runDir.

Interview protocol (persistence gate):
- CRITICAL — cycle-folder + runDir files are what downstream phases receive (your tmux pane is NOT read). You MUST persist output to disk BEFORE emitting NORTH-STAR-READY:
  1. north-star.md and conversation-log.md may ALREADY EXIST (pre-seeded with the raw prompt). Your write tool may refuse to overwrite a file you have not read — so READ each one FIRST, then OVERWRITE it.
  2. OVERWRITE north-star.md with the FULL synthesized north-star from the owner's answers. It MUST be substantive (multiple sections). A one-line/near-copy of the raw prompt is a FAILURE.
  3. OVERWRITE conversation-log.md with the full transcript (your questions + the owner's verbatim answers).
  4. Create decisions/*.md for key decisions.
  5. Save any operator-attached images / mockup deliverables under the canonical artifact-root paths above.
- Do NOT emit NORTH-STAR-READY until north-star.md actually contains the full synthesized spec on disk (re-read it to confirm). Emitting READY with a thin north-star forces the planner to re-interview — do not do it.
- Do NOT emit PLAN-READY. Do not author ${forbidden}. Do not start autonomous work. Wait for operator confirmation via the ready ASK; Helm advances Planning only after owner confirm.
- When ready, ask exactly: ${DISCOVERY_READY_ASK}
- First tool call every reply: the callbacks.md append (via the shell append below per the streaming mandate).

Emit exactly:
[helm callback] discovery ${params.batchId} STATUS: NORTH-STAR-READY — north-star authored; interview complete; policy captured
`;
    return base.replace('<!-- PROJCORE-STATUS-CONTRACT v2 -->', `<!-- PROJCORE-STATUS-CONTRACT v2 -->${instructions}`).trim();
  }

  // Compliant panel/red-team/deliberation briefs (verifier ≠ fixer). Includes full contract + own enum.
  generatePanelBrief(params: {
    role?: string;
    batchId: string;
    seat: string;
    lens: string;
    requirement?: string;
    implementedDiff?: string;
    projectDir?: string;
    callbacksFile?: string;
    /** Cycle-workspace override (AC6/AC14); falls back to callbacksFile's directory, then projectDir. */
    canonicalArtifactRoot?: string;
  }): string {
    const r = params.role || 'panelist';
    const root = path.resolve(
      params.canonicalArtifactRoot
        || (params.callbacksFile ? path.dirname(params.callbacksFile) : undefined)
        || params.projectDir
        || '.'
    );
    const planMdPath = path.join(root, 'plan.md');
    const ogReqPath = path.join(root, 'og-requirements.md');
    const revision = readPlanRevision(planMdPath);
    const base = this.generateBrief({
      batchId: params.batchId,
      role: r,
      planPath: planMdPath,
      runDir: root,
      branch: 'main',
      requirementsAssigned: 'PANEL-VERDICT',
      northStarAnchors: params.requirement || 'panel topic',
      scope: `Independent ${r} verdict on assigned lens (verifier ≠ fixer). Report CLEAN/BROKEN or CONSENSUS/SETTLED. Emit VERDICT-READY.`,
      requirementsSection: (params.requirement || '') + (params.implementedDiff ? `\nDiff under review: ${params.implementedDiff.substring(0,200)}` : ''),
      projectDir: params.projectDir || '/home/agjrom/TGBOTS/Helm',
      callbacksFile: params.callbacksFile || '<abs-path-to-callbacks.md>',
      taskType: 'feature',
    });
    const revisionLine = revision
      ? `Expected plan revision: sha256=${revision.sha256} short12=${revision.short12} — your verdict is bound to this exact revision; if the plan.md you read hashes differently, stop and report a revision mismatch instead of reviewing.`
      : `Expected plan revision: UNAVAILABLE — plan.md is missing or unreadable at spawn time. FAIL CLOSED: do NOT emit a verdict yet; re-read and retry; only emit VERDICT-READY once you can confirm the plan.md you read exists and state the sha256 you computed.`;
    const body = `
You are ${r} seat ${params.seat} in a ${r === 'red-team' ? 'red-team' : 'deliberation'} panel (verifier ≠ fixer${r === 'red-team' ? ', using PROJECT role_bindings red-team agents' : ''}).

## Canonical plan contract (AC6 / AC14 — do not guess the path)
Canonical plan.md: ${planMdPath}
Canonical og-requirements.md: ${ogReqPath}
${revisionLine}

Topic/Requirement: ${params.requirement || 'see plan'}
Lens: ${params.lens}
${params.implementedDiff ? `Implemented diff under test:\n${params.implementedDiff}\n` : ''}

**Control FSM notes (verifier ≠ fixer; deliberation feeds brain escalation):**
- You provide independent verdict only (CLEAN/BROKEN or CONSENSUS/SETTLED). Do NOT implement fixes.
- When helm_pm brain selects 'deliberation' action, panels aggregate verdicts (verifier≠fixer) and the outcome is park (DEFERRED terminal for the task).
- All verdicts respect the per-task terminals and run phases defined by the orchestrator (see brain brief).

Provide ONLY your independent verdict. Emit the callback then stop.
[helm callback] ${r} ${params.batchId} STATUS: VERDICT-READY — <CLEAN or BROKEN + details / verdict> (seat ${params.seat} for human trace only)
`;
    return base.replace('<!-- PROJCORE-STATUS-CONTRACT v2 -->', `<!-- PROJCORE-STATUS-CONTRACT v2 -->${body}`).trim();
  }

  // Compliant ibrain brief for implementation escalation (Phase C in orchestrator-loop consult).
  generateBrainBrief(params: {
    batchId: string;
    ledger: any;
    lastReproNote?: string | null;
    projectDir?: string;
    callbacksFile?: string;
  }): string {
    const base = this.generateBrief({
      batchId: params.batchId,
      role: 'ibrain',
      planPath: 'plan.json',
      runDir: '.',
      branch: 'main',
      requirementsAssigned: 'ESCALATION-DECISION',
      northStarAnchors: params.lastReproNote || 'escalated task',
      scope: 'Re-read run folder + failure ledger. CLASSIFY root cause (implementer | validator | plan | requirements). Return one decision. Emit DECISION-READY first.',
      requirementsSection: 'Failure-history ledger + original task brief (for context).',
      projectDir: params.projectDir || '/home/agjrom/TGBOTS/Helm',
      callbacksFile: params.callbacksFile || '<abs-path-to-callbacks.md>',
      taskType: 'feature',
    });
    const body = `
You are **helm_pm** — Helm's on-demand ROOT-CAUSE CLASSIFIER + decision brain (Phase C escalation; a Helm-internal role, not any standalone CLI agent). Re-read run folder + failure ledger on wake.

**ROOT-CAUSE CLASSIFIER (decide WHY the task keeps failing, then route):**
1. **implementer** issue (task sound, worker stuck) → bump-rung / re-brief / validator-handholding (unchanged).
2. **validator** issue (validator is WRONG — false-failing correct work, or inconsistent/vacuous diagnoses) → escalate-validator with validatorAction=revalidate (bump validator rung, re-validate SAME impl output) OR override (accept as PASS with overrideJustification). You judge which. Bound: max 1 override per task; NEVER override a deterministic test-gate FAIL.
3. **plan** issue (task REQUIREMENT/spec is impossible/contradictory/incomplete — not a worker problem; validator planDefectFlag or same gap survives) → re-plan with planRevisionDirective (what's wrong + what to fix) + decisionId. Wakes plancore to surgically revise THIS slice.
4. **requirements** issue (north-star/og-requirements fundamentally wrong) → escalate-to-JROM (page human to re-scope). Do NOT auto-reconsult discovery.

**FSM (CODE = source of truth — orchestrator-loop persistFinal + run-orchestrator + escalation-service; list exactly as built; do NOT invent states or terminals):**
- Canonical machine-plan complexity enum: ${MACHINE_COMPLEXITIES.join(' | ')}.
- Brain verdict JSON must include edge_class (${BRAIN_EDGE_CLASSES.join(' | ')}), route_to (${BRAIN_ROUTE_TO.join(' | ')}), blocker_owner (${BRAIN_BLOCKER_OWNERS.join(' | ')}), and non-empty reason.
- **Which edge_class goes with which route (#54 — say what you MEAN; the label must match your reasoning):**
  - \`rung-attempt-limit\` → bump-rung / re-brief / validator-handholding. The worker is stuck; the task is sound.
  - \`validator-failure\` → escalate-validator. The VALIDATOR is wrong (false-failing correct work, vacuous diagnosis). Only this edge may reach PASS via override.
  - \`plan-defect\` → re-plan. THIS task/slice is impossible, contradictory, or self-inconsistent as written.
  - \`requirements-gap\` → re-plan (preferred first move) or escalate-to-JROM. A requirement the task depends on is MISSING or underspecified upstream. Prefer re-plan: plancore escalates to a frontier model that can often supply a documented domain rule and log the assumption for operator review. Reserve escalate-to-JROM for a genuinely ARBITRARY product decision no model can derive (a business rule, a price, a policy) — not for a rule that is simply written down somewhere in the world.
  - \`external-blocker\` → escalate-to-JROM / deliberation. Something outside the engine is broken (credentials, environment, an unavailable dependency). A higher rung cannot fix it; never launder it into a PASS.
  Do NOT bend your reasoning to fit a label. If your reason says "plan defect, not a validator failure", the edge_class must be plan-defect — not validator-failure. Choosing an ill-fitting label to satisfy a perceived schema is a defect in itself.
- Per-task terminal states (runTask / persistFinal): ONLY PASS | FAIL | BLOCKED | DEFERRED. (Nothing else. No COMPLETE, SUCCESS, DONE, or RECURRENCE_PAUSE as a per-task terminal state.)
- Run phases (run-orchestrator): planning → executing → complete | failed | blocked.
- Escalation decision actions (escalation-service + loop): bump-rung (with targetRung + decisionId), validator-handholding (with spoonFedDirections), re-brief, deliberation, escalate-to-JROM, re-plan (with planRevisionDirective + decisionId), escalate-validator (with validatorAction=revalidate|override; override requires overrideJustification).
- Escalation model: ordinary validator FAILs are free same-rung correction retries and NEVER create escalation pressure by themselves. Wake helm_pm on validator \`defect_class=implementer-incapable\`, \`defect_class=plan-defect\`, or the generous per-rung \`HELM_MAX_TASK_ATTEMPTS\` backstop (default 12, clamped 3..40). helm_pm JUDGES root cause then routes. A top-rung backstop, or a brain bump-rung decision with no higher rung, → BLOCKED + actionable operator page for task/prompt review (a repeated top-model failure is a PROMPT/TASK defect, not a model-strength gap). Other explicit park decisions remain DEFERRED; parked-blocks-all (via getParkedBlockReason after deadlock guard) → phase=blocked + parked-prereq-block.md.
- Deploy (batch-boundary after PASS, B10-T06): discover dev_url + run deploy + validator UI-proof (reuses performRolePhase + B10-T03 framing). No dev_url/config → deploy-paused.md + phase=blocked + BLOCKED callback.
- Final tests (B11-T02/T03 post-queue): smoke (short-circuits on FAIL) then DEV-e2e. FAIL → plain persist (result.json + callback + artifacts) + inject atomic issue-fix task (task_type=issue) for loop-back to Implementation. Same-failure recurrence after full prior escalation chain (B10-T04 repro + B10-T05 ladder) → final-test-recurrence-pause.md + phase=blocked (RECURRENCE_PAUSE is never a per-task terminal; it is a blocked run phase outcome). MAX_FIX_ITERS=3 while still failing → blocked. No smoke/e2e config → final-tests-paused.md + phase=blocked.
- Other control: one task at a time (R-F1 via queue getNextReady + dispatch); top-rung retry exhaustion blocks the run and pages the operator; additive injection + graceful stop (R-F7); per-batch DEV deploy + UI-proof (R-F8); final tests + failure→fix-loop + visible recurrence pause (R-G1/G2).

**Role enum distinction (critical):** helm_pm uses the face callback enum shown above (DECISION-READY / BLOCKED etc.). This ROLE-callback enum is DISTINCT from per-task terminals PASS/FAIL/BLOCKED/DEFERRED (the run_task FSM). Do NOT conflate them.

Failure-history ledger (structured per-attempt: brief, rung/model, validator diagnosis, gates, evidence):
${JSON.stringify(params.ledger || {}, null, 2)}

Task original brief (for context only): ${params.lastReproNote || 'feature task'}.

Return one decision. Emit EXACTLY the callback first (per streaming mandate), then prose.
[helm callback] helm_pm ${params.batchId} STATUS: DECISION-READY — {"edge_class":"rung-attempt-limit","route_to":"bump-rung","blocker_owner":"brain","reason":"...","action":"bump-rung","targetRung":1,"decisionId":"dec-xxx"}
(allowed actions: bump-rung (with targetRung + decisionId), validator-handholding (with spoonFedDirections), re-brief, deliberation, escalate-to-JROM, re-plan (with planRevisionDirective + decisionId), escalate-validator (with validatorAction + overrideJustification when override))

First tool call every reply: the callback STATUS line using the helper.
`;
    return base.replace('<!-- PROJCORE-STATUS-CONTRACT v2 -->', `<!-- PROJCORE-STATUS-CONTRACT v2 -->${body}`).trim();
  }

  /**
   * Focused mid-run plan REVISE brief for plancore (planning brain — NOT ibrain).
   * Surgical revision of ONE defective task slice after ibrain decides re-plan.
   */
  generatePlanReviseBrief(params: {
    batchId: string;
    taskKey: string;
    atomicWork: string;
    validationCriteria: string;
    reqRefs?: string[];
    planRevisionDirective: string;
    ledger: any;
    northStarExcerpt?: string;
    projectDir?: string;
    callbacksFile?: string;
    runDir?: string;
  }): string {
    const base = this.generateBrief({
      batchId: params.batchId,
      role: 'plancore',
      planPath: 'plan.json',
      runDir: params.runDir || '.',
      branch: 'main',
      requirementsAssigned: `PLAN-REVISE:${params.taskKey}`,
      northStarAnchors: params.northStarExcerpt || 'mid-run slice revise',
      scope: `Surgically revise ONLY task ${params.taskKey}. Emit PLAN-READY with a revised task JSON. Do NOT re-plan the whole run.`,
      requirementsSection: params.planRevisionDirective,
      projectDir: params.projectDir || '/home/agjrom/TGBOTS/Helm',
      callbacksFile: params.callbacksFile || '<abs-path-to-callbacks.md>',
      taskType: 'feature',
    });
    const body = `
You are **helm_pm** (plancore / planning brain) — woken mid-run to REVISE one defective task slice. You are NOT the implementation brain (ibrain). Bounded surgical revision ONLY.

## Defective task (current)
- task_key: ${params.taskKey}
- atomic_work: ${params.atomicWork}
- validation_criteria: ${params.validationCriteria}
- req_refs: ${JSON.stringify(params.reqRefs || [])}

## ibrain planRevisionDirective (what's wrong + what to fix)
${params.planRevisionDirective}

## Failure ledger (context)
${JSON.stringify(params.ledger || {}, null, 2)}

## North-star / requirements excerpt
${params.northStarExcerpt || '(see north-star.md + og-requirements.md in runDir)'}

## Your job
Emit EXACTLY ONE revised task object for the SAME task_key (${params.taskKey}). Revise CONTENT ONLY:
- atomic_work
- validation_criteria
- req_refs (optional; omit to keep existing)

IMMUTABLE (do NOT change): task_key, task_type, batch, deps, assignee, validator_lane, complexity.
Do NOT return a set of replacement tasks. Do NOT rewrite the whole plan. Do NOT implement code.

Emit EXACTLY:
[helm callback] helm_pm ${params.batchId} STATUS: PLAN-READY — {"revised_task":{"task_key":"${params.taskKey}","atomic_work":"...","validation_criteria":"...","req_refs":[]},"summary":"<one-line revision summary>"}

First tool call every reply: the callback STATUS line.
`;
    return base.replace('<!-- PROJCORE-STATUS-CONTRACT v2 -->', `<!-- PROJCORE-STATUS-CONTRACT v2 -->${body}`).trim();
  }

  // ---------------------------------------------------------------------------
  // Adaptive tiered planner briefs (additive — existing planning path untouched)
  // ---------------------------------------------------------------------------

  /** Lead planner: draft skeleton only (task_keys + one-line intents + plan_depth). No full specs. */
  generateLeadSkeletonBrief(params: {
    batchId: string;
    northStar: string;
    conversationLog?: string;
    projectDir?: string;
    callbacksFile?: string;
    runDir?: string;
    canonicalArtifactRoot?: string;
    adaptiveDir: string;
  }): string {
    const root = params.canonicalArtifactRoot || params.runDir || '.';
    const base = this.generateBrief({
      batchId: params.batchId,
      role: 'plancore',
      planPath: path.join(root, 'plan.md'),
      runDir: params.runDir || '.',
      branch: 'main',
      requirementsAssigned: 'ADAPTIVE-SKELETON',
      northStarAnchors: params.northStar || '',
      scope: 'Adaptive planning STAGE 2: draft plan SKELETON only (task_keys + one-line intents + plan_depth tags). Do NOT write full plan.md yet.',
      requirementsSection: params.northStar || 'north-star',
      projectDir: params.projectDir || '/home/agjrom/TGBOTS/Helm',
      callbacksFile: params.callbacksFile || '<abs-path-to-callbacks.md>',
      taskType: 'feature',
    });
    const body = `
You are **lead_planner** (planner_01) — top-tier model drafting the plan SKELETON for adaptive tiered planning.
north-star + conversation-log are COMPLETE. Do NOT interview. Author the skeleton DIRECTLY.

## Output (ONLY)
Write JSON to \`${path.join(params.adaptiveDir, 'skeleton.json')}\`:
\`\`\`json
{
  "tasks": [
    {
      "task_key": "T01",
      "intent": "one-line intent",
      "plan_depth": "solo|pair|panel",
      "depth_vector": {"cross_cutting": false, "ambiguity": false, "blast_radius": "low|med|high", "novelty": false},
      "complexity": "low|med|high|xhigh",
      "deps": [],
      "req_refs": ["R-01"],
      "affinity": "optional-cluster-id",
      "shared_contract": false
    }
  ],
  "requirements": ["R-01", "R-02"]
}
\`\`\`

## Rules
- \`plan_depth\` is the ROUTING key (planning uncertainty) — SEPARATE from \`complexity\` (implementer effort).
- Derive plan_depth from depth_vector: justify {cross_cutting, ambiguity, blast_radius, novelty}.
- NO full task specs yet (no validation_criteria prose, no long titles).
- Cover every requirement with ≥1 task_key. No orphan deps. xhigh clusters need a shared-contract task.
- Emit VERDICT-READY after writing skeleton.json.

[helm callback] lead_planner ${params.batchId} STATUS: VERDICT-READY — skeleton written to adaptive/skeleton.json
`;
    return base.replace('<!-- PROJCORE-STATUS-CONTRACT v2 -->', `<!-- PROJCORE-STATUS-CONTRACT v2 -->${body}`).trim();
  }

  /** One panelist challenges the skeleton CUT via closed Critique protocol. */
  generateSkeletonCriticBrief(params: {
    batchId: string;
    skeleton: unknown;
    projectDir?: string;
    callbacksFile?: string;
    runDir?: string;
    adaptiveDir: string;
  }): string {
    const base = this.generateBrief({
      batchId: params.batchId,
      role: 'panelist',
      planPath: 'plan.md',
      runDir: params.runDir || '.',
      branch: 'main',
      requirementsAssigned: 'ADAPTIVE-SKELETON-CRITIQUE',
      northStarAnchors: 'skeleton dual-read',
      scope: 'Challenge the plan skeleton CUT via closed CRITIQUE protocol. Verifier ≠ fixer. Do not author full tasks.',
      requirementsSection: JSON.stringify(params.skeleton, null, 2).slice(0, 4000),
      projectDir: params.projectDir || '/home/agjrom/TGBOTS/Helm',
      callbacksFile: params.callbacksFile || '<abs-path-to-callbacks.md>',
      taskType: 'feature',
    });
    const body = `
You are panelist challenging the lead's plan SKELETON (CUT only — missing tasks, dep-DAG, false-atomic, coverage).

## Closed protocol — write JSON to \`${path.join(params.adaptiveDir, 'critique-skeleton.json')}\`:
\`\`\`
CRITIQUE-READY
verdict: ACCEPT | AMEND | ESCALATE
severity: soft | hard
reasons: [cross_cutting | missing_deps | unsafe_solo | contradicts_decision | false_atomic | needs_JROM | other]
patch: <optional structured deltas: add_tasks, add_deps, remove_tasks, merge, split, set_depth>
\`\`\`

Only ESCALATE+hard burns a tier step / forces re-cut. Soft AMEND may include a patch.
Do NOT write plan.md. Emit VERDICT-READY after the critique file.

[helm callback] panelist ${params.batchId} STATUS: VERDICT-READY — skeleton critique written
`;
    return base.replace('<!-- PROJCORE-STATUS-CONTRACT v2 -->', `<!-- PROJCORE-STATUS-CONTRACT v2 -->${body}`).trim();
  }

  /** Batch-tier authoring: lead/panel author a WHOLE set (solo_set / B_set / A cluster) in one pass. */
  generateTierAuthorBrief(params: {
    batchId: string;
    tier: 'solo' | 'pair' | 'panel';
    tasks: unknown[];
    seat?: number;
    projectDir?: string;
    callbacksFile?: string;
    runDir?: string;
    adaptiveDir: string;
  }): string {
    const role = params.tier === 'panel' && (params.seat ?? 0) > 0 ? 'panelist' : 'plancore';
    const outName = params.tier === 'panel'
      ? `authored-A-seat-${params.seat ?? 0}.json`
      : `authored-${params.tier === 'pair' ? 'B' : 'solo'}.json`;
    // For A clusters the orchestrator uses affinity-qualified names; seat brief still documents the contract.
    const base = this.generateBrief({
      batchId: params.batchId,
      role,
      planPath: 'plan.md',
      runDir: params.runDir || '.',
      branch: 'main',
      requirementsAssigned: `ADAPTIVE-TIER-${params.tier.toUpperCase()}`,
      northStarAnchors: `tier=${params.tier} batch authoring`,
      scope: `Author FULL task specs for the assigned ${params.tier} SET in ONE pass (never per-task). plan_depth stays separate from complexity/effort.`,
      requirementsSection: JSON.stringify(params.tasks, null, 2).slice(0, 4000),
      projectDir: params.projectDir || '/home/agjrom/TGBOTS/Helm',
      callbacksFile: params.callbacksFile || '<abs-path-to-callbacks.md>',
      taskType: 'feature',
    });
    const body = `
You are ${role === 'plancore' ? 'lead_planner' : 'panelist'} authoring the **${params.tier}** task SET in ONE pass (batch, not per-task).
${params.seat != null ? `Seat: ${params.seat} (independent draft; reconcile later).` : ''}

## Assigned skeleton tasks
${JSON.stringify(params.tasks, null, 2).slice(0, 6000)}

## Output
Write a JSON array of execution-plan tasks to \`${path.join(params.adaptiveDir, outName)}\` (orchestrator may use an affinity-qualified filename — same schema):
Each task MUST include: id, batch, title, req_refs, assignee (L1|L2|L3), validator_lane (L1|L2|L3), effort (low|med|high|xhigh), type (feature|issue), deps.
effort/complexity = implementer difficulty. Do NOT put plan_depth into effort.

[helm callback] ${role === 'plancore' ? 'lead_planner' : 'panelist'} ${params.batchId} STATUS: VERDICT-READY — tier set authored
`;
    return base.replace('<!-- PROJCORE-STATUS-CONTRACT v2 -->', `<!-- PROJCORE-STATUS-CONTRACT v2 -->${body}`).trim();
  }

  /** B-tier critic: amend the whole B_set via closed Critique. */
  generateTierCriticBrief(params: {
    batchId: string;
    tier: 'pair' | 'panel';
    tasks: unknown[];
    authored: unknown[];
    projectDir?: string;
    callbacksFile?: string;
    runDir?: string;
    adaptiveDir: string;
  }): string {
    const out = params.tier === 'pair' ? 'critique-B.json' : 'critique-A.json';
    const base = this.generateBrief({
      batchId: params.batchId,
      role: 'panelist',
      planPath: 'plan.md',
      runDir: params.runDir || '.',
      branch: 'main',
      requirementsAssigned: `ADAPTIVE-TIER-CRITIQUE-${params.tier.toUpperCase()}`,
      northStarAnchors: `critique ${params.tier} set`,
      scope: 'Closed Critique on a batch-authored tier set. ESCALATE+hard may promote depth or re-cut.',
      requirementsSection: JSON.stringify({ tasks: params.tasks, authored: params.authored }, null, 2).slice(0, 4000),
      projectDir: params.projectDir || '/home/agjrom/TGBOTS/Helm',
      callbacksFile: params.callbacksFile || '<abs-path-to-callbacks.md>',
      taskType: 'feature',
    });
    const body = `
You are panelist critiquing the **${params.tier}** authored SET (batch, not per-task).

Write closed protocol JSON to \`${path.join(params.adaptiveDir, out)}\`:
verdict ACCEPT|AMEND|ESCALATE, severity soft|hard, reasons enum, optional patch.
For AMEND, patch.tasks may replace the authored set. For ESCALATE+hard, patch may re-cut skeleton (add_tasks/merge/split/set_depth).

[helm callback] panelist ${params.batchId} STATUS: VERDICT-READY — tier critique written
`;
    return base.replace('<!-- PROJCORE-STATUS-CONTRACT v2 -->', `<!-- PROJCORE-STATUS-CONTRACT v2 -->${body}`).trim();
  }

  /** FIX 5 — one cheap binary "any false-solo?" audit over the solo_set. */
  generateSoloAuditBrief(params: {
    batchId: string;
    tasks: unknown[];
    authored: unknown[];
    projectDir?: string;
    callbacksFile?: string;
    runDir?: string;
    adaptiveDir: string;
  }): string {
    const base = this.generateBrief({
      batchId: params.batchId,
      role: 'panelist',
      planPath: 'plan.md',
      runDir: params.runDir || '.',
      branch: 'main',
      requirementsAssigned: 'ADAPTIVE-SOLO-AUDIT',
      northStarAnchors: 'false-solo audit',
      scope: 'Binary audit: any false-solo in the solo_set? Closed Critique only.',
      requirementsSection: JSON.stringify({ tasks: params.tasks, authored: params.authored }, null, 2).slice(0, 4000),
      projectDir: params.projectDir || '/home/agjrom/TGBOTS/Helm',
      callbacksFile: params.callbacksFile || '<abs-path-to-callbacks.md>',
      taskType: 'feature',
    });
    const body = `
Binary audit over the solo_set only: is any task falsely tagged solo (unsafe_solo / cross_cutting / false_atomic)?
Write Critique JSON to \`${path.join(params.adaptiveDir, 'critique-solo-audit.json')}\`.
ESCALATE+hard → promote those tasks to pair/panel. ACCEPT if all solo tags are sound.

[helm callback] panelist ${params.batchId} STATUS: VERDICT-READY — solo audit written
`;
    return base.replace('<!-- PROJCORE-STATUS-CONTRACT v2 -->', `<!-- PROJCORE-STATUS-CONTRACT v2 -->${body}`).trim();
  }

  /**
   * A-cluster settle-pair: named models author the settled task set after panel deadlock.
   * plancore only convenes — settle-pair writes the prose.
   */
  generateSettlePairBrief(params: {
    batchId: string;
    affinity: string;
    drafts: unknown[];
    tasks: unknown[];
    settlePairNames: [string, string];
    projectDir?: string;
    callbacksFile?: string;
    runDir?: string;
    adaptiveDir: string;
    outFile: string;
  }): string {
    const base = this.generateBrief({
      batchId: params.batchId,
      role: 'panelist',
      planPath: 'plan.md',
      runDir: params.runDir || '.',
      branch: 'main',
      requirementsAssigned: `ADAPTIVE-SETTLE-${params.affinity}`,
      northStarAnchors: `settle-pair for affinity=${params.affinity}`,
      scope: 'Settle A-panel deadlock: write ONE settled task set. plancore does not author.',
      requirementsSection: JSON.stringify({ tasks: params.tasks, drafts: params.drafts }, null, 2).slice(0, 4000),
      projectDir: params.projectDir || '/home/agjrom/TGBOTS/Helm',
      callbacksFile: params.callbacksFile || '<abs-path-to-callbacks.md>',
      taskType: 'feature',
    });
    const body = `
You are settle-pair member (**${params.settlePairNames[0]}** + **${params.settlePairNames[1]}**) reconciling A-panel deadlock for affinity \`${params.affinity}\`.

## Conflicting independent drafts
${JSON.stringify(params.drafts, null, 2).slice(0, 8000)}

## Skeleton tasks (for ids / req_refs)
${JSON.stringify(params.tasks, null, 2).slice(0, 4000)}

## Output
Write ONE settled JSON array of execution-plan tasks to \`${params.outFile}\`.
Each task MUST include: id, batch, title, req_refs, assignee, validator_lane, effort, type, deps.
Do NOT leave conflicts unresolved. If operator is required, still write best-effort settled tasks and note needs_JROM in a sibling critique only — plancore decides BLOCK from procedure flags.

[helm callback] panelist ${params.batchId} STATUS: VERDICT-READY — settle-pair wrote settled tasks
`;
    return base.replace('<!-- PROJCORE-STATUS-CONTRACT v2 -->', `<!-- PROJCORE-STATUS-CONTRACT v2 -->${body}`).trim();
  }

  /** Lead integrator: assemble merged plan.md + og-requirements.md (same schema as existing path). */
  generateIntegratorBrief(params: {
    batchId: string;
    authored: unknown[];
    requirements: string[];
    projectDir?: string;
    callbacksFile?: string;
    runDir?: string;
    canonicalArtifactRoot?: string;
    adaptiveDir: string;
  }): string {
    const root = params.canonicalArtifactRoot || params.runDir || '.';
    const base = this.generateBrief({
      batchId: params.batchId,
      role: 'plancore',
      planPath: path.join(root, 'plan.md'),
      runDir: params.runDir || '.',
      branch: 'main',
      requirementsAssigned: 'ADAPTIVE-INTEGRATE',
      northStarAnchors: 'lead integrator',
      scope: 'Assemble merged og-requirements.md + plan.md from tier-authored slices. Do not silently override A-settled text without logging.',
      requirementsSection: JSON.stringify(params.authored, null, 2).slice(0, 4000),
      projectDir: params.projectDir || '/home/agjrom/TGBOTS/Helm',
      callbacksFile: params.callbacksFile || '<abs-path-to-callbacks.md>',
      taskType: 'feature',
    });
    const body = `
You are **lead_planner** INTEGRATOR. Assemble the canonical artifacts from tier-authored slices.

## Requirements ids
${JSON.stringify(params.requirements)}

## Authored slices
${JSON.stringify(params.authored, null, 2).slice(0, 8000)}

## Write
1. \`${path.join(root, 'og-requirements.md')}\` — R-XX requirement contract
2. \`${path.join(root, 'plan.md')}\` — markdown + fenced json array with id,batch,title,req_refs,assignee,validator_lane,effort,type,deps

Same schema as the existing single-author planning path. Do NOT author plan.json (Helm derives it at ingest).
Emit VERDICT-READY after both files are written.

[helm callback] lead_planner ${params.batchId} STATUS: VERDICT-READY — integrated plan.md + og-requirements.md
`;
    return base.replace('<!-- PROJCORE-STATUS-CONTRACT v2 -->', `<!-- PROJCORE-STATUS-CONTRACT v2 -->${body}`).trim();
  }
}
