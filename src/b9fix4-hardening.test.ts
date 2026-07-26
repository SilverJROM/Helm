import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService } from './db/database.js';
import { AgentAssignmentService } from './services/agent-assignment-service.js';
import { ProjectAgentService } from './services/project-agent-service.js';

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b9fix4-'));
  const dbPath = path.join(dir, 'test.db');
  return { dbPath, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

describe('B9fix4 resolver hardening (F6/F7/F9)', () => {
  let cleanup: () => void;
  let dbs: DatabaseService;
  let assignment: AgentAssignmentService;
  let pas: ProjectAgentService;
  let pid: number;
  let aid: number;
  let toolkitId: number;
  let modelId: number;
  const studioDefinition = '# Studio persona\nSTUDIO-B9FIX4';

  beforeEach(() => {
    const t = makeTempDb();
    cleanup = t.cleanup;
    dbs = new DatabaseService(t.dbPath);
    assignment = new AgentAssignmentService(dbs);
    pas = new ProjectAgentService(dbs, assignment);

    dbs.raw.prepare("INSERT INTO agents (name, provider, model, default_effort, definition_md) VALUES (?,?,?,?,?)")
      .run('b9fix4-agent', 'claude', 'claude-opus-4-8', 'medium', studioDefinition);
    dbs.raw.prepare("INSERT INTO models (name, provider, model_id, cli, slug, display_name, effort) VALUES (?,?,?,?,?,?,?)")
      .run('b9fix4-model', 'claude', 'claude-sonnet-4-6', 'claude', 'b9fix4-model', 'b9fix4-model', 'medium');
    dbs.raw.prepare("INSERT INTO toolkits (name, description, body_md) VALUES (?,?,?)")
      .run('b9fix4-tk', null, 'Toolkit body');

    aid = (dbs.raw.prepare("SELECT id FROM agents WHERE name='b9fix4-agent'").get() as any).id;
    modelId = (dbs.raw.prepare("SELECT id FROM models WHERE name='b9fix4-model'").get() as any).id;
    toolkitId = (dbs.raw.prepare("SELECT id FROM toolkits WHERE name='b9fix4-tk'").get() as any).id;

    dbs.raw.prepare("INSERT INTO projects (name, directory) VALUES (?,?)").run('B9fix4-proj', '/tmp/b9fix4');
    pid = (dbs.raw.prepare("SELECT id FROM projects WHERE name='B9fix4-proj'").get() as any).id;
    pas.addAgent(pid, aid);
  });

  afterEach(() => cleanup());

  it('F6: blank definition_md_override in DB inherits Studio persona at read time', () => {
    dbs.raw.prepare("UPDATE project_agents SET definition_md_override = ? WHERE project_id = ? AND agent_id = ?")
      .run('', pid, aid);

    const effective = assignment.resolveProjectAgent(pid, aid);
    expect(effective?.definition_md).toBe(studioDefinition);
    expect(effective?.overrides.definition_md_override).toBeNull();
  });

  it('F6: whitespace-only definition_md_override in DB inherits Studio persona at read time', () => {
    dbs.raw.prepare("UPDATE project_agents SET definition_md_override = ? WHERE project_id = ? AND agent_id = ?")
      .run('   \n\t  ', pid, aid);

    const effective = assignment.resolveProjectAgent(pid, aid);
    expect(effective?.definition_md).toBe(studioDefinition);
    expect(effective?.overrides.definition_md_override).toBeNull();
  });

  it('F7: setProjectAgentToolkits keeps flag and rows consistent atomically', () => {
    const result = pas.setProjectAgentToolkits(pid, aid, {
      overridden: true,
      toolkits: [{ toolkit_id: toolkitId, position: 1 }]
    });
    expect(result.overridden).toBe(true);
    expect(result.toolkits).toHaveLength(1);

    const flags = dbs.raw.prepare('SELECT toolkits_overridden FROM project_agents WHERE project_id = ? AND agent_id = ?')
      .get(pid, aid) as any;
    const rowCount = (dbs.raw.prepare('SELECT COUNT(*) as c FROM project_agent_toolkits WHERE project_id = ? AND agent_id = ?')
      .get(pid, aid) as any).c;
    expect(flags.toolkits_overridden).toBe(1);
    expect(rowCount).toBe(1);
  });

  it('F7: listProjectAgents does not call resolveProjectAgent per row', () => {
    const spy = vi.spyOn(assignment, 'resolveProjectAgent');
    const rows = pas.listProjectAgents(pid);
    expect(rows).toHaveLength(1);
    expect(rows[0].effective.effort).toBe('medium');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('F9: list omits persona text and exposes has_persona_override + lean scalar effective', () => {
    const projectDefinition = '# Project persona\nPROJECT-B9FIX4';
    pas.setScalarOverrides(pid, aid, { definition_md_override: projectDefinition });

    const row = pas.listProjectAgents(pid)[0];
    expect('definition_md_override' in row).toBe(false);
    expect(row.has_persona_override).toBe(true);
    expect('definition_md' in row.effective).toBe(false);
    expect('definition_md_override' in row.effective.overrides).toBe(false);
    expect(assignment.resolveProjectAgent(pid, aid)?.definition_md).toBe(projectDefinition);
  });

  it('F9: list has_persona_override false when inheriting Studio persona', () => {
    const row = pas.listProjectAgents(pid)[0];
    expect(row.has_persona_override).toBe(false);
    expect('definition_md' in row.effective).toBe(false);
    expect(assignment.resolveProjectAgent(pid, aid)?.definition_md).toBe(studioDefinition);
  });
});