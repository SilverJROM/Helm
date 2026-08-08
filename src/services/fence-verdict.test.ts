/**
 * fence-workflow-upgrade C3 -- strict fence verdict schema + persistence.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from '../db/database.js';
import {
  FENCE_VERDICT_ARTIFACT_TYPE,
  FENCE_VERDICT_EVENT_TYPE,
  normalizeFenceVerdict,
  persistFenceVerdict,
} from './fence-verdict.js';
import { stampCompositionJudgment } from './fence-integration-agent-route.js';
import type { NormalizedValidatorVerdict } from './run-artifact-service.js';

function tempDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function insertProjectRun(db: DatabaseService): { projectId: number; runId: number } {
  const projectId = (
    db.raw
      .prepare('INSERT INTO projects (name, directory) VALUES (?, ?) RETURNING id')
      .get(`fence-c3-${Date.now()}`, `/tmp/fence-c3-${Date.now()}`) as { id: number }
  ).id;
  const runId = (
    db.raw
      .prepare(
        "INSERT INTO runs (project_id, batch_id, north_star_ref, status, phase) VALUES (?, ?, ?, 'active', 'implementation') RETURNING id"
      )
      .get(projectId, 'C3', 'fence-verdict') as { id: number }
  ).id;
  return { projectId, runId };
}

describe('C3 normalizeFenceVerdict (R6.4, R7.1, R7.2, R7.3)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('accepts the integration_test_agent composition judgment and interops with NormalizedValidatorVerdict', () => {
    const judgment = stampCompositionJudgment(
      {
        fence: 'I3',
        verdict: 'FAIL',
        fault_class: 'implementation',
        failing_units: ['C2'],
        seam_fingerprint: 'fp1:abc123',
        plan_defect: false,
        note: 'composition still fails after CLOSE',
      },
      'intagent-session-1'
    );

    const verdict = normalizeFenceVerdict(judgment);
    expect(verdict).toMatchObject({
      schema: 'fence-verdict-v1',
      fence: 'I3',
      verdict: 'FAIL',
      state: 'FAIL',
      fault_class: 'implementation',
      failing_units: ['C2'],
      seam_fingerprint: 'fp1:abc123',
      plan_defect: false,
      defectClass: 'behavior-mismatch',
      classificationSource: 'declared',
      validation_errors: [],
      judged_by: {
        role: 'integration_test_agent',
        model: 'codex55',
        session_id: 'intagent-session-1',
      },
    });
    const interop: NormalizedValidatorVerdict = verdict;
    expect(interop.state).toBe('FAIL');
    expect(interop.planDefectFlag).toBe(false);
  });

  it('accepts a clean PASS only when the required fields are present and fault fields are empty', () => {
    const verdict = normalizeFenceVerdict(
      stampCompositionJudgment(
        {
          fence: 'I3',
          verdict: 'PASS',
          fault_class: null,
          failing_units: [],
          seam_fingerprint: 'fp1:clean',
          plan_defect: false,
        },
        'intagent-session-2'
      )
    );

    expect(verdict.state).toBe('PASS');
    expect(verdict.defectClass).toBeNull();
    expect(verdict.fault_class).toBeNull();
    expect(verdict.failing_units).toEqual([]);
    expect(verdict.validation_errors).toEqual([]);
  });

  it('fails closed when a required field is omitted instead of treating it as no defect', () => {
    const verdict = normalizeFenceVerdict({
      schema: 'fence-composition-judgment-v1',
      fence: 'I3',
      verdict: 'FAIL',
      failing_units: ['C2'],
      seam_fingerprint: 'fp1:missing-fault',
      plan_defect: false,
      judged_by: {
        role: 'integration_test_agent',
        model: 'codex55',
        session_id: 'intagent-session-3',
      },
    });

    expect(verdict.state).toBe('FAIL');
    expect(verdict.verdict).toBe('FAIL');
    expect(verdict.fault_class).toBe('plan');
    expect(verdict.plan_defect).toBe(true);
    expect(verdict.defectClass).toBe('plan-defect');
    expect(verdict.seam_fingerprint).toBe('fp1:missing-fault');
    expect(verdict.validation_errors).toContain('fault_class');
  });

  it('fails closed when the ordinary validator ladder tries to own a composition verdict', () => {
    const verdict = normalizeFenceVerdict({
      schema: 'fence-composition-judgment-v1',
      fence: 'I3',
      verdict: 'FAIL',
      fault_class: 'implementation',
      failing_units: ['C2'],
      seam_fingerprint: 'fp1:wrong-role',
      plan_defect: false,
      judged_by: {
        role: 'validator',
        model: 'codex55',
        session_id: 'validator-session',
      },
    });

    expect(verdict.state).toBe('FAIL');
    expect(verdict.fault_class).toBe('plan');
    expect(verdict.plan_defect).toBe(true);
    expect(verdict.validation_errors).toContain('judged_by.role');
  });

  it('generates a system fingerprint when the seam_fingerprint field is missing', () => {
    const verdict = normalizeFenceVerdict({
      schema: 'fence-composition-judgment-v1',
      fence: 'I3',
      verdict: 'PLAN_DEFECT',
      fault_class: 'plan',
      failing_units: [],
      plan_defect: true,
      judged_by: {
        role: 'integration_test_agent',
        model: 'codex55',
        session_id: 'intagent-session-4',
      },
    });

    expect(verdict.state).toBe('FAIL');
    expect(verdict.plan_defect).toBe(true);
    expect(verdict.seam_fingerprint).toMatch(/^fp1:[a-f0-9]{20}$/);
    expect(verdict.validation_errors).toContain('seam_fingerprint');
  });

  it('persists every verdict/fingerprint as new append-only run event plus JSON artifact row', () => {
    const t = tempDir('helm-fence-c3-persist-');
    cleanups.push(t.cleanup);
    const db = new DatabaseService(path.join(t.dir, 'helm.db'));
    const { runId } = insertProjectRun(db);
    const judgment = stampCompositionJudgment(
      {
        fence: 'I3',
        verdict: 'FAIL',
        fault_class: 'implementation',
        failing_units: ['C2'],
        seam_fingerprint: 'fp1:persisted',
        plan_defect: false,
        note: 'defect_class=behavior-mismatch; persisted composition failure',
      },
      'intagent-session-5'
    );

    const first = persistFenceVerdict(db, { runId, batchId: 'C3', verdict: judgment, runDir: t.dir });
    const second = persistFenceVerdict(db, { runId, batchId: 'C3', verdict: judgment, runDir: t.dir });

    expect(first.eventId).not.toBe(second.eventId);
    expect(first.artifactId).not.toBe(second.artifactId);
    expect(fs.existsSync(first.artifactPath)).toBe(true);

    const artifacts = db.raw
      .prepare('SELECT id, type, path, sha FROM artifacts WHERE run_id = ? ORDER BY id')
      .all(runId) as Array<{ id: number; type: string; path: string; sha: string }>;
    expect(artifacts).toHaveLength(2);
    expect(artifacts.every((row) => row.type === FENCE_VERDICT_ARTIFACT_TYPE)).toBe(true);
    expect(artifacts.every((row) => row.sha.startsWith('sha256:'))).toBe(true);

    const events = db.raw
      .prepare('SELECT id, batch_id, event_type, payload_json FROM run_events WHERE run_id = ? ORDER BY id')
      .all(String(runId)) as Array<{ id: number; batch_id: string; event_type: string; payload_json: string }>;
    expect(events).toHaveLength(2);
    expect(events.every((row) => row.event_type === FENCE_VERDICT_EVENT_TYPE)).toBe(true);
    const payload = JSON.parse(events[0].payload_json);
    expect(payload.seam_fingerprint).toBe('fp1:persisted');
    expect(payload.artifact_id).toBe(first.artifactId);
    expect(payload.artifact_sha).toBe(first.sha);

    expect(() =>
      db.raw.prepare('UPDATE run_events SET payload_json = ? WHERE id = ?').run('{}', first.eventId)
    ).toThrow(/append-only/i);
    db.close();
  });
});
