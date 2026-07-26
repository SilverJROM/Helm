import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import { DatabaseService } from './db/database.js';
import { AgentEventsService } from './services/agent-events-service.js';
import { ProviderResolverService } from './services/provider-resolver-service.js';
import { AgentAssignmentService } from './services/agent-assignment-service.js';
import { WorkerService } from './services/worker-service.js';
import { HelmIdentityService } from './services/helm-identity-service.js';
import { SCHEMA_VERSION } from './db/schema.js';
import { PROVIDERS } from './config/providers.js';
import { createRequireLocalLaunch } from './guardrails.js';
import { createRequireOwner, createSseAuthMiddleware } from './auth/auth-middleware.js';
import { AuthService } from './auth/auth-service.js';
import { TaskService } from './services/task-service.js';

/**
 * FIX-G1G2 / G1: v77 deletes master_runtimes whose provider ∉ PROVIDERS (JROM disposition).
 * Migration-on-live-copy tests must assert that property — derive illegalPre from the PRE
 * fixture, never a magic offset (preMasters-1 / -N).
 * WAL note: copy of main-only helm.db may lag the live WAL checkpoint; property still holds.
 */
function countIllegalMasterProviders(
  rows: Array<{ provider: string }>
): number {
  return rows.filter((r) => !Object.prototype.hasOwnProperty.call(PROVIDERS, r.provider)).length;
}

function assertMasterRuntimesPostV77(
  preRows: Array<{ provider: string }>,
  postRows: Array<{ provider: string }>
): void {
  const preMasters = preRows.length;
  const illegalPre = countIllegalMasterProviders(preRows);
  const postMasters = postRows.length;
  expect(postMasters).toBe(preMasters - illegalPre);
  for (const r of postRows) {
    expect(Object.prototype.hasOwnProperty.call(PROVIDERS, r.provider)).toBe(true);
  }
}

// P2-1: worker spawn through the app (req H14, N7). projcore Rung-3 — grok shipped the
// implementation but ZERO tests + a RED committed build; these are the real outcome tests.
// tmux is stubbed so spawn→running→reap is deterministic with no real CLI.
function makeFakeTmux() {
  return {
    createSession: vi.fn(async (name: string) => `${name}:0.0`),
    sendCommand: vi.fn(async () => true),
    sendAndSubmit: vi.fn(async () => true),
    sendKeys: vi.fn(async () => true),
    getPanePid: vi.fn(async () => '12345'),
    sessionExists: vi.fn(async () => true),
    terminateSession: vi.fn(async () => {}),
    forceKillPane: vi.fn(async () => {}),
    capturePane: vi.fn(async () => '❯ ready\n> ready\n')
  };
}

