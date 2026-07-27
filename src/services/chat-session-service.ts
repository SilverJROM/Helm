import { createHash } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TmuxService } from '../tmux/tmux-service.js';
import { resolveHelmSandboxBin, makeStrictReadProfileEnv } from '../security/landlock-sandbox.js';
import { startGovernedDocGuard, type GovernedDocGuardHandle } from './doc-path-guard.js';
import { ModelService } from './model-service.js';
import { AgentAssignmentService } from './agent-assignment-service.js';
import { ProviderResolverService } from './provider-resolver-service.js';
import { MemoryService, type MemoryRow } from './memory-service.js';
import { ProjectService, type Project } from './project-service.js';
import { PROVIDERS, seatReadySignal } from '../config/providers.js';
import { applyEnvelopeIsolation } from './envelope-isolation.js';

// C1 KEY-C1: agent test-chat transport (SSE+POST, DELIB consensus 2026-06-21).
// Ephemeral in-memory session store — a test-chat session is a tmux pane running the
// agent's resolved provider/model. NOT persisted to DB; server restart kills all sessions
// (acceptable for test-chat). C1b wires the UI panel to this transport.

// B5 R-17: provider-agnostic global infra rules (service constant — not user-editable, not ~/.claude).
export const HELM_INFRA_RULES = `You are running inside Helm test-chat (test and discuss only — not production orchestration).

Memory: Do not use native CLI memory. Use Helm app and project memory supplied via the Helm UI.

Tools: Follow the Helm tool and callback protocol when tools are available.`;

// AGENTROLE T3: workspace rules for HELM agents (master_agent, overseer, jkagebunshin).
// These agents' real workplace is Agent Studio — they should do real work here, not be in "test mode".
export const HELM_WORKSPACE_RULES = `You are in your Helm workspace. JROM works with you here directly — this is your real workplace, not a disposable test chat. Do real work within your sanctioned flows. Memory: use Helm app/project memory from the UI; do not use native CLI memory. Tools: follow the Helm tool/callback protocol when available.`;

// Project-scoped Command Center chats are the operator's live project workspace. They must not inherit
// the disposable test-chat framing, especially for cycle Discovery/Planning work.
export const HELM_PROJECT_WORKSPACE_RULES = `You are operating inside Helm Command Center for this project. This is a real project workspace, not a disposable test chat.

Use Helm's project and cycle context as authoritative. When an active cycle is supplied, all Helm-generated work products for that cycle belong inside the active cycle folder. If the operator gives you a file, brief, notes, or an intake source for a cycle, normalize it into the active cycle folder as Helm cycle artifacts before planning. If the operator asks for Discovery, Planning, Implementation handoff, validation, or decisions, write those artifacts to the active cycle folder using Helm's canonical filenames and schemas. Do not invent separate generic phase-brain run folders unless explicitly instructed.

Memory: use Helm app/project memory supplied by the UI; do not use native CLI memory. Tools: follow the Helm tool and callback protocol when available.`;

// Reply protocol (JROM 2026-06-22): the agent thinks/works freely in its terminal (shown in the
// Session Logs tab), but must wrap its user-facing answer in markers — Helm shows ONLY that block
// in the Chat tab. Keeps thinking out of the chat + makes extraction deterministic (no fragile diff).
export const HELM_REPLY_OPEN = '⟦HELM_REPLY⟧';
export const HELM_REPLY_CLOSE = '⟦/HELM_REPLY⟧';
export const HELM_REPLY_PROTOCOL = `Chat reply protocol (IMPORTANT — follow every turn):
- Think, reason, and use tools normally. All of that stays in your terminal (the user sees it in the "Session Logs" tab).
- Then write your user-facing answer wrapped EXACTLY in these markers, on their own lines:
${HELM_REPLY_OPEN}
<your concise reply to the user here>
${HELM_REPLY_CLOSE}
- The Chat tab shows ONLY the text between those markers. Put nothing else inside them. Emit the markers literally (do not put them in a code block).`;

export interface ChatSession {
  agentId: number;
  tmuxSession: string;
  paneTarget: string;
  lastSnapshot: string;
  createdAt: number;
  bootstrapSent: boolean;
  bootstrapEndMarker: string;
  bootstrapHash: string;
  bootstrapMarkerSeen: boolean;
  spawnProvider: string;
  spawnModel: string;
  sending?: boolean;
  // Async delivery queue: sends are accepted immediately (HTTP returns fast — the Cloudflare tunnel
  // caps a held request at ~100s) and drained in the background, waiting as long as the agent is
  // genuinely working. Ordered; a running drain picks up anything appended while it runs.
  // F2: each queued item carries the STABLE client message id (the optimistic UI bubble's id) so a delivery
  // failure is correlated to the exact bubble by ID — never by (ambiguous, possibly duplicate) text — plus
  // the LOGICAL CHANNEL (round-6: `project:<pid>` / `studio:<agentId>`) the failure is recorded under, so a
  // failure produced by an OLD sid surfaces on the REPLACEMENT sid's stream (same channel).
  queue?: Array<{ text: string; msgId: string; channel: string }>;
  // CC-CHAT-1 B1: project-scoped sessions record their fence (projectDir) + owning project.
  projectId?: number;
  fenceDir?: string;
  // NOTE (F2, round-6): delivery failures live in a ChatSessionService-level ledger keyed by LOGICAL CHANNEL
  // (NOT sid), decoupled from session lifecycle — see channelLedger.
}

export interface ChatSessionDeps {
  tmux: TmuxService;
  modelService: ModelService;
  assignmentService: AgentAssignmentService;
  resolverService: ProviderResolverService;
  memoryService?: MemoryService;
  // When present, create() injects an authoritative "Project Definition" block (name + directory +
  // dev URL) into every project-scoped bootstrap, pulled live from the project row — so the agent
  // always knows its real working directory from the Helm project setup, never inferred from doc prose
  // (which may emphasise reference/source paths like a migration's origin app).
  projectService?: ProjectService;
  fenceDir?: string;
  nowFn?: () => number;
}

export interface ActiveCycleContext {
  id: number;
  name: string;
  folder_name: string;
  folder_path: string;
  phase?: string | null;
  autonomy?: string | null;
}

export function bootstrapEndMarker(sessionId: string): string {
  return `<!-- HELM_BOOTSTRAP_END:${sessionId} -->`;
}

/**
 * Dedicated, isolated sandbox directory for test-chat agent spawns (JROM 2026-06-22).
 * Test-chat is "test & discuss only" — agents spawn HERE, not in the live repo, so a stray
 * CLI session can't touch project files. For claude, we also pre-accept the folder-trust dialog
 * on THIS dir only (folder-trust plumbing — NOT identity; Helm still owns identity via the
 * injected definition_md). Mirrors RealTransport POCFIX7 but scoped to the sandbox dir.
 * Returns the absolute sandbox path (created if missing).
 */
export async function ensureTestChatSandbox(provider: string): Promise<string> {
  const base = process.env.HELM_TESTCHAT_SANDBOX
    || path.join(os.homedir() || process.cwd(), '.helm', 'testchat-sandbox');
  const abs = path.resolve(base);
  try { await fs.mkdir(abs, { recursive: true }); } catch { /* best-effort; launch will surface real failures */ }
  if (provider === 'claude') await ensureClaudeFolderTrust(abs);
  return abs;
}

