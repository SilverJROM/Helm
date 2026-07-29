/**
 * S05 — PlanningStaffingService ACs 19–22, 24.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { DatabaseService } from './db/database.js';
import { ProjectService } from './services/project-service.js';
import { AgentAssignmentService } from './services/agent-assignment-service.js';
import { PlannerPanelService } from './services/planner-panel-service.js';
import {
  PlanningStaffingEmptyError,
  PlanningStaffingMismatchError,
  PlanningStaffingService,
  computeManifestDigest,
  buildManifestDigestPayload,
  corePlanningPanelSizeTotal,
  toCorePlanningStaffingArgs,
} from './services/planning-staffing-service.js';

function seedModel(
  dbs: DatabaseService,
  name: string,
  provider: string,
  modelId: string,
  displayName: string
): number {
  const r = dbs.raw
    .prepare(
      `INSERT INTO models (name, provider, model_id, cli, slug, display_name, effort, approval, validation_status)
       VALUES (?, ?, ?, ?, ?, ?, 'medium', 'auto', 'valid')`
    )
    .run(name, provider, modelId, provider, name, displayName);
  return Number(r.lastInsertRowid);
}

describe('S05 PlanningStaffingService', () => {
  let dbPath: string;
  let dbs: DatabaseService;
  let projects: ProjectService;
  let assignments: AgentAssignmentService;
  let panel: PlannerPanelService;
  let staffing: PlanningStaffingService;
  let projectId: number;
  let opusId: number;
  let codexId: number;
  let backupId: number;
  let gpt55Id: number;

  beforeEach(() => {
    dbPath = path.join(
      os.tmpdir(),
      `helm-s05-${process.pid}-${Math.random().toString(36).slice(2)}.db`
    );
    dbs = new DatabaseService(dbPath);
    projects = new ProjectService(dbs);
    assignments = new AgentAssignmentService(dbs);
    panel = new PlannerPanelService(dbs);
    staffing = new PlanningStaffingService(dbs, assignments, panel);

    const p = projects.createProject({
      name: `s05-${Date.now()}`,
      directory: path.join(os.tmpdir(), `s05-proj-${Date.now()}`),
    });
    projectId = p.id;

    // Ensure adaptive OFF (core path) — createProject default is 0
    dbs.raw.prepare('UPDATE projects SET adaptive_planning = 0 WHERE id = ?').run(projectId);

    opusId = seedModel(dbs, 'Opus5', 'claude', 'claude-opus-4-8', 'Opus5');
    codexId = seedModel(dbs, 'Codex56Sol', 'codex', 'gpt-5.3-codex', 'Codex56Sol');
    backupId = seedModel(dbs, 'BackupClaude', 'claude', 'claude-sonnet-4', 'BackupClaude');
    gpt55Id = seedModel(dbs, 'gpt-5.5-generic', 'codex', 'gpt-5.5', 'gpt-5.5');
  });

  afterEach(() => {
    try {
      dbs.close();
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(dbPath, { force: true });
    } catch {
      /* ignore */
    }
  });

  it('AC19/21: adaptive=0 resolves Opus5+Codex56Sol co-planners + separate plancore; excludes generic gpt-5.5 planner', () => {
    // Configured panel (memory_mcp-shaped: two co-planners)
    panel.replaceConfig(projectId, {
      members: [
        { model_id: opusId, is_lead: true, effort: 'high' },
        { model_id: codexId, is_lead: false, effort: 'med' },
      ],
      backups: [],
      default_effort: 'med',
    });

    // Bind generic planner worker to gpt-5.5 — must NOT appear as a co-planner seat
    const plannerAgent = dbs.raw
      .prepare(
        `INSERT INTO agents (name, provider, model, default_effort, definition_md, spawn_pref, agent_type)
         VALUES ('generic-planner-gpt55', 'codex', 'gpt-5.5', 'med', '# planner', 'tmux', 'project')
         RETURNING id`
      )
      .get() as { id: number };
    assignments.setProjectBinding(projectId, 'planner', plannerAgent.id);

    // Distinct plancore binding
    const plancoreAgent = dbs.raw
      .prepare(
        `INSERT INTO agents (name, provider, model, default_effort, definition_md, spawn_pref, agent_type)
         VALUES ('s05-plancore-seat', 'grok', 'grok-4.5', 'high', '# plancore', 'tmux', 'project')
         RETURNING id`
      )
      .get() as { id: number };
    assignments.setProjectBinding(projectId, 'plancore', plancoreAgent.id);

    const m = staffing.resolveManifest(projectId);

    expect(m.adaptivePlanning).toBe(false);
    expect(m.plancore.role).toBe('plancore');
    expect(m.plancore.source).toBe('phase-owner');
    expect(m.plancore.model).toBe('grok-4.5');
    expect(m.plancore.provider).toBe('grok');

    expect(m.coPlanners).toHaveLength(2);
    expect(m.coPlanners.map((s) => s.model)).toEqual(['claude-opus-4-8', 'gpt-5.3-codex']);
    expect(m.coPlanners.map((s) => s.model)).not.toContain('gpt-5.5');
    expect(m.coPlanners.every((s) => s.source === 'primary')).toBe(true);
    expect(m.coPlanners.every((s) => s.ready)).toBe(true);
    expect(m.blocked).toBe(false);

    // Three seats total: plancore + 2 co-planners
    expect(m.panelMemberCount).toBe(2);
    expect(m.planningPanelSize).toBe(2);
    expect(m.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('AC20: save N members writes planning_panel_size=N transactionally; mismatch blocks', () => {
    const saved = panel.replaceConfig(projectId, {
      members: [
        { model_id: opusId, is_lead: true },
        { model_id: codexId, is_lead: false },
        { model_id: backupId, is_lead: false },
      ],
      default_effort: 'med',
    });
    expect(saved.members).toHaveLength(3);

    const row = dbs.raw
      .prepare('SELECT planning_panel_size FROM projects WHERE id = ?')
      .get(projectId) as { planning_panel_size: number };
    expect(row.planning_panel_size).toBe(3);

    // Forced mismatch: panel still 3 members, size forced to 1
    dbs.raw.prepare('UPDATE projects SET planning_panel_size = 1 WHERE id = ?').run(projectId);
    expect(() => staffing.resolveManifest(projectId)).toThrow(PlanningStaffingMismatchError);

    // Empty panel (delete rows) with size still set → empty typed block
    dbs.raw.prepare('DELETE FROM project_planner_panel WHERE project_id = ?').run(projectId);
    dbs.raw.prepare('UPDATE projects SET planning_panel_size = 2 WHERE id = ?').run(projectId);
    expect(() => staffing.resolveManifest(projectId)).toThrow(PlanningStaffingEmptyError);
  });

  it('AC22/24: configured backup labeled; no-backup unavailable stays blocked; digest stable then changes', () => {
    panel.replaceConfig(projectId, {
      members: [
        { model_id: opusId, is_lead: true, effort: 'high' },
        { model_id: codexId, is_lead: false, effort: 'med' },
      ],
      backups: [{ model_id: backupId }],
      default_effort: 'med',
    });

    // Primary slot 0 down → backup labeled
    const withBackup = staffing.resolveManifest(projectId, {
      unavailable: new Set(['claude/claude-opus-4-8']),
    });
    expect(withBackup.coPlanners[0].ready).toBe(true);
    expect(withBackup.coPlanners[0].source).toBe('backup for slot 0');
    expect(withBackup.coPlanners[0].model).toBe('claude-sonnet-4');
    expect(withBackup.coPlanners[1].source).toBe('primary');
    expect(withBackup.blocked).toBe(false);

    // Both primaries down, no usable backup for second (backup already used) → slot 1 blocked
    const blocked = staffing.resolveManifest(projectId, {
      unavailable: new Set([
        'claude/claude-opus-4-8',
        'codex/gpt-5.3-codex',
        'claude/claude-sonnet-4',
      ]),
    });
    expect(blocked.blocked).toBe(true);
    expect(blocked.coPlanners.some((s) => !s.ready)).toBe(true);
    expect(blocked.blockReasons.some((r) => /no configured backup/i.test(r))).toBe(true);
    // No invented gpt-5.5
    expect(blocked.coPlanners.every((s) => s.model !== 'gpt-5.5')).toBe(true);

    // Digest: same config/availability → same digest; change availability → different digest
    const a = staffing.resolveManifest(projectId);
    const b = staffing.resolveManifest(projectId);
    expect(a.digest).toBe(b.digest);
    expect(a.digest).not.toBe(withBackup.digest);

    const payload = buildManifestDigestPayload(a);
    expect(computeManifestDigest(payload)).toBe(a.digest);
  });

  it('fix1: core path wiring args — N co-planners → panelSizeTotal N+1; excludes generic planner model', () => {
    expect(corePlanningPanelSizeTotal(2)).toBe(3);
    expect(corePlanningPanelSizeTotal(0)).toBe(1);

    panel.replaceConfig(projectId, {
      members: [
        { model_id: opusId, is_lead: true },
        { model_id: codexId, is_lead: false },
      ],
      default_effort: 'med',
    });
    const plannerAgent = dbs.raw
      .prepare(
        `INSERT INTO agents (name, provider, model, default_effort, definition_md, spawn_pref, agent_type)
         VALUES ('wire-planner-gpt55', 'codex', 'gpt-5.5', 'med', '# p', 'tmux', 'project')
         RETURNING id`
      )
      .get() as { id: number };
    assignments.setProjectBinding(projectId, 'planner', plannerAgent.id);

    const m = staffing.resolveManifest(projectId);
    const args = toCorePlanningStaffingArgs(m);
    expect(args.usedPanel).toBe(true);
    expect(args.panelSizeTotal).toBe(3); // plancore + 2 co-planners
    expect(args.partnerModel).toBe('claude-opus-4-8');
    expect(args.partnerModel).not.toBe('gpt-5.5');
    expect(args.planningBrainModel).toBeTruthy();
    expect(args.blockReasons).toBeUndefined();
  });
});
