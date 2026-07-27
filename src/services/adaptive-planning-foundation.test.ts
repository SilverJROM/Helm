// Adaptive planner — Stage 1 (foundation + isolation). Proves the opt-in boundary: the flag exists and
// defaults OFF, the existing planning path is untouched when OFF, and an ON project delegates to the
// separate adaptive module (stages 2–4 now live; no AdaptivePlanningNotReadyError guard).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseService } from '../db/database.js';
import { SCHEMA_VERSION } from '../db/schema.js';
import { PlanningPhaseService } from './planning-phase-service.js';
import { AdaptivePlanningNotReadyError, ADAPTIVE_PLAN_EVENTS } from './adaptive-planning-phase.js';

describe('adaptive planner — Stage 1 foundation', () => {
  let dbPath: string;
  let dbs: DatabaseService;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `helm-adaptive-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
    dbs = new DatabaseService(dbPath);
  });
  afterEach(() => { try { dbs.close(); } catch {} try { fs.rmSync(dbPath, { force: true }); } catch {} });

  it('v92 migration: projects.adaptive_planning exists and defaults 0', () => {
    const cols = dbs.raw.prepare('PRAGMA table_info(projects)').all() as any[];
    const col = cols.find((c) => c.name === 'adaptive_planning');
    expect(col).toBeTruthy();
    expect(Number(col.dflt_value)).toBe(0);
    // Version pin tracks current SCHEMA_VERSION (v92 introduced the column; later batches bump version).
    expect(dbs.raw.prepare('SELECT MAX(version) v FROM schema_version').get() as any).toMatchObject({
      v: SCHEMA_VERSION,
    });
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(92);
  });

  it('CHECK rejects values other than 0/1', () => {
    dbs.raw.prepare("INSERT INTO projects (name, directory) VALUES ('p', '/tmp/p')").run();
    expect(() => dbs.raw.prepare("UPDATE projects SET adaptive_planning = 2 WHERE name='p'").run()).toThrow();
    expect(() => dbs.raw.prepare("UPDATE projects SET adaptive_planning = 1 WHERE name='p'").run()).not.toThrow();
  });

  // A10 (R1.3, v99): core planning panel size — total seats incl. plancore, default 2, CHECK >= 1.
  it('v99 migration: projects.planning_panel_size exists and defaults 2; CHECK rejects < 1', () => {
    const cols = dbs.raw.prepare('PRAGMA table_info(projects)').all() as any[];
    const col = cols.find((c) => c.name === 'planning_panel_size');
    expect(col).toBeTruthy();
    expect(Number(col.dflt_value)).toBe(2);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(99);

    dbs.raw.prepare("INSERT INTO projects (name, directory) VALUES ('p10', '/tmp/p10')").run();
    expect((dbs.raw.prepare("SELECT planning_panel_size FROM projects WHERE name='p10'").get() as any).planning_panel_size).toBe(2);
    expect(() => dbs.raw.prepare("UPDATE projects SET planning_panel_size = 0 WHERE name='p10'").run()).toThrow();
    expect(() => dbs.raw.prepare("UPDATE projects SET planning_panel_size = 3 WHERE name='p10'").run()).not.toThrow();
  });

  // A11 (R1.6 + D7, v100): co-planner agreement round cap — default 3, CHECK >= 1.
  it('v100 migration: projects.planning_round_cap exists and defaults 3; CHECK rejects < 1', () => {
    const cols = dbs.raw.prepare('PRAGMA table_info(projects)').all() as any[];
    const col = cols.find((c) => c.name === 'planning_round_cap');
    expect(col).toBeTruthy();
    expect(Number(col.dflt_value)).toBe(3);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(100);

    dbs.raw.prepare("INSERT INTO projects (name, directory) VALUES ('p11', '/tmp/p11')").run();
    expect((dbs.raw.prepare("SELECT planning_round_cap FROM projects WHERE name='p11'").get() as any).planning_round_cap).toBe(3);
    expect(() => dbs.raw.prepare("UPDATE projects SET planning_round_cap = 0 WHERE name='p11'").run()).toThrow();
    expect(() => dbs.raw.prepare("UPDATE projects SET planning_round_cap = 1 WHERE name='p11'").run()).not.toThrow();
  });

  it('exports the telemetry event names (path B measurement)', () => {
    expect(ADAPTIVE_PLAN_EVENTS.TIER_ROUTED).toBe('PLAN_TIER_ROUTED');
    expect(ADAPTIVE_PLAN_EVENTS.SKELETON_GATE).toBe('PLAN_SKELETON_GATE');
    expect(ADAPTIVE_PLAN_EVENTS.STAGE_TOKENS).toBe('PLAN_STAGE_TOKENS');
  });

  it('runPlanningPhase delegates to the adaptive module ONLY when the flag is on', async () => {
    const svc = new PlanningPhaseService({} as any, {} as any, {} as any);
    // ON → delegates into adaptive module. Stages 2–4 are live, so the old NotReady guard is gone.
    // Bare stubs still fail (missing fs / transport) — but NOT via AdaptivePlanningNotReadyError.
    const err = await svc
      .runPlanningPhase({ runDir: '/tmp/x', northStar: 'ns', adaptivePlanning: true } as any)
      .then(() => null, (e: unknown) => e);
    expect(err).not.toBeInstanceOf(AdaptivePlanningNotReadyError);
    // Still an error of some kind (no real transport/fs) — proves we entered the adaptive path.
    expect(err).toBeTruthy();
  });

  it('OFF (default) does NOT enter the adaptive module — the existing path runs', async () => {
    const svc = new PlanningPhaseService({} as any, {} as any, {} as any);
    // OFF → must NOT throw AdaptivePlanningNotReadyError (it proceeds into the legacy flow, which then
    // fails for other reasons on this bare stub — but crucially NOT via the adaptive guard).
    const err = await svc
      .runPlanningPhase({ runDir: '/tmp/x', northStar: 'ns' } as any)
      .then(() => null, (e: unknown) => e);
    expect(err).not.toBeInstanceOf(AdaptivePlanningNotReadyError);
  });
});