/**
 * CC-CHAT-1 B1: pre-accept the claude folder-trust dialog for a specific directory (folder-trust
 * plumbing — NOT identity; Helm still owns identity via the injected definition_md). Shared by the
 * test-chat sandbox and project-fenced sessions (which spawn at the project directory).
 */
export async function ensureClaudeFolderTrust(dir: string): Promise<void> {
  try {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    if (home) {
      const cfgPath = path.join(home, '.claude.json');
      let cfg: any = { projects: {} };
      try { cfg = JSON.parse((await fs.readFile(cfgPath, 'utf8')) || '{}'); } catch { /* fresh */ }
      if (!cfg.projects) cfg.projects = {};
      if (!cfg.projects[dir]) cfg.projects[dir] = {};
      cfg.projects[dir].hasTrustDialogAccepted = true;
      cfg.projects[dir].hasCompletedProjectOnboarding = true;
      await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
    }
  } catch (e) {
    console.warn('[chat-session] claude folder-trust ensure best-effort failed (continuing)', e);
  }
}

/** B6b R-16: approved app-scope memories as a readable block (omit when empty). */
export function formatAppMemoryBlock(memories: Pick<MemoryRow, 'title' | 'description' | 'body'>[]): string {
  if (memories.length === 0) return '';
  const lines = ['Helm shared memory:'];
  for (const m of memories) {
    const title = (m.title ?? '').trim();
    if (!title) continue;
    const summary = (m.description ?? m.body ?? '').trim().replace(/\s+/g, ' ');
    lines.push(summary ? `- ${title}: ${summary}` : `- ${title}`);
  }
  return lines.length > 1 ? lines.join('\n') : '';
}

