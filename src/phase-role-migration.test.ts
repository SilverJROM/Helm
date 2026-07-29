import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROVIDERS, PROVIDER_ROLES } from './config/providers.js';
import { DatabaseService } from './db/database.js';
import {
  SCHEMA_VERSION,
  V89_IBRAIN_DEFINITION_MD,
  V89_KNOWN_CANONICAL_PLANCORE_HASHES,
  V89_PLANCORE_DEFINITION_MD,
  V110_DISCOVERY_ALLOWED_STATUSES,
  V110_DISCOVERY_DEFINITION_MD,
  V110_DISCOVERY_REQUIRED_ARTIFACTS,
  V110_DISCOVERY_TERMINAL_STATUSES,
  V110_KNOWN_STALE_DISCOVERY_HASHES,
} from './db/schema.js';
import { createHash } from 'node:crypto';
import { AGENT_ROLES } from './guardrails.js';
import { ProjectService } from './services/project-service.js';

const V90_ROLES = [
  'discovery',
  'plancore',
  'ibrain',
  'coord',
  'implementer',
  'validator',
  'deliberation',
  'red-team',
  'planner',
  'routine-implementer',
  'panelist',
] as const;

const tempDirs: string[] = [];

function tempDbPath(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `helm-v90-${label}-`));
  tempDirs.push(dir);
  return path.join(dir, 'helm.db');
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function checkRoles(db: Database.Database, table: string): string[] {
  const row = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name = ?"
  ).get(table) as { sql: string };
  const match = /CHECK\s*\(role\s+IN\s*\(([^)]*)\)\)/i.exec(row.sql);
  if (!match) throw new Error(`missing role CHECK on ${table}`);
  return match[1].split(',').map((value) => value.trim().replace(/^'|'$/g, ''));
}

