/**
 * S01 — Shared Discovery contract (single source of truth).
 *
 * Consumed by:
 * - formatActiveCycleBlock / composeAgentSidecar (chat-session-service)
 * - BriefWriterService.generateInterviewBrief
 *
 * North-star: Discovery proposes; operator confirms; HELM convenes Planning.
 * Discovery never plans. Neither canonical nor effective Discovery contract
 * authorizes og-requirements.md, plan.md, or plan.json, or claims Planning complete.
 * HANDOFF is NOT a Discovery state.
 */

export const DISCOVERY_ROLE = 'discovery' as const;

/** Allowed Discovery states — exactly these four. */
export const DISCOVERY_ALLOWED_STATES = [
  'INTERVIEWING',
  'NORTH-STAR-READY',
  'IDLE',
  'BLOCKED',
] as const;

export type DiscoveryAllowedState = (typeof DISCOVERY_ALLOWED_STATES)[number];

/** Terminal Discovery states — exactly these two. HANDOFF is not included. */
export const DISCOVERY_TERMINAL_STATES = ['NORTH-STAR-READY', 'BLOCKED'] as const;

export type DiscoveryTerminalState = (typeof DISCOVERY_TERMINAL_STATES)[number];

/** Discovery-owned cycle artifacts only (no Planning schema / writes). */
export const DISCOVERY_ARTIFACTS = [
  'north-star.md',
  'conversation-log.md',
  'decisions/',
  'attachments/',
  'mockups/',
] as const;

/** Planning-owned artifacts — never authorized by the Discovery contract. */
export const PLANNING_FORBIDDEN_FOR_DISCOVERY = [
  'og-requirements.md',
  'plan.md',
  'plan.json',
] as const;

/**
 * Exact AC7 ready-path ASK string. Must appear in the Discovery contract surface
 * used by the ready path (sidecar phase block + interview brief).
 */
export const DISCOVERY_READY_ASK =
  'Initial Discovery docs are ready. May I ask Helm to start the configured Planning team?';

/** Closed-enum line matching dispatch-service / brief-writer getRoleStates for discovery. */
export function discoveryStatesEnumLine(): string {
  return `discovery states: ${DISCOVERY_ALLOWED_STATES.join(' | ')}`;
}

/** Terminal enum line for Discovery (documentation / contract surface). */
export function discoveryTerminalEnumLine(): string {
  return `discovery terminal: ${DISCOVERY_TERMINAL_STATES.join(' | ')}`;
}

/**
 * Phase contract block for an active cycle in Discovery.
 * Last-authority content: composeAgentSidecar places this last when phase is discovery.
 */
export function formatDiscoveryPhaseContract(): string {
  const artifactLines = DISCOVERY_ARTIFACTS.map((a) => {
    switch (a) {
      case 'north-star.md':
        return '- `north-star.md` — normalized source of truth from the operator file/brief/notes.';
      case 'conversation-log.md':
        return '- `conversation-log.md` — relevant operator answers or source-file summary when available.';
      case 'decisions/':
        return '- `decisions/*.md` — concrete planning assumptions and decisions.';
      case 'attachments/':
      case 'mockups/':
        return a === 'attachments/'
          ? '- `attachments/` and `mockups/` — referenced source files/images when applicable.'
          : null;
      default:
        return `- \`${a}\``;
    }
  }).filter(Boolean);

  return [
    '## Discovery phase contract (AUTHORITATIVE — last authority wins)',
    `- Role: \`${DISCOVERY_ROLE}\``,
    `- ${discoveryStatesEnumLine()}`,
    `- ${discoveryTerminalEnumLine()}`,
    '- `HANDOFF` is NOT a Discovery state.',
    '',
    'Discovery-owned artifacts only (write these in the cycle folder):',
    ...artifactLines,
    '',
    'Do NOT author, replace, or claim ownership of Planning artifacts:',
    ...PLANNING_FORBIDDEN_FOR_DISCOVERY.map((f) => `- \`${f}\``),
    'Discovery never plans. Do not write plan schema, task arrays, or claim Planning complete.',
    '',
    'When Discovery documents are ready, emit the canonical NORTH-STAR-READY callback and ask exactly:',
    DISCOVERY_READY_ASK,
  ].join('\n');
}