/** Strip ANSI/VT escape sequences (colour, cursor, style) so the clean chat thread is readable. */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\u001b\u009b][[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007|(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~])/g;
// eslint-disable-next-line no-control-regex
const LONE_CTRL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
export function stripAnsi(s: string): string {
  return (s ?? '').replace(ANSI_RE, '').replace(LONE_CTRL_RE, '');
}

/** tmux-safe slug from an agent name (for a readable, attach-able session name). */
export function agentSessionSlug(name: string | null | undefined): string {
  const s = (name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  return s || 'agent';
}

/** Raised by sendMessage when the agent is mid-generation — API maps this to HTTP 409 (not 500). */
export class AgentBusyError extends Error {
  constructor(msg = 'agent is generating a response — try again in a moment') {
    super(msg);
    this.name = 'AgentBusyError';
  }
}

/** Last N non-empty lines of a pane — the current footer/status region (not scrollback). */
export function paneFooterRegion(pane: string, maxLines = 8): string {
  const lines = stripAnsi(pane).split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  return lines.slice(-maxLines).join('\n');
}

/** True when the TUI footer shows ACTIVE generation indicators (not past-tense done markers). */
export function paneIsGenerating(pane: string): boolean {
  const footer = paneFooterRegion(pane, 8);
  return /esc to interrupt|esc to cancel|⏹|Responding…|Generating…|Thinking…|Working…/i.test(footer);
}

export interface ActiveSessionInfo {
  session_id: string;
  agent_id: number;
  agent_name: string;
  tmux_session: string;
}

/** B5 R-15/R-17 + B6b R-16 + AGENTROLE T3: identity-first opening message with app memories before end-marker.
 *  HELM agents get workspace rules (real workplace); PROJECT agents get test-chat infra rules. */
/**
 * Authoritative project-definition block — pulled live from the Helm project row (name + directory +
 * dev URL). Placed FIRST in the bootstrap so it outranks anything the agent later reads in project
 * docs. Fixes the "agent thinks the project lives at the reference/source path" class: docs for a
 * migration (e.g. lokalspeak ← meet-poc) are dominated by the SOURCE app's path, so an agent with no
 * explicit working-directory anchor mis-reports its location. This block is that anchor.
 */
export function formatProjectDefinitionBlock(
  projectContext?: Pick<Project, 'name' | 'directory' | 'dev_url'> | null,
  projectDocs?: { techStack?: string | null; docPaths?: string[] } | null
): string {
  if (!projectContext || !projectContext.directory) return '';
  const lines = [
    '## Project (AUTHORITATIVE — from the Helm project setup; OUTRANKS your base/Studio agent instructions)',
    `- Project: ${projectContext.name}`,
    `- Working directory: ${projectContext.directory}`,
  ];
  if (projectContext.dev_url) lines.push(`- Dev URL: ${projectContext.dev_url}`);
  const tech = projectDocs?.techStack?.trim();
  if (tech) {
    lines.push('', '### Tech stack (from the project)', tech);
  }
  lines.push(
    '',
    // JROM directive (2026-07-06): in a project, the PROJECT outranks the agent's own Agent-Studio
    // identity. Its definition, specs, docs, and standards govern; the base agent prompt is only the
    // fallback persona underneath.
    `PRECEDENCE: this project is the source of truth. Its definition, specs, docs, and standards ` +
      `OVERRIDE your own agent/Studio instructions and any default behavior wherever they conflict — ` +
      `follow the project over your defaults.`
  );
  const docs = (projectDocs?.docPaths || []).filter(Boolean);
  if (docs.length) {
    lines.push('', 'Project docs to read and follow (authoritative — consult before acting):', ...docs.map((d) => `- ${d}`));
  }
  lines.push(
    '',
    `The Working directory above is where THIS project lives — you operate here. Other paths mentioned in ` +
      `the docs (a reference/source app being migrated from, a rollback copy, sibling projects) are NOT your ` +
      `project location.`
  );
  return lines.join('\n');
}

export function formatActiveCycleBlock(activeCycle?: ActiveCycleContext | null): string {
  if (!activeCycle) return '';
  const lines = [
    '## Active Helm cycle (AUTHORITATIVE)',
    `- Cycle id: ${activeCycle.id}`,
    `- Cycle name: ${activeCycle.name}`,
    `- Cycle folder name: ${activeCycle.folder_name}`,
    `- Cycle folder path: ${activeCycle.folder_path}`,
  ];
  if (activeCycle.phase) lines.push(`- Current phase: ${activeCycle.phase}`);
  if (activeCycle.autonomy) lines.push(`- Autonomy: ${activeCycle.autonomy}`);
  lines.push(
    '',
    'All Helm work for this selected cycle must be created or moved inside that cycle folder. Treat project-level `plan/` folders as legacy/scratch unless the operator explicitly names them.',
    '',
    'For active-cycle Discovery / intake artifacts, write standardized files in the cycle folder:',
    '- `north-star.md` — normalized source of truth from the operator file/brief/notes.',
    '- `conversation-log.md` — relevant operator answers or source-file summary when available.',
    '- `decisions/*.md` — concrete planning assumptions and decisions.',
    '- `attachments/` and `mockups/` — referenced source files/images when applicable.',
    '',
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
    '',
    'Do not write cycle artifacts to generic phase-brain run folders, and do not use legacy names like `north_star.md`, `og_req.md`, or `execution_plan.md` for the active cycle.'
  );
  return lines.join('\n');
}

/**
 * Best-effort gather of a project's authoritative context for the bootstrap: the tech-stack text
 * (small, capped) + the doc paths the agent should treat as governing. Never throws — a missing
 * dir/file just yields fewer pointers; the session must still spawn.
 */
export async function gatherProjectDocs(dir: string): Promise<{ techStack: string | null; docPaths: string[] }> {
  const docPaths: string[] = [];
  let techStack: string | null = null;
  try {
    const hd = path.join(dir, 'helm_docs');
    const entries = await fs.readdir(hd);
    for (const f of entries.filter((e) => e.endsWith('.md')).sort()) {
      docPaths.push(path.join('helm_docs', f));
      if (f === 'tech-stack.md') {
        try {
          const raw = (await fs.readFile(path.join(hd, f), 'utf8')).trim();
          techStack = raw.length > 1200 ? raw.slice(0, 1200) + '\n…(truncated — read the file for the rest)' : raw;
        } catch { /* skip tech-stack read */ }
      }
    }
  } catch { /* no helm_docs dir */ }
  for (const name of ['project_specs.md', 'north-star.md', 'AGENT-HANDOFF.md', 'README.md']) {
    try {
      await fs.access(path.join(dir, name));
      docPaths.push(name);
    } catch { /* absent */ }
  }
  return { techStack, docPaths };
}

/**
 * SIDECAR content — the agent's FULL role brief: project-authority block + persona (definition_md) +
 * infra rules + app memories. This is written to a file the agent reads, NOT pasted into the composer.
 * (The 6.7KB projcore definition made the old single-paste bootstrap ~8.5KB/136 lines, which the TUI
 * composer dropped intermittently — projcore then started with no persona. JROM directive: inject only
 * the lean necessary prompt at start; the rest is a sidecar the agent reads.)
 */
export function composeAgentSidecar(
  definitionMd: string | null | undefined,
  appMemories: Pick<MemoryRow, 'title' | 'description' | 'body'>[] = [],
  agentType?: string,
  projectContext?: Pick<Project, 'name' | 'directory' | 'dev_url'> | null,
  projectDocs?: { techStack?: string | null; docPaths?: string[] } | null,
  activeCycle?: ActiveCycleContext | null
): string {
  const def = (definitionMd ?? '').trim();
  const projectBlock = formatProjectDefinitionBlock(projectContext, projectDocs);
  const cycleBlock = formatActiveCycleBlock(activeCycle);
  const infraRules = projectContext
    ? HELM_PROJECT_WORKSPACE_RULES
    : (agentType === 'house' || agentType === 'helm') ? HELM_WORKSPACE_RULES : HELM_INFRA_RULES;
  const memoryBlock = formatAppMemoryBlock(appMemories);
  return [projectBlock, cycleBlock, def, infraRules, memoryBlock].filter((p) => p.length > 0).join('\n\n');
}

/**
 * LEAN startup prompt actually pasted into the composer — small + reliable to submit. Establishes
 * identity + working dir, points at the sidecar file as the authoritative brief to read first, and
 * carries the reply protocol (needed from turn 1 so Helm can parse replies) + the end marker.
 */
export function composeLeanBootstrap(
  sessionId: string,
  opts: { agentName: string; projectName?: string | null; projectDir?: string | null; sidecarPath: string }
): string {
  const marker = bootstrapEndMarker(sessionId);
  const who = opts.projectName && opts.projectDir
    ? `You are ${opts.agentName}, working on the Helm project "${opts.projectName}" (working directory: ${opts.projectDir}).`
    : `You are ${opts.agentName}, an agent operating inside Helm.`;
  const briefRef =
    `Your full role brief and this project's authoritative context (persona, standards, tech-stack, ` +
    `and the project docs that govern your work) are in this file:\n  ${opts.sidecarPath}\n` +
    `Read that file FIRST — it is authoritative and overrides your own defaults — then respond.`;
  return `${who}\n\n${briefRef}\n\n${HELM_REPLY_PROTOCOL}\n\n${marker}`;
}

/**
 * Back-compat: the single-payload bootstrap (sidecar content + reply protocol + marker). Retained for
 * callers/tests that want the full text in one string; create() now uses the lean+sidecar split.
 */
export function composeBootstrap(
  definitionMd: string | null | undefined,
  sessionId: string,
  appMemories: Pick<MemoryRow, 'title' | 'description' | 'body'>[] = [],
  agentType?: string,
  projectContext?: Pick<Project, 'name' | 'directory' | 'dev_url'> | null,
  projectDocs?: { techStack?: string | null; docPaths?: string[] } | null,
  activeCycle?: ActiveCycleContext | null
): string {
  const marker = bootstrapEndMarker(sessionId);
  const sidecar = composeAgentSidecar(definitionMd, appMemories, agentType, projectContext, projectDocs, activeCycle);
  const parts = [sidecar, HELM_REPLY_PROTOCOL].filter((p) => p.length > 0);
  return `${parts.join('\n\n')}\n\n${marker}`;
}

/** B5 L4 + B5R2: strip visible bootstrap; once marker scrolled off (seen), return raw so answers show. */
export function sanitizePostBootstrap(
  raw: string,
  sess: Pick<ChatSession, 'bootstrapSent' | 'bootstrapEndMarker' | 'bootstrapMarkerSeen'>
): string {
  if (!sess.bootstrapSent) return raw;
  const idx = raw.indexOf(sess.bootstrapEndMarker);
  if (idx >= 0) {
    return raw.slice(idx + sess.bootstrapEndMarker.length).replace(/^\n+/, '');
  }
  if (sess.bootstrapMarkerSeen) return raw;
  return '';
}

const BOOTSTRAP_MARKER_MS = 5_000;

async function waitForBootstrapMarker(
  tmux: Pick<TmuxService, 'capturePane'>,
  target: string,
  marker: string,
  timeoutMs = BOOTSTRAP_MARKER_MS
): Promise<boolean> {
  if (process.env.USE_FAKE_TMUX === '1' && process.env.NODE_ENV !== 'production') return true;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const pane = stripAnsi(await tmux.capturePane(target, 200));
      if (pane.includes(marker)) return true;
    } catch { /* poll */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

export class ChatSessionService {
  private readonly sessions = new Map<string, ChatSession>();
  // R7.26/B22b-cont: userspace fence for the 3 plan/<cycle> governed docs, keyed by tmux session
  // name, for the fenced chat session's lifetime (project-fenced sessions only; test-chat sandbox
  // dirs have no governed docs to protect). north-star.md is kernel-fenced; see helm-sandbox.c.
  private readonly governedDocGuards = new Map<string, GovernedDocGuardHandle>();
  // Round-6 TERMINAL F2 CONTRACT: "an accepted message's uncertain delivery status may never disappear without
  // EITHER an exact failure event OR a visible gap." Failures are keyed by LOGICAL CHANNEL (project:<pid> /
  // studio:<agentId>), so a failure produced by an OLD sid surfaces on the REPLACEMENT sid's stream. Each
  // channel owns its own monotonic seq / cursor state. Every destructive retention path degrades to a gap
  // (never a silent loss); memory stays bounded. Compaction-to-a-gap is ALLOWED — we do NOT retain payloads forever.
  private static readonly DELIVERY_FAIL_CAP = 500;       // per-channel payload cap → overflow advances evictedThrough
  private static readonly LEDGER_TTL_MS = 30 * 60 * 1000; // untouched entries expire (acked→delete, unacked→tombstone)
  private static readonly LEDGER_MAX_CHANNELS = 2000;     // hard cap on channels retained
  private readonly channelLedger = new Map<string, {
    seq: number;            // channel-local monotonic failure seq
    failures: Array<{ seq: number; msgId: string; text: string; reason: string }>;
    evictedThrough: number; // highest seq compacted away → drives the per-channel gap (never a silent drop)
    ackedThrough: number;   // client-acknowledged high watermark (only acked payloads may be removed)
    emittedThrough: number; // round-7 (finding #2): highest seq the server has actually EMITTED to a consumer
                            // on this channel — an ACK may never advance ackedThrough past this (a buggy/racing
                            // ack must not poison the watermark and silently drop a not-yet-emitted failure).
    updatedAt: number;
  }>();
  // Process-wide STICKY loss marker: bumped only when even a gap TOMBSTONE must be discarded to hold the hard
  // cap. Emitted on EVERY stream; the client shows an app-wide gap until the owner explicitly acknowledges it.
  private lossGeneration = 0;
  // Per-PROCESS epoch. A restart resets channel seqs to 0; a cursor from a different epoch must not suppress a
  // new low-seq failure, and the client shows a gap for any prior unacknowledged optimistic state.
  private readonly deliveryEpoch = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  constructor(private readonly deps: ChatSessionDeps) {}

  get deliveryEpochToken(): string { return this.deliveryEpoch; }
  get deliveryLossGeneration(): number { return this.lossGeneration; }

  private channelEntry(channel: string) {
    let e = this.channelLedger.get(channel);
    if (!e) { e = { seq: 0, failures: [], evictedThrough: 0, ackedThrough: 0, emittedThrough: 0, updatedAt: Date.now() }; this.channelLedger.set(channel, e); }
    return e;
  }

  /** F2: record a PERMANENT delivery failure (after bounded retries) under its LOGICAL CHANNEL, correlated by
   *  the stable client `msgId`. Survives the session's sid being terminated/switched (keyed by channel, not sid). */
  private recordDeliveryFailure(channel: string, msgId: string, text: string, reason: string): void {
    const e = this.channelEntry(channel);
    e.failures.push({ seq: ++e.seq, msgId, text, reason });
    e.updatedAt = Date.now();
    // Per-channel overflow → discard oldest but advance evictedThrough (a GAP, never a silent loss).
    while (e.failures.length > ChatSessionService.DELIVERY_FAIL_CAP) {
      const dropped = e.failures.shift()!;
      e.evictedThrough = Math.max(e.evictedThrough, dropped.seq);
    }
    this.pruneChannelLedger();
  }

  /** F2 explicit ACK: the UI POSTs its channel high-watermark AFTER applying a delivery-failed event or
   *  rendering a gap. Only ACKNOWLEDGED payloads may be removed as fully-delivered notification state (an SSE
   *  write alone is NOT an ack). */
  ackDelivery(channel: string, throughSeq: number): void {
    const e = this.channelLedger.get(channel);
    if (!e) return;
    // round-7 (finding #2): reject out-of-range acks. An ack may only advance the watermark, and NEVER past
    // what the server has actually EMITTED to a consumer on this channel — otherwise an out-of-range ack (e.g.
    // 999 against seq 1–3) would poison ackedThrough so a LATER seq-4 failure is classified "acknowledged" and
    // TTL-deleted with no gap (silent loss). Clamp to emittedThrough; ignore non-finite / non-advancing acks.
    if (!Number.isFinite(throughSeq)) return;
    const emitted = e.emittedThrough || 0;
    const bounded = Math.min(throughSeq, emitted);
    if (bounded <= e.ackedThrough) return; // out-of-range or stale → no poisoning, no drop
    e.ackedThrough = bounded;
    e.updatedAt = Date.now();
    e.failures = e.failures.filter((f) => f.seq > e.ackedThrough); // drop delivered+acked payloads only
  }

  private channelHighestSeq(e: { failures: Array<{ seq: number }>; evictedThrough: number }): number {
    return e.failures.length ? e.failures[e.failures.length - 1].seq : e.evictedThrough;
  }
  private channelFullyAcked(e: { failures: Array<{ seq: number }>; evictedThrough: number; ackedThrough: number }): boolean {
    return e.ackedThrough >= this.channelHighestSeq(e);
  }

  /** Bound memory while NEVER silently losing an uncertain status:
   *  - TTL: acked/empty entries delete silently; an unacknowledged expired entry is COMPACTED to a one-record
   *    gap tombstone (payloads dropped, evictedThrough kept → the client still gets a gap).
   *  - Hard cap: first remove acked/empty, then compact unacked to tombstones; if STILL over cap, discard the
   *    oldest tombstones and bump the sticky process-wide lossGeneration (→ an app-wide visible gap). */
  private pruneChannelLedger(now = Date.now()): void {
    for (const [ch, e] of this.channelLedger) {
      if (now - e.updatedAt <= ChatSessionService.LEDGER_TTL_MS) continue;
      if (this.channelFullyAcked(e)) { this.channelLedger.delete(ch); continue; } // acked/empty → silent clean
      // unacknowledged → compact to a gap tombstone (constant size), keep the gap
      e.evictedThrough = Math.max(e.evictedThrough, this.channelHighestSeq(e));
      e.failures = [];
    }
    if (this.channelLedger.size <= ChatSessionService.LEDGER_MAX_CHANNELS) return;
    // pass 1: drop fully-acked/empty entries.
    for (const [ch, e] of this.channelLedger) {
      if (this.channelLedger.size <= ChatSessionService.LEDGER_MAX_CHANNELS) break;
      if (this.channelFullyAcked(e)) this.channelLedger.delete(ch);
    }
    // pass 2: compact unacked (oldest first) to gap tombstones (frees payload memory, keeps the gap).
    for (const [, e] of [...this.channelLedger.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)) {
      if (this.channelLedger.size <= ChatSessionService.LEDGER_MAX_CHANNELS) break;
      if (e.failures.length) { e.evictedThrough = Math.max(e.evictedThrough, this.channelHighestSeq(e)); e.failures = []; }
    }
    // pass 3: if STILL over cap (all tombstones), discard oldest tombstones + bump the sticky lossGeneration.
    let discardedTombstone = false;
    for (const [ch] of [...this.channelLedger.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)) {
      if (this.channelLedger.size <= ChatSessionService.LEDGER_MAX_CHANNELS) break;
      this.channelLedger.delete(ch);
      discardedTombstone = true;
    }
    if (discardedTombstone) this.lossGeneration += 1; // loss → app-wide visible gap (sticky until acked)
  }

  /** F2: delivery failures for a CHANNEL with seq > sinceSeq, plus a per-channel gap signal, the current epoch,
   *  and the sticky lossGeneration. Keyed by channel (survives sid switch). Reconnect-safe (resume from the
   *  client's last-seen seq). Epoch-aware: a cross-epoch cursor is ignored so a stale high cursor can't suppress
   *  a new low-seq failure. Each failure carries its stable `msgId` (correlate by ID). */
  getDeliveryFailuresSince(
    channel: string,
    sinceSeq: number,
    clientEpoch?: string
  ): { epoch: string; lossGeneration: number; gapThroughSeq: number | null; failures: Array<{ seq: number; msgId: string; text: string; reason: string }> } {
    const epoch = this.deliveryEpoch;
    const lossGeneration = this.lossGeneration;
    const e = this.channelLedger.get(channel);
    const effectiveSince = clientEpoch && clientEpoch !== epoch ? 0 : sinceSeq;
    if (!e) return { epoch, lossGeneration, gapThroughSeq: null, failures: [] };
    const gapThroughSeq = effectiveSince < e.evictedThrough ? e.evictedThrough : null;
    const from = gapThroughSeq != null ? e.evictedThrough : effectiveSince;
    const failures = e.failures.filter((f) => f.seq > from);
    // round-7 (finding #2): record the highest seq actually EMITTED to a consumer — the ACK watermark can never
    // legitimately advance past this. (A gap emit means the client saw everything through evictedThrough.)
    const handedHigh = failures.length ? failures[failures.length - 1].seq : (gapThroughSeq ?? 0);
    if (handedHigh > e.emittedThrough) e.emittedThrough = handedHigh;
    return { epoch, lossGeneration, gapThroughSeq, failures };
  }

  async create(
    agentId: number,
    overrideModelId?: string,
    projectId?: number,
    // CC-CHAT-1 B1: when set, the session spawns cwd'd AT this directory and the Landlock fence
    // (helm-sandbox <projectFenceDir> <cmd>) is scoped to it — exactly like worker/master launches.
    // B-ISO1: strictReadAllow is the OPT-IN strict READ profile (mechanical reuse of the same helper
    // as master/worker/real-transport). Absent (every existing caller) → fencedLaunch byte-identical
    // (default read-all). The harness does not launch chat seats, so this is lower-priority parity.
    opts?: { projectFenceDir?: string; activeCycle?: ActiveCycleContext | null; strictReadAllow?: string[] }
  ): Promise<{ sessionId: string; tmuxSession: string; spawnModel: string }> {
    // 1. Resolve agent → spawn provider/model.
    const agent = this.deps.assignmentService.getAgent(agentId);
    if (!agent) throw new Error(`unknown agent: ${agentId}`);
    const projectAgent = projectId == null ? null : this.deps.assignmentService.resolveProjectAgent(projectId, agentId);
    if (projectId != null && !projectAgent) throw new Error(`project agent not found: project=${projectId} agent=${agentId}`);
    const bootstrapDefinitionMd = projectAgent?.definition_md ?? agent.definition_md;

    let spawnProvider: string = agent.provider;
    let spawnModel: string = agent.model;
    // Prefer the agent's default model override when set — but only if that model is validated.
    if (agent.default_model_id != null) {
      const m = this.deps.modelService.getModel(agent.default_model_id);
      if (m) {
        if (m.validation_status !== 'valid') {
          // R-02G: primary invalid → try backup_model_id before throwing
          const bak = agent.backup_model_id != null
            ? this.deps.modelService.getModel(agent.backup_model_id)
            : null;
          if (bak && bak.validation_status === 'valid') {
            spawnProvider = bak.provider;
            spawnModel = bak.model_id;
          } else {
            throw new Error('agent model is not validated — run validation first (backup model also unavailable)');
          }
        } else {
          spawnProvider = m.provider;
          spawnModel = m.model_id;
        }
      }
    }
    // JROM directive (2026-07-06): the PER-PROJECT model override (project_agents.model_id) OUTRANKS
    // the global agent model. resolveProjectAgent already computed the effective model, but create()
    // previously ignored it — so a project that set projcore→codex55 still spawned the global
    // claude-sonnet-5. Apply it here (validated; falls back to the project backup, else keeps global).
    // Skipped for use_dynamic (model.id null) and for the explicit UI overrideModelId below (wins last).
    if (projectAgent && projectAgent.model && projectAgent.model.id != null
        && projectAgent.model.provider && projectAgent.model.model_id) {
      const pm = this.deps.modelService.getModel(projectAgent.model.id);
      if (pm && pm.validation_status === 'valid') {
        spawnProvider = pm.provider;
        spawnModel = pm.model_id;
      } else {
        const bak = projectAgent.backup_model_id != null
          ? this.deps.modelService.getModel(projectAgent.backup_model_id)
          : null;
        if (bak && bak.validation_status === 'valid') {
          spawnProvider = bak.provider;
          spawnModel = bak.model_id;
        }
      }
    }
    // AGENTROLE T5: optional cheap-model override for PROJECT agent test-chats.
    // If provided and the model is valid, use it; otherwise silently fall back to the configured model.
    if (overrideModelId) {
      const override = (this.deps.modelService as any).findByModelId
        ? (this.deps.modelService as any).findByModelId(overrideModelId)
        : null;
      if (override && override.validation_status === 'valid') {
        spawnProvider = override.provider;
        spawnModel = override.model_id;
      }
    }

    // 2. Resolve the launch command for the (provider, model) pair.
    const spec = this.deps.resolverService.resolveAgentLaunchSpec({
      provider: spawnProvider,
      model: spawnModel,
      mode: 'tui'
    });

    // 3. Create a dedicated tmux session and launch the agent under the sandbox fence.
    //    Test-chat spawns in a dedicated, isolated sandbox dir (NOT the live repo) — and for claude
    //    we pre-accept folder-trust on that dir so the TUI boots past the "trust this folder?" dialog
    //    (the regression that made claude test-chat fail the ready probe). Explicit override still wins.
    const sessionId = randomBytes(8).toString('hex');
    // Readable, attach-able naming convention (JROM 2026-06-22): helm-chat-<agentSlug>-<short>.
    // CC-CHAT-1 B1: project-fenced sessions use helm-chat-p<pid>-<agentSlug>-<nonce> (distinct from
    // run sessions AND from testchat sandbox sessions) and spawn AT the project directory.
    // Surfaced in the API + UI so JROM can `tmux attach -t <name>` directly.
    const projectFenceDir = opts?.projectFenceDir ? path.resolve(opts.projectFenceDir) : null;
    const sessionName = projectFenceDir && projectId != null
      ? `helm-chat-p${projectId}-${agentSessionSlug(agent.name)}-${sessionId.slice(0, 6)}`
      : `helm-chat-${agentSessionSlug(agent.name)}-${sessionId.slice(0, 6)}`;
    let fenceDir: string;
    if (projectFenceDir) {
      fenceDir = projectFenceDir;
      if (spawnProvider === 'claude') await ensureClaudeFolderTrust(fenceDir);
    } else {
      fenceDir = await ensureTestChatSandbox(spawnProvider);
    }
    // B-ISO1: compose (+ fail-closed validate) the OPT-IN strict read env BEFORE createSession, so a
    // bad allowlist refuses the spawn cleanly. Absent → '' (fencedLaunch byte-identical to read-all).
    const strictEnv = opts?.strictReadAllow !== undefined ? makeStrictReadProfileEnv(opts.strictReadAllow) : '';
    // S05 / AC3: discovery/chat is human-owned decision authority (never auto-reap candidate).
    const target = await this.deps.tmux.createSession(sessionName, fenceDir, { owner: 'human' });

    try {
      const sandboxBin = resolveHelmSandboxBin();
      const { envPrefix, launchCmd } = applyEnvelopeIsolation(spawnProvider, spec.launch_cmd);
      const fencedLaunch = `${strictEnv}${envPrefix}${sandboxBin} ${fenceDir} ${launchCmd}`;
      // trusted launch path (skipSafetyCheck) — mirrors RealTransport + WorkerService.
      await this.deps.tmux.sendCommand(target, fencedLaunch, true, true);
      // R7.26/B22b-cont: start the userspace guard as soon as the fenced process exists (not
      // gated on ready-probe success). Project-fenced sessions only — test-chat sandbox dirs
      // have no plan/<cycle> governed docs.
      if (projectFenceDir) {
        this.governedDocGuards.set(sessionName, startGovernedDocGuard(fenceDir));
      }

      // 4. Wait for genuine composer-ready (mirrors RealTransport POCFIX11/18/T2 — flat readyProbe alone
      //    is wrong for claude TUI: '>' matches during boot and never reaches accepting input).
      const ready = await waitForTestChatComposerReady(
        this.deps.tmux,
        spawnProvider,
        spawnModel,
        target
      );
      if (!ready) {
        throw new Error(`test-chat agent ready probe failed for ${spawnProvider}/${spawnModel}`);
      }

      // 5. B5 L3 + B6b R-16 + AGENTROLE T3: inject identity + rules + app memories BEFORE session is exposed.
      const endMarker = bootstrapEndMarker(sessionId);
      const appMemories = this.deps.memoryService?.listMemories({ scope: 'app', status: 'approved' }) ?? [];
      // Authoritative project directory/name/dev-url pulled LIVE from the project row (never a stale
      // caller-passed value), so the agent always anchors on the real Helm-defined working directory.
      const projectContext = projectId != null ? (this.deps.projectService?.getProject(projectId) ?? null) : null;
      // JROM directive: the project outranks the base agent — surface the project's tech-stack + the
      // authoritative doc paths so the agent treats them as governing (best-effort; never blocks spawn).
      const projectDocs = projectContext?.directory ? await gatherProjectDocs(projectContext.directory) : null;
      // SIDECAR: write the full role brief (persona + project authority + rules + memories) to a file
      // the agent reads, and paste only a LEAN prompt into the composer. A single ~8.5KB paste dropped
      // intermittently in the TUI (persona never landed); the lean prompt is small + reliable.
      const sidecarContent = composeAgentSidecar(
        bootstrapDefinitionMd,
        appMemories,
        agent.agent_type,
        projectContext,
        projectDocs,
        opts?.activeCycle ?? null
      );
      const sidecarPath = path.join(os.tmpdir(), 'helm-agent-briefs', `${sessionId}.md`);
      try {
        await fs.mkdir(path.dirname(sidecarPath), { recursive: true });
        await fs.writeFile(sidecarPath, sidecarContent, 'utf8');
      } catch { /* best-effort; lean prompt still establishes identity + reply protocol */ }
      const bootstrapPayload = composeLeanBootstrap(sessionId, {
        agentName: agent.name,
        projectName: projectContext?.name,
        projectDir: projectContext?.directory,
        sidecarPath
      });
      const bootstrapHash = createHash('sha256').update(bootstrapPayload).digest('hex').slice(0, 16);
      // F2: this is an interactive SEAT — gate on the provider's composer ready glyph so a seat that has not
      // yet reached its composer (auth/update/launch frame) is not falsely marked delivered. (Composer-ready
      // was just awaited above, so the glyph is present for a genuinely-ready seat.)
      const bootOk = await this.deps.tmux.sendAndSubmit(target, bootstrapPayload, { readySignal: seatReadySignal(spawnProvider) });
      if (!bootOk) throw new Error('bootstrap sendAndSubmit failed');
      // G1: submit-verify using F3 primitive (composerHoldsText + resubmitIfComposerHeld) for bootstrap.
      // Ensures the HELM_REPLY_PROTOCOL (and memories) actually left the composer even on variable
      // Enter-drop windows. Short loop; marker wait below provides additional confirmation.
      const isFakeBoot = process.env.USE_FAKE_TMUX === '1' && process.env.NODE_ENV !== 'production';
      if (!isFakeBoot) {
        for (let i = 0; i < 3; i++) {
          await new Promise((r) => setTimeout(r, 600));
          const pressed = await this.deps.tmux.resubmitIfComposerHeld(target, bootstrapPayload);
          if (!pressed) break;
        }
      }
      const bootstrapMarkerSeen = await waitForBootstrapMarker(this.deps.tmux, target, endMarker);

      // B5R: Studio/test-chat sessions are short bootstrap probes, so wait for idle before exposing.
      // Project-scoped Command Center sessions may read substantial project/cycle docs on first turn;
      // exposing the session lets the UI stream that work while sendMessage still queues on busy.
      const settled = projectFenceDir ? true : await waitForPostBootstrapSettle(
        this.deps.tmux,
        spawnProvider,
        spawnModel,
        target
      );
      if (!settled) {
        throw new Error(`test-chat post-bootstrap settle failed for ${spawnProvider}/${spawnModel}`);
      }

      this.sessions.set(sessionId, {
        agentId,
        tmuxSession: sessionName,
        paneTarget: target,
        lastSnapshot: '',
        createdAt: (this.deps.nowFn ?? Date.now)(),
        bootstrapSent: true,
        bootstrapEndMarker: endMarker,
        bootstrapHash,
        bootstrapMarkerSeen,
        spawnProvider,
        spawnModel,
        projectId: projectFenceDir ? projectId : undefined,
        fenceDir
      });
    } catch (err) {
      // Boot failed — tear down the half-created pane so we never leak a session.
      try { await this.deps.tmux.terminateSession(sessionName); } catch {}
      try { this.governedDocGuards.get(sessionName)?.stop(); } catch {}
      this.governedDocGuards.delete(sessionName);
      throw err;
    }

    return { sessionId, tmuxSession: sessionName, spawnModel };
  }

  /**
   * Accept a user message and deliver it to the agent, draining any queued messages in order. Kept
   * awaitable for tests (delivery completes before it resolves under fake tmux); in production the
   * HTTP handler fires it in the background and returns immediately, so the wait for a busy agent is
   * NOT bound by the request/tunnel timeout. Overlapping sends append to the queue (never rejected).
   */
  async sendMessage(sessionId: string, text: string, msgId?: string, channel?: string): Promise<void> {
    const sess = this.sessions.get(sessionId);
    if (!sess) throw new Error(`unknown session: ${sessionId}`);
    sess.queue = sess.queue || [];
    // F2: carry the STABLE client message id (correlate a failure to the exact bubble by ID, not text) and the
    // LOGICAL CHANNEL the failure is recorded under (survives sid switch). The UI supplies both; non-UI callers
    // get a generated id and a session-scoped channel fallback.
    sess.queue.push({ text, msgId: msgId || `dm-${++this.msgIdSeq}-${Date.now()}`, channel: channel || `session:${sessionId}` });
    // A drain loop is already running (started by an earlier send) — it will pick this up in order.
    if (sess.sending) return;
    sess.sending = true;
    try {
      while (sess.queue.length) {
        const next = sess.queue.shift()!;
        await this.deliverOne(sessionId, sess, next);
      }
    } finally {
      sess.sending = false;
    }
  }
  private msgIdSeq = 0;

  /**
   * Deliver a single message: wait (progress-based, NO wall-clock cap) until the agent is free, then
   * submit + verify. As long as the agent is actively working (its pane keeps changing), we keep
   * waiting — a codex/grok high-effort reply can run many minutes and the operator watches it in the
   * Raw pane. We only give up if the tmux session dies or the pane is frozen (zero change) for a long
   * stuck-backstop — never on an arbitrary timer.
   */
  private async deliverOne(sessionId: string, sess: ChatSession, item: { text: string; msgId: string; channel: string }): Promise<void> {
    const { text, msgId, channel } = item;
    // B5R2: grok may never echo the HTML marker — once the user sends, bootstrap is done being hidden.
    sess.bootstrapMarkerSeen = true;
    const isFake = process.env.USE_FAKE_TMUX === '1' && process.env.NODE_ENV !== 'production';
    const fastWd = process.env.HELM_TEST_FAST_WD === '1';
    // F2 END-TO-END: the HTTP layer already returned ok:true and the optimistic UI bubble shows delivered.
    // A fresh seat becomes ready in seconds, so we WAIT (bounded) for readiness and retry — the readiness
    // gate then rarely fires. Crucially, EVERY failure path (composer-not-ready, gate says not-ready, a
    // wedged/dead session) must NOT silently drop the message: after bounded retries we record a delivery
    // FAILURE that the SSE stream surfaces so the UI corrects the bubble to delivered=false. We never throw
    // here (a throw is swallowed by the fire-and-forget HTTP handler = the acknowledged-but-lost bug).
    const MAX_ATTEMPTS = 4;
    const RETRY_GAP_MS = fastWd || isFake ? 0 : 2500;
    let lastReason = 'seat never became ready';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        // BUG-1: waitForAgentFree only proves the pane is NOT generating; a BOOTING seat also reads
        // "not generating". It waits (progress-based) while the agent works, and throws only if the
        // session dies or is genuinely wedged — in which case retrying cannot help.
        await this.waitForAgentFree(sess.paneTarget);
      } catch (e: any) {
        this.recordDeliveryFailure(channel, msgId, text, String(e?.message || e));
        return;
      }
      // Genuine per-provider composer-ready (waits up to the provider budget; short-circuits under fake).
      const composerReady = await waitForTestChatComposerReady(
        this.deps.tmux,
        sess.spawnProvider,
        sess.spawnModel,
        sess.paneTarget
      );
      if (composerReady) {
        // F2 SEAT gate: never declare delivery into a seat not presenting its composer glyph (provider-correct).
        const ok = await this.deps.tmux.sendAndSubmit(sess.paneTarget, text, { readySignal: seatReadySignal(sess.spawnProvider) });
        if (ok) return; // SUCCESS: sendAndSubmit observed a positive post-send `submitted` pane state.

        // sendAndSubmit has already pasted exactly once, then bounded its read-back verification and
        // Enter-only retries. Re-entering this outer loop would paste the same user message a second time
        // after an indeterminate boot/capture frame. Fail closed instead; the channel ledger surfaces the
        // exact message as undelivered and the UI can retry explicitly without stacking duplicate pastes.
        lastReason = 'submission not confirmed (message held or pane state indeterminate)';
        break;
      } else {
        lastReason = 'composer not ready (seat still booting)';
      }
      if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, RETRY_GAP_MS));
    }
    // Bounded retries exhausted — surface (never a silent drop).
    this.recordDeliveryFailure(channel, msgId, text, lastReason);
  }

  /**
   * Block until the agent's composer is free (not generating). Progress-based: the wait is unbounded
   * while the agent is doing real work (pane content still changing), and only aborts if the session
   * ends or the pane is completely frozen for STUCK_NO_ACTIVITY_MS (a genuinely wedged CLI).
   */
  private async waitForAgentFree(target: string): Promise<void> {
    let lastPane = '';
    let lastActivity = Date.now();
    while (true) {
      let pane = '';
      try {
        pane = await this.deps.tmux.capturePane(target, 80);
      } catch {
        // capture failed — session likely gone
        if (!(await this.deps.tmux.sessionExists(target))) throw new Error('chat session ended');
      }
      if (!paneIsGenerating(pane)) return; // agent is free — submit now
      if (pane !== lastPane) { lastActivity = Date.now(); lastPane = pane; } // real progress → reset backstop
      if (Date.now() - lastActivity > STUCK_NO_ACTIVITY_MS) {
        if (!(await this.deps.tmux.sessionExists(target))) throw new Error('chat session ended');
        throw new Error('agent appears stuck (no pane activity)');
      }
      await new Promise((r) => setTimeout(r, SEND_QUEUE_POLL_MS));
    }
  }

  // Clean chat capture: bootstrap-hidden + ANSI-stripped → readable bubbles (codex55 cond.4: clean path).
  async capturePane(sessionId: string): Promise<string> {
    const sess = this.sessions.get(sessionId);
    if (!sess) throw new Error(`unknown session: ${sessionId}`);
    // Strip ANSI FIRST so the marker (HTML comment) isn't colour-split, then hide bootstrap.
    const clean = stripAnsi(await this.deps.tmux.capturePane(sess.paneTarget, 200));
    if (sess.bootstrapSent && clean.includes(sess.bootstrapEndMarker)) {
      sess.bootstrapMarkerSeen = true;
    }
    return sanitizePostBootstrap(clean, sess);
  }

  // Raw session logs for the "Session Logs" tab (codex55 cond.4/5): FULL pane, ANSI-stripped for a plain
  // <pre>, NO bootstrap hiding — this is the actual tmux session view (also attach-able via tmux_session).
  async captureRawLogs(sessionId: string): Promise<string> {
    const sess = this.sessions.get(sessionId);
    if (!sess) throw new Error(`unknown session: ${sessionId}`);
    const raw = await this.deps.tmux.capturePane(sess.paneTarget, 400);
    return stripAnsi(raw);
  }

  async terminate(sessionId: string): Promise<void> {
    const sess = this.sessions.get(sessionId);
    if (!sess) return; // no-op if already gone (idempotent for DELETE + shutdown sweep)
    this.sessions.delete(sessionId);
    try { await this.deps.tmux.terminateSession(sess.tmuxSession); } catch {}
    try { this.governedDocGuards.get(sess.tmuxSession)?.stop(); } catch {}
    this.governedDocGuards.delete(sess.tmuxSession);
  }

  getSession(sessionId: string): ChatSession | undefined {
    return this.sessions.get(sessionId);
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  // Live session ids — used by the server shutdown sweep to terminate every open pane.
  sessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  /** Enumerate live sessions for the ACTIVE roster group (AGENTROLE T1).
   *  Prunes map entries whose tmux pane no longer exists and de-dupes by agentId. */
  async listActiveSessions(): Promise<ActiveSessionInfo[]> {
    const out: ActiveSessionInfo[] = [];
    const seenAgents = new Set<number>();
    for (const [sessionId, sess] of this.sessions) {
      const alive = await this.deps.tmux.sessionExists(sess.paneTarget);
      if (!alive) {
        this.sessions.delete(sessionId);
        continue;
      }
      if (seenAgents.has(sess.agentId)) continue;
      seenAgents.add(sess.agentId);
      const agent = this.deps.assignmentService.getAgent(sess.agentId);
      out.push({
        session_id: sessionId,
        agent_id: sess.agentId,
        agent_name: agent?.name ?? `agent-${sess.agentId}`,
        tmux_session: sess.tmuxSession,
      });
    }
    return out;
  }
}