function createLegacyPhaseRoleDb(
  dbPath: string,
  version: 85 | 88,
  customPrompt = '# CUSTOM PLANCORE',
  runtimeState = 'running',
): void {
  const db = new Database(dbPath);
  const oldDiscoveryName = version < 87 ? 'north' : 'discovery';
  const oldPlancoreName = version < 87 ? 'projcore' : 'plancore';
  db.exec(`
CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
INSERT INTO schema_version (version) VALUES (${version});

CREATE TABLE agents (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  default_effort TEXT NOT NULL DEFAULT 'medium',
  definition_md TEXT,
  default_model_id INTEGER,
  backup_model_id INTEGER,
  spawn_pref TEXT NOT NULL DEFAULT 'tmux',
  in_development INTEGER NOT NULL DEFAULT 0,
  agent_type TEXT NOT NULL DEFAULT 'project',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE projects (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  directory TEXT NOT NULL,
  projcore_session TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE project_agents (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL,
  agent_id INTEGER NOT NULL,
  model_id INTEGER,
  use_dynamic INTEGER NOT NULL DEFAULT 0,
  backup_model_id INTEGER,
  effort_override TEXT,
  spawn_pref_override TEXT,
  disabled_override INTEGER,
  definition_md_override TEXT,
  toolkits_overridden INTEGER NOT NULL DEFAULT 0,
  escalations_overridden INTEGER NOT NULL DEFAULT 0,
  is_primary_driver INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, agent_id)
);

CREATE TABLE role_bindings (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('projcore','coord','implementer','validator','deliberation','red-team','planner','routine-implementer','panelist')),
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, role, agent_id)
);

CREATE TABLE role_defaults (
  role TEXT PRIMARY KEY CHECK(role IN ('projcore','coord','implementer','validator','deliberation','red-team','planner','routine-implementer','panelist')),
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE role_capabilities (
  role TEXT PRIMARY KEY CHECK(role IN ('projcore','coord','implementer','validator','deliberation','red-team','planner','routine-implementer','panelist')),
  allowed_statuses TEXT NOT NULL,
  terminal_statuses TEXT NOT NULL,
  can_write_code INTEGER NOT NULL DEFAULT 0,
  requires_repro_first INTEGER NOT NULL DEFAULT 0,
  panel_participant INTEGER NOT NULL DEFAULT 0,
  can_escalate INTEGER NOT NULL DEFAULT 0,
  session_policy TEXT NOT NULL DEFAULT 'fresh',
  required_artifacts TEXT,
  timeout_ms INTEGER,
  checkin_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE master_runtimes (
  project_id INTEGER PRIMARY KEY,
  master_run_id TEXT NOT NULL,
  tmux_session TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  state TEXT NOT NULL,
  strict_read_allow TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE runs (
  id INTEGER PRIMARY KEY,
  project_id INTEGER,
  status TEXT NOT NULL,
  phase TEXT NOT NULL
);

CREATE TABLE run_events (
  id INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL,
  batch_id TEXT,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);
  if (version === 85) {
    db.exec('ALTER TABLE master_runtimes RENAME TO master_runtimes_with_v86_column');
    db.exec(`
CREATE TABLE master_runtimes (
  project_id INTEGER PRIMARY KEY,
  master_run_id TEXT NOT NULL,
  tmux_session TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
DROP TABLE master_runtimes_with_v86_column;
`);
  }
  db.prepare(`
INSERT INTO agents (id, name, provider, model, default_effort, definition_md, spawn_pref)
VALUES (1, ?, 'claude', 'claude-opus-4-8', 'high', '# discovery', 'tmux')
`).run(oldDiscoveryName);
  db.prepare(`
INSERT INTO agents (id, name, provider, model, default_effort, definition_md, spawn_pref)
VALUES (2, ?, 'claude', 'claude-opus-4-8', 'high', ?, 'tmux')
`).run(oldPlancoreName, customPrompt);
  db.exec(`
INSERT INTO projects (id, name, directory, projcore_session)
VALUES (10, 'cards2', '/tmp/cards2', 'helm-projcore-cards2');
INSERT INTO project_agents (
  project_id, agent_id, model_id, use_dynamic, effort_override, spawn_pref_override
) VALUES (10, 2, 77, 0, 'xhigh', 'in-process');
INSERT INTO role_bindings (project_id, role, agent_id) VALUES (10, 'projcore', 2);
INSERT INTO role_defaults (role, agent_id) VALUES ('projcore', 2);
INSERT INTO role_capabilities (
  role, allowed_statuses, terminal_statuses, can_write_code, can_escalate,
  session_policy, required_artifacts
) VALUES (
  'projcore', '["PLANNING","DECIDING"]', '["PLAN-READY"]', 0, 1,
  'clear+rehydrate', '["plan.md"]'
);
INSERT INTO master_runtimes (project_id, master_run_id, tmux_session, provider, model, state)
VALUES (10, 'run-10', 'helm-projcore-cards2', 'projcore', 'run-projcore', '${runtimeState}');
INSERT INTO runs (id, project_id, status, phase)
VALUES (100, 10, 'active', '${version === 85 ? 'executing' : 'planning'}');
`);
  db.close();
}

function assertV90Safety(db: Database.Database): void {
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  for (const table of ['role_bindings', 'role_defaults', 'role_capabilities']) {
    const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?").pluck().get(table) as string;
    expect(ddl).not.toContain('projcore');
    expect(checkRoles(db, table)).toEqual(V90_ROLES);
    expect(db.prepare(`SELECT COUNT(*) FROM ${table} WHERE role = 'projcore'`).pluck().get()).toBe(0);
  }
  const currentChecks = [
    ["SELECT COUNT(*) FROM plumbing_configs WHERE role = 'projcore'", 'plumbing_configs'],
    ["SELECT COUNT(*) FROM agent_escalations WHERE trigger = 'projcore'", 'agent_escalations'],
    ["SELECT COUNT(*) FROM project_agent_escalations WHERE trigger = 'projcore'", 'project_agent_escalations'],
    ["SELECT COUNT(*) FROM routing_rules WHERE handler_role = 'projcore'", 'routing_rules'],
    ["SELECT COUNT(*) FROM master_runtimes WHERE provider = 'projcore' OR role = 'projcore'", 'master_runtimes'],
  ] as const;
  for (const [sql, table] of currentChecks) {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(table);
    if (exists) expect(db.prepare(sql).pluck().get(), sql).toBe(0);
  }
}

describe.sequential('v90 compatibility-deletion phase-role migration', () => {
  it('fresh v90 exposes exact final CHECKs, role seeds, split prompts, and no retired session column', () => {
    const dbPath = tempDbPath('fresh');
    const dbs = new DatabaseService(dbPath);
    expect(SCHEMA_VERSION).toBe(110);
    expect((dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version).toBe(SCHEMA_VERSION);
    for (const table of ['role_bindings', 'role_defaults', 'role_capabilities']) {
      expect(checkRoles(dbs.raw, table)).toEqual(V90_ROLES);
    }

    expect(AGENT_ROLES).toEqual(V90_ROLES);
    expect(PROVIDER_ROLES).toEqual(V90_ROLES);
    const defaults = dbs.raw.prepare(
      "SELECT role FROM role_defaults WHERE role IN ('discovery','plancore','ibrain') ORDER BY role"
    ).all().map((row: any) => row.role);
    expect(defaults).toEqual(['discovery', 'ibrain', 'plancore']);

    const capabilities = dbs.raw.prepare(
      "SELECT * FROM role_capabilities WHERE role IN ('discovery','plancore','ibrain') ORDER BY role"
    ).all() as any[];
    expect(capabilities.map((row) => row.role)).toEqual(['discovery', 'ibrain', 'plancore']);
    expect(capabilities.find((row) => row.role === 'discovery')).toMatchObject({
      allowed_statuses: V110_DISCOVERY_ALLOWED_STATUSES,
      terminal_statuses: V110_DISCOVERY_TERMINAL_STATUSES,
      can_write_code: 0,
      can_escalate: 0,
      required_artifacts: V110_DISCOVERY_REQUIRED_ARTIFACTS,
    });
    expect(capabilities.find((row) => row.role === 'plancore')).toMatchObject({
      can_write_code: 0,
      can_escalate: 1,
      session_policy: 'clear+rehydrate',
      required_artifacts: '["north-star.md","og-requirements.md","plan.md","decisions/"]',
    });
    expect(capabilities.find((row) => row.role === 'ibrain')).toMatchObject({
      can_write_code: 0,
      can_escalate: 1,
      session_policy: 'clear+rehydrate',
      required_artifacts: '["plan.md","decisions/","failure-history"]',
    });

    const prompts = dbs.raw.prepare(
      "SELECT name, definition_md FROM agents WHERE name IN ('plancore','ibrain') ORDER BY name"
    ).all() as any[];
    expect(prompts.find((row) => row.name === 'plancore').definition_md).toBe(V89_PLANCORE_DEFINITION_MD);
    expect(prompts.find((row) => row.name === 'plancore').definition_md).not.toContain('Phase C');
    expect(prompts.find((row) => row.name === 'ibrain').definition_md).toBe(V89_IBRAIN_DEFINITION_MD);
    expect(V89_KNOWN_CANONICAL_PLANCORE_HASHES.size).toBe(2);

    const project = new ProjectService(dbs).createProject({ name: 'fresh-project', directory: '/tmp/fresh-project' });
    const roster = dbs.raw.prepare(`
      SELECT a.name, pa.model_id, pa.effort_override, pa.spawn_pref_override
      FROM project_agents pa JOIN agents a ON a.id = pa.agent_id
      WHERE pa.project_id = ?
    `).all(project.id) as any[];
    expect(project.plancore_session).toBe('helm-plancore-fresh-project');
    expect(dbs.raw.prepare('PRAGMA table_info(projects)').all().map((column: any) => column.name)).not.toContain('projcore_session');
    // createProject seeds the full project roster (not ibrain alone) so a new project is usable
    // without hand-config; ibrain must still be present with no overrides.
    expect(roster).toContainEqual({ name: 'ibrain', model_id: null, effort_override: null, spawn_pref_override: null });
    expect(roster.every((r: any) => r.model_id === null && r.effort_override === null && r.spawn_pref_override === null)).toBe(true);
    expect(roster.map((r: any) => r.name).sort()).toEqual(
      (dbs.raw.prepare(`
        SELECT name FROM agents
        WHERE (in_development = 0 OR in_development IS NULL)
          AND lower(coalesce(agent_type, 'project')) NOT IN ('house', 'helm')
      `).all() as any[]).map((r: any) => r.name).sort()
    );
    assertV90Safety(dbs.raw);
    dbs.close();
  });

  it('migrates a v85 shape through v90, cleans all three residue tables, and preserves split bindings/roster overrides', () => {
    const dbPath = tempDbPath('v85');
    createLegacyPhaseRoleDb(dbPath, 85);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const dbs = new DatabaseService(dbPath);

    expect((dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version).toBe(SCHEMA_VERSION);
    expect(dbs.raw.prepare("SELECT name FROM agents WHERE id = 1").pluck().get()).toBe('discovery');
    expect(dbs.raw.prepare("SELECT name FROM agents WHERE id = 2").pluck().get()).toBe('plancore');
    expect(dbs.raw.prepare("SELECT definition_md FROM agents WHERE id = 2").pluck().get()).toBe('# CUSTOM PLANCORE');
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/custom plancore definition_md preserved.*sha256=/));

    const bindings = dbs.raw.prepare(
      'SELECT role, agent_id FROM role_bindings WHERE project_id = 10 ORDER BY role'
    ).all() as any[];
    expect(bindings).toEqual([
      { role: 'ibrain', agent_id: 2 },
      { role: 'plancore', agent_id: 2 },
    ]);
    const roster = dbs.raw.prepare(`
      SELECT a.name, pa.model_id, pa.use_dynamic, pa.effort_override, pa.spawn_pref_override
      FROM project_agents pa JOIN agents a ON a.id = pa.agent_id
      WHERE pa.project_id = 10 ORDER BY a.name
    `).all() as any[];
    expect(roster).toEqual([
      { name: 'ibrain', model_id: 77, use_dynamic: 0, effort_override: 'xhigh', spawn_pref_override: 'in-process' },
      { name: 'plancore', model_id: 77, use_dynamic: 0, effort_override: 'xhigh', spawn_pref_override: 'in-process' },
    ]);
    expect(dbs.raw.prepare('SELECT plancore_session FROM projects WHERE id = 10').pluck().get()).toBe('helm-projcore-cards2');
    const runtime = dbs.raw.prepare(
      'SELECT tmux_session, provider, model, role, state FROM master_runtimes WHERE project_id = 10'
    ).get() as any;
    expect(runtime).toEqual({
      tmux_session: 'helm-projcore-cards2',
      provider: 'claude',
      model: 'claude-opus-4-8',
      role: 'ibrain',
      state: 'running',
    });
    const migrationEvent = dbs.raw.prepare(
      "SELECT run_id, event_type, payload_json FROM run_events WHERE event_type = 'V90_MASTER_RUNTIME_TRANSLATED'"
    ).get() as any;
    expect(migrationEvent.run_id).toBe('run-10');
    expect(JSON.parse(migrationEvent.payload_json)).toMatchObject({
      project_id: 10,
      tmux_session: 'helm-projcore-cards2',
      from: { provider: 'projcore', model: 'run-projcore' },
      to: { provider: 'claude', model: 'claude-opus-4-8', role: 'ibrain' },
    });
    assertV90Safety(dbs.raw);
    dbs.close();
  });

  it('migrates a cards2-shaped v88 database and reopens as a no-op', () => {
    const dbPath = tempDbPath('v88');
    createLegacyPhaseRoleDb(dbPath, 88, '');
    const first = new DatabaseService(dbPath);
    expect((first.raw.prepare('SELECT version FROM schema_version').get() as any).version).toBe(SCHEMA_VERSION);
    expect(first.raw.prepare("SELECT definition_md FROM agents WHERE name = 'plancore'").pluck().get()).toBe(V89_PLANCORE_DEFINITION_MD);
    expect(first.raw.prepare('SELECT role FROM master_runtimes WHERE project_id = 10').pluck().get()).toBe('ibrain');
    const before = {
      agents: first.raw.prepare('SELECT COUNT(*) FROM agents').pluck().get(),
      bindings: first.raw.prepare('SELECT COUNT(*) FROM role_bindings').pluck().get(),
      defaults: first.raw.prepare('SELECT COUNT(*) FROM role_defaults').pluck().get(),
      capabilities: first.raw.prepare('SELECT COUNT(*) FROM role_capabilities').pluck().get(),
      roster: first.raw.prepare('SELECT COUNT(*) FROM project_agents').pluck().get(),
    };
    assertV90Safety(first.raw);
    first.close();

    const second = new DatabaseService(dbPath);
    expect({
      agents: second.raw.prepare('SELECT COUNT(*) FROM agents').pluck().get(),
      bindings: second.raw.prepare('SELECT COUNT(*) FROM role_bindings').pluck().get(),
      defaults: second.raw.prepare('SELECT COUNT(*) FROM role_defaults').pluck().get(),
      capabilities: second.raw.prepare('SELECT COUNT(*) FROM role_capabilities').pluck().get(),
      roster: second.raw.prepare('SELECT COUNT(*) FROM project_agents').pluck().get(),
    }).toEqual(before);
    assertV90Safety(second.raw);
    second.close();
  });

  it('prunes an already-terminal legacy projcore runtime and durably records that disposition', () => {
    const dbPath = tempDbPath('terminal-runtime');
    createLegacyPhaseRoleDb(dbPath, 88, '', 'failed');
    const dbs = new DatabaseService(dbPath);

    expect(dbs.raw.prepare('SELECT role FROM master_runtimes WHERE project_id = 10').pluck().get()).toBeUndefined();
    const event = dbs.raw.prepare(
      "SELECT run_id, event_type, payload_json FROM run_events WHERE event_type = 'V90_MASTER_RUNTIME_PRUNED'"
    ).get() as any;
    expect(event.run_id).toBe('run-10');
    expect(JSON.parse(event.payload_json)).toMatchObject({
      project_id: 10,
      state: 'failed',
      reason: 'terminal legacy projcore runtime',
    });
    assertV90Safety(dbs.raw);
    dbs.close();
  });

  it('migrates a consistent copied-live v88 cards2 database to v90 and second-open is idempotent', () => {
    const source = path.resolve('data/cards2-dedicated.db');
    expect(fs.existsSync(source)).toBe(true);
    const dbPath = tempDbPath('copied-live-v88');
    const live = new Database(source, { readonly: true });
    expect(live.prepare('SELECT version FROM schema_version').pluck().get()).toBe(88);
    live.exec(`VACUUM INTO '${dbPath.replace(/'/g, "''")}'`);
    live.close();

    const first = new DatabaseService(dbPath);
    expect(first.raw.prepare('SELECT version FROM schema_version').pluck().get()).toBe(SCHEMA_VERSION);
    assertV90Safety(first.raw);
    const before = first.raw.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name").all();
    first.close();

    const second = new DatabaseService(dbPath);
    expect(second.raw.prepare('SELECT version FROM schema_version').pluck().get()).toBe(SCHEMA_VERSION);
    expect(second.raw.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name").all()).toEqual(before);
    assertV90Safety(second.raw);
    second.close();
  });

  it('removes provider eligibility for the retired role while keeping all split phase roles eligible', () => {
    for (const [provider, definition] of Object.entries(PROVIDERS)) {
      for (const model of definition.models) {
        expect(model.eligibleRoles, `${provider}/${model.model}`).not.toContain('projcore');
      }
    }
    const eligible = Object.values(PROVIDERS).flatMap((definition) => definition.models.flatMap((model) => model.eligibleRoles));
    expect(eligible).toEqual(expect.arrayContaining(['discovery', 'plancore', 'ibrain']));
  });
});