/**
 * Planning phase contract for active-cycle sidecars (non-Discovery).
 * Preserves prior Planning schema so planning/non-cycle paths do not regress.
 */
export function formatPlanningPhaseContract(): string {
  return [
    'For active-cycle Planning artifacts, write exactly these files in the cycle folder:',
    '- `og-requirements.md` — requirements contract rendered by Helm Planning.',
    '- `plan.md` — Helm-algo machine contract rendered by Helm Planning and consumed by Implementation.',
    '',
    '`plan.md` must contain a fenced ```json task array. Each task needs `id`, `batch`, `title`, `req_refs`, `assignee`, `validator_lane`, `effort`, and `type`.',
    '`assignee` is the implementer lane: `L1`, `L2`, or `L3`. Use `L2`/`L3` directly for complex work; do not force everything through `L1`. `validator_lane` is the independent validator counterpart: `L1`, `L2`, or `L3`.',
    '`effort` MUST be exactly one of `low`, `med`, `high`, or `xhigh` — NOT T-shirt sizes like `S`/`M`/`L`/`XL` (a non-enum effort is rejected at ingest and blocks the run). `type` MUST be exactly `feature` or `issue`.',
    '`batch` MUST be a non-empty STRING (e.g. "B1", "B2") — NOT a bare number (`1` is rejected and disables Start Implementation; write "B1"). `id`/`title` are strings and `req_refs` is a string array.',
    'Copy this EXACT example task (every field, correct JSON types): {"id":"T01","batch":"B1","title":"Project scaffold","req_refs":["R-1"],"assignee":"L1","validator_lane":"L1","effort":"med","type":"feature"}.',
    'Only use a literal model slug in `assignee` or `validator` when deliberately overriding Helm project bindings. Prefer lane labels so the harness stays project-agnostic.',
  ].join('\n');
}

/** True when the cycle phase is Discovery (case-insensitive). Empty/unknown is not Discovery. */
export function isDiscoveryPhase(phase?: string | null): boolean {
  return String(phase || '')
    .trim()
    .toLowerCase() === 'discovery';
}

/** True when the cycle phase is Planning (case-insensitive). */
export function isPlanningPhase(phase?: string | null): boolean {
  const p = String(phase || '')
    .trim()
    .toLowerCase();
  return p === 'planning' || p === 'plan';
}

// ─── B21 / R7.2+R7.3 — discovery-time branch hygiene as FIRST exchange ────────

/**
 * Stable heading for the hygiene block. Used by formatActiveCycleBlock (sidecar) and
 * generateInterviewBrief; tests assert this block precedes the interview mandate and contains
 * no discovery-side judgement verbs (D5 / R7.2).
 */
export const DISCOVERY_HYGIENE_HEADING =
  '## Discovery opening exchange — repo branch hygiene (FIRST topic)';

/**
 * Structural survey facts shape (matches cycle-branch-onboarding CycleBranchSurvey / B4+B5
 * BranchSafetyReport). Kept structural here so discovery-contract stays free of service imports.
 */
export interface DiscoveryHygieneSurveyFacts {
  exists: boolean;
  mergedInto: string[];
  tiedToActiveCycleId: number | null;
  lastCommitAt: string | null;
  ageDays: number | null;
  aheadBehind: { ahead: number; behind: number } | null;
  uncommittedInWorktree: boolean;
  worktreePath: string | null;
}

export interface DiscoveryHygieneSurveyEntry {
  cycleId: number;
  cycleName: string;
  branch: string;
  report: { facts: DiscoveryHygieneSurveyFacts; narrative?: string | null };
}

export interface DiscoveryHygieneSurvey {
  branches: DiscoveryHygieneSurveyEntry[];
  degraded: boolean;
}

/**
 * Discovery-side judgement verbs / phrases that MUST NOT appear in the hygiene block.
 * The operator alone chooses keep / delete / ignore (R7.2, D5). Case-insensitive match.
 * Note: the words "delete" / "keep" / "ignore" as *operator options* are allowed; these
 * entries are discovery-side *judgment* language.
 */
