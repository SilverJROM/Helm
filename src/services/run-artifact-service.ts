import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseService } from '../db/database.js';

export class ValidatorProtocolDefectError extends Error {
  readonly code = 'VALIDATOR_PROTOCOL_DEFECT';
  constructor(message: string) { super(message); }
}

export function defectClassFromValidatorNote(note: string | null | undefined): string | null {
  const match = /(?:^|[\s;])defect_class\s*[:=]\s*([a-z0-9][a-z0-9._/-]*)/i.exec(note ?? '');
  return match?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Validator verdict normalization (Gate C / leg-9 — sol-legC-defectclass-findings.md)
//
// ONE shared contract, consumed by BOTH the role boundary (orchestrator-loop.performRolePhase)
// and validation persistence. Runs ONLY on an ALREADY-PARSED exact terminal state — note text
// never chooses the verdict. A real FAIL is never laundered into PASS, and a useful diagnosis is
// never replaced by a protocol-only string.
// ---------------------------------------------------------------------------

/** Preferred defect_class enum surfaced to the validator model. B1 model GUIDANCE only (not truth). */
export const PREFERRED_DEFECT_CLASSES = [
  'implementer-incapable',
  'plan-defect',
  'missing-artifact',
  'test-failure',
  'build-failure',
  'regression',
  'requirements-gap',
  'behavior-mismatch',
  'other',
] as const;

export type ValidatorClassificationSource = 'declared' | 'derived' | 'protocol-defect' | 'none';

export interface NormalizedValidatorVerdict {
  state: 'PASS' | 'FAIL' | 'BLOCKED';
  defectClass: string | null;
  escalateFlag: boolean;
  /** True when validator declares defect_class=plan-defect (task/spec is broken; plan needs revision). */
  planDefectFlag: boolean;
  note: string | null;
  classificationSource: ValidatorClassificationSource;
}

// Ordered derived-class rules — FIRST MATCH WINS (findings §2). The live Leg C note deterministically
// becomes `missing-artifact` because that rule precedes its secondary test-failure/requirements evidence.
const DERIVATION_RULES: Array<{ cls: string; re: RegExp }> = [
  { cls: 'missing-artifact', re: /\b(missing|absent|not\s+found|does\s+not\s+exist|no\s+such\s+file)\b/i },
  { cls: 'build-failure', re: /\b(compil\w*|typecheck\w*|type[-\s]?error|transpil\w*|does\s+not\s+compile|won'?t\s+compile|build\s+(fail\w*|error\w*|broke\w*))\b/i },
  { cls: 'test-failure', re: /\b(tests?|assert\w*|failing\s+tests?|non-?zero\s+exit|exit(s|ed)?\s+(code\s+)?[1-9])\b/i },
  { cls: 'regression', re: /\b(regress\w*|broke|broken|previously\s+working|used\s+to\s+work|no\s+longer\s+works?)\b/i },
  { cls: 'requirements-gap', re: /\b(requirements?|criteri(a|on)|unmet|not[-\s]met|not\s+satisfied|acceptance\s+criteri\w*)\b/i },
  { cls: 'behavior-mismatch', re: /\b(mismatch\w*|expected|actual|wrong|incorrect\w*|unexpected\w*|misbehav\w*)\b/i },
];

// Exact boilerplate/template values (case-folded + punctuation-removed) that are NOT a substantive diagnosis.
const BOILERPLATE_NOTES = new Set([
  'fail', 'failed', 'failure', 'error', 'unknown', 'none', 'na', 'tbd', 'todo',
  'reason', 'gaps', 'gaps listed by req',
]);

// An inability-to-validate statement is NOT a requirement failure (findings §2 cond 4 / §4) → BLOCKED.
const INABILITY_RE = /^(aborted|validation\s+aborted|unable\s+to\s+validate|cannot\s+validate|could\s+not\s+inspect|no\s+access|authentication\s+required)\b/i;

// Eligibility COPY of the note (never the stored original): trim, strip ONE redundant leading FAIL +
// separators, collapse whitespace. Used only to TEST substance / derive a class.
function validatorEligibilityText(note: string | null | undefined): string {
  let t = (note ?? '').trim();
  t = t.replace(/^fail\b[\s:;.,—–-]*/i, '');
  return t.replace(/\s+/g, ' ').trim();
}

// Case-fold + remove punctuation (keep spaces) + collapse — for the exact-boilerplate comparison.
function alnumNormalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]+/g, '').replace(/\s+/g, ' ').trim();
}

