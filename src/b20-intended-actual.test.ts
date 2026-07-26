/**
 * B20 — R5.23 Intended vs actual: structural reason required; multi-cause via resolve_id;
 * M3: real COUPLING reason row from B15b resolveCoupledValidator path (not hand-inserted).
 * B20-fix1: comparison-driven diff; SEAT_CHANGED on post-freeze seat re-point.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService } from './db/database.js';
import { SCHEMA_VERSION } from './db/schema.js';
import { ModelService } from './services/model-service.js';
import { ProjectService } from './services/project-service.js';
import { CycleService } from './services/cycle-service.js';
import { TopologyFreezeService } from './services/topology-freeze-service.js';
import { RoleTierService } from './services/role-tier-service.js';
import { TierResolutionService } from './services/tier-resolution-service.js';
import { IntendedActualService } from './services/intended-actual-service.js';

function setup(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(dir, `helm-test-${process.pid}.db`);
  process.env.HELM_DB_PATH = dbPath;
  const dbs = new DatabaseService(dbPath);
  const projects = new ProjectService(dbs);
  const cycles = new CycleService(dbs, projects);
  const freezes = new TopologyFreezeService(dbs);
  const intended = new IntendedActualService(dbs);
  const models = new ModelService(dbs);
  const roleTiers = new RoleTierService(dbs);
  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}proj-`));
  return {
    dbs,
    projects,
    cycles,
    freezes,
    intended,
    models,
    roleTiers,
    projDir,
    cleanup: () => {
      try {
        dbs.close();
      } catch {
        /* ignore */
      }
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      try {
        fs.rmSync(projDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

async function freezeCycle(s: ReturnType<typeof setup>, name: string) {
  const project = s.projects.createProject({ name, directory: s.projDir });
  const cycle = await s.cycles.createCycle(
    project.id,
    'C1',
    undefined,
    undefined,
    () => new Date('2026-07-10T12:00:00Z')
  );
  s.cycles.setCyclePhase(cycle.id, 'implementation');
  const freeze = s.freezes.getFreeze(cycle.id);
  expect(freeze).toBeTruthy();
  return { project, cycle, freeze: freeze! };
}

describe('B20 intended vs actual (R5.23)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('fresh DB lands SCHEMA_VERSION ≥74 with cycle_team_deltas + reason NOT NULL + SEAT_CHANGED', () => {
    const s = setup('helm-b20-schema-');
    cleanups.push(s.cleanup);

    const ver = (s.dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version;
    expect(ver).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(74);

    const table = s.dbs.raw
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='cycle_team_deltas'`)
      .get();
    expect(table).toBeTruthy();

    const sql = (
      s.dbs.raw
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='cycle_team_deltas'`)
        .get() as any
    ).sql as string;
    expect(sql).toMatch(/reason\s+TEXT\s+NOT\s+NULL/i);
    expect(sql).toMatch(/COUPLING/);
    expect(sql).toMatch(/SEAT_CHANGED/);
  });

  it('structural reject-without-reason: INSERT omitting reason throws', async () => {
    const s = setup('helm-b20-null-reason-');
    cleanups.push(s.cleanup);
    const { cycle } = await freezeCycle(s, 'b20-null');

    expect(() => {
      s.dbs.raw
        .prepare(
          `INSERT INTO cycle_team_deltas
            (cycle_id, resolve_id, seq, role, intended_tier, actual_tier, intended_slug, actual_slug)
           VALUES (?, 'r1', 0, 'implementer', 'L2', 'L3', 'grok45', 'codex55')`
        )
        .run(cycle.id);
    }).toThrow();
  });

  it('service rejects empty/null reason before write', async () => {
    const s = setup('helm-b20-svc-reason-');
    cleanups.push(s.cleanup);
    const { cycle } = await freezeCycle(s, 'b20-svc-reason');

    expect(() =>
      s.intended.insertDelta(cycle.id, {
        resolve_id: 'x',
        seq: 0,
        role: 'implementer',
        intended_tier: 'L2',
        actual_tier: 'L3',
        intended_slug: 'a',
        actual_slug: 'b',
        reason: '' as any,
      })
    ).toThrow(/reason required/i);

    expect(() =>
      s.intended.insertDelta(cycle.id, {
        resolve_id: 'x',
        seq: 0,
        role: 'implementer',
        intended_tier: 'L2',
        actual_tier: 'L3',
        reason: null as any,
      })
    ).toThrow(/reason required/i);

    expect(() =>
      s.intended.insertDelta(cycle.id, {
        resolve_id: 'x',
        seq: 0,
        role: 'implementer',
        intended_tier: 'L2',
        actual_tier: 'L3',
        reason: 'AS_INTENDED' as any,
      })
    ).toThrow(/reason/i);
  });

  it('M3 COUPLING fixture: real resolveVertical + resolveCoupledValidator → multi-cause chain', async () => {
    const s = setup('helm-b20-coupling-');
    cleanups.push(s.cleanup);
    const { cycle } = await freezeCycle(s, 'b20-coupling');

    const resolve = new TierResolutionService(s.dbs, () => true);
    resolve.beginResolve('fixture-r523-coupling');
    const impl = await resolve.resolveVertical('implementer', 'L2');
    expect(impl.terminal).toBe(false);
    expect(impl.to_tier).toBe('L3');
    const val = await resolve.resolveCoupledValidator('L2', impl.to_tier as 'L3');
    expect(val.tier).toBe('L3');
    resolve.endResolve();

    const stamps = resolve.listInvocations();
    expect(stamps).toHaveLength(2);
    expect(stamps.every((x) => x.resolve_id === 'fixture-r523-coupling')).toBe(true);
    expect(stamps[0].cause).toBe('DIFFICULTY');
    expect(stamps[1].cause).toBe('COUPLING');
    expect(stamps[1].role).toBe('validator');

    const deltas = s.intended.recordFromStamps(cycle.id, stamps);
    expect(deltas).toHaveLength(2);

    const implDelta = deltas.find((d) => d.role === 'implementer')!;
    const valDelta = deltas.find((d) => d.role === 'validator')!;
    expect(implDelta.reason).toBe('DIFFICULTY');
    expect(implDelta.intended_tier).toBe('L2');
    expect(implDelta.actual_tier).toBe('L3');
    expect(implDelta.resolve_id).toBe('fixture-r523-coupling');

    expect(valDelta.reason).toBe('COUPLING');
    expect(valDelta.intended_tier).toBe('L2');
    expect(valDelta.actual_tier).toBe('L3');
    expect(valDelta.resolve_id).toBe('fixture-r523-coupling');
    expect(valDelta.actual_slug).toBe('opus5'); // B12b validator/L3 primary

    const chains = s.intended.multiCauseChains(deltas);
    expect(chains).toHaveLength(1);
    expect(chains[0].distinct_reason_count).toBeGreaterThanOrEqual(2);
    expect(chains[0].reasons).toEqual(['DIFFICULTY', 'COUPLING']);
  });

  it('AS_INTENDED and actual==intended yields zero deltas', async () => {
    const s = setup('helm-b20-as-intended-');
    cleanups.push(s.cleanup);
    const { cycle } = await freezeCycle(s, 'b20-as-intended');

    const resolve = new TierResolutionService(s.dbs, () => true);
    await resolve.resolveLateral('implementer', 'L2');
    const stamps = resolve.listInvocations();
    expect(stamps).toHaveLength(1);
    expect(stamps[0].cause).toBe('AS_INTENDED');
    // Happy path: resolved seat matches freeze — no deviation, no row.
    const freeze = s.freezes.getFreeze(cycle.id)!;
    const intendedSeat = freeze.snapshot.role_tiers.find(
      (r: any) => r.role === 'implementer' && r.tier === 'L2'
    )!;
    expect(stamps[0].resolved_slug).toBe(intendedSeat.primary_model_slug);

    const deltas = s.intended.recordFromStamps(cycle.id, stamps);
    expect(deltas).toHaveLength(0);
  });

  it('post-freeze seat re-point: AS_INTENDED + actual≠intended → SEAT_CHANGED delta', async () => {
    // Inverted redteam (B20-F1): previously asserted 0 deltas for this scenario (vacuous R5.23).
    // Now must emit exactly one SEAT_CHANGED row with freeze intended vs live actual.
    const s = setup('helm-b20-seat-changed-');
    cleanups.push(s.cleanup);
    const { cycle, freeze } = await freezeCycle(s, 'b20-seat-changed');

    const intendedSeat = freeze.snapshot.role_tiers.find(
      (r: any) => r.role === 'implementer' && r.tier === 'L2'
    )!;
    const intendedSlug = intendedSeat.primary_model_slug as string;
    expect(intendedSlug).toBeTruthy();

    const other = s.dbs.raw
      .prepare(`SELECT id, slug FROM models WHERE slug != ? ORDER BY id LIMIT 1`)
      .get(intendedSlug) as { id: number; slug: string };
    expect(other).toBeTruthy();
    s.roleTiers.updateRoleTier('implementer', 'L2', { primary_model_id: other.id });

    const tier = new TierResolutionService(s.dbs, () => true);
    tier.clearInvocations();
    const res = await tier.resolveLateral('implementer', 'L2');
    const stamps = tier.listInvocations();
    expect(stamps).toHaveLength(1);
    expect(res.resolved_slug).toBe(other.slug);
    expect(res.resolved_slug).not.toBe(intendedSlug);
    expect(stamps[0].cause).toBe('AS_INTENDED');

    const deltas = s.intended.recordFromStamps(cycle.id, stamps);
    expect(deltas).toHaveLength(1);
    expect(deltas[0].reason).toBe('SEAT_CHANGED');
    expect(deltas[0].intended_slug).toBe(intendedSlug);
    expect(deltas[0].actual_slug).toBe(other.slug);
    expect(deltas[0].role).toBe('implementer');
    expect(deltas[0].intended_tier).toBe('L2');
    expect(deltas[0].actual_tier).toBe('L2');
    expect(s.intended.listDeltas(cycle.id)).toHaveLength(1);
  });

  it('recordFromStamps without freeze throws NO_FREEZE', async () => {
    const s = setup('helm-b20-nofreeze-');
    cleanups.push(s.cleanup);
    const project = s.projects.createProject({ name: 'b20-nf', directory: s.projDir });
    const cycle = await s.cycles.createCycle(
      project.id,
      'C1',
      undefined,
      undefined,
      () => new Date('2026-07-10T12:00:00Z')
    );
    // still planning — no freeze
    expect(s.freezes.getFreeze(cycle.id)).toBeNull();

    const resolve = new TierResolutionService(s.dbs, () => true);
    await resolve.resolveVertical('implementer', 'L2');

    expect(() => s.intended.recordFromStamps(cycle.id, resolve.listInvocations())).toThrow(
      /no topology freeze/i
    );
  });

  it('v73→v74 migration widens reason CHECK with SEAT_CHANGED', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b20-mig74-'));
    const dbPath = path.join(dir, 'mig.db');
    cleanups.push(() => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });

    process.env.HELM_DB_PATH = dbPath;
    const dbs = new DatabaseService(dbPath);
    expect(
      (dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version
    ).toBe(SCHEMA_VERSION);
    // Simulate pre-v74: rebuild table with old CHECK (no SEAT_CHANGED), version=73
    dbs.raw.pragma('foreign_keys = OFF');
    dbs.raw.exec(`
DROP TABLE IF EXISTS cycle_team_deltas;
CREATE TABLE cycle_team_deltas (
  id INTEGER PRIMARY KEY,
  cycle_id INTEGER NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
  resolve_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('implementer','validator')),
  intended_tier TEXT NOT NULL,
  actual_tier TEXT NOT NULL,
  intended_slug TEXT,
  actual_slug TEXT,
  reason TEXT NOT NULL CHECK(reason IN ('AVAILABILITY','DIFFICULTY','COUPLING')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(cycle_id, resolve_id, seq)
);
`);
    dbs.raw.prepare('UPDATE schema_version SET version = 73').run();
    dbs.raw.pragma('foreign_keys = ON');
    dbs.close();

    const dbs2 = new DatabaseService(dbPath);
    const ver = (dbs2.raw.prepare('SELECT version FROM schema_version').get() as any).version;
    expect(ver).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(74);
    const sql = (
      dbs2.raw
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='cycle_team_deltas'`)
        .get() as any
    ).sql as string;
    expect(sql).toMatch(/SEAT_CHANGED/);
    // SEAT_CHANGED insert must succeed after migration (FK off — no cycle row required)
    dbs2.raw.pragma('foreign_keys = OFF');
    dbs2.raw
      .prepare(
        `INSERT INTO cycle_team_deltas
          (cycle_id, resolve_id, seq, role, intended_tier, actual_tier, intended_slug, actual_slug, reason)
         VALUES (1, 'mig', 0, 'implementer', 'L2', 'L2', 'grok45', 'claude-opus', 'SEAT_CHANGED')`
      )
      .run();
    dbs2.close();
  });

  it('v72→v74 migration creates cycle_team_deltas with SEAT_CHANGED', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b20-mig-'));
    const dbPath = path.join(dir, 'mig.db');
    cleanups.push(() => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });

    process.env.HELM_DB_PATH = dbPath;
    const dbs = new DatabaseService(dbPath);
    expect(
      (dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version
    ).toBe(SCHEMA_VERSION);
    dbs.raw.exec(`DROP TABLE IF EXISTS cycle_team_deltas`);
    dbs.raw.prepare('UPDATE schema_version SET version = 72').run();
    dbs.close();

    // Re-open: v73 creates table, v74 widens CHECK → SCHEMA_VERSION
    const dbs2 = new DatabaseService(dbPath);
    const ver = (dbs2.raw.prepare('SELECT version FROM schema_version').get() as any).version;
    expect(ver).toBe(SCHEMA_VERSION);
    const table = dbs2.raw
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='cycle_team_deltas'`)
      .get();
    expect(table).toBeTruthy();
    const sql = (
      dbs2.raw
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='cycle_team_deltas'`)
        .get() as any
    ).sql as string;
    expect(sql).toMatch(/SEAT_CHANGED/);
    dbs2.close();
  });
});