export const DISCOVERY_HYGIENE_FORBIDDEN_JUDGEMENT_VERBS = [
  'recommend',
  'recommended',
  'should delete',
  'must delete',
  'ought to',
  'advisable',
  'i suggest',
  'suggest deleting',
  'prefer deleting',
  'safe to delete',
  'unsafe to keep',
  'cleanup needed',
  'you should',
  'verdict',
  'decision: delete',
  'decision: keep',
  'allow delete',
  'deny delete',
] as const;

/**
 * R7.2 / R7.3 / D5 — format the branch-hygiene survey as Discovery's FIRST conversational
 * exchange. Facts only: discovery presents, never judges. Operator chooses keep/delete/ignore
 * (and the new cycle's base); after their reply the normal requirements interview continues in
 * the SAME session. Never blocks: degraded/empty surveys still yield a presentable block.
 */
export function formatDiscoveryHygieneExchange(
  survey?: DiscoveryHygieneSurvey | null,
  opts?: { defaultBase?: string | null }
): string {
  const defaultBase = String(opts?.defaultBase || '').trim() || 'main';
  const lines: string[] = [
    DISCOVERY_HYGIENE_HEADING,
    '',
    'This is the FIRST topic of the Discovery conversation (R7.2 / D5). Open with it before any new-task requirements questions.',
    'Present FACTS only. You do NOT decide, act on, or judge cleanup. The operator alone chooses **keep** / **delete** / **ignore** for each listed branch, and confirms the base for this new cycle.',
    'After the operator replies (including "nothing to do, proceed"), continue in THIS SAME session into the normal requirements interview (R7.3). Do not open a separate flow.',
    '',
    '### Survey facts (structured; no narrative judgment)',
  ];

  if (!survey || survey.degraded) {
    lines.push(
      '- Survey status: degraded or unavailable — no sibling branch facts to list. Still ask the operator to confirm the base branch for this cycle, then proceed to the interview.'
    );
  } else if (!survey.branches.length) {
    lines.push('- No other Helm cycle branches found on this project.');
  } else {
    for (const entry of survey.branches) {
      const f = entry.report?.facts;
      if (!f) {
        lines.push(
          `- Branch \`${entry.branch}\` (cycle #${entry.cycleId} "${entry.cycleName}"): facts unavailable.`
        );
        continue;
      }
      const merged = f.mergedInto?.length ? f.mergedInto.join(', ') : 'none';
      const tied =
        f.tiedToActiveCycleId == null ? 'none' : String(f.tiedToActiveCycleId);
      const age = f.ageDays == null ? 'n/a' : String(f.ageDays);
      const aheadBehind = f.aheadBehind
        ? `ahead=${f.aheadBehind.ahead} behind=${f.aheadBehind.behind}`
        : 'n/a';
      const wt = f.worktreePath || 'none';
      lines.push(
        `- Branch \`${entry.branch}\` (cycle #${entry.cycleId} "${entry.cycleName}"): ` +
          `exists=${Boolean(f.exists)}; mergedInto=[${merged}]; tiedToActiveCycleId=${tied}; ` +
          `lastCommitAt=${f.lastCommitAt ?? 'n/a'}; ageDays=${age}; aheadBehind=${aheadBehind}; ` +
          `uncommittedInWorktree=${Boolean(f.uncommittedInWorktree)}; worktreePath=${wt}`
      );
    }
  }

  lines.push(
    '',
    `### Base for this new cycle`,
    `- Offered default base: \`${defaultBase}\` (operator may override; discovery does not pick).`,
    '',
    '### Operator decision (explicitly theirs — never discovery\'s)',
    'Ask the operator, for each relevant branch: **keep** / **delete** / **ignore**. Record their choice only; do not execute deletes from this survey step.',
    'Record their base-branch choice for the new cycle (or acceptance of the default), then continue the requirements interview in this same session.'
  );

  return lines.join('\n');
}

/** True when `text` contains any forbidden discovery-side judgement verb (case-insensitive). */
export function discoveryHygieneContainsJudgementVerb(text: string): boolean {
  const lower = String(text || '').toLowerCase();
  return DISCOVERY_HYGIENE_FORBIDDEN_JUDGEMENT_VERBS.some((v) => lower.includes(v));
}