/** A FAIL note is a substantive diagnosis (findings §2) — tests useful content, not eloquence. */
export function isSubstantiveValidatorDiagnosis(note: string | null | undefined): boolean {
  const eligibility = validatorEligibilityText(note);
  if (INABILITY_RE.test(eligibility)) return false;                       // cond 4: not an inability statement
  const words = eligibility.match(/[a-z0-9]+/gi) ?? [];
  if (words.length < 2) return false;                                     // cond 1: >= 2 alnum words
  const alnumChars = (eligibility.match(/[a-z0-9]/gi) ?? []).length;
  if (alnumChars < 5) return false;                                       // cond 2: >= 5 alnum chars
  if (BOILERPLATE_NOTES.has(alnumNormalize(eligibility))) return false;   // cond 3: not exact boilerplate
  return true;
}

/** First-match-wins keyword derivation with the canonical generic fallback (findings §2). */
export function deriveDefectClass(note: string | null | undefined): string {
  const eligibility = validatorEligibilityText(note);
  for (const rule of DERIVATION_RULES) {
    if (rule.re.test(eligibility)) return rule.cls;
  }
  return 'validator-reported-defect';
}

/**
 * Normalize an already-parsed EXACT validator terminal state into a persisted contract.
 * - exact PASS       -> unchanged (no prose-sentiment classifier).
 * - exact FAIL + valid explicit `defect_class=<token>` -> kept verbatim (even out-of-enum), source=declared.
 *   Escalation modifiers: `implementer-incapable` → escalateFlag; `plan-defect` → planDefectFlag.
 * - exact FAIL, no token, SUBSTANTIVE -> state FAIL, derived class, note = original + Helm annotation, source=derived.
 * - exact FAIL, no token, NON-substantive (empty/boilerplate/inability) -> BLOCKED / protocol-defect,
 *   note carries BOTH the reason AND the original text (explicit `<empty>` marker). Never loses received text.
 * - any other already-terminal state -> passed through untouched (normalizer only owns PASS/FAIL).
 */
export function normalizeValidatorVerdict(
  state: string,
  note: string | null | undefined,
): NormalizedValidatorVerdict {
  const original = note ?? null;
  if (state === 'PASS') {
    return { state: 'PASS', defectClass: null, escalateFlag: false, planDefectFlag: false, note: original, classificationSource: 'none' };
  }
  if (state !== 'FAIL') {
    return { state: state as NormalizedValidatorVerdict['state'], defectClass: null, escalateFlag: false, planDefectFlag: false, note: original, classificationSource: 'none' };
  }
  // Exact FAIL.
  const declared = defectClassFromValidatorNote(original);
  if (declared) {
    const cls = declared.toLowerCase();
    return {
      state: 'FAIL',
      defectClass: declared,
      escalateFlag: cls === 'implementer-incapable',
      planDefectFlag: cls === 'plan-defect',
      note: original,
      classificationSource: 'declared',
    };
  }
  if (isSubstantiveValidatorDiagnosis(original)) {
    const derived = deriveDefectClass(original);
    const annotated = `${original ?? ''} [HELM classification: derived defect_class=${derived}; validator omitted defect_class]`;
    return { state: 'FAIL', defectClass: derived, escalateFlag: false, planDefectFlag: false, note: annotated, classificationSource: 'derived' };
  }
  // Non-substantive: bounded protocol defect. NEVER replace-and-lose the received text.
  const trimmed = (original ?? '').trim();
  const marker = trimmed === '' ? '<empty>' : trimmed;
  const reason = INABILITY_RE.test(validatorEligibilityText(original))
    ? 'validator FAIL was an inability-to-validate statement, not a requirement failure'
    : 'validator FAIL lacked defect_class and a substantive diagnosis';
  return {
    state: 'BLOCKED',
    defectClass: 'protocol-defect',
    escalateFlag: false,
    planDefectFlag: false,
    note: `PROTOCOL-DEFECT: ${reason} (original: ${marker})`,
    classificationSource: 'protocol-defect',
  };
}

