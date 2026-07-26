// v93: per-project planner panel — migration, service round-trip, validation, wiring + backup fallback.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { DatabaseService } from '../db/database.js';
import {
  PlannerPanelService,
  applyBackupFallback,
  buildAdaptivePlannerPanel,
  DEFAULT_PLANNER_EFFORT,
} from './planner-panel-service.js';
import { resolvePanelWithAvailability } from './adaptive-planning-phase.js';
import { ProjectService } from './project-service.js';

function seedModels(dbs: DatabaseService): { a: number; b: number; c: number; d: number } {
  const ins = dbs.raw.prepare(`
    INSERT INTO models (name, provider, model_id, cli, slug, display_name, effort, approval, validation_status)
    VALUES (?, ?, ?, ?, ?, ?, 'medium', 'auto', 'valid')
  `);
  const a = Number(ins.run('pp-lead', 'grok', 'grok-4.5', 'grok', 'pp-lead', 'PP Lead').lastInsertRowid);
  const b = Number(ins.run('pp-member', 'codex', 'gpt-5.3-codex', 'codex', 'pp-member', 'PP Member').lastInsertRowid);
  const c = Number(ins.run('pp-backup1', 'claude', 'claude-opus-4-8', 'claude', 'pp-backup1', 'PP Backup1').lastInsertRowid);
  const d = Number(ins.run('pp-backup2', 'grok', 'grok-composer-2.5-fast', 'grok', 'pp-backup2', 'PP Backup2').lastInsertRowid);
  return { a, b, c, d };
}

