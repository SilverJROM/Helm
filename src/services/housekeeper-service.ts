import os from 'node:os';
import path from 'node:path';
import type { DatabaseService } from '../db/database.js';
import type { ITransport } from './fake-transport.js';
import type { HouseSelectResult, HouseUsageSelector } from './house-usage-selector.js';
import {
  DEFAULT_IDLE_THRESHOLD_MS,
  observeSessionIdleness,
  type SessionObservationResult,
} from './session-observation.js';
import type { HelmSessionRow, SessionRegistryService } from './session-registry-service.js';

export const HOUSEKEEPER_PANE_TAIL_MAX_CHARS = 4000;
export const HOUSEKEEPER_ENVELOPE_MAX_CHARS = 8000;
const HOUSEKEEPER_EVIDENCE_STRING_MAX_CHARS = 700;
const HOUSEKEEPER_EVIDENCE_MIN_STRING_CHARS = 120;
const HOUSEKEEPER_PANE_TAIL_MIN_CHARS = 200;
const HOUSEKEEPER_PROVENANCE_MAX_CHARS = 300;

export interface HousekeeperTmuxReads {
  sessionActivity(name: string): Promise<number | null>;
  sessionAttached(name: string): Promise<boolean | null>;
  capturePane(target: string, lines?: number): Promise<string>;
}

export interface HousekeeperDispatchOptions {
  runDir?: string;
  nowMs?: number;
  idleThresholdMs?: number;
  paneTailProvenance?: string;
}

export type HousekeeperDispatchResult =
  | { ok: true; outcome: 'dispatched'; investigationId: number; sessionName: string; handle: string; selected: Extract<HouseSelectResult, { ok: true }> }
  | { ok: true; outcome: 'no_candidate'; reason: string }
  | { ok: true; outcome: 'no_dispatch'; investigationId: number; sessionName: string; usage: Extract<HouseSelectResult, { ok: false }> };

interface InsertInvestigationParams {
  row: HelmSessionRow;
  observation: SessionObservationResult;
  paneTail: string;
  paneTailProvenance: string;
  envelope: HousekeeperEnvelope;
  usage: HouseSelectResult;
}

export interface HousekeeperEnvelope {
  schema_version: 1;
  route: 'housekeeper-investigation';
  guardrails: string[];
  session: {
    id: number;
    name: string;
    kind: string | null;
    owner: 'helm';
    status: 'active';
    project_id: number | null;
    run_id: number | null;
    created_at: string;
    last_used_at: string | null;
  };
  observation: SessionObservationResult;
  pane_tail: string;
  pane_tail_provenance: string;
  callback_facts: unknown[];
  run_facts: unknown[];
  task_facts: unknown[];
  last_dispatch: unknown | null;
}

export class HousekeeperService {
  constructor(
    private readonly db: DatabaseService,
    private readonly sessionRegistry: SessionRegistryService,
    private readonly tmux: HousekeeperTmuxReads,
    private readonly usageSelector: HouseUsageSelector,
    private readonly transport: ITransport,
  ) {}

  async dispatchOnce(opts: HousekeeperDispatchOptions = {}): Promise<HousekeeperDispatchResult> {
    const candidate = await this.findFirstInvestigable(opts);
    if (!candidate) return { ok: true, outcome: 'no_candidate', reason: 'no_active_helm_anomaly' };

    const usage = await this.usageSelector.select();
    const paneTail = boundText(
      await this.tmux.capturePane(candidate.row.name, 200).catch(() => ''),
      HOUSEKEEPER_PANE_TAIL_MAX_CHARS,
    );
    const paneTailProvenance =
      opts.paneTailProvenance ??
      'runtime tmux capturePane tail; tests use src/test-fixtures/panes/discovery-finished-turn-20260727.txt captured from a real agent turn';
    const evidence = this.loadDurableEvidence(candidate.row.run_id);

    const envelope = buildHousekeeperEnvelope({
      row: candidate.row,
      observation: candidate.observation,
      paneTail,
      paneTailProvenance,
      callbackFacts: evidence.callbackFacts,
      runFacts: evidence.runFacts,
      taskFacts: evidence.taskFacts,
      lastDispatch: evidence.lastDispatch,
    });
    const boundedEnvelope = boundEnvelope(envelope);
    assertBoundedEnvelope(boundedEnvelope);
    const investigationId = this.insertInvestigation({
      row: candidate.row,
      observation: candidate.observation,
      paneTail,
      paneTailProvenance,
      envelope: boundedEnvelope,
      usage,
    });

    if (!usage.ok) {
      this.db
        .prepare(`UPDATE housekeeper_investigations SET status = 'no_dispatch' WHERE id = ?`)
        .run(investigationId);
      return {
        ok: true,
        outcome: 'no_dispatch',
        investigationId,
        sessionName: candidate.row.name,
        usage,
      };
    }

    const brief = renderHousekeeperBrief(boundedEnvelope, usage, investigationId);
    assertBoundedEnvelope(boundedEnvelope);
    const spawned = await this.transport.spawn({
      role: 'housekeeper',
      brief,
      runDir: opts.runDir ?? path.join(os.tmpdir(), 'helm-housekeeper-dispatch'),
      batchId: 'housekeeper',
      rung: usage.rungIndex,
      model: usage.model,
      provider: usage.provider,
      sessionName: `helm-housekeeper-${investigationId}`,
    });

    this.db
      .prepare(
        `UPDATE housekeeper_investigations
         SET status = 'dispatched', dispatch_handle = ?, dispatched_at = datetime('now')
         WHERE id = ?`
      )
      .run(spawned.handle, investigationId);

    return {
      ok: true,
      outcome: 'dispatched',
      investigationId,
      sessionName: candidate.row.name,
      handle: spawned.handle,
      selected: usage,
    };
  }