/**
 * RunArtifactService (B1 ST2)
 * - Persists/reads the durable rows (runs, run_tasks, task_attempts, dispatches, callbacks(with acked_at+source), validations, artifacts)
 * - Writes/reads the canonical run-folder layout (prompts/, state/, artifacts/, callbacks.md)
 * - rehydrate() lets a fresh agent reconstruct state purely from DB + files (no hidden in-memory)
 * Round-trip tested. Minimal; no callbacks.md *parsing* (B5 scope).
 */
export class RunArtifactService {
  constructor(private readonly db: DatabaseService) {}

  // DB recorders (ST1 tables)

  createRun(projectId: number | null = null, batchId = 'batch-B1', northStarRef: string | null = null, cycleId: number | null = null): number {
    const info = this.db.raw
      .prepare(`INSERT INTO runs (project_id, cycle_id, batch_id, north_star_ref, status) VALUES (?,?,?,?, 'active')`)
      .run(projectId, cycleId, batchId, northStarRef);
    return info.lastInsertRowid as number;
  }

  /** Append a durable orchestration metric/event without exposing the private DB handle. */
  recordRunEvent(runId: number | string, eventType: string, payload: unknown, batchId: string | null = null): number {
    const info = this.db.raw
      .prepare(`INSERT INTO run_events (run_id, batch_id, event_type, payload_json) VALUES (?,?,?,?)`)
      .run(String(runId), batchId, eventType, JSON.stringify(payload ?? {}));
    return info.lastInsertRowid as number;
  }

  /** B10-T01: convenience for cycle→run bridge (cycleId required for the link). */
  createRunForCycle(projectId: number | null, cycleId: number, batchId = 'batch-B10', northStarRef: string | null = null): number {
    return this.createRun(projectId, batchId, northStarRef, cycleId);
  }

  // Leg D (batch barrier): `batch` is the resolved normalized batch label (trimmed) — persisted so
  // dispatch ordering, the deploy gate, and pending-after-drain classification read ONE durable batch
  // identity. NULL (default arg) for callers that don't supply one (legacy rows resolve to 'default').
  recordTask(runId: number, taskKey: string | null, label: string, batch: string | null = null): number {
    const info = this.db.raw
      .prepare(`INSERT INTO run_tasks (run_id, task_key, label, batch, status) VALUES (?,?,?,?, 'pending')`)
      .run(runId, taskKey, label, batch);
    return info.lastInsertRowid as number;
  }

  recordAttempt(taskId: number, attemptNum: number): number {
    const record = this.db.raw.transaction(() => {
      const info = this.db.raw
        .prepare(`INSERT INTO task_attempts (task_id, attempt_num, status) VALUES (?,?, 'pending')`)
        .run(taskId, attemptNum);
      const attemptId = Number(info.lastInsertRowid);
      const taskChange = this.db.raw.prepare(
        `UPDATE run_tasks
         SET status = 'working', attempts_count = attempts_count + 1,
             current_attempt_id = ?, updated_at = datetime('now')
         WHERE id = ?`
      ).run(attemptId, taskId);
      if (taskChange.changes !== 1) throw new Error(`recordAttempt could not update run_task ${taskId}`);
      return attemptId;
    });
    return record();
  }

