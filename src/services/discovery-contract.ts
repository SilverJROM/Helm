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
