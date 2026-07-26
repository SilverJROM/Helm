import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { AgentEventsService } from './agent-events-service.js';
import type { AgentEventRow } from './agent-events-service.js';
import { roleMatches } from './role-alias.js';

export type AgentEventType = "message" | "status" | "tool" | "gate";
export type AgentEventSource = "callback" | "git" | "pane" | "post" | "chat";

const ALLOWED_STATES = new Set([
  "DONE", "BLOCKED", "PASS", "FAIL",
  "WORKING", "PROPOSED", "NEEDS-INFO", "REVISE-PLAN",
  "REPRO-CONFIRMED", "REPRO-SATISFIED", "REPRO-FAILED", "REPRO-CLEARED-ON-LOCAL", "REPRO-STILL-PRESENT",
  // B8: projcore brain consult states + handholding selectable action (verifier≠fixer)
  "DECISION-READY", "DECIDING", "IDLE", "PLANNING", "PLAN-READY", "INTERVIEWING", "NORTH-STAR-READY", "HANDOFF", "HANDHOLD-DIRECTIONS",
  // B10: panelist seats + deliberation/red-team aggregate outcomes (verifier≠fixer; Helm routes consensus/verdict)
  "VERDICT-READY", "CONSENSUS", "SETTLED", "CLEAN", "BROKEN", "ROUND-1", "ROUND-2", "ROUND-3",
  // C2/C4: reviewer code-soundness verdicts (verifier ≠ fixer)
  "APPROVE", "REVISE", "REJECT-RESTART"
]);

export interface AgentEventIngestRun {
  runId: string;
  batchId: string;
  runDir: string;
  role: string;
  statusFilePath?: string;
  callbacksPath?: string;
  session?: string;
  expectedBranch?: string;
}

export interface GitHeadSnapshot {
  branch: string | null;
  head: string;
}

export interface AgentEventIngestServiceDeps {
  tmuxService?: { capturePane: (session: string, lines?: number) => Promise<string> };
  gitHeadReader?: (runDir: string) => Promise<GitHeadSnapshot | null>;
  now?: () => number;
}

export class AgentEventIngestService {
  private readonly seenCallbackLines = new Set<string>();
  private readonly gitHeads = new Map<string, string>();
  private readonly paneStates = new Map<string, { hash: string; lastActivityMs: number | null; emittedIdleDone: boolean }>();
  private readonly idleAfterActivityMs = 30_000;

  constructor(
    private readonly events: AgentEventsService,
    private readonly tmuxService: any = { capturePane: async () => "" },
    private readonly gitHeadReader: (runDir: string) => Promise<GitHeadSnapshot | null> = async () => null,
    private readonly now: () => number = Date.now
  ) {
    // M5: bound seen to prevent leak if ever used; explicit P2 scope (no wiring/poll in this batch per decision)
  }

  async runIngest(run: AgentEventIngestRun): Promise<AgentEventRow[]> {
    const results: AgentEventRow[] = [];
    if (this.seenCallbackLines.size > 10000) this.seenCallbackLines.clear();
    // RTF-M11: cap unbounded maps (gitHeads, paneStates) like seen
    if (this.gitHeads.size > 10000) this.gitHeads.clear();
    if (this.paneStates.size > 10000) this.paneStates.clear();
    const cb = await this.ingestCallbacks(run);
    results.push(...cb);
    const grok = await this.ingestGrokStatusFile(run);
    if (grok) results.push(grok);
    const git = await this.ingestGitHead(run);
    if (git) results.push(git);
    const idle = await this.ingestPaneIdle(run);
    if (idle) results.push(idle);
    return results;
  }

  private async ingestCallbacks(run: AgentEventIngestRun): Promise<AgentEventRow[]> {
    const callbacksPath = run.callbacksPath ?? path.join(run.runDir, "callbacks.md");
    let raw = "";
    try {
      raw = await readFile(callbacksPath, "utf8");
    } catch {
      return [];
    }

    const rows: AgentEventRow[] = [];
    const lines = raw.split(/\r?\n/);
    lines.forEach((line, index) => {
      const parsed = parseCallbackLine(line);
      if (!parsed || parsed.batchId !== run.batchId) return;
      // A shared face such as helm_pm is ambiguous without dispatch/run context.
      // Only the expected internal role may claim it, and that canonical role is
      // what is persisted for downstream routing.
      if (!roleMatches(run.role, parsed.role)) return;
      const key = `${callbacksPath}:${index}:${line}`;
      if (this.seenCallbackLines.has(key)) return;
      this.seenCallbackLines.add(key);
      rows.push(this.events.recordEvent({
        run_id: run.runId,
        role: run.role,
        batch_id: parsed.batchId,
        session: run.session ?? null,
        type: "status",
        state: parsed.state,
        source: "callback",
        correlation_id: correlationId(run.runId, parsed.batchId, parsed.state),
        body: {
          line,
          note: parsed.note
        }
      }));
    });
    return rows;
  }