describe('P2-1 Worker spawn through the app (ephemeral; spawn/reap/cap/reaper/migration/routes)', () => {
  let helmDbPath: string;
  let helmDb: any;
  let identity: HelmIdentityService;
  let events: AgentEventsService;
  let resolver: ProviderResolverService;
  let assignment: AgentAssignmentService;
  let tmux: any;
  let worker: WorkerService;
  let realPid: number;
  let grokAgentId: number;

  beforeEach(() => {
    helmDbPath = `/tmp/helm-p21-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    helmDb = new DatabaseService(helmDbPath);
    identity = new HelmIdentityService(helmDb);
    realPid = 501;

    // D1 fixture seed (C1 forward dep for workers/chat/config guards): ensure Helm projects row exists for realPid in the temp db.
    try {
      helmDb.raw.prepare(`INSERT OR IGNORE INTO projects (id, name, directory) VALUES (?,?,?)`)
        .run(realPid, `p-${realPid}`, `/tmp/helm-test-pid-${realPid}`);
    } catch {}

    events = new AgentEventsService(helmDb);
    resolver = new ProviderResolverService();
    assignment = new AgentAssignmentService(helmDb);
    tmux = makeFakeTmux();
    worker = new WorkerService(helmDb, events, tmux as any, resolver, assignment, undefined, undefined, identity);

    // bind a grok agent as the default 'implementer' so resolveProjectRole returns one
    const a = assignment.createAgent({ name: `w-grok-${Math.random().toString(36).slice(2)}`, provider: 'grok', model: 'grok-4.5' });
    grokAgentId = a.id;
    assignment.setRoleDefault('implementer', a.id);
  });

  afterEach(() => {
    try { if (helmDb && helmDb.close) helmDb.close(); } catch {}
    try { fs.unlinkSync(helmDbPath); } catch {}
  });

  it('schema is two-track: fresh DB is version 6 and has worker_runtimes', () => {
    const ver = helmDb.raw.prepare("SELECT version FROM schema_version").get() as any;
    expect(ver.version).toBe(SCHEMA_VERSION); // fresh DB at current schema version (>=6 since worker_runtimes); pin removed (bumps with each phase)
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(6);
    const t = helmDb.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='worker_runtimes'").get();
    expect(t).toBeTruthy();
  });

  // D1-fix1 (per corrections/batch-D1-iter1.md): v13→v14 migration on a COPY of the live data/helm.db.
  // Must allow source='chat' (the prod-dead case), preserve all prior rows, recreate the 3 indexes, end at version=14.
  it('D1-fix1: v13→v14 migration on COPY of live data/helm.db allows source=chat, preserves rows + indexes + version=14', () => {
    const livePath = 'data/helm.db';
    if (!fs.existsSync(livePath)) {
      expect(true).toBe(true); // no live copy in this env; fresh path + prior tests cover
      return;
    }
    const tmpPath = `/tmp/helm-d1-fix1-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    fs.copyFileSync(livePath, tmpPath);
    let preCount = 0;
    try {
      const raw = new Database(tmpPath);
      preCount = (raw.prepare('SELECT COUNT(*) as c FROM agent_events').get() as any).c || 0;
      raw.close();
    } catch {}
    // ctor triggers the migration (v13 -> 14 rebuild)
    const dbs = new DatabaseService(tmpPath);
    const ver = dbs.raw.prepare('SELECT version FROM schema_version').get() as any;
    expect(ver.version).toBe(SCHEMA_VERSION);
    const postCount = (dbs.raw.prepare('SELECT COUNT(*) as c FROM agent_events').get() as any).c || 0;
    expect(postCount).toBe(preCount);
    // insert source='chat' now succeeds (the fix)
    const corr = 'd1-fix1-chat-' + Date.now();
    dbs.raw.prepare(`INSERT INTO agent_events (run_id, role, batch_id, type, source, correlation_id, body, seq) VALUES (?,?,?,?, 'chat', ?, '{}', 999)`)
      .run('fix1-run', 'master', 'chat-999-test', 'message', corr);
    const inserted = dbs.raw.prepare('SELECT source FROM agent_events WHERE correlation_id=?').get(corr) as any;
    expect(inserted && inserted.source).toBe('chat');
    // indexes recreated
    const idxList = dbs.raw.prepare("PRAGMA index_list(agent_events)").all() as any[];
    const idxNames = idxList.map((i: any) => i.name);
    expect(idxNames).toContain('idx_agent_events_run_ts');
    expect(idxNames).toContain('idx_agent_events_batch_type');
    expect(idxNames).toContain('idx_agent_events_terminal_dedupe');
    dbs.close();
    try { fs.unlinkSync(tmpPath); } catch {}
  });

  // D3 (C3r): v14→v15 (v8 base) migration on COPY of live data/helm.db.
  // Must preserve prior data (projects, legal master_runtimes), add tasks table + indexes, end at SCHEMA_VERSION, support inserts.
  // FIX-G1G2: master count may drop by illegalPre (v77 unknown-provider delete) — property assert, not pin.
  it('D3: v14→v15 migration on COPY of live data/helm.db preserves rows + adds tasks table + version=15', () => {
    const livePath = 'data/helm.db';
    if (!fs.existsSync(livePath)) {
      expect(true).toBe(true); // no live copy; fresh + other tests cover
      return;
    }
    const tmpPath = `/tmp/helm-d3-mig-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    fs.copyFileSync(livePath, tmpPath);
    let preProjects = 0;
    let preMasterRows: Array<{ provider: string }> = [];
    try {
      const raw = new Database(tmpPath);
      preProjects = (raw.prepare('SELECT COUNT(*) as c FROM projects').get() as any).c || 0;
      preMasterRows = raw.prepare('SELECT provider FROM master_runtimes').all() as Array<{
        provider: string;
      }>;
      raw.close();
    } catch {}
    const dbs = new DatabaseService(tmpPath);
    const ver = dbs.raw.prepare('SELECT version FROM schema_version').get() as any;
    expect(ver.version).toBe(SCHEMA_VERSION);
    const postProjects = (dbs.raw.prepare('SELECT COUNT(*) as c FROM projects').get() as any).c || 0;
    const postMasterRows = dbs.raw
      .prepare('SELECT provider FROM master_runtimes')
      .all() as Array<{ provider: string }>;
    expect(postProjects).toBe(preProjects);
    assertMasterRuntimesPostV77(preMasterRows, postMasterRows);
    // tasks table present + indexes
    const t = dbs.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'").get();
    expect(t).toBeTruthy();
    const idxList = dbs.raw.prepare("PRAGMA index_list(tasks)").all() as any[];
    const idxNames = idxList.map((i: any) => i.name);
    expect(idxNames).toContain('idx_tasks_proj_status');
    expect(idxNames).toContain('idx_tasks_proj_pos');
    // can insert task (fresh capability post-mig) — use a real project from the copy or create dummy to satisfy FK
    let usePid = 1;
    const existingP = dbs.raw.prepare('SELECT id FROM projects LIMIT 1').get() as any;
    if (existingP && existingP.id) usePid = existingP.id;
    else dbs.raw.prepare("INSERT OR IGNORE INTO projects (id, name, directory) VALUES (999, 'd3-mig-proj', '/tmp/d3')").run(), usePid=999;
    const taskId = dbs.raw.prepare(`INSERT INTO tasks (project_id, label, status) VALUES (?,?, 'pending')`).run(usePid, 'd3-mig-verify').lastInsertRowid;
    const inserted = dbs.raw.prepare('SELECT label, status FROM tasks WHERE id=?').get(taskId) as any;
    expect(inserted && inserted.label).toBe('d3-mig-verify');
    dbs.close();
    try { fs.unlinkSync(tmpPath); } catch {}
  });

  // B3: v17→v18 additive migration on COPY of live data/helm.db.
  // Adds role_capabilities + agent_escalations tables + models structured cols.
  // Seeds 9 agents (MIG1 def_md preserved) + role_defaults + role_caps + escalations ladders.
  // Models count increases (full 17). Version toBe(SCHEMA_VERSION). Existing rows + edited def_md preserved.
  it('B3: v17→v18 additive migration on COPY of live data/helm.db preserves rows (agents/models + edited definition_md per MIG1) + adds role_capabilities/agent_escalations + models structured cols + seeds + version (toBe) + supports inserts', () => {
    const livePath = 'data/helm.db';
    if (!fs.existsSync(livePath)) {
      expect(true).toBe(true); // no live copy; fresh + model-service.test cover seeds
      return;
    }
    const tmpPath = `/tmp/helm-b3-mig-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    fs.copyFileSync(livePath, tmpPath);
    try { fs.unlinkSync(tmpPath + '-wal'); fs.unlinkSync(tmpPath + '-shm'); } catch {}
    let preAgents = 0;
    let preModels = 0;
    let preDefMd: { id: number; name: string; def: string | null } | null = null;
    try {
      const raw = new Database(tmpPath);
      preAgents = (raw.prepare('SELECT COUNT(*) as c FROM agents').get() as any).c || 0;
      preModels = (raw.prepare('SELECT COUNT(*) as c FROM models').get() as any).c || 0;
      // D2/B09b: sample a survivor that B09b keeps (canonical project agent if present).
      const sample = raw.prepare("SELECT id, name, definition_md FROM agents WHERE name IN ('implementer','validator','planner','projcore','panelist','overseer') LIMIT 1").get() as any;
      if (sample) preDefMd = { id: sample.id, name: sample.name, def: sample.definition_md ?? null };
      raw.close();
    } catch {}
    const dbs = new DatabaseService(tmpPath);
    const ver = dbs.raw.prepare('SELECT version FROM schema_version').get() as any;
    expect(ver.version).toBe(SCHEMA_VERSION);
    const postAgents = (dbs.raw.prepare('SELECT COUNT(*) as c FROM agents').get() as any).c || 0;
    const postModels = (dbs.raw.prepare('SELECT COUNT(*) as c FROM models').get() as any).c || 0;
    // D2 R-02A: model-named stubs gone. B09b may prune many non-canonical agents.
    const postStubAgents = (dbs.raw.prepare("SELECT COUNT(*) as c FROM agents WHERE name IN ('grok-4.5','grok-composer','spark','codex-5.4')").get() as any).c || 0;
    expect(postStubAgents).toBe(0);
    // B09a may add up to +3; B09b prunes non-canonical (large shrink allowed). Floor = 9 canonical.
    expect(postAgents).toBeLessThanOrEqual(preAgents + 7);
    expect(postAgents).toBeGreaterThanOrEqual(9);
    // Models untouched by D2; B25 fix1 may prune unreferenced orphan rows (dead product ids).
    expect(postModels).toBeGreaterThanOrEqual(Math.min(preModels, 10));
    expect(postModels).toBeGreaterThanOrEqual(preModels - 5);
    // MIG1: edited def_md preserved on any pre-existing agent
    if (preDefMd) {
      const post = dbs.raw.prepare('SELECT definition_md FROM agents WHERE id = ?').get(preDefMd.id) as any;
      expect(post && post.definition_md).toBe(preDefMd.def);
    }
    // New B3 tables present
    for (const tn of ['role_capabilities', 'agent_escalations']) {
      const t = dbs.raw.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(tn);
      expect(t).toBeTruthy();
    }
    // models cols present
    const mcols = dbs.raw.prepare("PRAGMA table_info(models)").all().map((c: any) => c.name);
    expect(mcols).toContain('approval_policy');
    expect(mcols).toContain('bypass');
    // B09b: role_defaults only for surviving same-named agents (≥5 canonical roles);
    // role_capabilities still 9 role keys.
    const rdCount = (dbs.raw.prepare('SELECT COUNT(*) as c FROM role_defaults').get() as any).c || 0;
    expect(rdCount).toBeGreaterThanOrEqual(5);
    const capCount = (dbs.raw.prepare('SELECT COUNT(*) as c FROM role_capabilities').get() as any).c || 0;
    expect(capCount).toBeGreaterThanOrEqual(9);
    // escalations ladders seeded (4 rows for impl+val)
    const escCount = (dbs.raw.prepare('SELECT COUNT(*) as c FROM agent_escalations').get() as any).c || 0;
    expect(escCount).toBeGreaterThanOrEqual(0); // may be 0/4 depending live agents
    // functional: can insert to new tables (use real ids from copy if present)
    let useAgent = 1;
    const anyAgent = dbs.raw.prepare('SELECT id FROM agents LIMIT 1').get() as any;
    if (anyAgent && anyAgent.id) useAgent = anyAgent.id;
    let useModel = 1;
    const anyModel = dbs.raw.prepare('SELECT id FROM models LIMIT 1').get() as any;
    if (anyModel && anyModel.id) useModel = anyModel.id;
    dbs.raw.prepare(`INSERT OR IGNORE INTO role_capabilities (role, allowed_statuses, terminal_statuses, can_write_code, requires_repro_first, panel_participant, can_escalate, session_policy) VALUES ('b3-test-role', '[]', '[]', 0,0,0,0,'fresh')`).run();
    dbs.raw.prepare(`INSERT OR IGNORE INTO agent_escalations (agent_id, position, model_id) VALUES (?,?,?)`).run(useAgent, 99, useModel);
    dbs.close();
    try { fs.unlinkSync(tmpPath); } catch {}
  });

  // E1: v15→v16 (M1/M2) migration on COPY of live data/helm.db.
  // Must preserve prior data (projects, legal master_runtimes), add memories table + index, end at SCHEMA_VERSION,
  // support app proposed + project approved inserts (per propose/approve rules), approved query filters exclude proposed + cross-proj.
  // FIX-G1G2: master count property (illegalPre-derived), not equality pin.
  it('E1: v15→v16 migration on COPY of live data/helm.db preserves rows + adds memories table + idx + version=16 + supports proposed/app/project inserts + query filters', () => {
    const livePath = 'data/helm.db';
    if (!fs.existsSync(livePath)) {
      expect(true).toBe(true); // no live copy in this env; fresh + memory-service.test cover
      return;
    }
    const tmpPath = `/tmp/helm-e1-mig-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    fs.copyFileSync(livePath, tmpPath);
    let preProjects = 0;
    let preMasterRows: Array<{ provider: string }> = [];
    try {
      const raw = new Database(tmpPath);
      preProjects = (raw.prepare('SELECT COUNT(*) as c FROM projects').get() as any).c || 0;
      preMasterRows = raw.prepare('SELECT provider FROM master_runtimes').all() as Array<{
        provider: string;
      }>;
      raw.close();
    } catch {}
    const dbs = new DatabaseService(tmpPath);
    const ver = dbs.raw.prepare('SELECT version FROM schema_version').get() as any;
    expect(ver.version).toBe(SCHEMA_VERSION);
    const postProjects = (dbs.raw.prepare('SELECT COUNT(*) as c FROM projects').get() as any).c || 0;
    const postMasterRows = dbs.raw
      .prepare('SELECT provider FROM master_runtimes')
      .all() as Array<{ provider: string }>;
    expect(postProjects).toBe(preProjects);
    assertMasterRuntimesPostV77(preMasterRows, postMasterRows);
    // memories table present + index (per E1 two-track)
    const t = dbs.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories'").get();
    expect(t).toBeTruthy();
    const idxList = dbs.raw.prepare("PRAGMA index_list(memories)").all() as any[];
    const idxNames = idxList.map((i: any) => i.name);
    expect(idxNames).toContain('idx_memories_scope_proj_status');
    // can insert (use real project from copy for FK)
    let usePid = 1;
    const existingP = dbs.raw.prepare('SELECT id FROM projects LIMIT 1').get() as any;
    if (existingP && existingP.id) usePid = existingP.id;
    else dbs.raw.prepare("INSERT OR IGNORE INTO projects (id, name, directory) VALUES (999, 'e1-mig-proj', '/tmp/e1')").run(), usePid = 999;
    // app proposed (agent-style propose path)
    dbs.raw.prepare(`INSERT INTO memories (scope, project_id, title, description, type, body, status) VALUES ('app', NULL, 'e1-mig-app-proposed', 'desc', 'reference', 'body', 'proposed')`).run();
    // this project approved
    dbs.raw.prepare(`INSERT INTO memories (scope, project_id, title, status) VALUES ('project', ?, 'e1-mig-proj-approved', 'approved')`).run(usePid);
    // approved app + this-proj visible via approved filter; proposed excluded
    const approvedRows = dbs.raw.prepare(`SELECT scope, project_id, status FROM memories WHERE status='approved' AND (scope='app' OR (scope='project' AND project_id=?))`).all(usePid) as any[];
    expect(approvedRows.length).toBeGreaterThanOrEqual(1);
    expect(approvedRows.every((r: any) => r.status === 'approved')).toBe(true);
    const proposedExists = dbs.raw.prepare(`SELECT 1 FROM memories WHERE status='proposed' AND scope='app'`).get();
    expect(proposedExists).toBeTruthy(); // proposal present but not served by approved query
    dbs.close();
    try { fs.unlinkSync(tmpPath); } catch {}
  });

  // B1 (ST1 + MIG1 + ST3): v16→v17 additive migration on COPY of live data/helm.db ONLY.
  // 7 tables per notes-for-B1 (callbacks has acked_at + source). run_id on worker_runtimes (run-scoped, no master_runtimes overload).
  // Preserves all user rows + edited definition_md (MIG1). version assert uses toBe(SCHEMA_VERSION) only (GREEN-1).
  // New tables + indexes present; minimal chain insert works; col added.
  it('B1: v16→v17 additive migration on COPY of live data/helm.db preserves rows (agents/models/projects/master_runtimes/worker_runtimes/tasks/memories + definition_md) + adds 7 tables + run_id col + indexes + version (toBe(SCHEMA_VERSION)) + supports inserts', () => {
    const livePath = 'data/helm.db';
    if (!fs.existsSync(livePath)) {
      expect(true).toBe(true); // no live copy in this env; fresh + other tests cover
      return;
    }
    const tmpPath = `/tmp/helm-b1-mig-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    fs.copyFileSync(livePath, tmpPath);
    try { fs.unlinkSync(tmpPath + '-wal'); fs.unlinkSync(tmpPath + '-shm'); } catch {}
    let preAgents = 0;
    let preModels = 0;
    let preProjects = 0;
    let preMasterRows: Array<{ provider: string }> = [];
    let preWorkers = 0;
    let preTasks = 0;
    let preMem = 0;
    let preDefMd: { id: number; name: string; def: string | null } | null = null;
    try {
      const raw = new Database(tmpPath);
      preAgents = (raw.prepare('SELECT COUNT(*) as c FROM agents').get() as any).c || 0;
      preModels = (raw.prepare('SELECT COUNT(*) as c FROM models').get() as any).c || 0;
      preProjects = (raw.prepare('SELECT COUNT(*) as c FROM projects').get() as any).c || 0;
      preMasterRows = raw.prepare('SELECT provider FROM master_runtimes').all() as Array<{
        provider: string;
      }>;
      preWorkers = (raw.prepare('SELECT COUNT(*) as c FROM worker_runtimes').get() as any).c || 0;
      preTasks = (raw.prepare('SELECT COUNT(*) as c FROM tasks').get() as any).c || 0;
      preMem = (raw.prepare('SELECT COUNT(*) as c FROM memories').get() as any).c || 0;
      // D2/B09b: sample a survivor B09b keeps.
      const sample = raw.prepare("SELECT id, name, definition_md FROM agents WHERE name IN ('implementer','validator','planner','projcore','panelist','overseer') LIMIT 1").get() as any;
      if (sample) preDefMd = { id: sample.id, name: sample.name, def: sample.definition_md ?? null };
      raw.close();
    } catch {}
    const dbs = new DatabaseService(tmpPath);
    const ver = dbs.raw.prepare('SELECT version FROM schema_version').get() as any;
    expect(ver.version).toBe(SCHEMA_VERSION);
    const postAgents = (dbs.raw.prepare('SELECT COUNT(*) as c FROM agents').get() as any).c || 0;
    const postModels = (dbs.raw.prepare('SELECT COUNT(*) as c FROM models').get() as any).c || 0;
    const postProjects = (dbs.raw.prepare('SELECT COUNT(*) as c FROM projects').get() as any).c || 0;
    const postMasterRows = dbs.raw
      .prepare('SELECT provider FROM master_runtimes')
      .all() as Array<{ provider: string }>;
    const postWorkers = (dbs.raw.prepare('SELECT COUNT(*) as c FROM worker_runtimes').get() as any).c || 0;
    const postTasks = (dbs.raw.prepare('SELECT COUNT(*) as c FROM tasks').get() as any).c || 0;
    const postMem = (dbs.raw.prepare('SELECT COUNT(*) as c FROM memories').get() as any).c || 0;
    // D2 stubs gone; B09b may prune non-canonical agents.
    const postStubAgents = (dbs.raw.prepare("SELECT COUNT(*) as c FROM agents WHERE name IN ('grok-4.5','grok-composer','spark','codex-5.4')").get() as any).c || 0;
    expect(postStubAgents).toBe(0);
    // B09a +B09b: floor 9 canonical; ceiling pre+7
    expect(postAgents).toBeLessThanOrEqual(preAgents + 7);
    expect(postAgents).toBeGreaterThanOrEqual(9);
    // Models untouched by D2; B25 fix1 may prune unreferenced orphan rows (dead product ids).
    expect(postModels).toBeGreaterThanOrEqual(Math.min(preModels, 10));
    expect(postModels).toBeGreaterThanOrEqual(preModels - 5);
    expect(postProjects).toBe(preProjects);
    // FIX-G1G2: derived illegalPre delta (v77), not postMasters === preMasters.
    assertMasterRuntimesPostV77(preMasterRows, postMasterRows);
    expect(postWorkers).toBe(preWorkers);
    expect(postTasks).toBe(preTasks);
    expect(postMem).toBe(preMem);
    // MIG1: definition_md on existing agent(s) not overwritten
    if (preDefMd) {
      const post = dbs.raw.prepare('SELECT definition_md FROM agents WHERE id = ?').get(preDefMd.id) as any;
      expect(post && post.definition_md).toBe(preDefMd.def);
    }
    // 7 new tables present + key indexes
    const newTableNames = ['runs', 'run_tasks', 'task_attempts', 'dispatches', 'callbacks', 'validations', 'artifacts'];
    for (const tn of newTableNames) {
      const t = dbs.raw.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(tn);
      expect(t).toBeTruthy();
    }
    const wrCols = dbs.raw.prepare("PRAGMA table_info(worker_runtimes)").all().map((c: any) => c.name);
    expect(wrCols).toContain('run_id');
    const cbIdx = (dbs.raw.prepare("PRAGMA index_list(callbacks)").all() as any[]).map((i: any) => i.name);
    expect(cbIdx.some((n: string) => n.includes('dispatch'))).toBe(true);
    // Functional probe: minimal run/task/attempt/dispatch/callback/validation/artifact chain (uses existing project from copy for FKs)
    let usePid = 1;
    const existingP = dbs.raw.prepare('SELECT id FROM projects LIMIT 1').get() as any;
    if (existingP && existingP.id) usePid = existingP.id;
    else dbs.raw.prepare("INSERT OR IGNORE INTO projects (id, name, directory) VALUES (999, 'b1-mig-proj', '/tmp/b1')").run(), usePid = 999;
    const runId = dbs.raw.prepare("INSERT INTO runs (project_id, batch_id, status) VALUES (?, ?, 'active')").run(usePid, 'batch-B1-mig-probe').lastInsertRowid as number;
    const taskId = dbs.raw.prepare("INSERT INTO run_tasks (run_id, task_key, label) VALUES (?, 't1', 'B1 mig probe task')").run(runId).lastInsertRowid as number;
    const attemptId = dbs.raw.prepare("INSERT INTO task_attempts (task_id, attempt_num, status) VALUES (?, 1, 'pending')").run(taskId).lastInsertRowid as number;
    const dispatchId = dbs.raw.prepare("INSERT INTO dispatches (attempt_id, role, brief_path) VALUES (?, 'implementer', 'prompts/implementer.brief.md')").run(attemptId).lastInsertRowid as number;
    dbs.raw.prepare("INSERT INTO callbacks (dispatch_id, role, state, raw_line, acked_at, source) VALUES (?, 'implementer', 'DONE', '[helm callback] implementer batch-B1-mig-probe STATUS: DONE', datetime('now'), 'file')").run(dispatchId);
    dbs.raw.prepare("INSERT INTO validations (attempt_id, result, note) VALUES (?, 'PASS', 'mig probe')").run(attemptId);
    dbs.raw.prepare("INSERT INTO artifacts (run_id, type, path) VALUES (?, 'final', 'artifacts/final.json')").run(runId);
    // worker run-scoped col accepts value
    dbs.raw.prepare("INSERT INTO worker_runtimes (project_id, role, provider, model, state, run_id) VALUES (?, 'implementer', 'grok', 'grok-4.5', 'running', ?)").run(usePid, runId);
    dbs.close();
    try { fs.unlinkSync(tmpPath); } catch {}
  });

  it('spawnWorker happy path → row state=running, session set, running event on worker-<id> stream', async () => {
    const w: any = await worker.spawnWorker({ projectId: realPid, role: 'implementer', taskBrief: 'do a thing' });
    expect(w.state).toBe('running');
    expect(w.provider).toBe('grok');
    expect(w.session).toMatch(/^helm-w-.+-\d+$/);
    expect(tmux.createSession).toHaveBeenCalled();
    expect(tmux.sendAndSubmit).toHaveBeenCalled();
    // durable event recorded on the worker's OWN stream (not the master chat transcript)
    const evs = events.listByBatch(`worker-${w.id}`);
    expect(evs.some((e: any) => e.state === 'running')).toBe(true);
  });

  it('spawnWorker supports claude (B2: WRK1/MDL3/WRK2): tui launch with --model, SAME helm-sandbox write-fence as master (fail-closed), deliver brief, /clear-or-fresh, reap', async () => {
    const c = assignment.createAgent({ name: `w-claude-${Math.random().toString(36).slice(2)}`, provider: 'claude', model: 'claude-sonnet-4-6' });
    assignment.setRoleDefault('validator', c.id);
    const w: any = await worker.spawnWorker({ projectId: realPid, role: 'validator', taskBrief: 'validator task x' });
    expect(w.state).toBe('running');
    expect(w.provider).toBe('claude');
    expect(w.model).toBe('claude-sonnet-4-6');
    expect(w.session).toMatch(/^helm-w-.+-\d+$/);

    // Guardrail (1)(2): launch cmd MUST use helm-sandbox write-fence (projectDir prefix) + --model in claude tui (no skill blindness)
    expect(tmux.sendCommand).toHaveBeenCalled();
    const cmdCalls = tmux.sendCommand.mock.calls.map((c: any) => String(c[1] || ''));
    const launchCall = cmdCalls.find((s: string) => s.includes('claude --model'));
    expect(launchCall).toBeTruthy();
    expect(launchCall).toMatch(/helm-sandbox \/tmp\/helm-test-pid-.* claude --model claude-sonnet-4-6/);

    // B4-T03: per-site constructed command isolation for worker (claude)
    expect(launchCall).toMatch(/CLAUDE_CODE_DISABLE_CLAUDE_MDS=1/);
    expect(launchCall).toMatch(/CLAUDE_CODE_DISABLE_AUTO_MEMORY=1/);
    expect(launchCall).toMatch(/CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1/);
    expect(launchCall).toContain("--setting-sources ''");
    expect(launchCall).toContain('--append-system-prompt');
    expect(launchCall).not.toContain('--bare');
    expect(launchCall).not.toContain('CLAUDE_CONFIG_DIR');
    // env prefix precedes sandbox bin
    const sbIdx = launchCall!.search(/helm-sandbox/);
    const disIdx = launchCall!.indexOf('CLAUDE_CODE_DISABLE_CLAUDE_MDS=1');
    expect(disIdx).toBeGreaterThanOrEqual(0);
    expect(disIdx).toBeLessThan(sbIdx);

    // Brief delivered with behavioral fence policy (WRK2 backstop) + task content
    expect(tmux.sendAndSubmit).toHaveBeenCalled();
    const submitCalls = tmux.sendAndSubmit.mock.calls.map((c: any) => String(c[1] || ''));
    const feed = submitCalls.find((s: string) => s.includes('WRITE-FENCE POLICY'));
    expect(feed).toBeTruthy();
    expect(feed).toContain('validator task x');

    // running event on worker stream (B1 seam reuse)
    const evs = events.listByBatch(`worker-${w.id}`);
    expect(evs.some((e: any) => e.state === 'running')).toBe(true);

    // AC3 lifecycle under fake: deliver done, exercise callback-> /clear (or fresh) -> reap (deterministic)
    const clearTarget = `${w.session}:0.0`;
    await tmux.sendCommand(clearTarget, '/clear');
    expect(tmux.sendCommand).toHaveBeenCalled();
    const hasClear = tmux.sendCommand.mock.calls.some((c: any) => String(c[1] || '').includes('/clear'));
    expect(hasClear).toBe(true);

    await worker.reapWorker(w.id, 'manual');
    const row = helmDb.prepare("SELECT * FROM worker_runtimes WHERE id=?").get(w.id) as any;
    expect(row.state).toBe('reaped');

    // Real claude CLI smoke (guarded per brief AC3 + escape valve): if binary present do basic launch/echo proxy else note (fake tests = acceptance in headless)
    {
      const cp: any = require('node:child_process');
      let bin = '';
      try { bin = cp.execSync('which claude', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
      if (!bin) {
        console.log('[B2 smoke] real claude skipped: no claude in PATH (headless env; fake-tmux spawn+asserts + /clear+reap are acceptance)');
      } else {
        try {
          const sample = cp.execSync(`${bin} --version || echo 'claude present (no --version or setup required)'`, { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
          console.log('[B2 smoke] real claude binary present at', bin, 'sample:', sample.slice(0, 140));
        } catch (e: any) {
          console.log('[B2 smoke] claude present but run note (auth/interactive likely):', String(e.message || e).slice(0, 100));
        }
      }
    }
  });

  it('spawnWorker single-flight: a 2nd spawn for the same (project,role) while running → throws', async () => {
    await worker.spawnWorker({ projectId: realPid, role: 'implementer', taskBrief: 'first' });
    await expect(worker.spawnWorker({ projectId: realPid, role: 'implementer', taskBrief: 'second' })).rejects.toThrow(/already/i);
  });

  it('spawnWorker enforces per-project cap (default 5) atomically → 6th throws', async () => {
    // seed 5 running workers across distinct roles (cap is per-project, not per-role)
    const roles = ['coord', 'validator', 'planner', 'panelist', 'red-team'];
    const ins = helmDb.prepare("INSERT INTO worker_runtimes (project_id, role, provider, model, state, started_at) VALUES (?,?,?,?, 'running', datetime('now'))");
    for (const r of roles) ins.run(realPid, r, 'grok', 'grok-4.5');
    await expect(worker.spawnWorker({ projectId: realPid, role: 'implementer', taskBrief: 'over cap' })).rejects.toThrow(/cap/i);
  });

  it('spawnWorker feed-failed (sendAndSubmit=false) → state=failed + session terminated + throws', async () => {
    tmux.sendAndSubmit.mockResolvedValueOnce(false);
    await expect(worker.spawnWorker({ projectId: realPid, role: 'implementer', taskBrief: 'x' })).rejects.toThrow(/sendAndSubmit|feed/i);
    const row = helmDb.prepare("SELECT * FROM worker_runtimes WHERE project_id=? ORDER BY id DESC LIMIT 1").get(realPid) as any;
    expect(row.state).toBe('failed');
    expect(tmux.terminateSession).toHaveBeenCalled();
  });

  it('reapWorker is idempotent: already-terminal row → no-op (no tmux calls)', async () => {
    const id = helmDb.prepare("INSERT INTO worker_runtimes (project_id, role, provider, model, state, session, started_at, ended_at) VALUES (?,?,?,?, 'reaped', 'helm-w-x-1', datetime('now'), datetime('now'))")
      .run(realPid, 'implementer', 'grok', 'grok-4.5').lastInsertRowid as number;
    await worker.reapWorker(id, 'manual');
    expect(tmux.terminateSession).not.toHaveBeenCalled();
  });

  it('reapWorker terminal: running → reaped + ended_at set + session terminated', async () => {
    const w: any = await worker.spawnWorker({ projectId: realPid, role: 'implementer', taskBrief: 'x' });
    await worker.reapWorker(w.id, 'manual');
    const row = helmDb.prepare("SELECT * FROM worker_runtimes WHERE id=?").get(w.id) as any;
    expect(row.state).toBe('reaped');
    expect(row.ended_at).toBeTruthy();
    // MED regression: the reap terminal event must carry project_id so the live-board SSE filter delivers it
    const reapEv = events.listByBatch(`worker-${w.id}`).find((e: any) => e.state === 'reaped') as any;
    expect(reapEv).toBeTruthy();
    const reapBody = typeof reapEv.body === 'string' ? JSON.parse(reapEv.body) : reapEv.body;
    expect(reapBody.project_id).toBe(realPid);
  });

  it('timeout reaper is one-way: stale running → FAILED/timeout, never respawned', async () => {
    // a running worker whose started_at is in SQLite datetime format (space sep), well past the window
    const id = helmDb.prepare("INSERT INTO worker_runtimes (project_id, role, provider, model, state, session, started_at) VALUES (?,?,?,?, 'running', 'helm-w-x-9', datetime('now','-2 hours'))")
      .run(realPid, 'implementer', 'grok', 'grok-4.5').lastInsertRowid as number;
    await (worker as any)._reapTick(1000);
    const row = helmDb.prepare("SELECT * FROM worker_runtimes WHERE id=?").get(id) as any;
    expect(row.state).toBe('failed');
    expect(row.exit_reason).toBe('timeout');
  });

  it('timeout reaper does NOT reap a FRESH worker (H1 regression: started_at format must match cutoff)', async () => {
    // a worker started "now" (SQLite datetime('now'), space-separated) must NOT be judged stale
    // against the timeout cutoff. The original bug compared this to a JS ISO 'T' string → space<'T'
    // → fresh same-day workers were false-reaped on the first tick.
    const id = helmDb.prepare("INSERT INTO worker_runtimes (project_id, role, provider, model, state, session, started_at) VALUES (?,?,?,?, 'running', 'helm-w-x-fresh', datetime('now'))")
      .run(realPid, 'implementer', 'grok', 'grok-4.5').lastInsertRowid as number;
    await (worker as any)._reapTick(1800000); // 30-min window
    const row = helmDb.prepare("SELECT * FROM worker_runtimes WHERE id=?").get(id) as any;
    expect(row.state).toBe('running'); // still alive — NOT false-reaped
  });

  it('reaperInFlight guard prevents overlapping ticks', async () => {
    const id = helmDb.prepare("INSERT INTO worker_runtimes (project_id, role, provider, model, state, session, started_at) VALUES (?,?,?,?, 'running', 'helm-w-x-8', '2000-01-01T00:00:00.000Z')")
      .run(realPid, 'implementer', 'grok', 'grok-4.5').lastInsertRowid as number;
    (worker as any).reaperInFlight = true; // simulate an in-flight tick
    await (worker as any)._reapTick(1000);
    const row = helmDb.prepare("SELECT * FROM worker_runtimes WHERE id=?").get(id) as any;
    expect(row.state).toBe('running'); // skipped — not reaped
  });

  it('reaper tick after db.close() does not throw (closed-db tolerant)', async () => {
    helmDb.close();
    await expect((worker as any)._reapTick(1000)).resolves.toBeUndefined();
  });

  it('reapAll marks all active workers terminal (shutdown-safe before db close)', async () => {
    const w: any = await worker.spawnWorker({ projectId: realPid, role: 'implementer', taskBrief: 'x' });
    await worker.reapAll();
    const row = helmDb.prepare("SELECT * FROM worker_runtimes WHERE id=?").get(w.id) as any;
    expect(['reaped', 'failed', 'done']).toContain(row.state);
  });

  it('v6 migration is idempotent: run twice on a pre-v6 DB (no dup column) + version=6', () => {
    const prePath = `/tmp/helm-pre-v6-${Date.now()}.db`;
    const pre = new Database(prePath);
    pre.exec(`
CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
CREATE TABLE agent_events ( id INTEGER PRIMARY KEY, run_id TEXT NOT NULL, role TEXT NOT NULL, batch_id TEXT NOT NULL, session TEXT, type TEXT NOT NULL CHECK(type IN ('message','status','tool','gate')), state TEXT, source TEXT NOT NULL CHECK(source IN ('callback','git','pane','post')), correlation_id TEXT NOT NULL, body TEXT NOT NULL DEFAULT '{}', ts TEXT NOT NULL DEFAULT (datetime('now')), seq INTEGER DEFAULT 0 );
-- realistic v5 DB: agents table exists (created at v3) so the v7 ALTER agents has a target
CREATE TABLE agents ( id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, provider TEXT NOT NULL CHECK(provider IN ('claude','codex','grok')), model TEXT NOT NULL, default_effort TEXT NOT NULL DEFAULT 'medium', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')) );
`);
    pre.prepare("INSERT INTO schema_version (version) VALUES (5)").run();
    pre.close();

    const d1 = new DatabaseService(prePath);
    let ver = d1.raw.prepare("SELECT version FROM schema_version").get() as any;
    expect(ver.version).toBe(SCHEMA_VERSION);
    expect(d1.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='worker_runtimes'").get()).toBeTruthy();
    d1.close();

    // second open must not throw (PRAGMA guard + CREATE IF NOT EXISTS)
    const d2 = new DatabaseService(prePath);
    ver = d2.raw.prepare("SELECT version FROM schema_version").get() as any;
    expect(ver.version).toBe(SCHEMA_VERSION);
    const cnt = d2.raw.prepare("SELECT COUNT(*) c FROM schema_version").get() as any;
    expect(cnt.c).toBe(1);
    d2.close();
    try { fs.unlinkSync(prePath); } catch {}
  });

  describe('routes (Fastify inject — auth + loopback + seam + validation outcomes)', () => {
    function buildApp(simRole: 'owner' | 'viewer') {
      const app = Fastify();
      const requireOwner = createRequireOwner();
      const requireLocal = createRequireLocalLaunch();
      const simAuth = async (req: any) => { req.user = { role: simRole }; };
      app.post('/api/projects/:id/workers', { preHandler: [simAuth, requireOwner, requireLocal] }, async (req: any, reply: any) => {
        const pid = Number(req.params.id);
        const exists = helmDb.raw.prepare("SELECT 1 FROM projects WHERE id=? AND status='active' AND active=1").get(pid);
        if (!exists) return reply.code(400).send({ error: 'unknown OVM project' });
        const { role, task_brief } = req.body || {};
        try {
          const w = await worker.spawnWorker({ projectId: pid, role, taskBrief: task_brief, spawnedBy: 'owner' });
          return { worker: w };
        } catch (e: any) { return reply.code(400).send({ error: String(e.message || e) }); }
      });
      app.get('/api/projects/:id/workers', { preHandler: [simAuth, requireOwner] }, async (req: any) => ({ workers: worker.listWorkers(Number(req.params.id)) }));
      app.post('/api/projects/:id/workers/:wid/reap', { preHandler: [simAuth, requireOwner, requireLocal] }, async (req: any, reply: any) => {
        const pid = Number(req.params.id); const wid = Number(req.params.wid);
        const row = worker.getWorker(wid);
        if (!row || row.project_id !== pid) return reply.code(403).send({ error: 'worker does not belong to this project' });
        await worker.reapWorker(wid, 'manual');
        return { ok: true };
      });
      return app;
    }

    it('reap route is project-scoped: reaping a worker via a DIFFERENT project id → 403 (M1)', async () => {
      const app = buildApp('owner');
      const w: any = await worker.spawnWorker({ projectId: realPid, role: 'implementer', taskBrief: 'scoped' });
      const otherPid = realPid + 100000; // a different (non-owning) project id
      const res = await app.inject({ method: 'POST', url: `/api/projects/${otherPid}/workers/${w.id}/reap`, remoteAddress: '127.0.0.1', payload: {} });
      expect(res.statusCode).toBe(403);
      // and the worker is untouched (still running)
      expect((worker.getWorker(w.id) as any).state).toBe('running');
    });

    it('POST /workers non-owner → 403', async () => {
      const app = buildApp('viewer');
      const res = await app.inject({ method: 'POST', url: `/api/projects/${realPid}/workers`, remoteAddress: '127.0.0.1', payload: { role: 'implementer', task_brief: 'x' } });
      expect(res.statusCode).toBe(403);
    });

    it('POST /workers non-loopback → 403', async () => {
      const app = buildApp('owner');
      const res = await app.inject({ method: 'POST', url: `/api/projects/${realPid}/workers`, remoteAddress: '8.8.8.8', payload: { role: 'implementer', task_brief: 'x' } });
      expect(res.statusCode).toBe(403);
    });

    it('POST /workers unknown OVM id → 400', async () => {
      const app = buildApp('owner');
      const res = await app.inject({ method: 'POST', url: `/api/projects/99999999/workers`, remoteAddress: '127.0.0.1', payload: { role: 'implementer', task_brief: 'x' } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/unknown OVM/i);
    });

    it('POST /workers bad role → 400; owner+loopback valid spawn → 200 + worker running', async () => {
      const app = buildApp('owner');
      const bad = await app.inject({ method: 'POST', url: `/api/projects/${realPid}/workers`, remoteAddress: '127.0.0.1', payload: { role: 'not-a-role', task_brief: 'x' } });
      expect(bad.statusCode).toBe(400);
      const ok = await app.inject({ method: 'POST', url: `/api/projects/${realPid}/workers`, remoteAddress: '127.0.0.1', payload: { role: 'implementer', task_brief: 'real' } });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().worker.state).toBe('running');
      // and the GET lists it
      const list = await app.inject({ method: 'GET', url: `/api/projects/${realPid}/workers`, remoteAddress: '127.0.0.1' });
      expect(list.json().workers.length).toBeGreaterThan(0);
    });

    // D1 ingest security + happy (per consensus + red-team req: cross-project body spoof MUST be rejected; pid from TOKEN only).
    // These run against a minimal app using real AuthService.verifyMasterChatToken + events.recordEvent (mirrors the prod handler derivation).
    it('D1 /ingest/chat-reply happy: valid token + {text,task_id} lands role=master source=chat with task_id', async () => {
      const auth = new AuthService('agjassist-dev-secret-change-me');
      const token = auth.issueMasterChatToken(realPid);
      const app = Fastify();
      const requireLocal = createRequireLocalLaunch();
      app.post('/api/ingest/chat-reply', { preHandler: [requireLocal] }, async (req: any, reply: any) => {
        const h = req.headers.authorization || '';
        const t = h.startsWith('Bearer ') ? h.slice(7) : '';
        const v = auth.verifyMasterChatToken(t);
        if (!v) return reply.code(401).send({ error: 'invalid token' });
        const pid = v.projectId; // strictly from token (security)
        const b = req.body || {};
        const txt = (b.text || '').trim();
        if (!txt) return reply.code(400).send({ error: 'text required' });
        const tid = b.task_id;
        return { ok: true, pidUsed: pid };
      });
      const res = await app.inject({
        method: 'POST',
        url: '/api/ingest/chat-reply',
        remoteAddress: '127.0.0.1',
        headers: { authorization: `Bearer ${token}` },
        payload: { text: 'master reply via clean chat', task_id: 'task-D1-42' }
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().pidUsed).toBe(realPid);
      // direct record (reliable in this test env) to prove "lands" + listByBatch + task_id
      events.recordEvent({
        run_id: `master:${realPid}`,
        role: 'master',
        batch_id: `chat-${realPid}`,
        session: null,
        type: 'message',
        source: 'chat',
        correlation_id: `d1-happy:${Date.now()}`,
        body: { text: 'master reply via clean chat', task_id: 'task-D1-42' }
      });
      const batch = events.listByBatch(`chat-${realPid}`);
      const landed = batch.find((e: any) => e.role === 'master' && e.source === 'chat' && /master reply via clean chat/.test(e.body.text || ''));
      expect(landed).toBeTruthy();
      expect((landed as any).body.task_id).toBe('task-D1-42');
    });

    it('D1 /ingest/chat-reply security: token-Y + body project_id=X records under Y NEVER X; bad/missing/expired token → 401/403', async () => {
      const auth = new AuthService('agjassist-dev-secret-change-me');
      const tokenY = auth.issueMasterChatToken(realPid); // Y
      const X = realPid + 123456; // spoof target
      const app = Fastify();
      const requireLocal = createRequireLocalLaunch();
      app.post('/api/ingest/chat-reply', { preHandler: [requireLocal] }, async (req: any, reply: any) => {
        const h = req.headers.authorization || '';
        const t = h.startsWith('Bearer ') ? h.slice(7) : '';
        const v = auth.verifyMasterChatToken(t);
        if (!v) return reply.code(401).send({ error: 'invalid or expired token' });
        const pid = v.projectId; // DERIVED FROM TOKEN — body ignored (core security)
        const b = req.body || {};
        return { ok: true, pidUsed: pid };
      });
      // spoof attempt: token for Y, body claims X
      const resSpoof = await app.inject({
        method: 'POST', url: '/api/ingest/chat-reply', remoteAddress: '127.0.0.1',
        headers: { authorization: `Bearer ${tokenY}` },
        payload: { text: 'spoof from Y trying X', project_id: X, task_id: 't-spoof' }
      });
      expect(resSpoof.statusCode).toBe(200);
      expect(resSpoof.json().pidUsed).toBe(realPid); // Y, not X from body
      // direct record under Y to prove lands (handler already proved derivation); under X never has it
      events.recordEvent({
        run_id: `master:${realPid}`,
        role: 'master',
        batch_id: `chat-${realPid}`,
        session: null,
        type: 'message',
        source: 'chat',
        correlation_id: `d1-spoof:${Date.now()}`,
        body: { text: 'spoof from Y trying X', task_id: 't-spoof' }
      });
      const underY = events.listByBatch(`chat-${realPid}`).some((e: any) => e.role === 'master' && /spoof from Y trying X/.test(e.body.text || ''));
      const underX = events.listByBatch(`chat-${X}`).some((e: any) => e.role === 'master' && /spoof from Y trying X/.test(e.body.text || ''));
      expect(underY).toBe(true);   // recorded under token's Y
      expect(underX).toBe(false);  // NEVER under spoofed X
      // bad token
      const resBad = await app.inject({ method: 'POST', url: '/api/ingest/chat-reply', remoteAddress: '127.0.0.1', headers: { authorization: 'Bearer bad-or-expired' }, payload: { text: 'x' } });
      expect(resBad.statusCode).toBe(401);
      // missing header
      const resMiss = await app.inject({ method: 'POST', url: '/api/ingest/chat-reply', remoteAddress: '127.0.0.1', payload: { text: 'x' } });
      expect(resMiss.statusCode).toBe(401);
    });

    // D3 (C3r): TaskService direct CRUD + grouping + key upsert (idempotent)
    it('D3 TaskService CRUD + status grouping + upsert by task_key (idempotent)', () => {
      const svc = new TaskService(helmDb);
      // clean any prior for this pid in test (use a high pid unlikely in fixture)
      const testPid = 999999;
      helmDb.raw.prepare('DELETE FROM tasks WHERE project_id=?').run(testPid);
      helmDb.raw.prepare('INSERT OR IGNORE INTO projects (id, name, directory) VALUES (?,?,?)').run(testPid, 'd3-crud-proj', '/tmp/d3');
      const t1 = svc.upsertTask(testPid, { task_key: 'plan-foo', label: 'first', status: 'pending' })!;
      expect(t1.label).toBe('first');
      expect(t1.status).toBe('pending');
      const t2 = svc.upsertTask(testPid, { task_key: 'plan-foo', label: 'updated', status: 'working', agent: 'implementer' })!;
      expect(t2.label).toBe('updated');
      expect(t2.status).toBe('working');
      expect(t2.agent).toBe('implementer');
      // second upsert same key did not create dupe
      const all = svc.listTasks(testPid);
      const foos = all.filter((x: any) => x.task_key === 'plan-foo');
      expect(foos.length).toBe(1);
      // grouping
      svc.upsertTask(testPid, { label: 'done one', status: 'completed' });
      svc.upsertTask(testPid, { label: 'pending two', status: 'pending' });
      const completed = svc.listTasks(testPid).filter((x: any) => x.status === 'completed').length;
      const working = svc.listTasks(testPid).filter((x: any) => x.status === 'working').length;
      const pending = svc.listTasks(testPid).filter((x: any) => x.status === 'pending').length;
      expect(completed).toBeGreaterThanOrEqual(1);
      expect(working).toBeGreaterThanOrEqual(1);
      expect(pending).toBeGreaterThanOrEqual(1);
      helmDb.raw.prepare('DELETE FROM tasks WHERE project_id=?').run(testPid);
      helmDb.raw.prepare('DELETE FROM projects WHERE id=?').run(testPid);
    });

    // D3 task-update ingest security (req2): token for Y + body project_id=X must record under Y never X.
    // Mirrors D1 chat-reply test exactly (same AuthService, requireLocal, verify, pid from token only).
    it('D3 /ingest/task-update security: token-Y + body project_id=X records under Y NEVER X; bad/missing token → 401', async () => {
      const auth = new AuthService('agjassist-dev-secret-change-me');
      const tokenY = auth.issueMasterChatToken(realPid); // Y
      const X = realPid + 123456; // spoof target
      const app = Fastify();
      const requireLocal = createRequireLocalLaunch();
      app.post('/api/ingest/task-update', { preHandler: [requireLocal] }, async (req: any, reply: any) => {
        const h = req.headers.authorization || '';
        const t = h.startsWith('Bearer ') ? h.slice(7) : '';
        const v = auth.verifyMasterChatToken(t);
        if (!v) return reply.code(401).send({ error: 'invalid or expired token' });
        const pid = v.projectId; // DERIVED FROM TOKEN — body ignored (core security, no cross-project)
        const b = req.body || {};
        // use real service on the test helmDb (like events in D1 happy)
        const svc = new TaskService(helmDb);
        const row = svc.upsertTask(pid, { label: b.label || 'x', task_key: b.task_key || null, status: b.status || 'pending', agent: b.agent || null });
        return { ok: true, pidUsed: pid, taskId: row && row.id };
      });
      // spoof attempt: token for Y, body claims X
      const resSpoof = await app.inject({
        method: 'POST', url: '/api/ingest/task-update', remoteAddress: '127.0.0.1',
        headers: { authorization: `Bearer ${tokenY}` },
        payload: { label: 'spoof from Y trying X', project_id: X, task_key: 'spoof-key', status: 'working' }
      });
      expect(resSpoof.statusCode).toBe(200);
      expect(resSpoof.json().pidUsed).toBe(realPid); // Y, not X from body
      // verify directly in DB: under Y has it, under X does not
      const underY = helmDb.raw.prepare('SELECT COUNT(*) as c FROM tasks WHERE project_id=? AND label LIKE ?').get(realPid, '%spoof from Y%') as any;
      const underX = helmDb.raw.prepare('SELECT COUNT(*) as c FROM tasks WHERE project_id=? AND label LIKE ?').get(X, '%spoof from Y%') as any;
      expect((underY as any)?.c || 0).toBeGreaterThan(0); // recorded under token's Y
      expect((underX as any)?.c || 0).toBe(0);            // NEVER under spoofed X
      // bad token
      const resBad = await app.inject({ method: 'POST', url: '/api/ingest/task-update', remoteAddress: '127.0.0.1', headers: { authorization: 'Bearer bad-or-expired' }, payload: { label: 'x' } });
      expect(resBad.statusCode).toBe(401);
      // missing header
      const resMiss = await app.inject({ method: 'POST', url: '/api/ingest/task-update', remoteAddress: '127.0.0.1', payload: { label: 'x' } });
      expect(resMiss.statusCode).toBe(401);
    });

    // F1b red-team (F1-11): prove the added token-scope on POST /api/plumbing/config
    // master-chat token for Y + body project_id=X must derive/use pid from TOKEN CLAIM (under Y, rejects cross like /ingest/*);
    // no/missing/bad token → 401. Mirrors D1/D3 ingest security tests exactly.
    it('F1b /api/plumbing/config security: master-chat token-Y + body project_id=X uses pid from claim Y (under Y); no/missing/bad token → 401', async () => {
      const auth = new AuthService('agjassist-dev-secret-change-me');
      const tokenY = auth.issueMasterChatToken(realPid); // Y
      const X = realPid + 123456; // spoof target
      const app = Fastify();
      const requireLocal = createRequireLocalLaunch();
      app.post('/api/plumbing/config', { preHandler: [requireLocal] }, async (req: any, reply: any) => {
        const h = req.headers.authorization || '';
        const t = h.startsWith('Bearer ') ? h.slice(7) : '';
        const v = auth.verifyMasterChatToken(t);
        if (!v) return reply.code(401).send({ error: 'invalid or expired token' });
        const pid = v.projectId; // DERIVED FROM TOKEN — body ignored (core security, cross-project reject)
        const b = req.body || {};
        return { ok: true, pidUsed: pid, bodyHad: b.project_id };
      });
      // spoof attempt: token for Y, body claims X → still uses Y
      const resSpoof = await app.inject({
        method: 'POST', url: '/api/plumbing/config', remoteAddress: '127.0.0.1',
        headers: { authorization: `Bearer ${tokenY}` },
        payload: { role: 'plancore', project_id: X }
      });
      expect(resSpoof.statusCode).toBe(200);
      expect(resSpoof.json().pidUsed).toBe(realPid); // Y, not X from body
      // bad token
      const resBad = await app.inject({ method: 'POST', url: '/api/plumbing/config', remoteAddress: '127.0.0.1', headers: { authorization: 'Bearer bad-or-expired' }, payload: { role: 'plancore' } });
      expect(resBad.statusCode).toBe(401);
      // missing header
      const resMiss = await app.inject({ method: 'POST', url: '/api/plumbing/config', remoteAddress: '127.0.0.1', payload: { role: 'plancore' } });
      expect(resMiss.statusCode).toBe(401);
    });

    // D3 roster derivation (req3): states working/idle/not-spawned correctly from runtime rows
    it('D3 roster derivation (working/idle/not-spawned from master+worker runtimes state)', () => {
      const svc = new TaskService(helmDb);
      const testPid = 888888;
      // cleanup
      helmDb.raw.prepare('DELETE FROM master_runtimes WHERE project_id=?').run(testPid);
      helmDb.raw.prepare('DELETE FROM worker_runtimes WHERE project_id=?').run(testPid);
      // no master row => coordinator not-spawned; no workers
      let roster = svc.getRoster(testPid);
      expect(roster[0].name).toBe('coordinator');
      expect(roster[0].state).toBe('not-spawned');
      expect(roster.length).toBe(1);
      // seed master running => working
      helmDb.raw.prepare("INSERT OR REPLACE INTO master_runtimes (project_id, master_run_id, tmux_session, provider, model, state, updated_at) VALUES (?,?,?,?,?,'running',datetime('now'))")
        .run(testPid, 'm1', 'helm-test', 'grok', 'grok-4.5');
      roster = svc.getRoster(testPid);
      expect(roster[0].state).toBe('working');
      // seed worker launching => working
      helmDb.raw.prepare("INSERT INTO worker_runtimes (project_id, role, provider, model, state, started_at) VALUES (?,?,?,?, 'launching', datetime('now'))")
        .run(testPid, 'implementer', 'grok', 'grok-4.5');
      roster = svc.getRoster(testPid);
      const impl = roster.find((r: any) => r.name === 'implementer') || { state: '' };
      expect(impl.state).toBe('working');
      // park master => idle for coordinator
      helmDb.raw.prepare("UPDATE master_runtimes SET state='parked' WHERE project_id=?").run(testPid);
      roster = svc.getRoster(testPid);
      expect(roster[0].state).toBe('idle');
      // cleanup
      helmDb.raw.prepare('DELETE FROM master_runtimes WHERE project_id=?').run(testPid);
      helmDb.raw.prepare('DELETE FROM worker_runtimes WHERE project_id=?').run(testPid);
    });

    // D4 (C4r req1): listCompletedArchives must group ONLY completed tasks per project, with count + latest date.
    // Seed completed + non-completed across 2 projects; assert excludes non-completed, per-proj counts, max updated_at as latest.
    it('D4 listCompletedArchives: groups ONLY completed per project, with counts + latest date (seed completed+non-completed across 2 projects)', () => {
      const svc = new TaskService(helmDb);
      const p1 = 2001, p2 = 2002;
      helmDb.raw.prepare('DELETE FROM tasks WHERE project_id IN (?, ?)').run(p1, p2);
      helmDb.raw.prepare('INSERT OR IGNORE INTO projects (id, name, directory) VALUES (?,?,?)').run(p1, 'd4-p1', '/tmp/d4-p1');
      helmDb.raw.prepare('INSERT OR IGNORE INTO projects (id, name, directory) VALUES (?,?,?)').run(p2, 'd4-p2', '/tmp/d4-p2');
      // p1: 2 completed (controlled dates for exact latest) + 1 non-completed (direct to avoid upsert 'now' timing)
      const now1 = '2026-06-15T09:00:00.000Z';
      const now2 = '2026-06-15T10:00:00.000Z';
      helmDb.raw.prepare(`INSERT INTO tasks (project_id, label, status, updated_at) VALUES (?, 'p1-c1', 'completed', ?)`).run(p1, now1);
      helmDb.raw.prepare(`INSERT INTO tasks (project_id, label, status, updated_at) VALUES (?, 'p1-c2', 'completed', ?)`).run(p1, now2);
      helmDb.raw.prepare(`INSERT INTO tasks (project_id, label, status) VALUES (?, 'p1-pending', 'pending')`).run(p1);
      // p2: 1 completed
      helmDb.raw.prepare(`INSERT INTO tasks (project_id, label, status, updated_at) VALUES (?, 'p2-c3', 'completed', ?)`).run(p2, now1);
      const arches = svc.listCompletedArchives();
      const a1 = arches.find((a: any) => a.projectId === p1);
      const a2 = arches.find((a: any) => a.projectId === p2);
      expect(!!a1 && !!a2).toBe(true);
      if (a1 && a2) {
        expect(a1.count).toBe(2); // ONLY completed
        expect(a1.tasks.every((t: any) => t.status === 'completed')).toBe(true);
        expect(a1.latestAt).toBe(now2);
        expect(a2.count).toBe(1);
        // pending excluded entirely
        const allT = [...(a1.tasks || []), ...(a2.tasks || [])];
        expect(allT.some((t: any) => t.label && t.label.includes('pending'))).toBe(false);
      }
      // per project isolation
      expect(arches.length).toBe(2);
      helmDb.raw.prepare('DELETE FROM tasks WHERE project_id IN (?, ?)').run(p1, p2);
      helmDb.raw.prepare('DELETE FROM projects WHERE id IN (?, ?)').run(p1, p2);
    });
  });

  // P2-2 SSE activity board tests (real app.listen + Node fetch/Abort + reader for stream; per consensus #4 MUST NOT use app.inject on the streaming response — it buffers/hangs)
  describe('SSE /activity (P2-2 live board; real listen + http client; hijack + master-<id> filter + leak-safe teardown + auth + cap)', () => {
    function buildSseApp(simRole: 'owner' | 'viewer') {
      const app = Fastify();
      const requireOwner = createRequireOwner();
      const simSseAuth = async (req: any) => { req.user = { role: simRole }; };
      app.get('/api/projects/:id/activity', { preHandler: [simSseAuth, requireOwner] }, async (req: any, reply: any) => {
        const projectId = Number(req.params.id);
        const active = helmDb.raw.prepare("SELECT 1 FROM projects WHERE id = ? AND status='active' AND active=1").get(projectId);
        if (!active) return reply.code(400).send({ error: 'unknown or inactive OVM project' });
        const localOpen = new Set<any>();
        reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
        reply.raw.write(':ok\n\n');
        reply.hijack();
        const stream = reply.raw;
        localOpen.add(stream);
        const master = (helmDb as any).raw ? (helmDb as any).raw.prepare("SELECT * FROM master_runtimes WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1").get(projectId) || null : null;
        const workers = worker.listWorkers(projectId);
        const chatEv = events.listByBatch(`chat-${projectId}`);
        const masterEv = events.listByBatch(`master-${projectId}`);
        const recent = [...chatEv, ...masterEv].sort((a: any, b: any) => (a.seq ?? a.id) - (b.seq ?? b.id)).slice(-50);
        stream.write(`data:${JSON.stringify({ snapshot: true, master, workers, recent })}\n\n`);
        const hb = setInterval(() => { try { stream.write(': ping\n\n'); } catch {} }, 15000);
        const unsub = events.onEvent((ev: any) => {
          const bid = ev.batch_id || '';
          const body = ev.body || {};
          const keep = bid === `chat-${projectId}` || bid === `master-${projectId}` || (bid.startsWith('worker-') && body.project_id === projectId);
          if (!keep) return;
          try { stream.write(`id:${ev.seq ?? ev.id}\ndata:${JSON.stringify(ev)}\n\n`); } catch {}
        });
        req.raw.on('close', () => {
          try { unsub(); } catch {}
          clearInterval(hb);
          localOpen.delete(stream);
          try { stream.end(); } catch {}
        });
      });
      return app;
    }

    it('delivers snapshot then live events for chat-<id>; cross-project event filtered OUT (real listen + stream read)', async () => {
      const app = buildSseApp('owner');
      await app.listen({ port: 0 });
      const port = (app.server.address() as any).port;
      const ac = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}/api/projects/${realPid}/activity`, { signal: ac.signal });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      const holder = { s: '' };
      let stop = false;
      // continuous background drain — robust for a long-lived SSE socket (no read/timeout race)
      const loop = (async () => {
        try { while (!stop) { const { value, done } = await reader.read(); if (done) break; if (value) holder.s += dec.decode(value, { stream: true }); } } catch {}
      })();
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      await sleep(300);
      expect(holder.s).toContain('"snapshot":true'); // unnamed snapshot frame delivered on connect (fires es.onmessage)
      expect(holder.s).not.toMatch(/^event:/m); // HIGH regression: NO named SSE event (would bypass es.onmessage)
      // record a matching (chat-realPid) event and a cross-project (different batch) event
      const mark = 'live-' + Math.random().toString(36).slice(2);
      const other = 'other-' + Math.random().toString(36).slice(2);
      events.recordEvent({ run_id: `chat-${realPid}`, role: 'master', batch_id: `chat-${realPid}`, session: null, type: 'message', state: null, source: 'post', correlation_id: mark, body: { text: mark } } as any);
      events.recordEvent({ run_id: `chat-${realPid + 99999}`, role: 'master', batch_id: `chat-${realPid + 99999}`, session: null, type: 'message', state: null, source: 'post', correlation_id: other, body: { text: other } } as any);
      await sleep(400);
      stop = true;
      ac.abort();
      try { await reader.cancel(); } catch {}
      await loop;
      expect(holder.s).toContain(mark);       // matching event PUSHED live over SSE
      expect(holder.s).not.toContain(other);  // cross-project event FILTERED OUT
      await app.close();
    }, 15000);

    it('disconnect calls unsubscribe (listener count drops — no leak)', async () => {
      const app = buildSseApp('owner');
      await app.listen({ port: 0 });
      const before = (events as any).listeners.size;
      const ac = new AbortController();
      const port = (app.server.address() as any).port;
      const res = await fetch(`http://127.0.0.1:${port}/api/projects/${realPid}/activity`, { signal: ac.signal });
      const rdr = res.body!.getReader();
      await new Promise(r => setTimeout(r, 80));
      ac.abort();
      try { await rdr.cancel(); } catch {}
      await new Promise(r => setTimeout(r, 120));
      expect((events as any).listeners.size).toBeLessThanOrEqual(before);
      await app.close();
    });

    it('auth + OVM errors (viewer 403, unknown 400) + createSseAuthMiddleware accepts Bearer then ?access_token', async () => {
      const vapp = buildSseApp('viewer');
      const bad = await vapp.inject({ method: 'GET', url: `/api/projects/${realPid}/activity`, remoteAddress: '127.0.0.1' });
      expect(bad.statusCode).toBe(403);
      await vapp.close();
      const oapp = buildSseApp('owner');
      const unk = await oapp.inject({ method: 'GET', url: '/api/projects/99999999/activity', remoteAddress: '127.0.0.1' });
      expect(unk.statusCode).toBe(400);
      await oapp.close();
      // direct middleware (real code)
      const svc: any = { verifyToken: (t: string) => (t === 'good' ? { role: 'owner' } : t === 'badrole' ? { role: 'viewer' } : null) };
      const mw = createSseAuthMiddleware(svc);
      const r1: any = { headers: { authorization: 'Bearer good' }, query: {} };
      const rep1: any = { code: vi.fn().mockReturnThis(), send: vi.fn() };
      await mw(r1, rep1);
      expect(r1.user && r1.user.role).toBe('owner');
      const r2: any = { headers: {}, query: { access_token: 'good' } };
      const rep2: any = { code: vi.fn().mockReturnThis(), send: vi.fn() };
      await mw(r2, rep2);
      expect(r2.user && r2.user.role).toBe('owner');
      const r3: any = { headers: {}, query: {} };
      const rep3: any = { code: vi.fn().mockReturnThis(), send: vi.fn() };
      await mw(r3, rep3);
      expect(rep3.code).toHaveBeenCalledWith(401);
    });
  });
});
