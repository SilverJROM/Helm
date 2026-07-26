/**
 * B2 / AC-13 — agents.model TEXT fallback + source enum on resolve + list.
 * When only agents.model is set (no default_model_id, no project override),
 * resolved name is that concrete string with source `inherited` (not unknown/default).
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService } from './db/database.js';
import { AgentAssignmentService } from './services/agent-assignment-service.js';
import { ProjectAgentService } from './services/project-agent-service.js';

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

describe('B2 AC-13 agents.model TEXT fallback + source', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('ONLY agents.model set → resolve + list: concrete name + source inherited (not unknown/default)', () => {
    const t = tempDbPath('helm-b2-model-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);
    const assignment = new AgentAssignmentService(dbs);
    const pas = new ProjectAgentService(dbs, assignment);

    // Panelist-like: launch TEXT only, no default_model_id, no project override.
    dbs.raw
      .prepare(
        `INSERT INTO agents (name, provider, model, default_effort, spawn_pref, agent_type, classification, default_model_id)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(
        'b2-panelist-like',
        'claude',
        'claude-sonnet-4-6',
        'medium',
        'tmux',
        'project',
        'solo',
        null
      );
    const agent = dbs.raw
      .prepare("SELECT id, model, default_model_id FROM agents WHERE name = 'b2-panelist-like'")
      .get() as { id: number; model: string; default_model_id: number | null };
    expect(agent.default_model_id).toBeNull();
    expect(agent.model).toBe('claude-sonnet-4-6');

    dbs.raw.prepare('INSERT INTO projects (name, directory) VALUES (?,?)').run('B2-proj', '/tmp/b2');
    const project = dbs.raw.prepare("SELECT id FROM projects WHERE name = 'B2-proj'").get() as {
      id: number;
    };
    pas.addAgent(project.id, agent.id);

    const effective = assignment.resolveProjectAgent(project.id, agent.id);
    expect(effective).not.toBeNull();
    expect(effective!.model.type).toBe('inherited');
    expect(effective!.model.source).toBe('inherited');
    expect(effective!.model.name).toBe('claude-sonnet-4-6');
    expect(effective!.model.model_id).toBe('claude-sonnet-4-6');
    expect(effective!.model.id).toBeNull();
    expect(effective!.model.provider).toBe('claude');

    const list = pas.listProjectAgents(project.id);
    expect(list).toHaveLength(1);
    const row = list[0];
    expect(row.resolved.type).toBe('inherited');
    expect(row.resolved.source).toBe('inherited');
    expect(row.resolved.name).toBe('claude-sonnet-4-6');
    expect(row.effective.model.type).toBe('inherited');
    expect(row.effective.model.source).toBe('inherited');
    expect(row.effective.model.name).toBe('claude-sonnet-4-6');
    expect(row.effective.model.model_id).toBe('claude-sonnet-4-6');

    // default_model_id still wins over agents.model TEXT (type stays 'default' for back-compat)
    dbs.raw
      .prepare(
        `INSERT INTO models (name, provider, model_id, cli, slug, display_name, effort)
         VALUES (?,?,?,?,?,?,?)`
      )
      .run('b2-def', 'claude', 'claude-haiku-4-6', 'claude', 'b2-def', 'b2-def', 'low');
    const def = dbs.raw.prepare("SELECT id FROM models WHERE name = 'b2-def'").get() as { id: number };
    dbs.raw.prepare('UPDATE agents SET default_model_id = ? WHERE id = ?').run(def.id, agent.id);

    const withDefault = assignment.resolveProjectAgent(project.id, agent.id)!;
    expect(withDefault.model.type).toBe('default');
    expect(withDefault.model.source).toBe('inherited');
    expect(withDefault.model.name).toBe('b2-def');
    expect(withDefault.model.id).toBe(def.id);

    dbs.close();
  });
});