/** Pre-S02 B09a discovery seed (known-stale fingerprint; includes HANDOFF + Planning auth). */
const V109_STALE_DISCOVERY_DEFINITION_MD = `---
role: discovery
kind: project
agent_type: project
lifecycle: per-effort
default_provider: claude
default_model: claude-opus-5
default_effort: high
spawn_pref: tmux
callback_contract: "[helm callback] discovery <run-id> STATUS: <INTERVIEWING|NORTH-STAR-READY|HANDOFF>"
---
# discovery — strategy front-end

Author project/effort north-star, decisions/, og-requirements.md, and topology.yaml.
Interview, thin-context archaeology, stamp Team Topology Contract. Hand off to plancore only on
explicit user cue. You do not implement.
`;

const V109_STALE_NORTH_FRONTMATTER_MD = `---
role: north
kind: project
agent_type: project
lifecycle: per-effort
default_provider: claude
default_model: claude-opus-5
default_effort: high
spawn_pref: tmux
callback_contract: "[helm callback] discovery <run-id> STATUS: <INTERVIEWING|NORTH-STAR-READY|HANDOFF>"
---
# discovery — strategy front-end

Author project/effort north-star, decisions/, og-requirements.md, and topology.yaml.
Interview, thin-context archaeology, stamp Team Topology Contract. Hand off to plancore only on
explicit user cue. You do not implement.
`;

