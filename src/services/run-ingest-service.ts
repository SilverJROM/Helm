import { createHash } from 'node:crypto';
import { DatabaseService } from '../db/database.js';

export const RUN_REGISTER_ENVELOPE = 'helm.run-ingest/v1';

const HEX64 = /^[a-f0-9]{64}$/i;

export interface RunRegisterHashes {
  ready: string;
  plan: string;
  queue: string;
  topology: string;
}

export interface RunRegisterEnvelope {
  envelope: string;
  event_id: string;
  external_run_id: string;
  generation: number;
  hashes: RunRegisterHashes;
  payload_hash: string;
}

export interface RunRegisterBody {
  ok: true;
  run_id: number;
  project_id: number;
  external_run_id: string;
  generation: number;
  event_id: string;
  state_revision: number;
}

export interface RunRegisterResult {
  httpStatus: 200 | 201;
  body: RunRegisterBody;
  replay: boolean;
}

export type RunTerminalState = 'success' | 'failed' | 'blocked';

export interface RunCompleteEnvelope {
  envelope: string;
  event_id: string;
  external_run_id: string;
  generation: number;
  expected_state_revision: number;
  terminal_state: RunTerminalState;
  seal?: string;
  reason?: string;
  payload_hash: string;
}

export interface RunCompleteBody {
  ok: true;
  run_id: number;
  project_id: number;
  external_run_id: string;
  generation: number;
  event_id: string;
  terminal_state: RunTerminalState;
  state_revision: number;
}

export interface RunCompleteResult {
  httpStatus: 200;
  body: RunCompleteBody;
  replay: boolean;
}

/** AC4: malformed envelope, bad hash shape, or a declared payload_hash that disagrees with the canonical server hash. */
export class RunIngestValidationError extends Error {}
/** AC3: the same event_id or the same (project, external_run_id, generation) identity already resolved to a different payload. */
export class RunIngestConflictError extends Error {}

function requireNonEmptyString(value: unknown, field: string, maxLen = 200): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLen) {
    throw new RunIngestValidationError(`invalid run-ingest envelope: ${field} must be a non-empty string`);
  }
  return value;
}

function requireHash(value: unknown, field: string): string {
  if (typeof value !== 'string' || !HEX64.test(value)) {
    throw new RunIngestValidationError(`invalid run-ingest envelope: ${field} must be a 64-char hex hash`);
  }
  return value.toLowerCase();
}

function validateEnvelope(input: unknown): RunRegisterEnvelope {
  if (!input || typeof input !== 'object') {
    throw new RunIngestValidationError('invalid run-ingest envelope: body must be an object');
  }
  const raw = input as Record<string, unknown>;
  if (raw.envelope !== RUN_REGISTER_ENVELOPE) {
    throw new RunIngestValidationError(`invalid run-ingest envelope: envelope must be "${RUN_REGISTER_ENVELOPE}"`);
  }
  const event_id = requireNonEmptyString(raw.event_id, 'event_id');
  const external_run_id = requireNonEmptyString(raw.external_run_id, 'external_run_id');
  if (!Number.isInteger(raw.generation) || (raw.generation as number) < 0) {
    throw new RunIngestValidationError('invalid run-ingest envelope: generation must be a non-negative integer');
  }
  const generation = raw.generation as number;
  const rawHashes = raw.hashes;
  if (!rawHashes || typeof rawHashes !== 'object') {
    throw new RunIngestValidationError('invalid run-ingest envelope: hashes must be an object');
  }
  const h = rawHashes as Record<string, unknown>;
  const hashes: RunRegisterHashes = {
    ready: requireHash(h.ready, 'hashes.ready'),
    plan: requireHash(h.plan, 'hashes.plan'),
    queue: requireHash(h.queue, 'hashes.queue'),
    topology: requireHash(h.topology, 'hashes.topology'),
  };
  const payload_hash = requireHash(raw.payload_hash, 'payload_hash');
  return { envelope: RUN_REGISTER_ENVELOPE, event_id, external_run_id, generation, hashes, payload_hash };
}