type TmuxReadyPoll = Pick<TmuxService, 'waitForReady' | 'capturePane' | 'sendKeys'>;

const COMPOSER_READY_MS = 60_000;
// codex/grok chat replies (high effort + the project-authority bootstrap) routinely run 1–2 min; the
// send-path readiness must wait that out rather than 500 with "composer not ready". Generous budget —
// the poll returns the instant the agent is genuinely free, so this only bounds the pathological case.
const CLI_COMPOSER_READY_MS = 180_000;
const POST_BOOTSTRAP_SETTLE_MS = 60_000;
export const SEND_QUEUE_WAIT_MS = 120_000;
const SEND_QUEUE_POLL_MS = 500;
// Progress-based backstop: how long the pane may be COMPLETELY frozen (zero change, still flagged
// generating) before we treat the CLI as wedged and abort a queued send. Not a cap on real work —
// any pane change resets it — just a floor against a genuinely hung session hanging the drain forever.
export const STUCK_NO_ACTIVITY_MS = 10 * 60_000;
const QUIESCENCE_POLL_MS = 500;
const QUIESCENCE_STABLE_POLLS = 2;

/** B5R: after bootstrap turn, wait for composer-ready then pane quiescence (provider-agnostic). */
export async function waitForPostBootstrapSettle(
  tmux: TmuxReadyPoll,
  provider: string,
  model: string,
  target: string,
  timeoutMs = POST_BOOTSTRAP_SETTLE_MS
): Promise<boolean> {
  if (process.env.USE_FAKE_TMUX === '1' && process.env.NODE_ENV !== 'production') return true;

  const ready = await waitForTestChatComposerReady(tmux, provider, model, target);
  if (!ready) return false;

  // codex/grok TUIs stream + animate, and an agentic CLI may still be composing its reply to the
  // (now larger) project-authority bootstrap under high effort — so the full 200-line pane rarely
  // byte-stabilizes within the window. Composer-ready is the real gate (waitForTestChatComposerReady
  // above), and sendMessage re-checks readiness + queues-on-busy before every send. So for these
  // providers: attempt a SHORT quiescence, but treat composer-ready as settled if it doesn't converge
  // (never fail the spawn on animation). Claude keeps the strict full-window quiescence it works with.
  const relaxed = provider === 'codex' || provider === 'grok' || /grok/i.test(model || '');
  const effectiveTimeout = relaxed ? Math.min(timeoutMs, 8_000) : timeoutMs;

  const start = Date.now();
  let prev = '';
  let stableCount = 0;
  while (Date.now() - start < effectiveTimeout) {
    try {
      const pane = await capturePlain(tmux, target, 200);
      if (pane === prev) stableCount++;
      else {
        stableCount = 0;
        prev = pane;
      }
      if (stableCount >= QUIESCENCE_STABLE_POLLS) return true;
    } catch { /* poll */ }
    await new Promise((r) => setTimeout(r, QUIESCENCE_POLL_MS));
  }
  // Relaxed providers: composer was ready → settled-enough even without full quiescence.
  return relaxed;
}

