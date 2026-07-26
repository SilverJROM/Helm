/**
 * B15a — R3.14 / I6 DIFFICULTY vertical climb + L3 terminal stall.
 * Pipeline step 2 (after B14a lateral AVAIL). No B15b COUPLING, no B15c UI.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService } from './db/database.js';
import { ModelService } from './services/model-service.js';
import { EscalationService } from './services/escalation-service.js';
import { TierResolutionService } from './services/tier-resolution-service.js';
import {
  assertDifficultyClimbable,
  assertSeatAvailable,
  ResolveStallError,
} from './db/resolve-time-invariants.js';

function setupDb(prefix: string): { dbs: DatabaseService; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(dir, `helm-test-${process.pid}.db`);
  process.env.HELM_DB_PATH = dbPath;
  const dbs = new DatabaseService(dbPath);
  return {
    dbs,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

describe('B15a DIFFICULTY vertical + L3 exhaustion (R3.14, I6)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
    vi.restoreAllMocks();
  });

  it('vertical climb: implementer L1 DIFFICULTY → L2 primary (grok45), stamp cause=DIFFICULTY', async () => {
    const { dbs, cleanup } = setupDb('helm-b15a-climb-');
    cleanups.push(cleanup);
    new ModelService(dbs);

    const rungSpy = vi.spyOn(EscalationService.prototype, 'resolveRungAndModel');
    const svc = new TierResolutionService(dbs, () => true);
    const res = await svc.resolveVertical('implementer', 'L1');

    expect(res.cause).toBe('DIFFICULTY');
    expect(res.signal_difficulty).toBe('VERTICAL_CLIMB');
    expect(res.terminal).toBe(false);
    expect(res.from_tier).toBe('L1');
    expect(res.to_tier).toBe('L2');
    expect(res.resolved_source).toBe('primary');
    expect(res.resolved_slug).toBe('grok45'); // B12b seed: implementer/L2 primary
    expect(() => assertDifficultyClimbable(res)).not.toThrow();

    const stamps = svc.listInvocations();
    expect(stamps).toHaveLength(1);
    expect(stamps[0].cause).toBe('DIFFICULTY');
    expect(stamps[0].from_tier).toBe('L1');
    expect(stamps[0].to_tier).toBe('L2');
    expect(stamps[0].signal_difficulty).toBe('VERTICAL_CLIMB');
    expect(stamps[0].resolved_slug).toBe('grok45');
    // Studio L1/L2/L3 climb is not the old EscalationService rung ladder.
    expect(rungSpy).not.toHaveBeenCalled();

    dbs.close();
  });

  it('L2→L3 climb lands on L3 primary when available', async () => {
    const { dbs, cleanup } = setupDb('helm-b15a-l2l3-');
    cleanups.push(cleanup);
    new ModelService(dbs);

    const svc = new TierResolutionService(dbs, () => true);
    const res = await svc.resolveVertical('implementer', 'L2');

    expect(res.from_tier).toBe('L2');
    expect(res.to_tier).toBe('L3');
    expect(res.cause).toBe('DIFFICULTY');
    expect(res.terminal).toBe(false);
    expect(res.resolved_slug).toBe('codex55'); // B12b: implementer/L3 primary
    expect(() => assertDifficultyClimbable(res)).not.toThrow();
    dbs.close();
  });

  it('L3 DIFFICULTY terminal: stall difficulty-exhaustion; DIFFICULTY stamp retained; no L4', async () => {
    const { dbs, cleanup } = setupDb('helm-b15a-l3term-');
    cleanups.push(cleanup);
    new ModelService(dbs);

    const rungSpy = vi.spyOn(EscalationService.prototype, 'resolveRungAndModel');
    const svc = new TierResolutionService(dbs, () => true);
    const res = await svc.resolveVertical('implementer', 'L3');

    expect(res.cause).toBe('DIFFICULTY');
    expect(res.signal_difficulty).toBe('L3_EXHAUSTED');
    expect(res.terminal).toBe(true);
    expect(res.from_tier).toBe('L3');
    expect(res.to_tier).toBeNull();
    expect(res.resolved_slug).toBeNull();

    // Stamp retained before stall.
    const stamps = svc.listInvocations();
    expect(stamps).toHaveLength(1);
    expect(stamps[0].cause).toBe('DIFFICULTY');
    expect(stamps[0].signal_difficulty).toBe('L3_EXHAUSTED');
    expect(stamps[0].from_tier).toBe('L3');
    expect(stamps[0].to_tier).toBeNull();

    expect(() => assertDifficultyClimbable(res)).toThrow(ResolveStallError);
    try {
      assertDifficultyClimbable(res);
    } catch (e) {
      expect((e as ResolveStallError).reason).toBe('difficulty-exhaustion');
    }

    // No lateral-as-difficulty and no old rung ladder.
    expect(rungSpy).not.toHaveBeenCalled();
    dbs.close();
  });

  it('R8 / boundary: AVAIL path does not auto-climb; assertDifficultyClimbable no-op on climb; seat guard separate', async () => {
    const { dbs, cleanup } = setupDb('helm-b15a-r8-');
    cleanups.push(cleanup);
    new ModelService(dbs);

    const rungSpy = vi.spyOn(EscalationService.prototype, 'resolveRungAndModel');

    // AVAIL NO_SEAT still does not enter DIFFICULTY path (B14a invariant).
    const lateral = new TierResolutionService(dbs, () => false);
    const noseat = await lateral.resolveLateral('implementer', 'L1');
    expect(noseat.signal_availability).toBe('NO_SEAT');
    expect(lateral.listInvocations()[0].cause).toBe('AVAILABILITY');
    expect(lateral.listInvocations()[0].signal_difficulty).toBeUndefined();
    expect(rungSpy).not.toHaveBeenCalled();
    // Seat exhaustion is B14b; difficulty guard must not fire on AVAIL terminal.
    expect(() => assertSeatAvailable('implementer', noseat)).toThrow(ResolveStallError);
    expect(() =>
      assertDifficultyClimbable({ terminal: false, signal_difficulty: undefined })
    ).not.toThrow();

    dbs.close();
  });
});
