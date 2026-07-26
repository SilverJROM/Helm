import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseService } from './db/database.js';
import { MemoryService } from './services/memory-service.js';
import { SCHEMA_VERSION } from './db/schema.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-e1-memory-'));
  const dbPath = path.join(dir, 'test.db');
  return {
    dbPath,
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  };
}

describe('E1 MemoryService (M1 + M2-backend): app + project scopes; propose→approve; JIT query; cross write-silo / read-allow', () => {
  let dbPath: string;
  let cleanup: () => void;
  let dbs: DatabaseService;
  let ms: MemoryService;
  let projA: number;
  let projB: number;

  beforeEach(() => {
    const t = makeTempDb();
    dbPath = t.dbPath;
    cleanup = t.cleanup;
    dbs = new DatabaseService(dbPath); // triggers fresh v16 (memories present)
    ms = new MemoryService(dbs);

    // Seed two projects for scope + cross tests (FK)
    dbs.raw.prepare("INSERT INTO projects (name, directory) VALUES (?,?)").run('E1-ProjA', '/tmp/e1a');
    dbs.raw.prepare("INSERT INTO projects (name, directory) VALUES (?,?)").run('E1-ProjB', '/tmp/e1b');
    const pa = dbs.raw.prepare('SELECT id FROM projects WHERE name = ?').get('E1-ProjA') as any;
    const pb = dbs.raw.prepare('SELECT id FROM projects WHERE name = ?').get('E1-ProjB') as any;
    projA = pa.id;
    projB = pb.id;
  });

  afterEach(() => {
    cleanup();
  });

  it('fresh DB yields SCHEMA_VERSION=16 + memories table + idx (two-track)', () => {
    const ver = (dbs.raw.prepare("SELECT version FROM schema_version").get() as any).version;
    expect(ver).toBe(SCHEMA_VERSION);
    const has = !!dbs.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories'").get();
    expect(has).toBe(true);
    const idx = dbs.raw.prepare("PRAGMA index_list(memories)").all() as any[];
    expect(idx.some((i: any) => i.name === 'idx_memories_scope_proj_status')).toBe(true);
  });

  it('AGENT-proposed app memory starts status=proposed; owner approve flips to approved; queryMemory returns ONLY approved (proposals excluded)', () => {
    // Simulate agent propose path (app, approved=false)
    const proposed = ms.createMemory(
      { scope: 'app', title: 'Agent Proposed App Note', description: 'from agent', type: 'feedback', body: 'body for jit' },
      { approved: false }
    );
    expect(proposed).toBeTruthy();
    expect(proposed!.status).toBe('proposed');
    expect(proposed!.project_id).toBeNull();
    expect(proposed!.scope).toBe('app');

    // query before approve: proposal NOT returned (only approved)
    const before = ms.queryMemory({ project_id: projA, q: '' });
    expect(before.find((m) => m.id === proposed!.id)).toBeUndefined();

    // Owner approves
    const approved = ms.approveMemory(proposed!.id);
    expect(approved).toBeTruthy();
    expect(approved!.status).toBe('approved');

    // Now query returns it (for any project, as app)
    const after = ms.queryMemory({ project_id: projA });
    expect(after.some((m) => m.id === approved!.id && m.status === 'approved')).toBe(true);

    // proposals still excluded from query even after other approved exist
    const stillProposed = ms.listMemories({ status: 'proposed', scope: 'app' });
    expect(stillProposed.length).toBe(0); // we approved the only one
  });

  it('queryMemory returns ONLY approved app + this-project (other project excluded; proposals never served)', () => {
    // approved app
    ms.createMemory({ scope: 'app', title: 'Global Approved Ref', body: 'ref for all' }, { approved: true });
    // approved this-proj (A)
    ms.createMemory({ scope: 'project', project_id: projA, title: 'ProjA Note', body: 'a only' }, { approved: true });
    // approved other-proj (B)
    ms.createMemory({ scope: 'project', project_id: projB, title: 'ProjB Secret', body: 'b only' }, { approved: true });
    // proposed app (should never appear in query)
    ms.createMemory({ scope: 'app', title: 'Proposed App Hidden', body: 'never' }, { approved: false });

    const forA = ms.queryMemory({ project_id: projA, q: '' });
    const titlesForA = forA.map((m) => m.title);
    expect(titlesForA).toContain('Global Approved Ref');
    expect(titlesForA).toContain('ProjA Note');
    expect(titlesForA).not.toContain('ProjB Secret');
    expect(forA.every((m) => m.status === 'approved')).toBe(true);

    const forB = ms.queryMemory({ project_id: projB });
    const titlesForB = forB.map((m) => m.title);
    expect(titlesForB).toContain('Global Approved Ref');
    expect(titlesForB).toContain('ProjB Secret');
    expect(titlesForB).not.toContain('ProjA Note');

    // q match ranks (title > desc > body)
    const ranked = ms.queryMemory({ project_id: projA, q: 'ref' });
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0].title).toMatch(/Global.*Ref|Ref/); // high score on title
  });

  it('cross-project WRITE rejected (token claim only / enforceProjectId); cross-project READ allowed (owner list other pid)', () => {
    // cross write attempt (claim A, trying project B) -> reject
    expect(() =>
      ms.createMemory(
        { scope: 'project', project_id: projB, title: 'Cross Write Bad', body: 'x' },
        { approved: true, claimProjectId: projA }
      )
    ).toThrow(/cross-project write rejected/);

    // good create for A
    const goodA = ms.createMemory(
      { scope: 'project', project_id: projA, title: 'A Owned', body: 'ok' },
      { approved: true, claimProjectId: projA }
    );
    expect(goodA).toBeTruthy();

    // cross READ allowed: owner (no claim) lists other project explicitly
    const bList = ms.listMemories({ scope: 'project', project_id: projB, status: 'approved' });
    // (even if none yet, the call succeeds without cross error — read allowed)
    expect(Array.isArray(bList)).toBe(true);

    // create one in B, then list from "A context" still sees B's (cross read)
    ms.createMemory({ scope: 'project', project_id: projB, title: 'B Owned Readable', body: 'ref' }, { approved: true });
    const bVisible = ms.listMemories({ scope: 'project', project_id: projB });
    expect(bVisible.some((m) => m.title.includes('B Owned'))).toBe(true);
  });

  it('CRUD + approve/reject + list filters + project scope always approved', () => {
    const created = ms.createMemory({ scope: 'project', project_id: projA, title: 'CRUD Test', description: 'd', body: 'b' });
    expect(created!.status).toBe('approved'); // project always approved

    const got = ms.getMemory(created!.id);
    expect(got!.title).toBe('CRUD Test');

    const updated = ms.updateMemory(created!.id, { title: 'CRUD Updated', status: 'approved' });
    expect(updated!.title).toBe('CRUD Updated');

    const listed = ms.listMemories({ scope: 'project', project_id: projA });
    expect(listed.length).toBeGreaterThan(0);

    ms.rejectMemory(created!.id); // deletes proposal/rejected
    expect(ms.getMemory(created!.id)).toBeUndefined(); // sqlite .get() returns undefined (not null) when no row; consistent with service cast + TaskService patterns
  });

  // E-b2: horizon per-project split query (G13)
  it('E-b2: listProjectMemoriesByHorizon + list filters return split short/long per project only', () => {
    // seed mixed
    ms.createMemory({ scope: 'project', project_id: projA, title: 'pA-short-1', horizon: 'short' } as any);
    ms.createMemory({ scope: 'project', project_id: projA, title: 'pA-long-1', horizon: 'long' } as any);
    ms.createMemory({ scope: 'project', project_id: projA, title: 'pA-long-2', horizon: 'long' } as any);
    ms.createMemory({ scope: 'project', project_id: projB, title: 'pB-short', horizon: 'short' } as any);
    const splitA = ms.listProjectMemoriesByHorizon(projA);
    expect(splitA.shortTerm.map(m => m.title)).toContain('pA-short-1');
    expect(splitA.longTerm.map(m => m.title).sort()).toEqual(['pA-long-1', 'pA-long-2']);
    expect(splitA.shortTerm.every(m => m.project_id === projA && m.horizon === 'short')).toBe(true);
    expect(splitA.longTerm.every(m => m.project_id === projA && m.horizon === 'long')).toBe(true);
    const splitB = ms.listProjectMemoriesByHorizon(projB);
    expect(splitB.shortTerm.length).toBe(1);
    expect(splitB.longTerm.length).toBe(0);
    // list with horizon also works
    const onlyShortA = ms.listMemories({ scope: 'project', project_id: projA, horizon: 'short' });
    expect(onlyShortA.length).toBe(1);
  });

  // B6: agent-meta scope (v39 memories.agent_id)
  it('B6: fresh DB has agent_id column + agent scope list/create/filter', () => {
    const mcols = dbs.raw.prepare('PRAGMA table_info(memories)').all().map((c: any) => c.name);
    expect(mcols).toContain('agent_id');

    dbs.raw.prepare("INSERT INTO agents (name, provider, model, default_effort, spawn_pref) VALUES (?,?,?,?,?)").run('b6-test-agent', 'grok', 'grok-4.5', 'medium', 'tmux');
    const agent = dbs.raw.prepare("SELECT id FROM agents WHERE name = 'b6-test-agent'").get() as { id: number };

    expect(() =>
      ms.createMemory({ scope: 'agent', title: 'missing agent_id' } as any)
    ).toThrow(/agent_id is required/);

    const created = ms.createMemory({
      scope: 'agent',
      agent_id: agent.id,
      title: 'Agent meta note',
      description: 'purple scope',
      type: 'user',
      body: 'agent-scoped body',
    });
    expect(created).toBeTruthy();
    expect(created!.scope).toBe('agent');
    expect(created!.agent_id).toBe(agent.id);
    expect(created!.project_id).toBeNull();
    expect(created!.status).toBe('approved');

    const listed = ms.listMemories({ scope: 'agent', agent_id: agent.id });
    expect(listed.some((m) => m.id === created!.id)).toBe(true);

    dbs.raw.prepare("INSERT INTO agents (name, provider, model, default_effort, spawn_pref) VALUES (?,?,?,?,?)").run('b6-other-agent', 'grok', 'grok-4.5', 'medium', 'tmux');
    const other = dbs.raw.prepare("SELECT id FROM agents WHERE name = 'b6-other-agent'").get() as { id: number };
    ms.createMemory({ scope: 'agent', agent_id: other.id, title: 'Other agent note', body: 'x' });
    const filtered = ms.listMemories({ scope: 'agent', agent_id: agent.id });
    expect(filtered.every((m) => m.agent_id === agent.id)).toBe(true);
    expect(filtered.some((m) => m.title === 'Other agent note')).toBe(false);
  });
});
