/**
 * B14b — R3.17/I7 seat exhaustion, role-agnostic.
 * Primary unavailable AND (backup null OR backup unavailable) -> stall + flag JROM via
 * assertSeatAvailable, fed by TierResolutionService.resolveLateral (B14a). Never climbs onto
 * another role's model: no EscalationService rung climb, no cross-role tier lookup.
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
import { assertSeatAvailable, ResolveStallError } from './db/resolve-time-invariants.js';

function setupDb(prefix: string): { dbs: DatabaseService; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(dir, `helm-test-${process.pid}.db`);
  process.env.HELM_DB_PATH = dbPath;
  const dbs = new DatabaseService(dbPath);
  return { dbs, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } } };
}

describe('B14b seat exhaustion (R3.17, role-agnostic)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
    vi.restoreAllMocks();
  });

  it('fixture (a): implementer dual-unavailable (primary+backup down) -> stalls with seat-exhaustion, no rung climb', async () => {
    const { dbs, cleanup } = setupDb('helm-b14b-impl-dual-');
    cleanups.push(cleanup);
    new ModelService(dbs);

    const rungSpy = vi.spyOn(EscalationService.prototype, 'resolveRungAndModel');
    const tierSpy = vi.spyOn(RoleTierService.prototype, 'getRoleTier');

    const svc = new TierResolutionService(dbs, () => false);
    const res = await svc.resolveLateral('implementer', 'L3');
    expect(res.signal_availability).toBe('NO_SEAT');

    expect(() => assertSeatAvailable('implementer', res)).toThrow(ResolveStallError);
    try {
      assertSeatAvailable('implementer', res);
    } catch (e) {
      expect((e as ResolveStallError).reason).toBe('seat-exhaustion');
    }

    // No difficulty climb, and no lateral peek at another role's tier row.
    expect(rungSpy).not.toHaveBeenCalled();
    expect(tierSpy).toHaveBeenCalledTimes(1);
    expect(tierSpy).toHaveBeenCalledWith('implementer', 'L3');

    dbs.close();
  });

  it('fixture (b): validator L3 has backup=NULL, primary unavailable -> stalls with seat-exhaustion, no cross-role climb', async () => {
    const { dbs, cleanup } = setupDb('helm-b14b-val-nobackup-');
    cleanups.push(cleanup);
    new ModelService(dbs);
    const roleTiers = new RoleTierService(dbs);
    expect(roleTiers.getRoleTier('validator', 'L3')!.backup_model_id).toBeNull();

    const rungSpy = vi.spyOn(EscalationService.prototype, 'resolveRungAndModel');
    const tierSpy = vi.spyOn(RoleTierService.prototype, 'getRoleTier');

    const svc = new TierResolutionService(dbs, () => false);
    const res = await svc.resolveLateral('validator', 'L3');
    expect(res.signal_availability).toBe('NO_SEAT');

    expect(() => assertSeatAvailable('validator', res)).toThrow(ResolveStallError);

    expect(rungSpy).not.toHaveBeenCalled();
    // Only the validator's own tier is consulted, exactly once (by resolveLateral) —
    // never implementer's row. assertSeatAvailable takes the already-resolved signal
    // and never calls back into RoleTierService.
    expect(tierSpy).toHaveBeenCalledTimes(1);
    expect(tierSpy).toHaveBeenCalledWith('validator', 'L3');

    dbs.close();
  });

  it('negative control: assertSeatAvailable is a no-op on AS_INTENDED / LATERAL_FAILOVER (only NO_SEAT stalls)', async () => {
    const { dbs, cleanup } = setupDb('helm-b14b-negctrl-');
    cleanups.push(cleanup);
    new ModelService(dbs);

    const happy = new TierResolutionService(dbs, () => true);
    const resHappy = await happy.resolveLateral('implementer', 'L3');
    expect(() => assertSeatAvailable('implementer', resHappy)).not.toThrow();

    const lateral = new TierResolutionService(dbs, (slug) => slug !== 'codex55');
    const resLateral = await lateral.resolveLateral('implementer', 'L3');
    expect(() => assertSeatAvailable('implementer', resLateral)).not.toThrow();

    dbs.close();
  });
});