  getInvestigation(id: number): any {
    return this.db.prepare(`SELECT * FROM housekeeper_investigations WHERE id = ?`).get(id);
  }

  listInvestigations(): any[] {
    return this.db
      .prepare(`SELECT * FROM housekeeper_investigations ORDER BY id ASC`)
      .all() as any[];
  }

  private async findFirstInvestigable(opts: HousekeeperDispatchOptions): Promise<{
    row: HelmSessionRow;
    observation: SessionObservationResult;
  } | null> {
    const rows = this.sessionRegistry.listHelmOwnedActiveCandidates();
    for (const row of rows) {
      const [sessionActivity, sessionAttached] = await Promise.all([
        this.tmux.sessionActivity(row.name).catch(() => null),
        this.tmux.sessionAttached(row.name).catch(() => null),
      ]);
      const observation = observeSessionIdleness({
        lastUsedAt: row.last_used_at,
        createdAt: row.created_at,
        sessionActivity,
        sessionAttached,
        runId: row.run_id,
        nowMs: opts.nowMs,
        idleThresholdMs: opts.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS,
      });
      if (observation.action === 'INVESTIGATE') {
        return { row, observation };
      }
    }
    return null;
  }

  private insertInvestigation(params: InsertInvestigationParams): number {
    const selected = params.usage.ok ? params.usage : null;
    const info = this.db
      .prepare(
        `INSERT INTO housekeeper_investigations (
          helm_session_id, session_name, owner, status, trigger_reason, observation_json,
          pane_tail, pane_tail_provenance, envelope_json, usage_json,
          selected_provider, selected_model, selected_slug, selected_rung_index, selected_reason
        ) VALUES (?, ?, 'helm', 'dispatching', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        params.row.id,
        params.row.name,
        params.observation.reason,
        JSON.stringify(params.observation),
        params.paneTail,
        params.paneTailProvenance,
        JSON.stringify(params.envelope),
        JSON.stringify(params.usage),
        selected?.provider ?? null,
        selected?.model ?? null,
        selected?.slug ?? null,
        selected?.rungIndex ?? null,
        selected?.reason ?? params.usage.reason,
      );
    return Number(info.lastInsertRowid);
  }

  private loadDurableEvidence(runId: number | null): {
    callbackFacts: unknown[];
    runFacts: unknown[];
    taskFacts: unknown[];
    lastDispatch: unknown | null;
  } {
    if (runId == null) {
      return { callbackFacts: [], runFacts: [], taskFacts: [], lastDispatch: null };
    }
    const runFacts = this.db
      .prepare(`SELECT id, status, phase, started_at, ended_at FROM runs WHERE id = ?`)
      .all(runId) as any[];
    const taskFacts = this.db
      .prepare(`SELECT id, task_key, label, batch, status, attempts_count FROM run_tasks WHERE run_id = ? ORDER BY id DESC LIMIT 5`)
      .all(runId) as any[];
    const callbackFacts = this.db
      .prepare(
        `SELECT c.id, c.role, c.state, c.raw_line, c.received_at, d.role AS dispatch_role
         FROM callbacks c
         JOIN dispatches d ON d.id = c.dispatch_id
         JOIN task_attempts ta ON ta.id = d.attempt_id
         JOIN run_tasks rt ON rt.id = ta.task_id
         WHERE rt.run_id = ?
         ORDER BY c.id DESC LIMIT 5`
      )
      .all(runId) as any[];
    const lastDispatch = this.db
      .prepare(
        `SELECT d.id, d.role, d.brief_path, d.transport_handle, d.spawned_at, d.reaped_at
         FROM dispatches d
         JOIN task_attempts ta ON ta.id = d.attempt_id
         JOIN run_tasks rt ON rt.id = ta.task_id
         WHERE rt.run_id = ?
         ORDER BY d.id DESC LIMIT 1`
      )
      .get(runId) ?? null;
    return { callbackFacts, runFacts, taskFacts, lastDispatch };
  }
}

function buildHousekeeperEnvelope(params: {
  row: HelmSessionRow;
  observation: SessionObservationResult;
  paneTail: string;
  paneTailProvenance: string;
  callbackFacts: unknown[];
  runFacts: unknown[];
  taskFacts: unknown[];
  lastDispatch: unknown | null;
}): HousekeeperEnvelope {
  const { row } = params;
  return {
    schema_version: 1,
    route: 'housekeeper-investigation',
    guardrails: [
      'owner=helm active rows only',
      'investigation only; never reap',
      'do not repair status in S18a',
      'uncertainty must become needs-human in S18b',
    ],
    session: {
      id: row.id,
      name: row.name,
      kind: row.kind,
      owner: 'helm',
      status: 'active',
      project_id: row.project_id,
      run_id: row.run_id,
      created_at: row.created_at,
      last_used_at: row.last_used_at,
    },
    observation: params.observation,
    pane_tail: params.paneTail,
    pane_tail_provenance: params.paneTailProvenance,
    callback_facts: params.callbackFacts,
    run_facts: params.runFacts,
    task_facts: params.taskFacts,
    last_dispatch: params.lastDispatch,
  };
}

function boundEnvelope(envelope: HousekeeperEnvelope): HousekeeperEnvelope {
  const stages = [
    { paneTailMax: HOUSEKEEPER_PANE_TAIL_MAX_CHARS, evidenceStringMax: HOUSEKEEPER_EVIDENCE_STRING_MAX_CHARS, evidenceRows: 5, keepLastDispatch: true },
    { paneTailMax: 3000, evidenceStringMax: 500, evidenceRows: 5, keepLastDispatch: true },
    { paneTailMax: 2000, evidenceStringMax: 350, evidenceRows: 3, keepLastDispatch: true },
    { paneTailMax: 1000, evidenceStringMax: 220, evidenceRows: 2, keepLastDispatch: true },
    { paneTailMax: HOUSEKEEPER_PANE_TAIL_MIN_CHARS, evidenceStringMax: HOUSEKEEPER_EVIDENCE_MIN_STRING_CHARS, evidenceRows: 1, keepLastDispatch: true },
    { paneTailMax: HOUSEKEEPER_PANE_TAIL_MIN_CHARS, evidenceStringMax: HOUSEKEEPER_EVIDENCE_MIN_STRING_CHARS, evidenceRows: 0, keepLastDispatch: false },
  ];

  for (const stage of stages) {
    const next = buildBoundEnvelopeStage(envelope, stage);
    if (serializedEnvelopeLength(next) <= HOUSEKEEPER_ENVELOPE_MAX_CHARS) {
      return next;
    }
  }

  throw new Error(`housekeeper envelope exceeds ${HOUSEKEEPER_ENVELOPE_MAX_CHARS} chars after deterministic bounding`);
}

function boundText(raw: string, maxChars: number): string {
  const text = String(raw ?? '');
  if (text.length <= maxChars) return text;
  return text.slice(text.length - maxChars);
}

function serializedEnvelopeLength(envelope: HousekeeperEnvelope): number {
  return JSON.stringify(envelope).length;
}

function assertBoundedEnvelope(envelope: HousekeeperEnvelope): void {
  const actual = serializedEnvelopeLength(envelope);
  if (actual > HOUSEKEEPER_ENVELOPE_MAX_CHARS) {
    throw new Error(`housekeeper envelope exceeds ${HOUSEKEEPER_ENVELOPE_MAX_CHARS} chars before persist/spawn (${actual})`);
  }
}

function buildBoundEnvelopeStage(
  envelope: HousekeeperEnvelope,
  stage: { paneTailMax: number; evidenceStringMax: number; evidenceRows: number; keepLastDispatch: boolean },
): HousekeeperEnvelope {
  return {
    ...envelope,
    pane_tail: boundText(envelope.pane_tail, stage.paneTailMax),
    pane_tail_provenance: boundText(envelope.pane_tail_provenance, HOUSEKEEPER_PROVENANCE_MAX_CHARS),
    callback_facts: boundEvidenceRows(envelope.callback_facts, stage.evidenceRows, stage.evidenceStringMax),
    run_facts: boundEvidenceRows(envelope.run_facts, stage.evidenceRows, stage.evidenceStringMax),
    task_facts: boundEvidenceRows(envelope.task_facts, stage.evidenceRows, stage.evidenceStringMax),
    last_dispatch: stage.keepLastDispatch ? boundEvidenceValue(envelope.last_dispatch, stage.evidenceStringMax) : null,
  };
}

function boundEvidenceRows(rows: unknown[], maxRows: number, maxStringChars: number): unknown[] {
  return rows.slice(0, maxRows).map((row) => boundEvidenceValue(row, maxStringChars));
}

function boundEvidenceValue(value: unknown, maxStringChars: number): unknown {
  if (typeof value === 'string') return boundText(value, maxStringChars);
  if (Array.isArray(value)) return value.map((entry) => boundEvidenceValue(entry, maxStringChars));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, boundEvidenceValue(entry, maxStringChars)])
    );
  }
  return value;
}

function renderHousekeeperBrief(
  envelope: HousekeeperEnvelope,
  selected: Extract<HouseSelectResult, { ok: true }>,
  investigationId: number,
): string {
  return [
    `Housekeeper investigation ${investigationId}`,
    `Selected rung: ${selected.slug} (${selected.provider}/${selected.model}) reason=${selected.reason}`,
    'Return only a future S18b-compatible callback verdict. Do not kill, reap, or repair status.',
    '',
    JSON.stringify(envelope, null, 2),
  ].join('\n');
}
