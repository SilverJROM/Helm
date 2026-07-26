/**
 * B15b — R3.14 / I7.2 validator COUPLING: impl DIFFICULTY vertical -> val couples to same
 * tier, val cause=COUPLING. Re-runs the B15x val-collision fixture with coupling layered on
 * top (must still fail-closed per I7). No B15c UI, no orchestrator wiring.
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
import { assertNoValCollision, assertSeatAvailable, ResolveStallError } from './db/resolve-time-invariants.js';

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

function modelId(dbs: DatabaseService, slug: string): number {
  const row = dbs.prepare('SELECT id FROM models WHERE slug = ?').get(slug) as { id: number } | undefined;
  if (!row) throw new Error(`fixture setup: missing seeded model ${slug}`);
  return row.id;
}

describe('B15b validator COUPLING (R3.14, I7.2)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
    vi.restoreAllMocks();
  });

  it('impl L2->L3 DIFFICULTY vertical couples validator to L3, cause=COUPLING (not DIFFICULTY)', async () => {
    const { dbs, cleanup } = setupDb('helm-b15b-couple-');
    cleanups.push(cleanup);
    new ModelService(dbs);

    const svc = new TierResolutionService(dbs, () => true);
    const impl = await svc.resolveVertical('implementer', 'L2');
    expect(impl.terminal).toBe(false);
    expect(impl.to_tier).toBe('L3');
    expect(impl.resolved_slug).toBe('codex55'); // B12b: implementer/L3 primary

    const val = await svc.resolveCoupledValidator('L2', impl.to_tier as 'L3');
    expect(val.tier).toBe('L3');
    expect(val.resolved_slug).toBe('opus4.8'); // B12b: validator/L3 primary
    expect(() => assertNoValCollision(impl.resolved_slug, val.resolved_slug)).not.toThrow();

    const stamps = svc.listInvocations();
    expect(stamps).toHaveLength(2);
    expect(stamps[1].role).toBe('validator');
    expect(stamps[1].cause).toBe('COUPLING');
    expect(stamps[1].from_tier).toBe('L2');
    expect(stamps[1].to_tier).toBe('L3');
    expect(stamps[1].signal_difficulty).toBeUndefined(); // coupling never inflates impl DIFFICULTY (M5)
  });

  it('coupled val stamp is cause=COUPLING even when the seat pick would otherwise read AS_INTENDED', async () => {
    const { dbs, cleanup } = setupDb('helm-b15b-cause-');
    cleanups.push(cleanup);
    new ModelService(dbs);

    const svc = new TierResolutionService(dbs, () => true);
    const val = await svc.resolveCoupledValidator('L1', 'L2');

    expect(val.signal_availability).toBe('AS_INTENDED'); // seat pick itself hit primary cleanly
    expect(svc.listInvocations()[0].cause).toBe('COUPLING'); // but the stamped cause is COUPLING, not AS_INTENDED
  });

  it('B15x re-fixture w/ coupling ON: forced same-tier primary collision still fail-closed (val-collision)', async () => {
    const { dbs, cleanup } = setupDb('helm-b15b-collision-');
    cleanups.push(cleanup);
    new ModelService(dbs);
    const roleTiers = new RoleTierService(dbs);

    // Real B12b seeds never collide (impl/val primaries differ at every tier) — force the
    // collision the way B13's save-time guard does NOT catch (it only guards impl *backup*
    // vs same-tier val model, never impl *primary* vs val *primary* — see role-tier-invariants.ts).
    roleTiers.updateRoleTier('validator', 'L3', { primary_model_id: modelId(dbs, 'codex55') });

    const svc = new TierResolutionService(dbs, () => true);
    const impl = await svc.resolveVertical('implementer', 'L2');
    expect(impl.resolved_slug).toBe('codex55');

    const val = await svc.resolveCoupledValidator('L2', impl.to_tier as 'L3');
    expect(val.resolved_slug).toBe('codex55'); // forced collision via coupling

    expect(() => assertNoValCollision(impl.resolved_slug, val.resolved_slug)).toThrow(ResolveStallError);
    try {
      assertNoValCollision(impl.resolved_slug, val.resolved_slug);
    } catch (e) {
      expect((e as ResolveStallError).reason).toBe('val-collision');
    }

    // Coupling stamp is still emitted before the caller-side I7 guard stalls (audit trail intact).
    const stamps = svc.listInvocations();
    expect(stamps[1].cause).toBe('COUPLING');
    expect(stamps[1].resolved_slug).toBe('codex55');
  });

  it('coupled validator NO_SEAT still enforced by B14b assertSeatAvailable (coupling does not bypass R3.17)', async () => {
    const { dbs, cleanup } = setupDb('helm-b15b-noseat-');
    cleanups.push(cleanup);
    new ModelService(dbs);

    const svc = new TierResolutionService(dbs, () => false); // primary+backup both unavailable
    const val = await svc.resolveCoupledValidator('L2', 'L3');

    expect(val.signal_availability).toBe('NO_SEAT');
    expect(svc.listInvocations()[0].cause).toBe('COUPLING');
    expect(() => assertSeatAvailable('validator', val)).toThrow(ResolveStallError);
  });

  it('no rung-ladder / no auto-escalation from a coupled resolve', async () => {
    const { dbs, cleanup } = setupDb('helm-b15b-r8-');
    cleanups.push(cleanup);
    new ModelService(dbs);

    const rungSpy = vi.spyOn(EscalationService.prototype, 'resolveRungAndModel');
    const svc = new TierResolutionService(dbs, () => true);
    await svc.resolveCoupledValidator('L1', 'L2');

    expect(rungSpy).not.toHaveBeenCalled();
  });
});
