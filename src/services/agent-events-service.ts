import { DatabaseService } from "../db/database.js";

export type AgentEventType = "message" | "status" | "tool" | "gate";
export type AgentEventSource = "callback" | "git" | "pane" | "post" | "chat";

export interface AgentEventInput {
  run_id: string;
  role: string;
  batch_id: string;
  session?: string | null;
  type: AgentEventType;
  state?: string | null;
  source: AgentEventSource;
  correlation_id: string;
  body?: Record<string, unknown>;
  ts?: string;
  seq?: number;
}

export interface AgentEventRow {
  id: number;
  run_id: string;
  role: string;
  batch_id: string;
  session: string | null;
  type: AgentEventType;
  state: string | null;
  source: AgentEventSource;
  correlation_id: string;
  body: Record<string, unknown>;
  seq: number;
  ts: string;
}

export type AgentEventListener = (event: AgentEventRow) => void;

interface RawAgentEventRow extends Omit<AgentEventRow, "body"> {
  body: string;
}

export class AgentEventsService {
  private readonly listeners = new Set<AgentEventListener>();

  constructor(private readonly db: DatabaseService) {}

  onEvent(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private nextSeqForRun(runId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM agent_events WHERE run_id = ?")
      .get(runId) as { maxSeq: number } | undefined;
    return (row?.maxSeq ?? 0) + 1;
  }

  recordEvent(input: AgentEventInput): AgentEventRow {
    if (input.type === "status" && (input.state === "DONE" || input.state === "BLOCKED")) {
      return this.recordTerminalStatus(input);
    }

    const body = normalizeBody(input.body, input.source);
    const seq = input.seq ?? this.nextSeqForRun(input.run_id);
    const result = this.db
      .prepare(
        `INSERT INTO agent_events (
          run_id, role, batch_id, session, type, state, source, correlation_id, body, seq, ts
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.run_id,
        input.role,
        input.batch_id,
        input.session ?? null,
        input.type,
        input.state ?? null,
        input.source,
        input.correlation_id,
        JSON.stringify(body),
        seq,
        input.ts ?? new Date().toISOString()
      );

    return this.emitEvent(this.getEventById(Number(result.lastInsertRowid)));
  }

  listEvents(runId: string): AgentEventRow[] {
    const rows = this.db
      .prepare("SELECT * FROM agent_events WHERE run_id = ? ORDER BY id ASC")
      .all(runId) as RawAgentEventRow[];
    return rows.map(parseRow);
  }

  // Project-scoped chat transcript: batch-keyed so it survives master run_id changes (hot-swap),
  // and renders owner messages immediately without depending on a live master run.
  listByBatch(batchId: string): AgentEventRow[] {
    const rows = this.db
      .prepare("SELECT * FROM agent_events WHERE batch_id = ? ORDER BY id ASC")
      .all(batchId) as RawAgentEventRow[];
    return rows.map(parseRow);
  }

  // CC-CHAT-2 R7: patch delivery outcome onto an already-recorded event (delivered:true/false +
  // session) AFTER the background tmux attempt resolves. Deliberately does NOT emit to SSE
  // listeners — the CC chat poll picks the patched body up (avoids duplicate bubbles).
  updateBody(id: number, patch: Record<string, unknown>, session?: string | null): void {
    const existing = this.db
      .prepare("SELECT * FROM agent_events WHERE id = ?")
      .get(id) as RawAgentEventRow | undefined;
    if (!existing) return;
    const body = { ...parseBody(existing.body), ...patch };
    this.db
      .prepare("UPDATE agent_events SET body = ?, session = ? WHERE id = ?")
      .run(JSON.stringify(body), session !== undefined ? session : existing.session, id);
  }

  findTerminal(runId: string, batchId: string, state: string, correlationId: string): AgentEventRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM agent_events
         WHERE run_id = ? AND batch_id = ? AND state = ? AND correlation_id = ?
           AND type = 'status'
         LIMIT 1`
      )
      .get(runId, batchId, state, correlationId) as RawAgentEventRow | undefined;
    return row ? parseRow(row) : null;
  }

  private recordTerminalStatus(input: AgentEventInput): AgentEventRow {
    const existing = this.findTerminal(
      input.run_id,
      input.batch_id,
      input.state ?? "",
      input.correlation_id
    );
    if (!existing) {
      const body = normalizeBody(input.body, input.source);
      const seq = input.seq ?? this.nextSeqForRun(input.run_id);
      const result = this.db
        .prepare(
          `INSERT INTO agent_events (
            run_id, role, batch_id, session, type, state, source, correlation_id, body, seq, ts
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.run_id,
          input.role,
          input.batch_id,
          input.session ?? null,
          input.type,
          input.state ?? null,
          input.source,
          input.correlation_id,
          JSON.stringify(body),
          seq,
          input.ts ?? new Date().toISOString()
        );
      return this.emitEvent(this.getEventById(Number(result.lastInsertRowid)));
    }

    const mergedBody = mergeProvenance(existing.body, input.body, input.source);
    const mergedSession = existing.session ?? input.session ?? null;
    this.db
      .prepare("UPDATE agent_events SET body = ?, session = ? WHERE id = ?")
      .run(JSON.stringify(mergedBody), mergedSession, existing.id);
    return this.emitEvent(this.getEventById(existing.id));
  }

  private getEventById(id: number): AgentEventRow {
    const row = this.db
      .prepare("SELECT * FROM agent_events WHERE id = ?")
      .get(id) as RawAgentEventRow | undefined;
    if (!row) throw new Error(`agent_events row ${id} not found after insert`);
    return parseRow(row);
  }

  private emitEvent(event: AgentEventRow): AgentEventRow {
    for (const listener of this.listeners) {
      listener(event);
    }
    return event;
  }
}

function normalizeBody(body: Record<string, unknown> | undefined, source: AgentEventSource): Record<string, unknown> {
  return mergeProvenance({}, body, source);
}

function mergeProvenance(
  base: Record<string, unknown>,
  incoming: Record<string, unknown> | undefined,
  source: AgentEventSource
): Record<string, unknown> {
  const next = { ...base, ...(incoming ?? {}) };
  const sources = new Set<AgentEventSource>();
  for (const value of Array.isArray(base.sources) ? base.sources : []) {
    if (isAgentEventSource(value)) sources.add(value);
  }
  for (const value of Array.isArray(incoming?.sources) ? incoming.sources : []) {
    if (isAgentEventSource(value)) sources.add(value);
  }
  sources.add(source);
  next.sources = Array.from(sources).sort();
  return next;
}

function isAgentEventSource(value: unknown): value is AgentEventSource {
  return value === "callback" || value === "git" || value === "pane" || value === "post" || value === "chat";
}

function parseRow(row: RawAgentEventRow): AgentEventRow {
  return {
    ...row,
    body: parseBody(row.body)
  };
}

function parseBody(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
