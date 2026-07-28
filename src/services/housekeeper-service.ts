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
import {
  sessionStatusTokenFromRow,
  type HelmSessionRow,
  type SessionRegistryService,
} from './session-registry-service.js';

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
  investigationCooldownMs?: number;
  paneTailProvenance?: string;
}

export type HousekeeperDispatchResult =
  | { ok: true; outcome: 'dispatched'; investigationId: number; sessionName: string; handle: string; selected: Extract<HouseSelectResult, { ok: true }> }
  | { ok: true; outcome: 'no_candidate'; reason: string }
  | { ok: true; outcome: 'no_dispatch'; investigationId: number; sessionName: string; usage: Extract<HouseSelectResult, { ok: false }> };

interface InsertInvestigationParams {
  row: HelmSessionRow;
  observation: SessionObservationResult;
  stateSignature: string;
  paneTail: string;
  paneTailProvenance: string;
  envelope: HousekeeperEnvelope;
  usage: HouseSelectResult;
}

export interface HousekeeperApplyInput {
  verdict: string;
  evidence: string;
  rationale: string;
}

/** Typed apply_error when done evidence cites nothing checkable in the stored envelope (B10b / AC14). */
export const HOUSEKEEPER_APPLY_ERROR_EVIDENCE_NOT_IN_ENVELOPE = 'evidence_not_in_envelope';

export type HousekeeperApplyResult =
  | { ok: true; outcome: 'applied_done'; investigationId: number; sessionName: string }
  | { ok: true; outcome: 'needs_human'; investigationId: number; sessionName: string }
  | { ok: false; outcome: 'invalid_verdict'; error: string }
  | { ok: false; outcome: 'invalid_callback_proof'; investigationId: number; sessionName: string; error: string }
  | { ok: false; outcome: 'not_found'; error: string }
  | { ok: false; outcome: 'owner_recheck_failed'; investigationId: number; sessionName: string; owner: string | null; error: string }
  | { ok: false; outcome: 'terminal_conflict'; investigationId: number; sessionName: string; existingVerdict: string | null; error: string };

/** Explicit bounded-probe outcomes persisted on the investigation envelope (B10 / AC13). */
export type HousekeeperPaneCaptureOutcome = 'ok' | 'empty' | 'failed';

export interface HousekeeperProbeOutcomes {
  /** throw → failed; whitespace-only capture → empty; non-empty → ok */
  pane_capture: HousekeeperPaneCaptureOutcome;
  /** short error text when pane_capture === 'failed'; else null */
  pane_capture_error: string | null;
  /** false iff session.run_id is null (facts load skipped / unobtainable) */
  facts_obtainable: boolean;
  /** true if any run/task/callback row or last_dispatch was loaded */
  facts_present: boolean;
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
  /** Mechanical probe sufficiency — apply derives done eligibility from this only (AC13/AC15). */
  probe: HousekeeperProbeOutcomes;
  callback_facts: unknown[];
  run_facts: unknown[];
  task_facts: unknown[];
  last_dispatch: unknown | null;
}

export class HousekeeperService {
  private scheduler: NodeJS.Timeout | null = null;
  private schedulerInFlight = false;

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
    const paneProbe = await this.capturePaneProbe(candidate.row.name);
    const paneTail = boundText(paneProbe.paneTail, HOUSEKEEPER_PANE_TAIL_MAX_CHARS);
    const paneTailProvenance =
      opts.paneTailProvenance ??
      'runtime tmux capturePane tail; tests use src/test-fixtures/panes/discovery-finished-turn-20260727.txt captured from a real agent turn';
    const evidence = this.loadDurableEvidence(candidate.row.run_id);
    const stateSignature = buildStateSignature(candidate.row, candidate.observation);
    const probe = buildProbeOutcomes({
      paneCapture: paneProbe.outcome,
      paneCaptureError: paneProbe.error,
      runId: candidate.row.run_id,
      callbackFacts: evidence.callbackFacts,
      runFacts: evidence.runFacts,
      taskFacts: evidence.taskFacts,
      lastDispatch: evidence.lastDispatch,
    });

