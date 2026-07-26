/**
 * B15c — R3.15 Telemetry UI Reading B (M2+M5).
 * Denom = unique resolve_id final impl L3; bucket = tier-entry cause; seat separate.
 * Fixtures use real resolve path (resolveVertical / resolveLateral), not hand-inserted rows.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService } from './db/database.js';
import { ModelService } from './services/model-service.js';
import { TierResolutionService } from './services/tier-resolution-service.js';
import { aggregateImplL3Invocations } from './services/impl-l3-telemetry.js';

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

describe('B15c Telemetry Reading B (R3.15 M2+M5)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
    vi.restoreAllMocks();
  });

  it('scenario1: DIFFICULTY(L2→L3)+AVAIL(L3 p→b) = one L3 inv, bucket DIFFICULTY, seat=backup', async () => {
    const { dbs, cleanup } = setupDb('helm-b15c-s1-');
    cleanups.push(cleanup);
    new ModelService(dbs);

    // Mutable availability: vertical lands on L3 primary; then primary goes down for lateral.
    const down = new Set<string>();
    const svc = new TierResolutionService(dbs, (slug) => !down.has(slug));

    svc.beginResolve('chain-diff-then-avail');
    const vert = await svc.resolveVertical('implementer', 'L2');
    expect(vert.to_tier).toBe('L3');
    expect(vert.resolved_source).toBe('primary');
    expect(vert.resolved_slug).toBe('codex55');

    down.add('codex55'); // L3 primary unavailable → lateral to backup
    const lat = await svc.resolveLateral('implementer', 'L3');
    expect(lat.signal_availability).toBe('LATERAL_FAILOVER');
    expect(lat.resolved_source).toBe('backup');
    expect(lat.resolved_slug).toBe('sonnet5');
    svc.endResolve();

    const stamps = svc.listInvocations();
    expect(stamps).toHaveLength(2);
    expect(stamps.every((s) => s.resolve_id === 'chain-diff-then-avail')).toBe(true);
    expect(stamps.map((s) => s.seq)).toEqual([0, 1]);
    expect(stamps[0].cause).toBe('DIFFICULTY');
    expect(stamps[1].cause).toBe('AVAILABILITY');

    const view = aggregateImplL3Invocations(stamps);
    expect(view.denominator).toBe(1);
    expect(view.buckets.DIFFICULTY).toBe(1);
    expect(view.buckets.AVAILABILITY).toBe(0);
    expect(view.invocations).toHaveLength(1);
    expect(view.invocations[0].cause).toBe('DIFFICULTY');
    expect(view.invocations[0].seat).toBe('backup');
    expect(view.invocations[0].resolved_slug).toBe('sonnet5');
    expect(view.invocations[0].record_count).toBe(2);
  });

  it('scenario2: plain AVAIL L3-on-backup no vertical = one L3 inv, bucket AVAILABILITY', async () => {
    const { dbs, cleanup } = setupDb('helm-b15c-s2-');
    cleanups.push(cleanup);
    new ModelService(dbs);

    const svc = new TierResolutionService(dbs, (slug) => slug !== 'codex55');
    svc.beginResolve('chain-avail-only');
    const lat = await svc.resolveLateral('implementer', 'L3');
    expect(lat.signal_availability).toBe('LATERAL_FAILOVER');
    expect(lat.resolved_source).toBe('backup');
    svc.endResolve();

    const view = aggregateImplL3Invocations(svc.listInvocations());
    expect(view.denominator).toBe(1);
    expect(view.buckets.AVAILABILITY).toBe(1);
    expect(view.buckets.DIFFICULTY).toBe(0);
    expect(view.invocations[0].cause).toBe('AVAILABILITY');
    expect(view.invocations[0].seat).toBe('backup');
    expect(view.invocations[0].record_count).toBe(1);
  });

  it('COUPLING validator stamps do not inflate impl DIFFICULTY / denom', async () => {
    const { dbs, cleanup } = setupDb('helm-b15c-coupling-');
    cleanups.push(cleanup);
    new ModelService(dbs);

    const svc = new TierResolutionService(dbs, () => true);
    svc.beginResolve('chain-with-coupling');
    await svc.resolveVertical('implementer', 'L2'); // impl L3 DIFFICULTY
    await svc.resolveCoupledValidator('L2', 'L3'); // val COUPLING — must not count
    svc.endResolve();

    const view = aggregateImplL3Invocations(svc.listInvocations());
    expect(view.denominator).toBe(1);
    expect(view.buckets.DIFFICULTY).toBe(1);
    expect(view.buckets.COUPLING).toBe(0);
    expect(view.invocations[0].cause).toBe('DIFFICULTY');
    expect(view.invocations[0].seat).toBe('primary');
  });

  it('raw record count must not become denominator (M2: multi-record chain = one inv)', async () => {
    const { dbs, cleanup } = setupDb('helm-b15c-m2-');
    cleanups.push(cleanup);
    new ModelService(dbs);

    const down = new Set<string>();
    const svc = new TierResolutionService(dbs, (slug) => !down.has(slug));
    svc.beginResolve('m2-chain');
    await svc.resolveVertical('implementer', 'L2');
    down.add('codex55');
    await svc.resolveLateral('implementer', 'L3');
    svc.endResolve();

    const stamps = svc.listInvocations().filter((s) => s.role === 'implementer' && s.tier === 'L3');
    expect(stamps.length).toBe(2); // two L3 *records*
    const view = aggregateImplL3Invocations(svc.listInvocations());
    expect(view.denominator).toBe(1); // one *invocation*
    // If we wrongly bucketed final-record cause → AVAILABILITY; M5 requires DIFFICULTY
    expect(view.buckets.DIFFICULTY + view.buckets.AVAILABILITY + view.buckets.AS_INTENDED).toBe(
      view.denominator
    );
    expect(view.buckets.DIFFICULTY).toBe(1);
  });
});
