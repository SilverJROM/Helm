/**
 * B14a — R3.13/R3.15/I6 lateral AVAILABILITY resolve + always-on invocation stamps.
 * Happy AS_INTENDED emits; primary-down lateral failover to backup; both-down NO_SEAT stops
 * (no DIFFICULTY climb, B15a territory); backup-less validator seat NO_SEAT is not a crash;
 * emit path fires on every branch.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService } from './db/database.js';
import { ModelService } from './services/model-service.js';
import { RoleTierService } from './services/role-tier-service.js';
import { EscalationService } from './services/escalation-service.js';
import { TierResolutionService } from './services/tier-resolution-service.js';

function tempDbPath(prefix: string): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(dir, `helm-test-${process.pid}.db`);
  return {
    dbPath,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

function setupDb(prefix: string): { dbs: DatabaseService; cleanup: () => void } {
  const t = tempDbPath(prefix);
  process.env.HELM_DB_PATH = t.dbPath;
  const dbs = new DatabaseService(t.dbPath);
  return { dbs, cleanup: t.cleanup };
}

describe('B14a tier-resolution-service (lateral AVAILABILITY)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
    vi.restoreAllMocks();
  });

  it('happy path: primary available emits exactly one AS_INTENDED invocation record', async () => {
    const { dbs, cleanup } = setupDb('helm-b14a-happy-');
    cleanups.push(cleanup);
    new ModelService(dbs); // seed models

    const svc = new TierResolutionService(dbs, () => true);
    const res = await svc.resolveLateral('implementer', 'L3');

    expect(res.signal_availability).toBe('AS_INTENDED');
    expect(res.resolved_source).toBe('primary');
    expect(res.resolved_slug).toBe('codex55'); // B12b seed: implementer/L3 primary
    expect(svc.listInvocations()).toHaveLength(1);
    expect(svc.listInvocations()[0].signal_availability).toBe('AS_INTENDED');
    dbs.close();
  });

  it('primary unavailable: lateral failover to backup, stamped LATERAL_FAILOVER', async () => {
    const { dbs, cleanup } = setupDb('helm-b14a-lateral-');
    cleanups.push(cleanup);
    new ModelService(dbs);

    const svc = new TierResolutionService(dbs, (slug) => slug !== 'codex55');
    const res = await svc.resolveLateral('implementer', 'L3');

    expect(res.signal_availability).toBe('LATERAL_FAILOVER');
    expect(res.resolved_source).toBe('backup');
    expect(res.resolved_slug).toBe('sonnet5'); // B12b seed: implementer/L3 backup
    expect(svc.listInvocations()).toHaveLength(1);
    dbs.close();
  });

  it('both primary and backup unavailable: NO_SEAT, and never escalates DIFFICULTY (B15a territory)', async () => {
    const { dbs, cleanup } = setupDb('helm-b14a-noseat-');
    cleanups.push(cleanup);
    new ModelService(dbs);

    const spy = vi.spyOn(EscalationService.prototype, 'resolveRungAndModel');
    const svc = new TierResolutionService(dbs, () => false);
    const res = await svc.resolveLateral('implementer', 'L3');

    expect(res.signal_availability).toBe('NO_SEAT');
    expect(res.resolved_slug).toBeNull();
    expect(res.resolved_source).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    expect(svc.listInvocations()).toHaveLength(1);
    dbs.close();
  });

  it('negative control: the prototype spy fires when a DIFFICULTY climb is invoked, proving case 3 is failable', () => {
    const spy = vi.spyOn(EscalationService.prototype, 'resolveRungAndModel');
    const escalation = new EscalationService();
    escalation.resolveRungAndModel({ role: 'implementer' });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('backup-less validator seat (L3 = opus, no backup): primary down is NO_SEAT, not a crash', async () => {
    const { dbs, cleanup } = setupDb('helm-b14a-nobackup-');
    cleanups.push(cleanup);
    new ModelService(dbs);
    const roleTiers = new RoleTierService(dbs);
    expect(roleTiers.getRoleTier('validator', 'L3')!.backup_model_id).toBeNull();

    const svc = new TierResolutionService(dbs, () => false);
    const res = await svc.resolveLateral('validator', 'L3');

    expect(res.signal_availability).toBe('NO_SEAT');
    expect(res.resolved_slug).toBeNull();
    dbs.close();
  });

  it('emit path fires on every resolve, across all three signal branches', async () => {
    const { dbs, cleanup } = setupDb('helm-b14a-emitcount-');
    cleanups.push(cleanup);
    new ModelService(dbs);

    const seen: string[] = [];
    const svc = new TierResolutionService(dbs, () => true);
    svc.onInvocation((stamp) => seen.push(stamp.signal_availability!));

    await svc.resolveLateral('implementer', 'L1'); // AS_INTENDED

    const svcLateral = new TierResolutionService(dbs, (slug) => slug !== 'grokcompose');
    svcLateral.onInvocation((stamp) => seen.push(stamp.signal_availability!));
    await svcLateral.resolveLateral('implementer', 'L1'); // LATERAL_FAILOVER (backup spark)

    const svcStall = new TierResolutionService(dbs, () => false);
    svcStall.onInvocation((stamp) => seen.push(stamp.signal_availability!));
    await svcStall.resolveLateral('implementer', 'L1'); // NO_SEAT

    expect(seen).toEqual(['AS_INTENDED', 'LATERAL_FAILOVER', 'NO_SEAT']);
    dbs.close();
  });
});