function validateCompleteEnvelope(input: unknown): RunCompleteEnvelope {
  if (!input || typeof input !== 'object') {
    throw new RunIngestValidationError('invalid run-complete envelope: body must be an object');
  }
  const raw = input as Record<string, unknown>;
  if (raw.envelope !== RUN_REGISTER_ENVELOPE) {
    throw new RunIngestValidationError(`invalid run-complete envelope: envelope must be "${RUN_REGISTER_ENVELOPE}"`);
  }
  const event_id = requireNonEmptyString(raw.event_id, 'event_id');
  const external_run_id = requireNonEmptyString(raw.external_run_id, 'external_run_id');
  if (!Number.isInteger(raw.generation) || (raw.generation as number) < 0) {
    throw new RunIngestValidationError('invalid run-complete envelope: generation must be a non-negative integer');
  }
  const generation = raw.generation as number;
  if (!Number.isInteger(raw.expected_state_revision) || (raw.expected_state_revision as number) < 0) {
    throw new RunIngestValidationError('invalid run-complete envelope: expected_state_revision must be a non-negative integer');
  }
  const expected_state_revision = raw.expected_state_revision as number;
  if (raw.terminal_state !== 'success' && raw.terminal_state !== 'failed' && raw.terminal_state !== 'blocked') {
    throw new RunIngestValidationError('invalid run-complete envelope: terminal_state must be one of success|failed|blocked');
  }
  const terminal_state = raw.terminal_state as RunTerminalState;

  let seal: string | undefined;
  let reason: string | undefined;
  if (terminal_state === 'success') {
    seal = requireHash(raw.seal, 'seal');
  } else {
    reason = requireNonEmptyString(raw.reason, 'reason', 2000);
  }

  const payload_hash = requireHash(raw.payload_hash, 'payload_hash');
  return {
    envelope: RUN_REGISTER_ENVELOPE,
    event_id,
    external_run_id,
    generation,
    expected_state_revision,
    terminal_state,
    seal,
    reason,
    payload_hash,
  };
}

/** success -> complete/complete; failed -> failed/failed; blocked -> failed/blocked (matches the run-orchestrator terminal-state convention). */
function terminalStatusPhase(state: RunTerminalState): { status: 'complete' | 'failed'; phase: 'complete' | 'failed' | 'blocked' } {
  if (state === 'success') return { status: 'complete', phase: 'complete' };
  if (state === 'failed') return { status: 'failed', phase: 'failed' };
  return { status: 'failed', phase: 'blocked' };
}

/**
 * Canonical server hash over the complete envelope's identity + outcome fields (everything except
 * the caller's own declared payload_hash) — mirrors computeRunRegisterPayloadHash for the complete op.
 */