/**
 * Minimal v109-shaped disposable DB for S02 upgrade-path tests.
 * Never touches data/helm.db.
 */
function createV109DiscoveryShapeDb(
  dbPath: string,
  discoveryDefinition: string,
  options?: { discoveryCaps?: { allowed: string; terminal: string; artifacts: string } }
): void {
  const db = new Database(dbPath);
  const caps = options?.discoveryCaps ?? {
    allowed: '["INTERVIEWING","NORTH-STAR-READY","HANDOFF","BLOCKED"]',
    terminal: '["NORTH-STAR-READY","HANDOFF","BLOCKED"]',
    artifacts: '["north-star.md","decisions/"]',
  };
  db.exec(`
CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
INSERT INTO schema_version (version) VALUES (109);

CREATE TABLE agents (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  default_effort TEXT NOT NULL DEFAULT 'medium',
  definition_md TEXT,
  spawn_pref TEXT NOT NULL DEFAULT 'tmux',
  agent_type TEXT NOT NULL DEFAULT 'project',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE role_capabilities (
  role TEXT PRIMARY KEY,
  allowed_statuses TEXT NOT NULL,
  terminal_statuses TEXT NOT NULL,
  can_write_code INTEGER NOT NULL DEFAULT 0,
  requires_repro_first INTEGER NOT NULL DEFAULT 0,
  panel_participant INTEGER NOT NULL DEFAULT 0,
  can_escalate INTEGER NOT NULL DEFAULT 0,
  session_policy TEXT NOT NULL DEFAULT 'fresh',
  required_artifacts TEXT,
  timeout_ms INTEGER,
  checkin_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);
  db.prepare(
    `INSERT INTO agents (id, name, provider, model, default_effort, definition_md, spawn_pref, agent_type)
     VALUES (1, 'discovery', 'claude', 'claude-opus-5', 'high', ?, 'tmux', 'project')`
  ).run(discoveryDefinition);
  db.prepare(
    `INSERT INTO role_capabilities (
       role, allowed_statuses, terminal_statuses, can_write_code, requires_repro_first,
       panel_participant, can_escalate, session_policy, required_artifacts, timeout_ms, checkin_ms
     ) VALUES ('discovery', ?, ?, 0, 0, 0, 0, 'fresh', ?, NULL, NULL)`
  ).run(caps.allowed, caps.terminal, caps.artifacts);
  db.close();
}

describe.sequential('v110 S02 Discovery canonical drift repair', () => {
  it('fresh DB has discovery persona/caps with no HANDOFF or Planning artifact authority', () => {
    const dbPath = tempDbPath('s02-fresh');
    const dbs = new DatabaseService(dbPath);
    expect((dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version).toBe(110);

    const def = dbs.raw.prepare("SELECT definition_md FROM agents WHERE name = 'discovery'").pluck().get() as string;
    expect(def).toBe(V110_DISCOVERY_DEFINITION_MD);
    expect(def).toContain('role: discovery');
    expect(def).not.toMatch(/STATUS:\s*<[^>]*HANDOFF/);
    expect(def).not.toMatch(/Author[^\n]*og-requirements/);
    expect(def).toMatch(/Do NOT author[^\n]*og-requirements\.md/);
    expect(def).toMatch(/Do NOT author[^\n]*plan\.md/);
    expect(def).toContain('north-star.md');
    expect(def).toContain(
      'Initial Discovery docs are ready. May I ask Helm to start the configured Planning team?'
    );

    const caps = dbs.raw.prepare("SELECT * FROM role_capabilities WHERE role = 'discovery'").get() as any;
    expect(caps.allowed_statuses).toBe(V110_DISCOVERY_ALLOWED_STATUSES);
    expect(caps.terminal_statuses).toBe(V110_DISCOVERY_TERMINAL_STATUSES);
    expect(caps.required_artifacts).toBe(V110_DISCOVERY_REQUIRED_ARTIFACTS);
    expect(caps.allowed_statuses).not.toContain('HANDOFF');
    expect(caps.terminal_statuses).not.toContain('HANDOFF');
    dbs.close();
  });

  it('v109-shaped stale discovery (and role:north frontmatter) upgrades to canonical role/status', () => {
    const staleHash = createHash('sha256').update(V109_STALE_DISCOVERY_DEFINITION_MD, 'utf8').digest('hex');
    const northHash = createHash('sha256').update(V109_STALE_NORTH_FRONTMATTER_MD, 'utf8').digest('hex');
    expect(V110_KNOWN_STALE_DISCOVERY_HASHES.has(staleHash)).toBe(true);
    expect(V110_KNOWN_STALE_DISCOVERY_HASHES.has(northHash)).toBe(true);

    for (const [label, body] of [
      ['old-canonical', V109_STALE_DISCOVERY_DEFINITION_MD],
      ['north-frontmatter', V109_STALE_NORTH_FRONTMATTER_MD],
    ] as const) {
      const dbPath = tempDbPath(`s02-stale-${label}`);
      createV109DiscoveryShapeDb(dbPath, body);
      const dbs = new DatabaseService(dbPath);
      expect((dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version).toBe(110);
      const def = dbs.raw.prepare("SELECT definition_md FROM agents WHERE name = 'discovery'").pluck().get() as string;
      expect(def, label).toBe(V110_DISCOVERY_DEFINITION_MD);
      expect(def, label).toContain('role: discovery');
      expect(def, label).not.toContain('role: north');
      expect(def, label).not.toMatch(/STATUS:.*HANDOFF/);
      const caps = dbs.raw.prepare("SELECT * FROM role_capabilities WHERE role = 'discovery'").get() as any;
      expect(caps.allowed_statuses).toBe(V110_DISCOVERY_ALLOWED_STATUSES);
      expect(caps.terminal_statuses).toBe(V110_DISCOVERY_TERMINAL_STATUSES);
      expect(caps.required_artifacts).toBe(V110_DISCOVERY_REQUIRED_ARTIFACTS);
      dbs.close();
    }
  });

  it('non-matching custom persona remains byte-identical across upgrade', () => {
    const custom = '# CUSTOM DISCOVERY PERSONA — do not touch\nrole: my-special-discovery\n';
    const dbPath = tempDbPath('s02-custom');
    createV109DiscoveryShapeDb(dbPath, custom);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const dbs = new DatabaseService(dbPath);
    expect((dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version).toBe(110);
    const def = dbs.raw.prepare("SELECT definition_md FROM agents WHERE name = 'discovery'").pluck().get() as string;
    expect(def).toBe(custom);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/\[v110\] custom discovery definition_md preserved.*sha256=/)
    );
    // caps still move (system table) even when persona is custom
    const caps = dbs.raw.prepare("SELECT * FROM role_capabilities WHERE role = 'discovery'").get() as any;
    expect(caps.allowed_statuses).toBe(V110_DISCOVERY_ALLOWED_STATUSES);
    expect(caps.terminal_statuses).toBe(V110_DISCOVERY_TERMINAL_STATUSES);
    dbs.close();
  });

  it('empty discovery definition is filled with canonical on upgrade', () => {
    const dbPath = tempDbPath('s02-empty');
    createV109DiscoveryShapeDb(dbPath, '');
    const dbs = new DatabaseService(dbPath);
    expect(dbs.raw.prepare("SELECT definition_md FROM agents WHERE name = 'discovery'").pluck().get()).toBe(
      V110_DISCOVERY_DEFINITION_MD
    );
    dbs.close();
  });
});