/** B1: test-chat composer-ready — aligned with real-transport launch waits. */
export async function waitForTestChatComposerReady(
  tmux: TmuxReadyPoll,
  provider: string,
  model: string,
  target: string
): Promise<boolean> {
  // Claude TUI: flat '>' readyProbe matches during boot — use genuine-ready only (RealTransport POCFIX18).
  if (provider === 'claude') {
    return waitForClaudeComposerReady(tmux, target, COMPOSER_READY_MS);
  }
  // codex/grok high-effort replies can run 1–2 min, during which the composer is absent. Their
  // dedicated ready-polls already wait for the composer to return AND for generation to stop, so skip
  // the redundant fixed waitForReady and give them a generous budget — otherwise a send that lands
  // while the agent is still composing hits the 60s ceiling and 500s with "composer not ready".
  if (provider === 'grok' || /grok/i.test(model || '')) {
    return waitForGrokComposerReady(tmux, target, CLI_COMPOSER_READY_MS);
  }
  if (provider === 'codex') {
    return waitForCodexComposerReady(tmux, target, CLI_COMPOSER_READY_MS);
  }
  const probe = (PROVIDERS as Record<string, any>)[provider]?.readyProbe ?? { signal: '❯', timeoutMs: 30_000 };
  return tmux.waitForReady(target, probe.signal ?? '❯', probe.timeoutMs ?? 30_000);
}

