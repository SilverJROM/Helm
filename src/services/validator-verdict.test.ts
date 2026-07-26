import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from '../db/database.js';
import { RunArtifactService, ValidatorProtocolDefectError } from './run-artifact-service.js';

describe('B01.s4 validator defect_class protocol', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

  function attempt() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b01-s4-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const db = new DatabaseService(path.join(dir, 'helm-test.db'));
    const artifacts = new RunArtifactService(db);
    const runId = artifacts.createRun();
    const taskId = artifacts.recordTask(runId, 'B01.s4', 'validator verdict');
    return { db, artifacts, attemptId: artifacts.recordAttempt(taskId, 1) };
  }

  it('stores a validator FAIL with its required defect_class', () => {
    const { db, artifacts, attemptId } = attempt();
    artifacts.recordValidatorVerdict(attemptId, 'FAIL', 'defect_class=missing-accessibility-label; button has no label');
    expect(db.raw.prepare('SELECT result, defect_class FROM validations WHERE attempt_id = ?').get(attemptId))
      .toMatchObject({ result: 'FAIL', defect_class: 'missing-accessibility-label' });
    db.close();
  });

  it('rejects an unlabeled validator FAIL as a protocol defect', () => {
    const { db, artifacts, attemptId } = attempt();
    expect(() => artifacts.recordValidatorVerdict(attemptId, 'FAIL', 'button has no label'))
      .toThrow(ValidatorProtocolDefectError);
    expect(db.raw.prepare('SELECT COUNT(*) AS count FROM validations').get()).toMatchObject({ count: 0 });
    db.close();
  });

  it('allows PASS without a defect_class', () => {
    const { db, artifacts, attemptId } = attempt();
    artifacts.recordValidatorVerdict(attemptId, 'PASS', 'verified');
    expect(db.raw.prepare('SELECT result, defect_class FROM validations WHERE attempt_id = ?').get(attemptId))
      .toMatchObject({ result: 'PASS', defect_class: null });
    db.close();
  });
});
