// v93: planner-panel REST validation (service-level; routes map errors 400/404).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { DatabaseService } from '../../db/database.js';
import { PlannerPanelService } from '../../services/planner-panel-service.js';
import { ProjectService } from '../../services/project-service.js';

describe('planner-panel API validation (service contract)', () => {
  let dbPath: string;
  let dbs: DatabaseService;
  let svc: PlannerPanelService;
  let projects: ProjectService;
  let projectId: number;
  let modelA: number;
  let modelB: number;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `helm-pp-api-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
    dbs = new DatabaseService(dbPath);
    svc = new PlannerPanelService(dbs);
    projects = new ProjectService(dbs);
    const p = projects.createProject({ name: `ppa-${Date.now()}`, directory: `/tmp/ppa-${Date.now()}` });
    projectId = p.id;
    const ins = dbs.raw.prepare(`
      INSERT INTO models (name, provider, model_id, cli, slug, display_name, effort, approval, validation_status)
      VALUES (?, ?, ?, ?, ?, ?, 'medium', 'auto', 'valid')
    `);
    modelA = Number(ins.run('api-a', 'grok', 'grok-4.5', 'grok', 'api-a', 'A').lastInsertRowid);
    modelB = Number(ins.run('api-b', 'codex', 'gpt-5.3', 'codex', 'api-b', 'B').lastInsertRowid);
  });
  afterEach(() => {
    try { dbs.close(); } catch {}
    try { fs.rmSync(dbPath, { force: true }); } catch {}
  });

  it('PUT contract: ≥1 member required', () => {
    expect(() => svc.replaceConfig(projectId, { members: [] as any })).toThrow(/at least one/i);
  });

  it('PUT contract: exactly one lead', () => {
    expect(() =>
      svc.replaceConfig(projectId, {
        members: [
          { model_id: modelA, is_lead: false },
          { model_id: modelB, is_lead: false },
        ],
      })
    ).toThrow(/exactly one/i);
  });

  it('GET after PUT returns members + backups + default_effort shape', () => {
    svc.replaceConfig(projectId, {
      members: [
        { model_id: modelA, is_lead: true, effort: 'low' },
        { model_id: modelB, is_lead: false },
      ],
      backups: [{ model_id: modelB }],
      default_effort: 'high',
    });
    const cfg = svc.getConfig(projectId);
    expect(cfg).toMatchObject({
      default_effort: 'high',
      members: [
        expect.objectContaining({ model_id: modelA, is_lead: true, effort: 'low' }),
        expect.objectContaining({ model_id: modelB, is_lead: false }),
      ],
      backups: [expect.objectContaining({ model_id: modelB })],
    });
    expect(cfg.members[0].model).toMatchObject({ provider: 'grok', model_id: 'grok-4.5' });
  });

  it('unknown project throws', () => {
    expect(() => svc.getConfig(999999)).toThrow(/unknown project/i);
  });
});