describe('planner panel — v93', () => {
  let dbPath: string;
  let dbs: DatabaseService;
  let svc: PlannerPanelService;
  let projects: ProjectService;
  let ids: { a: number; b: number; c: number; d: number };
  let projectId: number;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `helm-pp-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
    dbs = new DatabaseService(dbPath);
    svc = new PlannerPanelService(dbs);
    projects = new ProjectService(dbs);
    ids = seedModels(dbs);
    const p = projects.createProject({ name: `pp-${Date.now()}`, directory: `/tmp/pp-${Date.now()}` });
    projectId = p.id;
  });
  afterEach(() => {
    try { dbs.close(); } catch {}
    try { fs.rmSync(dbPath, { force: true }); } catch {}
  });

  it('v93 migration: project_planner_panel table + planner_default_effort column', () => {
    const tables = dbs.raw.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='project_planner_panel'"
    ).all() as any[];
    expect(tables.length).toBe(1);
    const cols = dbs.raw.prepare('PRAGMA table_info(projects)').all() as any[];
    expect(cols.some((c) => c.name === 'planner_default_effort')).toBe(true);
    expect(dbs.raw.prepare('SELECT MAX(version) v FROM schema_version').get() as any).toMatchObject({ v: 98 });
  });

  it('getConfig returns empty members + default effort when unset', () => {
    const cfg = svc.getConfig(projectId);
    expect(cfg.members).toEqual([]);
    expect(cfg.backups).toEqual([]);
    expect(cfg.default_effort).toBe(DEFAULT_PLANNER_EFFORT);
  });

  it('replaceConfig / getConfig round-trips members, lead, backups, default_effort', () => {
    const saved = svc.replaceConfig(projectId, {
      members: [
        { model_id: ids.a, is_lead: true, effort: 'high' },
        { model_id: ids.b, is_lead: false, effort: null },
      ],
      backups: [{ model_id: ids.c }, { model_id: ids.d }],
      default_effort: 'xhigh',
    });
    expect(saved.default_effort).toBe('xhigh');
    expect(saved.members).toHaveLength(2);
    expect(saved.members[0].is_lead).toBe(true);
    expect(saved.members[0].model_id).toBe(ids.a);
    expect(saved.members[0].effort).toBe('high');
    expect(saved.members[0].model?.provider).toBe('grok');
    expect(saved.members[1].is_lead).toBe(false);
    expect(saved.members[1].model_id).toBe(ids.b);
    expect(saved.backups).toHaveLength(2);
    expect(saved.backups[0].model_id).toBe(ids.c);
    expect(saved.backups[1].model_id).toBe(ids.d);

    const again = svc.getConfig(projectId);
    expect(again).toEqual(saved);

    // Atomic replace — second write drops previous rows
    const next = svc.replaceConfig(projectId, {
      members: [{ model_id: ids.b, is_lead: true }],
      backups: [],
      default_effort: 'low',
    });
    expect(next.members).toHaveLength(1);
    expect(next.backups).toHaveLength(0);
    expect(next.default_effort).toBe('low');
    const count = (dbs.raw.prepare('SELECT COUNT(*) AS c FROM project_planner_panel WHERE project_id = ?').get(projectId) as any).c;
    expect(count).toBe(1);
  });

  it('replaceConfig rejects empty members, zero/many leads, unknown models', () => {
    expect(() => svc.replaceConfig(projectId, { members: [] })).toThrow(/at least one/i);
    expect(() =>
      svc.replaceConfig(projectId, {
        members: [
          { model_id: ids.a, is_lead: false },
          { model_id: ids.b, is_lead: false },
        ],
      })
    ).toThrow(/exactly one/i);
    expect(() =>
      svc.replaceConfig(projectId, {
        members: [
          { model_id: ids.a, is_lead: true },
          { model_id: ids.b, is_lead: true },
        ],
      })
    ).toThrow(/exactly one/i);
    expect(() =>
      svc.replaceConfig(projectId, {
        members: [{ model_id: 999999, is_lead: true }],
      })
    ).toThrow(/unknown model_id/i);
  });

  it('buildPlannerPanel produces PlannerPanel for adaptive inputs', () => {
    svc.replaceConfig(projectId, {
      members: [
        { model_id: ids.a, is_lead: true, effort: 'high' },
        { model_id: ids.b, is_lead: false },
      ],
      backups: [{ model_id: ids.c }],
      default_effort: 'med',
    });
    const panel = svc.buildPlannerPanel(projectId);
    expect(panel).toBeTruthy();
    expect(panel!.size).toBe(2);
    expect(panel!.leadModel).toBe('grok-4.5');
    expect(panel!.leadProvider).toBe('grok');
    expect(panel!.memberModels).toEqual(['grok-4.5', 'gpt-5.3-codex']);
    expect(panel!.memberProviders).toEqual(['grok', 'codex']);
    // lead override high; non-lead inherits panel default_effort med
    expect(panel!.memberEfforts).toEqual(['high', 'med']);
    expect(panel!.backups).toEqual([{ model: 'claude-opus-4-8', provider: 'claude' }]);
    expect(panel!.defaultEffort).toBe('med');
  });

  it('buildPlannerPanel returns null when no members configured', () => {
    expect(svc.buildPlannerPanel(projectId)).toBeNull();
  });

  it('applyBackupFallback selects the next available backup when a member is down', () => {
    const members = [
      { provider: 'grok', model: 'grok-4.5', modelRowId: 1, effort: 'high' as const },
      { provider: 'codex', model: 'gpt-5.3-codex', modelRowId: 2, effort: 'med' as const },
    ];
    const backups = [
      { provider: 'claude', model: 'claude-opus-4-8', modelRowId: 3 },
      { provider: 'grok', model: 'grok-composer-2.5-fast', modelRowId: 4 },
    ];
    // Primary lead unavailable → first backup
    const down = new Set(['grok/grok-4.5']);
    const seats = applyBackupFallback(members, backups, down);
    expect(seats[0].fromBackup).toBe(true);
    expect(seats[0].model).toBe('claude-opus-4-8');
    expect(seats[0].provider).toBe('claude');
    expect(seats[1].fromBackup).toBe(false);
    expect(seats[1].model).toBe('gpt-5.3-codex');

    const panel = buildAdaptivePlannerPanel(seats, { leadIndex: 0 });
    expect(panel.leadModel).toBe('claude-opus-4-8');
    expect(panel.memberModels).toEqual(['claude-opus-4-8', 'gpt-5.3-codex']);
  });

  it('applyBackupFallback with predicate skips already-used backups', () => {
    const members = [
      { provider: 'a', model: 'm1', modelRowId: 1, effort: 'low' as const },
      { provider: 'b', model: 'm2', modelRowId: 2, effort: 'low' as const },
    ];
    const backups = [
      { provider: 'c', model: 'b1', modelRowId: 3 },
      { provider: 'd', model: 'b2', modelRowId: 4 },
    ];
    const isDown = (p: string, m: string) => m === 'm1' || m === 'm2';
    const seats = applyBackupFallback(members, backups, isDown);
    expect(seats.map((s) => s.model)).toEqual(['b1', 'b2']);
    expect(seats.every((s) => s.fromBackup)).toBe(true);
  });

  it('resolvePanelWithAvailability (async) swaps unavailable member for backup', async () => {
    const panel = {
      size: 2,
      leadModel: 'grok-4.5',
      leadProvider: 'grok',
      memberModels: ['grok-4.5', 'gpt-5.3-codex'],
      memberProviders: ['grok', 'codex'],
      backups: [
        { model: 'claude-opus-4-8', provider: 'claude' },
        { model: 'grok-composer-2.5-fast', provider: 'grok' },
      ],
      defaultEffort: 'med',
    };
    const resolved = await resolvePanelWithAvailability(panel, async (provider, model) => {
      // simulate seat-binary: grok CLI missing for lead
      if (provider === 'grok' && model === 'grok-4.5') return false;
      return true;
    });
    expect(resolved.memberModels![0]).toBe('claude-opus-4-8');
    expect(resolved.memberProviders![0]).toBe('claude');
    expect(resolved.leadModel).toBe('claude-opus-4-8');
    expect(resolved.leadProvider).toBe('claude');
    expect(resolved.memberModels![1]).toBe('gpt-5.3-codex');
  });

  it('buildPlannerPanel applies sync unavailable set (service-level fallback)', () => {
    svc.replaceConfig(projectId, {
      members: [
        { model_id: ids.a, is_lead: true },
        { model_id: ids.b, is_lead: false },
      ],
      backups: [{ model_id: ids.c }],
      default_effort: 'med',
    });
    const panel = svc.buildPlannerPanel(projectId, new Set(['grok/grok-4.5']));
    expect(panel!.leadModel).toBe('claude-opus-4-8');
    expect(panel!.memberModels).toEqual(['claude-opus-4-8', 'gpt-5.3-codex']);
  });
});
