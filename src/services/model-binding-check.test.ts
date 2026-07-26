import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { findModelBindingDivergences, warnModelBindingDivergences } from './model-binding-check.js';

// Minimal schema mirroring the three binding layers.
function seed(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE models (id INTEGER PRIMARY KEY, model_id TEXT);
    CREATE TABLE agents (id INTEGER PRIMARY KEY, name TEXT, model TEXT, default_model_id INTEGER);
    CREATE TABLE project_agents (id INTEGER PRIMARY KEY, project_id INTEGER, agent_id INTEGER, model_id INTEGER);
    INSERT INTO models (id, model_id) VALUES (1,'gpt-5.3-codex-spark'),(2,'grok-4.5'),(3,'claude-sonnet-5');
  `);
  return db;
}

describe('#48 findModelBindingDivergences', () => {
  let db: Database.Database;
  beforeEach(() => { db = seed(); });
  afterEach(() => db.close());

  it('flags the exact bug: default_model_id set to spark but project_agents governs grok', () => {
    // agents.model=grok-4.5, default_model_id=spark(1); project override = grok-4.5(2)
    db.prepare("INSERT INTO agents (id,name,model,default_model_id) VALUES (1,'implementer','grok-4.5',1)").run();
    db.prepare("INSERT INTO project_agents (project_id,agent_id,model_id) VALUES (1,1,2)").run();
    const d = findModelBindingDivergences(db);
    expect(d).toHaveLength(1);
    expect(d[0].governs).toBe('grok-4.5');
    expect(d[0].governsLayer).toBe('project_agents.model_id');
    expect(d[0].ignored).toEqual(expect.arrayContaining([{ layer: 'agents.default_model_id', model: 'gpt-5.3-codex-spark' }]));
  });

  it('no divergence when all layers agree', () => {
    db.prepare("INSERT INTO agents (id,name,model,default_model_id) VALUES (1,'validator','grok-4.5',2)").run();
    db.prepare("INSERT INTO project_agents (project_id,agent_id,model_id) VALUES (1,1,2)").run();
    expect(findModelBindingDivergences(db)).toHaveLength(0);
  });

  it('no project override → agents.model governs; a disagreeing default_model_id is flagged', () => {
    db.prepare("INSERT INTO agents (id,name,model,default_model_id) VALUES (1,'plancore','grok-4.5',1)").run();
    db.prepare("INSERT INTO project_agents (project_id,agent_id,model_id) VALUES (1,1,NULL)").run();
    const d = findModelBindingDivergences(db);
    expect(d).toHaveLength(1);
    expect(d[0].governsLayer).toBe('agents.model');
    expect(d[0].governs).toBe('grok-4.5');
  });

  it('warnModelBindingDivergences returns the count and emits a clear message', () => {
    db.prepare("INSERT INTO agents (id,name,model,default_model_id) VALUES (1,'implementer','grok-4.5',1)").run();
    db.prepare("INSERT INTO project_agents (project_id,agent_id,model_id) VALUES (1,1,2)").run();
    const msgs: string[] = [];
    const n = warnModelBindingDivergences(db, (m) => msgs.push(m));
    expect(n).toBe(1);
    expect(msgs[0]).toMatch(/GOVERNS the launch/);
    expect(msgs[0]).toMatch(/Edit project_agents.model_id/);
  });

  it('empty on a thin fixture without the tables', () => {
    const bare = new Database(':memory:');
    expect(findModelBindingDivergences(bare)).toHaveLength(0);
    bare.close();
  });
});