export function computeRunCompletePayloadHash(
  projectId: number,
  fields: {
    event_id: string;
    external_run_id: string;
    generation: number;
    expected_state_revision: number;
    terminal_state: RunTerminalState;
    seal?: string;
    reason?: string;
  }
): string {
  const canonical = {
    envelope: RUN_REGISTER_ENVELOPE,
    op: 'complete',
    project_id: projectId,
    event_id: fields.event_id,
    external_run_id: fields.external_run_id,
    generation: fields.generation,
    expected_state_revision: fields.expected_state_revision,
    terminal_state: fields.terminal_state,
    seal: fields.seal ?? null,
    reason: fields.reason ?? null,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * Canonical server hash over the register envelope's identity fields (everything except the
 * caller's own declared payload_hash). Exported so callers (and tests) can compute the exact
 * value that must be supplied as `payload_hash` — the server never trusts a declared hash it
 * cannot itself re-derive.
 */
export function computeRunRegisterPayloadHash(
  projectId: number,
  fields: { event_id: string; external_run_id: string; generation: number; hashes: RunRegisterHashes }
): string {
  const canonical = {
    envelope: RUN_REGISTER_ENVELOPE,
    project_id: projectId,
    event_id: fields.event_id,
    external_run_id: fields.external_run_id,
    generation: fields.generation,
    hashes: {
      ready: fields.hashes.ready,
      plan: fields.hashes.plan,
      queue: fields.hashes.queue,
      topology: fields.hashes.topology,
    },
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * O5.2 — exactly-once, replay-safe run registration for the external OVM/tiller coordinator.
 * One (project, external_run_id, generation) identity registers at most once; the append-only
 * `run_ingest_receipts` row (keyed by event_id, with a second unique semantic key) is the sole
 * source of truth distinguishing an exact replay from a conflicting duplicate.
 */
export class RunIngestService {
  constructor(private readonly db: DatabaseService) {}

  register(projectId: number, rawEnvelope: unknown): RunRegisterResult {
    const envelope = validateEnvelope(rawEnvelope);
    const canonicalHash = computeRunRegisterPayloadHash(projectId, envelope);
    if (canonicalHash !== envelope.payload_hash) {
      throw new RunIngestValidationError('invalid run-ingest envelope: payload_hash does not match canonical server hash');
    }
    const semanticKey = `${projectId}:${envelope.external_run_id}:${envelope.generation}:register`;

    const txn = this.db.raw.transaction((): RunRegisterResult => {
      const existingByEvent = this.db.prepare(
        'SELECT semantic_key, payload_hash, response_json FROM run_ingest_receipts WHERE event_id = ?'
      ).get(envelope.event_id) as { semantic_key: string; payload_hash: string; response_json: string } | undefined;

      if (existingByEvent) {
        if (existingByEvent.semantic_key === semanticKey && existingByEvent.payload_hash === canonicalHash) {
          return { httpStatus: 200, body: JSON.parse(existingByEvent.response_json), replay: true };
        }
        throw new RunIngestConflictError('event_id already used with a different run identity or payload');
      }

      const existingBySemantic = this.db.prepare(
        'SELECT id FROM run_ingest_receipts WHERE semantic_key = ?'
      ).get(semanticKey);
      if (existingBySemantic) {
        // event_id is new here (checked above) — a second event for an already-registered run identity is a conflict.
        throw new RunIngestConflictError('run identity already registered under a different event');
      }

      let runId: number;
      try {
        const info = this.db.prepare(
          `INSERT INTO runs (project_id, external_run_id, generation, source, status, phase, register_seal_hash, state_revision)
           VALUES (?, ?, ?, 'ingest', 'active', 'executing', ?, 0)`
        ).run(projectId, envelope.external_run_id, envelope.generation, canonicalHash);
        runId = Number(info.lastInsertRowid);
      } catch {
        throw new RunIngestConflictError('run identity already registered');
      }

      this.db.prepare(
        `INSERT INTO run_events (run_id, event_type, payload_json) VALUES (?, 'REGISTERED', ?)`
      ).run(String(runId), JSON.stringify({
        event_id: envelope.event_id,
        external_run_id: envelope.external_run_id,
        generation: envelope.generation,
        hashes: envelope.hashes,
        project_id: projectId,
      }));

      const body: RunRegisterBody = {
        ok: true,
        run_id: runId,
        project_id: projectId,
        external_run_id: envelope.external_run_id,
        generation: envelope.generation,
        event_id: envelope.event_id,
        state_revision: 0,
      };

      this.db.prepare(
        'INSERT INTO run_ingest_receipts (run_id, event_id, semantic_key, payload_hash, response_json) VALUES (?, ?, ?, ?, ?)'
      ).run(runId, envelope.event_id, semanticKey, canonicalHash, JSON.stringify(body));

      return { httpStatus: 201, body, replay: false };
    });

    return txn();
  }

  /**
   * O5.3 — exactly-once, replay-safe terminal completion for a previously registered run.
   * CAS-updates status/phase/state_revision/ended_at and appends one terminal run_event inside
   * the same transaction as the append-only receipt, so a restart always observes one consistent
   * terminal row (AC4) and a rejected request leaves zero partial state (AC3).
   */
  complete(projectId: number, rawEnvelope: unknown): RunCompleteResult {
    const envelope = validateCompleteEnvelope(rawEnvelope);
    const canonicalHash = computeRunCompletePayloadHash(projectId, envelope);
    if (canonicalHash !== envelope.payload_hash) {
      throw new RunIngestValidationError('invalid run-complete envelope: payload_hash does not match canonical server hash');
    }
    const semanticKey = `${projectId}:${envelope.external_run_id}:${envelope.generation}:complete`;

    const txn = this.db.raw.transaction((): RunCompleteResult => {
      const existingByEvent = this.db.prepare(
        'SELECT semantic_key, payload_hash, response_json FROM run_ingest_receipts WHERE event_id = ?'
      ).get(envelope.event_id) as { semantic_key: string; payload_hash: string; response_json: string } | undefined;

      if (existingByEvent) {
        if (existingByEvent.semantic_key === semanticKey && existingByEvent.payload_hash === canonicalHash) {
          return { httpStatus: 200, body: JSON.parse(existingByEvent.response_json), replay: true };
        }
        throw new RunIngestConflictError('event_id already used with a different run identity or payload');
      }

      const existingBySemantic = this.db.prepare(
        'SELECT id FROM run_ingest_receipts WHERE semantic_key = ?'
      ).get(semanticKey);
      if (existingBySemantic) {
        // event_id is new here (checked above) — a second completion event for an already-terminal run identity is a conflict.
        throw new RunIngestConflictError('run already has a terminal completion recorded under a different event');
      }

      const run = this.db.prepare(
        'SELECT id, status, state_revision FROM runs WHERE project_id = ? AND external_run_id = ? AND generation = ?'
      ).get(projectId, envelope.external_run_id, envelope.generation) as
        | { id: number; status: string; state_revision: number }
        | undefined;
      if (!run) {
        throw new RunIngestConflictError('cannot complete a run that has not been registered');
      }
      if (run.status !== 'active') {
        throw new RunIngestConflictError(`invalid transition: run is not active (status=${run.status})`);
      }
      if (run.state_revision !== envelope.expected_state_revision) {
        throw new RunIngestConflictError('stale expected_state_revision: run state has moved on');
      }

      const nextRevision = run.state_revision + 1;
      const { status, phase } = terminalStatusPhase(envelope.terminal_state);

      const update = this.db.prepare(
        `UPDATE runs SET status = ?, phase = ?, state_revision = ?, ended_at = datetime('now'), terminal_seal_hash = ?
         WHERE id = ? AND state_revision = ? AND status = 'active'`
      ).run(status, phase, nextRevision, envelope.seal ?? null, run.id, run.state_revision);
      if (update.changes !== 1) {
        throw new RunIngestConflictError('stale expected_state_revision: run state has moved on');
      }

      this.db.prepare(
        `INSERT INTO run_events (run_id, event_type, payload_json) VALUES (?, 'TERMINAL', ?)`
      ).run(String(run.id), JSON.stringify({
        event_id: envelope.event_id,
        external_run_id: envelope.external_run_id,
        generation: envelope.generation,
        terminal_state: envelope.terminal_state,
        seal: envelope.seal ?? null,
        reason: envelope.reason ?? null,
        project_id: projectId,
      }));

      const body: RunCompleteBody = {
        ok: true,
        run_id: run.id,
        project_id: projectId,
        external_run_id: envelope.external_run_id,
        generation: envelope.generation,
        event_id: envelope.event_id,
        terminal_state: envelope.terminal_state,
        state_revision: nextRevision,
      };

      this.db.prepare(
        'INSERT INTO run_ingest_receipts (run_id, event_id, semantic_key, payload_hash, response_json) VALUES (?, ?, ?, ?, ?)'
      ).run(run.id, envelope.event_id, semanticKey, canonicalHash, JSON.stringify(body));

      return { httpStatus: 200, body, replay: false };
    });

    return txn();
  }
}