  recordDispatch(attemptId: number, role: string, briefPath: string | null = null, transportHandle: string | null = null): number {
    const info = this.db.raw
      .prepare(`INSERT INTO dispatches (attempt_id, role, brief_path, transport_handle, spawned_at) VALUES (?,?,?,?, datetime('now'))`)
      .run(attemptId, role, briefPath, transportHandle);
    return info.lastInsertRowid as number;
  }

  recordCallback(dispatchId: number, role: string, state: string, rawLine: string | null = null, source: 'file' | 'seam' = 'file'): number {
    const info = this.db.raw
      .prepare(`INSERT INTO callbacks (dispatch_id, role, state, raw_line, received_at, source) VALUES (?,?,?,?, datetime('now'), ?)`)
      .run(dispatchId, role, state, rawLine, source);
    return info.lastInsertRowid as number;
  }

  recordAck(callbackId: number): void {
    this.db.raw.prepare(`UPDATE callbacks SET acked_at = datetime('now') WHERE id = ?`).run(callbackId);
  }

  recordValidation(attemptId: number, result: 'PASS' | 'FAIL' | 'DONE' | 'BLOCKED', note: string | null = null, defectClass: string | null = null): number {
    const info = this.db.raw
      .prepare(`INSERT INTO validations (attempt_id, result, note, defect_class, ts) VALUES (?,?,?,?, datetime('now'))`)
      .run(attemptId, result, note, defectClass);
    return info.lastInsertRowid as number;
  }

  /** Validator-only persistence: a FAIL without a declared class is a protocol defect. */
  recordValidatorVerdict(attemptId: number, result: 'PASS' | 'FAIL', note: string | null = null): number {
    const defectClass = defectClassFromValidatorNote(note);
    if (result === 'FAIL' && !defectClass) {
      throw new ValidatorProtocolDefectError('validator FAIL requires non-empty defect_class');
    }
    return this.recordValidation(attemptId, result, note, defectClass);
  }

  recordArtifact(runId: number, type: string, filePath: string, sha: string | null = null, taskId: number | null = null): number {
    const info = this.db.raw
      .prepare(`INSERT INTO artifacts (run_id, task_id, type, path, sha, created_at) VALUES (?,?,?,?,?, datetime('now'))`)
      .run(runId, taskId ?? null, type, filePath, sha);
    return info.lastInsertRowid as number;
  }

  /**
   * B5: build <project_dir>/helm_tasks/<tasklist>/<task>/ artifact root.
   * tasklist derived from batchId or runId; task from taskKey or taskId.
   * Safe slugging. Used by writers (C/E phases) and Documents.
   */
  getTaskArtifactRoot(projectDir: string, runId?: number | null, batchId?: string | null, taskId?: number | null, taskKey?: string | null): string {
    // Deterministic documented rule (per B5 fix): replace EACH non-alnum char (outside [a-z0-9_-]) with _ ; NO trim (leading/trailing _ kept if produced).
    const safe = (s: string | null | undefined, fallback: string) =>
      (s && String(s).trim())
        ? String(s).replace(/[^a-z0-9_-]/gi, '_') || fallback
        : fallback;
    const list = safe(batchId, runId != null ? `run${runId}` : 'run');
    const task = safe(taskKey, taskId != null ? `task${taskId}` : 'task');
    return path.join(projectDir, 'helm_tasks', list, task);
  }

  // FS canonical layout (generalizes B0 ThinRunArtifactWriter; used for roundtrips + rehydrate)

  private async ensure(subdir: string, runDir: string): Promise<void> {
    await fs.mkdir(path.join(runDir, subdir), { recursive: true });
  }

  async writeBrief(runDir: string, role: string, content: string): Promise<void> {
    await this.ensure('prompts', runDir);
    await fs.writeFile(path.join(runDir, 'prompts', `${role}.brief.md`), content, 'utf8');
  }

