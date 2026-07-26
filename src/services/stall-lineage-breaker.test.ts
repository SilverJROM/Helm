import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from '../db/database.js';
import { evaluateBreaker, StallLineageService } from './stall-lineage-service.js';

describe('B01.s5 stall lineage breaker', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
  function service(): StallLineageService {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b01-s5-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    return new StallLineageService(new DatabaseService(path.join(dir, 'helm-test.db')));
  }
  function lineage(service: StallLineageService) {
    return service.openOrGetLineage({ run_id: 'run-b01-s5', batch_id: 'B01.s5', scope_generation: 0, initial_signature: 'initial-class' });
  }

  it('accepts a legacy class_history-only lineage input', () => {
    expect(evaluateBreaker({ class_history: ['same', 'same'] }))
      .toMatchObject({ tripped: true, reason: 'spin' });
  });

  it('trips persisted same-signature spin rounds', () => {
    const svc = service();
    const opened = lineage(svc);
    svc.recordRound(opened.stall_lineage_id, 'callback-missing', 'callback');
    const persisted = svc.recordRound(opened.stall_lineage_id, 'callback-missing', 'callback');
    expect(evaluateBreaker(persisted)).toMatchObject({ tripped: true, reason: 'spin' });
  });

  it('trips persisted two-round multi-surface blast', () => {
    const svc = service();
    const opened = lineage(svc);
    svc.recordRound(opened.stall_lineage_id, 'new-class-a', 'surface-a');
    const persisted = svc.recordRound(opened.stall_lineage_id, 'new-class-b', 'surface-b');
    expect(evaluateBreaker(persisted, { new_class_rounds_to_stall: 2 })).toMatchObject({ tripped: true, reason: 'blast' });
  });

  it('does not trip persisted productive narrowing on one surface', () => {
    const svc = service();
    const opened = lineage(svc);
    svc.recordRound(opened.stall_lineage_id, 'identity/nul', 'lineage-identity');
    svc.recordRound(opened.stall_lineage_id, 'identity/mid-surrogate', 'lineage-identity');
    const persisted = svc.recordRound(opened.stall_lineage_id, 'identity/eof-surrogate', 'lineage-identity');
    expect(evaluateBreaker(persisted)).toMatchObject({ tripped: false, reason: null });
  });
});