    const envelope = buildHousekeeperEnvelope({
      row: candidate.row,
      observation: candidate.observation,
      paneTail,
      paneTailProvenance,
      probe,
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
      stateSignature,
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

  applyCallback(id: number, input: HousekeeperApplyInput): HousekeeperApplyResult {
    const verdict = normalizeHousekeeperVerdict(input.verdict);
    if (!verdict) {
      return { ok: false, outcome: 'invalid_verdict', error: 'housekeeper verdict must be done or needs-human' };
    }

    const row = this.getInvestigation(id);
    if (!row) return { ok: false, outcome: 'not_found', error: 'housekeeper investigation not found' };

    const evidence = boundText(input.evidence, 4000);
    const rationale = boundText(input.rationale, 4000);
    const terminal = normalizeTerminalInvestigationStatus(row.status);
    if (terminal) {
      if (terminal.verdict === verdict) {
        return { ok: true, outcome: terminal.outcome, investigationId: id, sessionName: row.session_name };
      }
      return {
        ok: false,
        outcome: 'terminal_conflict',
        investigationId: id,
        sessionName: row.session_name,
        existingVerdict: row.callback_verdict ?? terminal.verdict,
        error: 'housekeeper investigation is already terminal',
      };
    }

    if (verdict === 'done' && (!isCallbackProofText(evidence) || !isCallbackProofText(rationale))) {
      return {
        ok: false,
        outcome: 'invalid_callback_proof',
        investigationId: id,
        sessionName: row.session_name,
        error: 'done callback requires non-empty evidence and rationale',
      };
    }

    // B10 / AC13+AC15: keep-bias in apply — done only when stored envelope probe is sufficient.
    // needs-human is never gated by probe sufficiency.
    if (verdict === 'done' && !isDoneEligibleFromStoredEnvelope(row.envelope_json)) {
      return {
        ok: false,
        outcome: 'invalid_callback_proof',
        investigationId: id,
        sessionName: row.session_name,
        error: 'done ineligible: bounded probe insufficient (failed/empty capture, null run_id, or absent facts)',
      };
    }

    // B10b / AC14: claimed evidence must cite checkable material from the persisted envelope.
    // Non-empty prose is not evidence. needs-human is never gated by citation.
    if (verdict === 'done' && !evidenceCitesStoredEnvelope(evidence, row.envelope_json)) {
      this.db
        .prepare(
          `UPDATE housekeeper_investigations
           SET callback_verdict = ?, callback_evidence = ?, callback_rationale = ?,
               status = 'apply_rejected', apply_error = ?, applied_at = datetime('now')
           WHERE id = ?`
        )
        .run(verdict, evidence, rationale, HOUSEKEEPER_APPLY_ERROR_EVIDENCE_NOT_IN_ENVELOPE, id);
      return {
        ok: false,
        outcome: 'invalid_callback_proof',
        investigationId: id,
        sessionName: row.session_name,
        error: `${HOUSEKEEPER_APPLY_ERROR_EVIDENCE_NOT_IN_ENVELOPE}: claimed evidence cites nothing checkable in stored envelope`,
      };
    }

    const session = this.sessionRegistry.get(row.session_name);

    if (!session || session.owner !== 'helm') {
      this.db
        .prepare(
          `UPDATE housekeeper_investigations
           SET callback_verdict = ?, callback_evidence = ?, callback_rationale = ?,
               status = 'apply_rejected', apply_error = ?, applied_at = datetime('now')
           WHERE id = ?`
        )
        .run(verdict, evidence, rationale, 'owner_recheck_failed', id);
      return {
        ok: false,
        outcome: 'owner_recheck_failed',
        investigationId: id,
        sessionName: row.session_name,
        owner: session?.owner ?? null,
        error: 'session owner is no longer helm',
      };
    }

    if (verdict === 'needs-human') {
      this.db
        .prepare(
          `UPDATE housekeeper_investigations
           SET callback_verdict = ?, callback_evidence = ?, callback_rationale = ?,
               status = 'needs_human', apply_error = NULL, applied_at = datetime('now')
           WHERE id = ?`
        )
        .run(verdict, evidence, rationale, id);
      return { ok: true, outcome: 'needs_human', investigationId: id, sessionName: row.session_name };
    }

    this.db.raw.transaction(() => {
      this.db
        .prepare(
          `UPDATE housekeeper_investigations
           SET callback_verdict = ?, callback_evidence = ?, callback_rationale = ?,
               status = 'applied_done', apply_error = NULL, applied_at = datetime('now')
           WHERE id = ? AND status NOT IN ('applied_done', 'needs_human')`
        )
        .run(verdict, evidence, rationale, id);
      // B02 AC6: CAS markIdle with the session row captured at owner recheck (one-shot token).
      // Full investigation-token persistence is B11 — here we only make the status write CAS-only.
      this.sessionRegistry.markIdle(sessionStatusTokenFromRow(session), 'housekeeper-done');
    })();
    return { ok: true, outcome: 'applied_done', investigationId: id, sessionName: row.session_name };
  }

  startScheduler(intervalMs: number, opts: HousekeeperDispatchOptions = {}): boolean {
    if (this.scheduler || !Number.isFinite(intervalMs) || intervalMs <= 0) return false;
    this.scheduler = setInterval(() => {
      void this.schedulerTick(opts);
    }, intervalMs);
    this.scheduler.unref?.();
    return true;
  }

  stopScheduler(): void {
    if (this.scheduler) clearInterval(this.scheduler);
    this.scheduler = null;
  }

  async schedulerTick(opts: HousekeeperDispatchOptions = {}): Promise<void> {
    if (this.schedulerInFlight) return;
    this.schedulerInFlight = true;
    try {
      await this.dispatchOnce(opts);
    } catch (e) {
      console.warn('[housekeeper] scheduler dispatch failed', { err: String(e) });
    } finally {
      this.schedulerInFlight = false;
    }
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
        const stateSignature = buildStateSignature(row, observation);
        if (this.hasRecentInvestigationForUnchangedState(row.name, stateSignature, opts.investigationCooldownMs ?? 6 * 60 * 60 * 1000)) {
          continue;
        }
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
          helm_session_id, session_name, owner, status, trigger_reason, state_signature, observation_json,
          pane_tail, pane_tail_provenance, envelope_json, usage_json,
          selected_provider, selected_model, selected_slug, selected_rung_index, selected_reason
        ) VALUES (?, ?, 'helm', 'dispatching', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        params.row.id,
        params.row.name,
        params.observation.reason,
        params.stateSignature,
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

  private hasRecentInvestigationForUnchangedState(sessionName: string, stateSignature: string, cooldownMs: number): boolean {
    if (!Number.isFinite(cooldownMs) || cooldownMs <= 0) return false;
    const cutoffMs = Date.now() - cooldownMs;
    const row = this.db
      .prepare(
        `SELECT created_at FROM housekeeper_investigations
         WHERE session_name = ? AND state_signature = ?
         ORDER BY id DESC LIMIT 1`
      )
      .get(sessionName, stateSignature) as { created_at: string } | undefined;
    if (!row?.created_at) return false;
    const createdMs = Date.parse(row.created_at.endsWith('Z') ? row.created_at : `${row.created_at}Z`);
    return Number.isFinite(createdMs) && createdMs >= cutoffMs;
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

  /**
   * Bounded pane probe: never collapses throw → empty without recording outcome.
   * Failed/empty still allow dispatch; only apply of `done` is gated (B10).
   */
  private async capturePaneProbe(sessionName: string): Promise<{
    paneTail: string;
    outcome: HousekeeperPaneCaptureOutcome;
    error: string | null;
  }> {
    try {
      const raw = await this.tmux.capturePane(sessionName, 200);
      const paneTail = String(raw ?? '');
      if (paneTail.trim().length === 0) {
        return { paneTail: '', outcome: 'empty', error: null };
      }
      return { paneTail, outcome: 'ok', error: null };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        paneTail: '',
        outcome: 'failed',
        error: boundText(msg || 'capturePane threw', 200),
      };
    }
  }
}

function buildProbeOutcomes(params: {
  paneCapture: HousekeeperPaneCaptureOutcome;
  paneCaptureError: string | null;
  runId: number | null;
  callbackFacts: unknown[];
  runFacts: unknown[];
  taskFacts: unknown[];
  lastDispatch: unknown | null;
}): HousekeeperProbeOutcomes {
  const factsObtainable = params.runId != null;
  const factsPresent =
    params.runFacts.length > 0 ||
    params.taskFacts.length > 0 ||
    params.callbackFacts.length > 0 ||
    params.lastDispatch != null;
  return {
    pane_capture: params.paneCapture,
    pane_capture_error: params.paneCapture === 'failed' ? params.paneCaptureError : null,
    facts_obtainable: factsObtainable,
    facts_present: factsPresent,
  };
}

/** AC13: done only when pane ok AND facts obtainable AND facts present. */
export function isDoneEligibleFromEnvelope(envelope: HousekeeperEnvelope): boolean {
  const probe = envelope?.probe;
  if (!probe) return false;
  return (
    probe.pane_capture === 'ok' &&
    probe.facts_obtainable === true &&
    probe.facts_present === true
  );
}

function isDoneEligibleFromStoredEnvelope(envelopeJson: unknown): boolean {
  try {
    const parsed =
      typeof envelopeJson === 'string'
        ? (JSON.parse(envelopeJson) as HousekeeperEnvelope)
        : (envelopeJson as HousekeeperEnvelope);
    if (!parsed || typeof parsed !== 'object') return false;
    return isDoneEligibleFromEnvelope(parsed);
  } catch {
    return false;
  }
}

const EVIDENCE_CITE_PANE_TOKEN_MIN = 8;
const EVIDENCE_CITE_PANE_WINDOW = 24;
const EVIDENCE_CITE_FACT_MIN = 4;

/** Lifecycle/boolean tokens present in nearly every envelope — not sufficient as sole citation. */
const LOW_SIGNAL_CITE_ATOMS = new Set([
  'active',
  'idle',
  'working',
  'executing',
  'true',
  'false',
  'null',
  'file',
  'ok',
  'empty',
  'failed',
  'worker',
]);

function normalizeCiteText(value: string): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Collect checkable atoms from the investigation envelope (pane-tail + durable facts). */
export function collectEnvelopeCiteAtoms(envelope: HousekeeperEnvelope): string[] {
  const atoms = new Set<string>();
  const add = (raw: string, minLen: number) => {
    const n = normalizeCiteText(raw);
    if (n.length >= minLen && !LOW_SIGNAL_CITE_ATOMS.has(n)) atoms.add(n);
  };

  const pane = String(envelope?.pane_tail ?? '');
  for (const tok of pane.toLowerCase().split(/[^a-z0-9_./:@-]+/)) {
    if (tok.length >= EVIDENCE_CITE_PANE_TOKEN_MIN && !LOW_SIGNAL_CITE_ATOMS.has(tok)) atoms.add(tok);
  }
  for (const line of pane.split(/\n/)) {
    const n = normalizeCiteText(line);
    if (n.length < EVIDENCE_CITE_PANE_WINDOW) continue;
    // Distinctive windows from real pane lines (bounded scan).
    const limit = Math.min(n.length, 240);
    for (let i = 0; i + EVIDENCE_CITE_PANE_WINDOW <= limit; i += EVIDENCE_CITE_PANE_WINDOW) {
      const win = n.slice(i, i + EVIDENCE_CITE_PANE_WINDOW);
      if (!LOW_SIGNAL_CITE_ATOMS.has(win)) atoms.add(win);
    }
    // Also keep a head slice for lines that models often quote.
    const head = n.slice(0, Math.min(n.length, 48));
    if (!LOW_SIGNAL_CITE_ATOMS.has(head)) atoms.add(head);
  }

  const walk = (value: unknown): void => {
    if (value == null) return;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      add(String(value), EVIDENCE_CITE_FACT_MIN);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (typeof value === 'object') {
      for (const v of Object.values(value as Record<string, unknown>)) walk(v);
    }
  };
  walk(envelope?.callback_facts);
  walk(envelope?.run_facts);
  walk(envelope?.task_facts);
  walk(envelope?.last_dispatch);

  return [...atoms];
}

/**
 * Match a checkable atom inside the claim.
 * Long pane windows may be substrings; short atoms require whole-token/phrase boundaries
 * so e.g. envelope token "complete" does not accept claim word "completed".
 */
function claimIncludesCiteAtom(claim: string, atom: string): boolean {
  if (!atom) return false;
  if (atom.length >= EVIDENCE_CITE_PANE_WINDOW) {
    return claim.includes(atom);
  }
  const escaped = atom.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`);
  return re.test(claim);
}

/**
 * AC14: claimed evidence must reference facts actually present in the envelope
 * (pane-tail content, callback/run/task facts, last dispatch). Non-empty prose alone fails.
 */
export function evidenceCitesEnvelope(evidence: string, envelope: HousekeeperEnvelope): boolean {
  if (!envelope || typeof envelope !== 'object') return false;
  const claim = normalizeCiteText(evidence);
  if (!claim) return false;
  const atoms = collectEnvelopeCiteAtoms(envelope);
  if (atoms.length === 0) return false;
  return atoms.some((atom) => claimIncludesCiteAtom(claim, atom));
}

function evidenceCitesStoredEnvelope(evidence: string, envelopeJson: unknown): boolean {
  try {
    const parsed =
      typeof envelopeJson === 'string'
        ? (JSON.parse(envelopeJson) as HousekeeperEnvelope)
        : (envelopeJson as HousekeeperEnvelope);
    if (!parsed || typeof parsed !== 'object') return false;
    return evidenceCitesEnvelope(evidence, parsed);
  } catch {
    return false;
  }
}

function buildHousekeeperEnvelope(params: {
  row: HelmSessionRow;
  observation: SessionObservationResult;
  paneTail: string;
  paneTailProvenance: string;
  probe: HousekeeperProbeOutcomes;
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
    probe: params.probe,
    callback_facts: params.callbackFacts,
    run_facts: params.runFacts,
    task_facts: params.taskFacts,
    last_dispatch: params.lastDispatch,
  };
}

function normalizeHousekeeperVerdict(raw: string): 'done' | 'needs-human' | null {
  const verdict = String(raw ?? '').trim().toLowerCase();
  if (verdict === 'done') return 'done';
  if (verdict === 'needs-human') return 'needs-human';
  return null;
}

function normalizeTerminalInvestigationStatus(status: string): { outcome: 'applied_done'; verdict: 'done' } | { outcome: 'needs_human'; verdict: 'needs-human' } | null {
  if (status === 'applied_done') return { outcome: 'applied_done', verdict: 'done' };
  if (status === 'needs_human') return { outcome: 'needs_human', verdict: 'needs-human' };
  return null;
}

function isCallbackProofText(value: string): boolean {
  return value.trim().length > 0;
}

function buildStateSignature(row: HelmSessionRow, observation: SessionObservationResult): string {
  return JSON.stringify({
    session: {
      name: row.name,
      owner: row.owner,
      status: row.status,
      run_id: row.run_id,
      last_used_at: row.last_used_at,
    },
    observation: {
      action: observation.action,
      reason: observation.reason,
      effectiveActivityMs: observation.effectiveActivityMs,
    },
  });
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