  async appendAck(runDir: string, role: string, batchId: string, dispatchNonce = 'legacy'): Promise<void> {
    const cbPath = path.join(runDir, 'callbacks.md');
    const ack = `[helm ACK] ${role} ${batchId} RECEIVED dispatch=${dispatchNonce} — ack before reap`;
    await fs.appendFile(cbPath, `\n${ack}\n`, 'utf8');
  }

  async persistState(runDir: string, transitions: string[], finalStatus: string, runId?: number): Promise<void> {
    await this.ensure('state', runDir);
    await this.ensure('artifacts', runDir);
    const transPath = 'state/transitions.json';
    const finalPath = 'artifacts/final.json';
    await fs.writeFile(path.join(runDir, transPath), JSON.stringify(transitions, null, 2), 'utf8');
    await fs.writeFile(
      path.join(runDir, finalPath),
      JSON.stringify({ status: finalStatus, transitions, ts: new Date().toISOString() }, null, 2),
      'utf8'
    );
    if (runId != null) {
      this.recordArtifact(runId, 'state', transPath);
      this.recordArtifact(runId, 'final', finalPath);
    }
  }

  // B8 (ESC3): per-attempt ledger persisted under canonical run-folder layout (failure-history/)
  // Entries include brief_path, model/rung, validator diagnosis, failed gates, evidence etc.
  // Fed to escalated rung briefs so smarter model does not re-walk dead ends 1-3.
  async writeFailureHistory(runDir: string, ledger: { version: number; attempts: any[]; generated_at: string }): Promise<void> {
    await this.ensure('failure-history', runDir);
    const fsPath = path.join(runDir, 'failure-history', 'ledger.json');
    await fs.writeFile(fsPath, JSON.stringify(ledger, null, 2), 'utf8');
    // also per-attempt for easy inspection
    for (const e of ledger.attempts || []) {
      const a = e.attempt || e.attempt_num || 0;
      await fs.writeFile(path.join(runDir, 'failure-history', `attempt-${a}.json`), JSON.stringify(e, null, 2), 'utf8');
    }
  }