/** Capture + strip ANSI before matching — tmux -e colour-splits footers word-by-word
 *  (e.g. \x1b[91mbypass\x1b[39m permissions), which broke the ready-probe regexes — the
 *  historical ~50% claude boot flakiness. Always match the ready-probes on plain text. */
async function capturePlain(tmux: TmuxReadyPoll, target: string, lines: number): Promise<string> {
  return stripAnsi(await tmux.capturePane(target, lines));
}

async function waitForGrokComposerReady(tmux: TmuxReadyPoll, target: string, timeoutMs: number): Promise<boolean> {
  if (process.env.USE_FAKE_TMUX === '1' && process.env.NODE_ENV !== 'production') return true;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const pane = await capturePlain(tmux, target, 100);
      if ((pane.includes('always-approve') || pane.includes('Grok Build')) && !pane.includes('Starting session')) {
        return true;
      }
    } catch { /* poll */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function waitForClaudeComposerReady(tmux: TmuxReadyPoll, target: string, timeoutMs: number): Promise<boolean> {
  if (process.env.USE_FAKE_TMUX === '1' && process.env.NODE_ENV !== 'production') return true;
  const start = Date.now();
  let lastDismiss = 0;
  while (Date.now() - start < timeoutMs) {
    try {
      const pane = await capturePlain(tmux, target, 120);
      if (/bypass permissions on|shift\+tab to cycle/i.test(pane) && !/Do you trust|trust this folder/i.test(pane)) {
        return true;
      }
      // Claude boot shows one-time onboarding/feature interstitials (e.g. "Try the new fullscreen
      // renderer?", "Enter to confirm · Esc to cancel") that block the composer. Esc dismisses them.
      // Throttle so we don't spam Esc (harmless on the composer, but avoid hammering).
      const interstitial = /Esc to cancel|fullscreen renderer|Yes, try it|Not now|Enter to confirm|Do you trust|trust this folder|❯\s*1\./i.test(pane);
      if (interstitial && Date.now() - lastDismiss > 1500) {
        try { await tmux.sendKeys(target, '\x1b'); } catch { /* best-effort dismiss */ }
        lastDismiss = Date.now();
      }
    } catch { /* poll */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function waitForCodexComposerReady(tmux: TmuxReadyPoll, target: string, timeoutMs: number): Promise<boolean> {
  if (process.env.USE_FAKE_TMUX === '1' && process.env.NODE_ENV !== 'production') return true;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const pane = await capturePlain(tmux, target, 120);
      // Ready ONLY when the codex composer prompt is present AND it is NOT mid-generation. The launch
      // command itself contains "gpt-5.5", so model-string matching here can paste bootstrap text into
      // Codex's startup window before the TUI accepts a real turn.
      const hasComposer = /^\s*›/mu.test(pane);
      const stillBooting = /Starting|loading|spinner/i.test(pane);
      if (hasComposer && !stillBooting && !paneIsGenerating(pane)) return true;
    } catch { /* poll */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