  private async ingestGrokStatusFile(run: AgentEventIngestRun): Promise<AgentEventRow | null> {
    if (!run.statusFilePath) return null;

    const parsed = await parseGrokStatusFile(run.statusFilePath);
    if (!parsed) return null;

    return this.events.recordEvent({
      run_id: run.runId,
      role: run.role,
      batch_id: run.batchId,
      session: run.session ?? null,
      type: "status",
      state: parsed.status,
      source: "callback",
      correlation_id: correlationId(run.runId, run.batchId, parsed.status),
      body: {
        file: run.statusFilePath,
        commit: parsed.commit,
        dev_url: parsed.dev_url,
        notes: parsed.notes
      }
    });
  }

  private async ingestGitHead(run: AgentEventIngestRun): Promise<AgentEventRow | null> {
    const snapshot = await this.gitHeadReader(run.runDir);
    if (!snapshot) return null;
    if (run.expectedBranch && snapshot.branch !== run.expectedBranch) return null;

    const key = `${run.runId}:${run.batchId}`;
    const previousHead = this.gitHeads.get(key);
    this.gitHeads.set(key, snapshot.head);
    if (!previousHead || previousHead === snapshot.head) return null;

    return this.events.recordEvent({
      run_id: run.runId,
      role: run.role,
      batch_id: run.batchId,
      session: run.session ?? null,
      type: "status",
      state: "DONE",
      source: "git",
      correlation_id: correlationId(run.runId, run.batchId, "DONE"),
      body: {
        previous_head: previousHead,
        head: snapshot.head,
        branch: snapshot.branch
      }
    });
  }

  private async ingestPaneIdle(run: AgentEventIngestRun): Promise<AgentEventRow | null> {
    if (!run.session) return null;

    let pane = "";
    try {
      pane = await this.tmuxService.capturePane(run.session, 200);
    } catch {
      return null;
    }
    const nowMs = this.now();
    const currentHash = hashPane(pane);
    const key = `${run.runId}:${run.batchId}:${run.session}`;
    const existing = this.paneStates.get(key);
    if (!existing) {
      this.paneStates.set(key, {
        hash: currentHash,
        lastActivityMs: null,
        emittedIdleDone: false
      });
      return null;
    }

    if (existing.hash !== currentHash) {
      this.paneStates.set(key, {
        hash: currentHash,
        lastActivityMs: nowMs,
        emittedIdleDone: false
      });
      return null;
    }

    if (
      existing.lastActivityMs === null ||
      existing.emittedIdleDone ||
      hasBusySignal(pane) ||
      nowMs - existing.lastActivityMs < this.idleAfterActivityMs
    ) {
      return null;
    }

    existing.emittedIdleDone = true;
    return this.events.recordEvent({
      run_id: run.runId,
      role: run.role,
      batch_id: run.batchId,
      session: run.session,
      type: "status",
      state: "DONE",
      source: "pane",
      correlation_id: correlationId(run.runId, run.batchId, "DONE"),
      body: {
        idle_after_activity_ms: nowMs - existing.lastActivityMs,
        pane_hash: currentHash
      }
    });
  }
}

export function parseCallbackLine(line: string): {
  role: string;
  batchId: string;
  state: string;
  note: string | null;
} | null {
  const match = /^\[helm callback\]\s+(\S+)\s+(\S+)\s+STATUS:\s+([A-Z-]+)(?:\s+[—-]\s+(.+))?\s*$/.exec(line);
  if (!match) return null;
  const state = match[3];
  if (!ALLOWED_STATES.has(state)) {
    return null;
  }
  return {
    // Preserve the emitted role. Shared faces are resolved only by callers that know
    // the expected dispatch/run role; a generic parser must not guess plancore vs ibrain.
    role: match[1],
    batchId: match[2],
    state,
    note: match[4] ?? null
  };
}

export interface GrokStatusFile {
  status: string;
  commit: string | null;
  dev_url: string | null;
  notes: string | null;
}

export async function parseGrokStatusFile(filePath: string): Promise<GrokStatusFile | null> {
  let raw = "";
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.status !== "string") return null;

  const status = record.status.trim().toUpperCase();
  if (!ALLOWED_STATES.has(status)) {
    return null;
  }

  return {
    status,
    commit: optionalString(record.commit),
    dev_url: optionalString(record.dev_url),
    notes: optionalString(record.notes)
  };
}

export function correlationId(runId: string, batchId: string, state: string): string {
  return `terminal:${runId}:${batchId}:${state}`;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export async function readGitHeadBestEffort(runDir: string): Promise<GitHeadSnapshot | null> {
  const gitDir = path.join(runDir, ".git");
  try {
    const gitStat = await (await import('node:fs/promises')).stat(gitDir);
    if (!gitStat.isDirectory()) return null;
  } catch {
    return null;
  }

  try {
    const headRaw = await readFile(path.join(gitDir, "HEAD"), "utf8");
    const refMatch = /^ref:\s*(.+)\s*$/m.exec(headRaw);
    if (!refMatch) {
      return { branch: null, head: headRaw.trim() };
    }

    const ref = refMatch[1];
    const refRaw = await readFile(path.join(gitDir, ref), "utf8");
    return {
      branch: ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref,
      head: refRaw.trim()
    };
  } catch {
    return null;
  }
}

function hashPane(pane: string): string {
  let h = 0;
  for (let i = 0; i < pane.length; i++) {
    h = (h * 31 + pane.charCodeAt(i)) | 0;
  }
  return h.toString(16);
}

function hasBusySignal(pane: string): boolean {
  return /processing|thinking|working|busy/i.test(pane);
}