  async readFailureHistory(runDir: string): Promise<{ version: number; attempts: any[]; generated_at: string } | null> {
    try {
      const raw = await fs.readFile(path.join(runDir, 'failure-history', 'ledger.json'), 'utf8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  // Rehydrate: rows from DB + files from layout. Fresh agent can resume with zero hidden state (ST2).
  async rehydrate(runId: number, runDir: string): Promise<{
    run: any;
    tasks: any[];
    attempts: any[];
    dispatches: any[];
    callbacks: any[];
    validations: any[];
    artifacts: any[];
    briefs: Record<string, string>;
    transitions: string[];
    final: any;
    cbFileContent: string;
    failureHistory: any | null;
  }> {
    const run = this.db.raw.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
    const tasks = this.db.raw.prepare('SELECT * FROM run_tasks WHERE run_id = ? ORDER BY id').all(runId);
    const attempts = this.db.raw.prepare(`
      SELECT ta.* FROM task_attempts ta
      JOIN run_tasks rt ON ta.task_id = rt.id
      WHERE rt.run_id = ? ORDER BY ta.id
    `).all(runId);
    const dispatches = this.db.raw.prepare(`
      SELECT d.* FROM dispatches d
      JOIN task_attempts ta ON d.attempt_id = ta.id
      JOIN run_tasks rt ON ta.task_id = rt.id
      WHERE rt.run_id = ? ORDER BY d.id
    `).all(runId);
    const callbacks = this.db.raw.prepare(`
      SELECT c.* FROM callbacks c
      JOIN dispatches d ON c.dispatch_id = d.id
      JOIN task_attempts ta ON d.attempt_id = ta.id
      JOIN run_tasks rt ON ta.task_id = rt.id
      WHERE rt.run_id = ? ORDER BY c.id
    `).all(runId);
    const validations = this.db.raw.prepare(`
      SELECT v.* FROM validations v
      JOIN task_attempts ta ON v.attempt_id = ta.id
      JOIN run_tasks rt ON ta.task_id = rt.id
      WHERE rt.run_id = ? ORDER BY v.id
    `).all(runId);
    const artifacts = this.db.raw.prepare('SELECT * FROM artifacts WHERE run_id = ? ORDER BY id').all(runId);

    const briefs: Record<string, string> = {};
    try {
      const pdir = path.join(runDir, 'prompts');
      const files = await fs.readdir(pdir).catch(() => [] as string[]);
      for (const f of files) {
        if (f.endsWith('.brief.md')) {
          const role = f.replace('.brief.md', '');
          briefs[role] = await fs.readFile(path.join(pdir, f), 'utf8');
        }
      }
    } catch {}

    let transitions: string[] = [];
    let final: any = null;
    try { transitions = JSON.parse(await fs.readFile(path.join(runDir, 'state', 'transitions.json'), 'utf8')); } catch {}
    try { final = JSON.parse(await fs.readFile(path.join(runDir, 'artifacts', 'final.json'), 'utf8')); } catch {}

    let cbFileContent = '';
    try { cbFileContent = await fs.readFile(path.join(runDir, 'callbacks.md'), 'utf8'); } catch {}

    let failureHistory: any | null = null;
    try {
      const raw = await fs.readFile(path.join(runDir, 'failure-history', 'ledger.json'), 'utf8');
      failureHistory = JSON.parse(raw);
    } catch {}

    return { run, tasks, attempts, dispatches, callbacks, validations, artifacts, briefs, transitions, final, cbFileContent, failureHistory };
  }

  /**
   * B13-T01b: per-task live state for a cycle's LATEST run (R-I4/F6/B5), server-derived from
   * cycle_id -> runs (never a client-supplied run id, mirrors B11-T04's guard). No run yet for
   * this cycle -> hasRun:false (honest graceful; the Implementation tab keeps its existing
   * all-pending seam, never fabricated). attempts is COUNT(task_attempts), NOT run_tasks.attempts_count
   * (that column is never incremented by any writer). commit is the latest artifacts row of
   * type='commit' for the task, or null if none was recorded (real-or-absent, never invented).
   */
  getCycleRunState(cycleId: number): {
    hasRun: boolean;
    runId?: number;
    runActive?: boolean;
    tasks: Array<{
      taskKey: string | null;
      label: string;
      status: string;
      attempts: number;
      durationSec: number | null;
      commit: { path: string; sha: string | null } | null;
      validationNotes: Array<{ result: string; note: string | null; ts: string }>;
    }>;
  } {
    // B13-T03d/R-F7: also read phase+status so the Implementation-tab Graceful Stop can target this
    // cycle's live run (and be a no-op when the run is already terminal).
    const run: any = this.db.raw.prepare('SELECT id, phase, status FROM runs WHERE cycle_id = ? ORDER BY id DESC LIMIT 1').get(cycleId);
    if (!run) return { hasRun: false, tasks: [] };
    const runActive = !(['complete', 'failed', 'blocked'].includes(String(run.phase)) || ['complete', 'failed'].includes(String(run.status)));

    const taskRows = this.db.raw.prepare(
      'SELECT id, task_key, label, status, created_at, updated_at FROM run_tasks WHERE run_id = ? ORDER BY id ASC'
    ).all(run.id) as any[];

    const tasks = taskRows.map((t) => {
      const attemptsRow: any = this.db.raw.prepare('SELECT COUNT(*) AS c FROM task_attempts WHERE task_id = ?').get(t.id);
      const commitRow: any = this.db.raw
        .prepare("SELECT path, sha FROM artifacts WHERE run_id = ? AND task_id = ? AND type = 'commit' ORDER BY id DESC LIMIT 1")
        .get(run.id, t.id);
      const validationRows = this.db.raw.prepare(
        `SELECT v.result AS result, v.note AS note, v.ts AS ts
         FROM validations v JOIN task_attempts ta ON v.attempt_id = ta.id
         WHERE ta.task_id = ? ORDER BY v.id ASC`
      ).all(t.id) as any[];
      const terminal = t.status === 'complete' || t.status === 'failed' || t.status === 'deferred';
      const durRow: any = terminal
        ? this.db.raw
            .prepare('SELECT CAST(ROUND((julianday(updated_at) - julianday(created_at)) * 86400) AS INTEGER) AS sec FROM run_tasks WHERE id = ?')
            .get(t.id)
        : null;
      const attemptsCount = Number(attemptsRow?.c || 0);
      // LV-R1: a task with a real in-flight attempt in an ACTIVE run reads as 'working' (honest —
      // derived from an actual task_attempts row, never fabricated; stored DB rows untouched). GUARDED
      // on runActive so completed/no-run cycles (the dogfood cycles 1/2) are unaffected — a terminal run
      // never re-labels its stored 'complete'/'pending' tasks. Only pending/working stored statuses are
      // promoted; complete/failed/deferred stay as stored.
      const derivedStatus =
        runActive && attemptsCount >= 1 && (t.status === 'pending' || t.status === 'working') && !terminal
          ? 'working'
          : t.status;
      return {
        taskKey: t.task_key ?? null,
        label: t.label,
        status: derivedStatus,
        attempts: attemptsCount,
        durationSec: durRow ? Number(durRow.sec) : null,
        commit: commitRow ? { path: commitRow.path, sha: commitRow.sha ?? null } : null,
        validationNotes: validationRows.map((v) => ({ result: v.result, note: v.note ?? null, ts: v.ts }))
      };
    });

    return { hasRun: true, runId: Number(run.id), runActive, tasks };
  }

  // B10 DSP9/10: read the canonical req-matrix.md for final validation gate (every row must be VERIFIED)
  async readReqMatrix(runDir: string): Promise<Array<{ req: string; status: string }>> {
    try {
      const raw = await fs.readFile(path.join(runDir, 'req-matrix.md'), 'utf8');
      const rows: Array<{ req: string; status: string }> = [];
      for (const line of raw.split('\n')) {
        if (!line.includes('|') || line.includes('---') || line.includes('Req | Batch')) continue;
        const cols = line.split('|').map((c) => c.trim());
        if (cols.length >= 4 && cols[1]) {
          rows.push({ req: cols[1], status: cols[3] });
        }
      }
      return rows;
    } catch {
      return [];
    }
  }

  // E3-writers: write under the B5 helm_tasks/<tasklist>/<task> root (in addition to runDir for orchestration files).
  // Used by NEW runs. Per-task: prompts/, changes.md, validation/ etc. run-level also recordable under tasklist dir.
  async writeToHelmTaskRoot(projectDir: string, runId: number | null | undefined, batchId: string | null | undefined, taskId: number | null | undefined, taskKey: string | null | undefined, relPath: string, content: string): Promise<void> {
    if (!projectDir) return;
    const root = this.getTaskArtifactRoot(projectDir, runId ?? undefined, batchId ?? undefined, taskId ?? undefined, taskKey ?? undefined);
    const full = path.join(root, relPath);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
  }

  // Convenience for per-task brief (mirrors runDir prompts/ + also to helm root)
  async writeBriefToHelmRoot(projectDir: string, runId: number | null | undefined, batchId: string | null | undefined, taskId: number | null | undefined, taskKey: string | null | undefined, role: string, content: string): Promise<void> {
    await this.writeToHelmTaskRoot(projectDir, runId, batchId, taskId, taskKey, `prompts/${role}.brief.md`, content);
  }
}
