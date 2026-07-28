import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { DatabaseService } from '../db/database.js';
import { SCHEMA_VERSION } from '../db/schema.js';
import { SessionRegistryService, deriveSessionKind, deriveSessionOwner } from './session-registry-service.js';
import { WorkerService } from './worker-service.js';

function makeTempDb(): { db: DatabaseService; cleanup: () => void } {
  const dbPath = path.join(os.tmpdir(), `helm-slr-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = new DatabaseService(dbPath);
  return {
    db,
    cleanup: () => {
      try { db.close(); } catch {}
      for (const suf of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + suf); } catch {} }
    }
  };
}

describe('SL-R1/R2 SessionRegistryService', () => {
  let db: DatabaseService;
  let cleanup: () => void;
  let reg: SessionRegistryService;

  beforeEach(() => {
    const t = makeTempDb();
    db = t.db;
    cleanup = t.cleanup;
    reg = new SessionRegistryService(db);
  });
  afterEach(() => cleanup());

  it('register-on-create sets status active + derives kind + list/get', () => {
    reg.register('helm-batch-A1-implementer-abc123', { owner: 'helm' });
    const row = reg.get('helm-batch-A1-implementer-abc123');
    expect(row).toBeTruthy();
    expect(row!.status).toBe('active');
    expect(row!.kind).toBe('implementer');
    expect(row!.created_at).toBeTruthy();
    expect(reg.list().length).toBe(1);
  });

  it('kind derivation covers canonical phase brains and treats retired names as other', () => {
    const cases: Array<[string, string]> = [
      ['helm-plancore-cards', 'plancore'],
      ['helm-ibrain-cards', 'ibrain'],
      ['helm-discovery-cards', 'discovery'],
      ['helm-projcore-cards', 'other'],
      ['helm-pm-cards', 'other'],
      ['helm-preflight-seat-binary', 'preflight'],
      ['helm-p5b-test-xyz', 'test'],
      ['helm-w-cards-42', 'worker'],
      ['helm-batch-A1-validator-deadbe', 'validator'],
      ['helm-something-random', 'other'],
      ['03_impl_grokbuild_rscf', 'other'],
    ];

    for (const [name, expected] of cases) {
      expect(deriveSessionKind(name)).toBe(expected);
    }

    // non-helm names still classify but the janitor never touches them (guardrail is name-prefix).
  });

  it('markIdle then markReaped transition (idle → reaped, ended_at set)', () => {
    reg.register('helm-w-cards-7', { owner: 'helm' });
    reg.markIdle('helm-w-cards-7', 'run-terminal');
    expect(reg.get('helm-w-cards-7')!.status).toBe('idle');
    reg.markReaped('helm-w-cards-7', 'janitor-ttl');
    const row = reg.get('helm-w-cards-7')!;
    expect(row.status).toBe('reaped');
    expect(row.ended_at).toBeTruthy();
    expect(row.reason).toBe('janitor-ttl');
  });

  it('register is last-wins (re-create resets a reaped row to active)', () => {
    reg.register('helm-w-cards-9', { owner: 'helm' });
    reg.markReaped('helm-w-cards-9');
    expect(reg.get('helm-w-cards-9')!.status).toBe('reaped');
    reg.register('helm-w-cards-9', { owner: 'helm' });
    const row = reg.get('helm-w-cards-9')!;
    expect(row.status).toBe('active');
    expect(row.ended_at).toBeNull();
    // still one row (UNIQUE name upsert)
    expect(reg.list().filter((r) => r.name === 'helm-w-cards-9').length).toBe(1);
  });

  it('enrich fills run_id / project_id / kind', () => {
    reg.register('helm-batch-A1-implementer-z', { owner: 'helm' });
    reg.enrich('helm-batch-A1-implementer-z', { runId: 55, projectId: 3 });
    const row = reg.get('helm-batch-A1-implementer-z')!;
    expect(row.run_id).toBe(55);
    expect(row.project_id).toBe(3);
  });

  // A2 (R4.16): planning seats must land in helm_sessions with both ids at register time
  // (the createSession choke point calls register with opts — this is the DB half of that contract).
  it('A2: register of a planning seat with projectId+runId stores both ids (not NULL)', () => {
    reg.register('helm-batch-A2-plancore-abc12', { owner: 'helm', projectId: 42, runId: 99, kind: 'plancore' });
    reg.register('helm-batch-A2-partner-def34', { owner: 'helm', projectId: 42, runId: 99, kind: 'deliberation' });
    const plancore = reg.get('helm-batch-A2-plancore-abc12')!;
    const partner = reg.get('helm-batch-A2-partner-def34')!;
    expect(plancore.project_id).toBe(42);
    expect(plancore.run_id).toBe(99);
    expect(plancore.kind).toBe('plancore');
    expect(plancore.status).toBe('active');
    expect(partner.project_id).toBe(42);
    expect(partner.run_id).toBe(99);
    expect(partner.kind).toBe('deliberation');
  });
});

// ---------------------------------------------------------------------------
// S04 / AC1 — helm_sessions.owner column, CHECK, round-trip, upsert authority preserve.
// Synthetic DB only; HELM_SESSION_JANITOR stays 0; never touch live data/helm.db.
// ---------------------------------------------------------------------------
describe('S04 helm_sessions.owner (AC1)', () => {
  let db: DatabaseService;
  let cleanup: () => void;
  let reg: SessionRegistryService;
  let liveMtimeBefore: number | null;

  beforeEach(() => {
    const livePath = path.join(process.cwd(), 'data', 'helm.db');
    liveMtimeBefore = fs.existsSync(livePath) ? fs.statSync(livePath).mtimeMs : null;
    const t = makeTempDb();
    db = t.db;
    cleanup = t.cleanup;
    reg = new SessionRegistryService(db);
  });
  afterEach(() => {
    cleanup();
    const livePath = path.join(process.cwd(), 'data', 'helm.db');
    if (liveMtimeBefore != null && fs.existsSync(livePath)) {
      expect(fs.statSync(livePath).mtimeMs).toBe(liveMtimeBefore);
    }
  });

  it('fresh DB: owner column present, SCHEMA_VERSION ≥ 102', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(102);
    const ver = (db.raw.prepare('SELECT version FROM schema_version').get() as any).version;
    expect(ver).toBe(SCHEMA_VERSION);
    const cols = db.raw.prepare('PRAGMA table_info(helm_sessions)').all().map((c: any) => c.name);
    expect(cols).toContain('owner');
    reg.register('helm-w-owner-ok', { owner: 'helm' });
    expect(reg.get('helm-w-owner-ok')!.owner).toBe('helm');
  });

  // S05: direct register without owner refuses (defensive; create-path is pre-spawn).
  it('S05: register() without owner throws', () => {
    expect(() => reg.register('helm-w-no-owner' as any, {} as any)).toThrow(/owner required/);
    expect(() => reg.register('helm-w-no-owner2', { owner: undefined as any })).toThrow(/owner required/);
    expect(() => reg.register('helm-w-bad-owner', { owner: 'robot' as any })).toThrow(/owner required/);
    expect(reg.get('helm-w-no-owner')).toBeFalsy();
  });

  it('owner round-trip: helm | human | legacy:unknown', () => {
    reg.register('helm-w-owner-helm', { owner: 'helm', kind: 'worker' });
    reg.register('helm-discovery-owner-human', { owner: 'human', kind: 'discovery' });
    reg.register('helm-legacy-seat', { owner: 'legacy:unknown', kind: 'other' });
    expect(reg.get('helm-w-owner-helm')!.owner).toBe('helm');
    expect(reg.get('helm-discovery-owner-human')!.owner).toBe('human');
    expect(reg.get('helm-legacy-seat')!.owner).toBe('legacy:unknown');
  });

  it('CHECK rejects invalid owner values', () => {
    expect(() => {
      db.raw.prepare(
        `INSERT INTO helm_sessions (name, kind, owner, status) VALUES ('helm-bad-owner', 'test', 'robot', 'active')`
      ).run();
    }).toThrow();
  });

  it('recreated-name upsert keeps authority when owner re-asserted; omit throws (S05)', () => {
    reg.register('helm-w-cards-auth', { owner: 'helm', projectId: 1, runId: 10 });
    expect(reg.get('helm-w-cards-auth')!.owner).toBe('helm');
    reg.markReaped('helm-w-cards-auth', 'test-reap');
    // S05: re-register without owner refuses (no silent null authority).
    expect(() => reg.register('helm-w-cards-auth', { projectId: 1, runId: 11 } as any)).toThrow(/owner required/);
    // Re-register with explicit owner resets to active + keeps/sets authority.
    reg.register('helm-w-cards-auth', { owner: 'helm', projectId: 1, runId: 11 });
    const row = reg.get('helm-w-cards-auth')!;
    expect(row.status).toBe('active');
    expect(row.owner).toBe('helm');
    expect(row.ended_at).toBeNull();
    // Explicit new owner may update authority (not silent drop — intentional set).
    reg.register('helm-w-cards-auth', { owner: 'human' });
    expect(reg.get('helm-w-cards-auth')!.owner).toBe('human');
  });

  it('v100→SCHEMA_VERSION synthetic fixture: adds owner column; S07 backfills proven worker; CHECK holds', () => {
    const fixturePath = path.join(os.tmpdir(), `helm-s04-v100-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    try {
      const raw = new Database(fixturePath);
      raw.exec(`
        CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
        INSERT INTO schema_version (version) VALUES (100);
        CREATE TABLE helm_sessions (
          id INTEGER PRIMARY KEY,
          name TEXT UNIQUE NOT NULL,
          kind TEXT,
          project_id INTEGER,
          run_id INTEGER,
          status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','idle','reaped')),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_used_at TEXT,
          ended_at TEXT,
          reason TEXT
        );
        INSERT INTO helm_sessions (name, kind, status) VALUES ('helm-pre-s04', 'worker', 'active');
      `);
      raw.close();

      const migrated = new DatabaseService(fixturePath);
      const ver = (migrated.raw.prepare('SELECT version FROM schema_version').get() as any).version;
      expect(ver).toBe(SCHEMA_VERSION);
      const cols = migrated.raw.prepare('PRAGMA table_info(helm_sessions)').all().map((c: any) => c.name);
      expect(cols).toContain('owner');
      // S07 v102: proven worker name+kind is backfilled to helm (no longer left null after full migrate).
      const pre = migrated.raw.prepare(`SELECT owner FROM helm_sessions WHERE name = 'helm-pre-s04'`).get() as any;
      expect(pre.owner).toBe('helm');
      // CHECK still rejects bad values after upgrade.
      expect(() => {
        migrated.raw.prepare(
          `INSERT INTO helm_sessions (name, owner, status) VALUES ('helm-bad-mig', 'robot', 'active')`
        ).run();
      }).toThrow();
      // Allowed values write after upgrade.
      migrated.raw.prepare(
        `INSERT INTO helm_sessions (name, owner, status) VALUES ('helm-ok-mig', 'helm', 'active')`
      ).run();
      expect(
        (migrated.raw.prepare(`SELECT owner FROM helm_sessions WHERE name = 'helm-ok-mig'`).get() as any).owner
      ).toBe('helm');
      migrated.close();
    } finally {
      for (const suf of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(fixturePath + suf); } catch {}
      }
    }
  });
});

// ---------------------------------------------------------------------------
// S07 / AC5 — fail-safe owner backfill (v102) + query-level Helm-owned exclusion.
// Synthetic/copied fixtures only; HELM_SESSION_JANITOR=0; live data/helm.db mtime untouched.
// ---------------------------------------------------------------------------
describe('S07 owner backfill v102 + listHelmOwnedCandidates (AC5)', () => {
  let liveMtimeBefore: number | null;

  beforeEach(() => {
    const livePath = path.join(process.cwd(), 'data', 'helm.db');
    liveMtimeBefore = fs.existsSync(livePath) ? fs.statSync(livePath).mtimeMs : null;
  });
  afterEach(() => {
    const livePath = path.join(process.cwd(), 'data', 'helm.db');
    if (liveMtimeBefore != null && fs.existsSync(livePath)) {
      expect(fs.statSync(livePath).mtimeMs).toBe(liveMtimeBefore);
    }
  });

  it('deriveSessionOwner fail-safe table: proven human/helm only; ambiguous → legacy:unknown', () => {
    const cases: Array<[string, string | null | undefined, string]> = [
      // human
      ['helm-discovery-cards', null, 'human'],
      ['helm-discovery-cards', 'discovery', 'human'],
      ['helm-chat-discovery-ab12cd', null, 'human'],
      ['helm-chat-p3-discovery-ab12cd', 'other', 'human'],
      ['helm-batch-A1-discovery-x1', null, 'human'],
      // helm brains / workers / preflight / tests
      ['helm-plancore-cards', null, 'helm'],
      ['helm-ibrain-cards', 'ibrain', 'helm'],
      ['helm-preflight-codex-abc', null, 'helm'],
      ['helm-w-cards-7', null, 'helm'],
      ['helm-batch-A1-implementer-abc123', null, 'helm'],
      ['helm-batch-A2-validator-def', null, 'helm'],
      ['helm-model-probe-test', null, 'helm'],
      ['helm-weird-name', 'worker', 'helm'], // context: proven kind + helm- prefix
      // ambiguous / non-helm → legacy
      ['helm-weird-name', 'other', 'legacy:unknown'],
      ['helm-weird-name', null, 'legacy:unknown'],
      ['not-helm-session', 'worker', 'legacy:unknown'],
      ['', null, 'legacy:unknown'],
    ];
    for (const [name, kind, expected] of cases) {
      expect(deriveSessionOwner(name, kind)).toBe(expected);
    }
  });

  it('v101→v102 reality-shaped fixture: backfills proven owners; ambiguous→legacy; counts preserved; idempotent', () => {
    const fixturePath = path.join(os.tmpdir(), `helm-s07-v101-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const seed = [
      { name: 'helm-discovery-proj-1', kind: 'discovery' },
      { name: 'helm-chat-discovery-aa11bb', kind: 'other' },
      { name: 'helm-w-cards-42', kind: 'worker' },
      { name: 'helm-plancore-cards', kind: 'plancore' },
      { name: 'helm-ibrain-cards', kind: 'ibrain' },
      { name: 'helm-preflight-codex-xyz', kind: 'other' }, // pre-S06 misclassified as other; name still proven
      { name: 'helm-ambiguous-seat', kind: 'other' },
      { name: 'random-tmux-name', kind: null },
    ] as const;

    try {
      const raw = new Database(fixturePath);
      raw.exec(`
        CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
        INSERT INTO schema_version (version) VALUES (101);
        CREATE TABLE helm_sessions (
          id INTEGER PRIMARY KEY,
          name TEXT UNIQUE NOT NULL,
          kind TEXT,
          project_id INTEGER,
          run_id INTEGER,
          owner TEXT CHECK(owner IS NULL OR owner IN ('helm','human','legacy:unknown')),
          status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','idle','reaped')),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_used_at TEXT,
          ended_at TEXT,
          reason TEXT
        );
      `);
      const ins = raw.prepare(
        `INSERT INTO helm_sessions (name, kind, owner, status) VALUES (?, ?, NULL, 'active')`
      );
      for (const row of seed) ins.run(row.name, row.kind);
      // Pre-set authority must not be rewritten by backfill.
      raw.prepare(
        `INSERT INTO helm_sessions (name, kind, owner, status) VALUES ('helm-w-already-human', 'worker', 'human', 'active')`
      ).run();
      const countBefore = (raw.prepare(`SELECT COUNT(*) AS c FROM helm_sessions`).get() as any).c;
      raw.close();

      const migrated = new DatabaseService(fixturePath);
      const ver = (migrated.raw.prepare('SELECT version FROM schema_version').get() as any).version;
      expect(ver).toBe(SCHEMA_VERSION);
      expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(102);

      const countAfter = (migrated.raw.prepare(`SELECT COUNT(*) AS c FROM helm_sessions`).get() as any).c;
      expect(countAfter).toBe(countBefore);

      const ownerOf = (name: string) =>
        (migrated.raw.prepare(`SELECT owner FROM helm_sessions WHERE name = ?`).get(name) as any).owner;

      expect(ownerOf('helm-discovery-proj-1')).toBe('human');
      expect(ownerOf('helm-chat-discovery-aa11bb')).toBe('human');
      expect(ownerOf('helm-w-cards-42')).toBe('helm');
      expect(ownerOf('helm-plancore-cards')).toBe('helm');
      expect(ownerOf('helm-ibrain-cards')).toBe('helm');
      expect(ownerOf('helm-preflight-codex-xyz')).toBe('helm');
      expect(ownerOf('helm-ambiguous-seat')).toBe('legacy:unknown');
      expect(ownerOf('random-tmux-name')).toBe('legacy:unknown');
      // Already-set owner preserved (WHERE owner IS NULL only).
      expect(ownerOf('helm-w-already-human')).toBe('human');

      // Null owners fully drained by backfill.
      const stillNull = (migrated.raw.prepare(
        `SELECT COUNT(*) AS c FROM helm_sessions WHERE owner IS NULL`
      ).get() as any).c;
      expect(stillNull).toBe(0);

      migrated.close();

      // Idempotent: second open leaves owners + version unchanged.
      const again = new DatabaseService(fixturePath);
      expect((again.raw.prepare('SELECT version FROM schema_version').get() as any).version).toBe(SCHEMA_VERSION);
      const ownerOf2 = (name: string) =>
        (again.raw.prepare(`SELECT owner FROM helm_sessions WHERE name = ?`).get(name) as any).owner;
      expect(ownerOf2('helm-ambiguous-seat')).toBe('legacy:unknown');
      expect(ownerOf2('helm-w-cards-42')).toBe('helm');
      expect(ownerOf2('helm-w-already-human')).toBe('human');
      again.close();
    } finally {
      for (const suf of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(fixturePath + suf); } catch {}
      }
    }
  });

  it('listHelmOwnedCandidates SQL-excludes human, legacy:unknown, and null', () => {
    const t = makeTempDb();
    try {
      const reg = new SessionRegistryService(t.db);
      reg.register('helm-w-helm-only', { owner: 'helm', kind: 'worker' });
      reg.register('helm-discovery-human', { owner: 'human', kind: 'discovery' });
      reg.register('helm-legacy-x', { owner: 'legacy:unknown', kind: 'other' });
      // Force a null owner row past register() to prove SQL exclusion.
      t.db.raw.prepare(
        `INSERT INTO helm_sessions (name, kind, owner, status) VALUES ('helm-null-owner', 'other', NULL, 'active')`
      ).run();

      const all = reg.list();
      expect(all.length).toBe(4);

      const helmOnly = reg.listHelmOwnedCandidates();
      expect(helmOnly.map((r) => r.name)).toEqual(['helm-w-helm-only']);
      expect(helmOnly.every((r) => r.owner === 'helm')).toBe(true);
      expect(helmOnly.some((r) => r.owner === 'human' || r.owner === 'legacy:unknown' || r.owner == null)).toBe(false);
    } finally {
      t.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// S12 — assertion-based session reconciler (WorkerService.sessionJanitorTick).
// Synthetic DB + fake tmux only. HELM_SESSION_JANITOR tests may enable the path in-process;
// deploy stays 0. No live tmux. No data/helm.db mutation.
// ---------------------------------------------------------------------------
describe('S12 session reconciler (WorkerService.sessionJanitorTick)', () => {
  let db: DatabaseService;
  let cleanup: () => void;
  let reg: SessionRegistryService;
  let terminated: string[];
  let tmuxSpy: any;
  let ws: WorkerService;
  let janitorModeBefore: string | undefined;
  /** Map of session name → existence tri-state (default true = live). */
  let existsMap: Map<string, boolean | null>;
  /** Map of session name → attached tri-state (default false = unattached, may REAP). */
  let attachedMap: Map<string, boolean | null>;

  function seedSession(
    name: string,
    opts: {
      status?: string;
      runId?: number | null;
      ageSecs?: number;
      owner?: string | null;
    } = {}
  ) {
    const status = opts.status ?? 'active';
    const runId = opts.runId === undefined ? null : opts.runId;
    const ageSecs = opts.ageSecs ?? 0;
    const owner = opts.owner === undefined ? 'helm' : opts.owner;
    db.prepare(
      `INSERT INTO helm_sessions (name, kind, project_id, run_id, owner, status, created_at, last_used_at)
       VALUES (?, 'test', 1, ?, ?, ?, datetime('now', ?), datetime('now', ?))`
    ).run(name, runId, owner, status, `-${ageSecs} seconds`, `-${ageSecs} seconds`);
  }

  function seedRun(status: string, phase: string): number {
    const info = db.prepare(
      `INSERT INTO runs (project_id, status, phase, started_at) VALUES (NULL, ?, ?, datetime('now'))`
    ).run(status, phase);
    return Number(info.lastInsertRowid);
  }

  function seedLiveWorker(session: string, runId: number | null) {
    db.prepare(
      `INSERT INTO worker_runtimes (project_id, role, provider, model, session, state, run_id, started_at)
       VALUES (1, 'implementer', 'grok', 'grok-4.5', ?, 'running', ?, datetime('now'))`
    ).run(session, runId);
  }

  beforeEach(() => {
    const t = makeTempDb();
    db = t.db;
    cleanup = t.cleanup;
    reg = new SessionRegistryService(db);
    terminated = [];
    existsMap = new Map();
    attachedMap = new Map();
    janitorModeBefore = process.env.HELM_SESSION_JANITOR;
    process.env.HELM_SESSION_JANITOR = 'on';
    tmuxSpy = {
      terminateSession: async (name: string) => {
        terminated.push(name);
      },
      sessionHasHelmChildTag: async (_name: string) => true,
      // S12: tri-state existence for decideSessionReconcile (default live).
      sessionExistsTriState: async (name: string) =>
        existsMap.has(name) ? existsMap.get(name)! : true,
      // S12-V1: default unattached so REAP happy-path tests proceed; override per-test.
      sessionAttached: async (name: string) =>
        attachedMap.has(name) ? attachedMap.get(name)! : false,
    };
    ws = new WorkerService(db, {} as any, tmuxSpy as any, {} as any, {} as any, undefined, reg);
    delete process.env.HELM_SESSION_TTL_MS;
  });
  afterEach(() => {
    cleanup();
    if (janitorModeBefore === undefined) {
      delete process.env.HELM_SESSION_JANITOR;
    } else {
      process.env.HELM_SESSION_JANITOR = janitorModeBefore;
    }
    delete process.env.HELM_SESSION_TTL_MS;
  });

  it('REAP: helm + idle assertion + live + tagged → terminate once + markReaped', async () => {
    seedSession('helm-w-cards-1', { status: 'idle' });
    await ws.sessionJanitorTick();
    expect(terminated).toEqual(['helm-w-cards-1']);
    expect(reg.get('helm-w-cards-1')!.status).toBe('reaped');
    expect(reg.get('helm-w-cards-1')!.reason).toBe('reconcile:asserted_complete_live');
  });

  it('KEEP: unasserted active stays even when aged far past any legacy TTL', async () => {
    seedSession('helm-w-cards-stale-active', { status: 'active', ageSecs: 10 * 60 * 60 });
    await ws.sessionJanitorTick();
    expect(terminated).toEqual([]);
    expect(reg.get('helm-w-cards-stale-active')!.status).toBe('active');
  });

  it('KEEP: human-owned idle is never auto-reaped', async () => {
    seedSession('helm-discovery-chat', { status: 'idle', owner: 'human', ageSecs: 10 * 60 * 60 });
    await ws.sessionJanitorTick();
    expect(terminated).toEqual([]);
    expect(reg.get('helm-discovery-chat')!.status).toBe('idle');
  });

  it('KEEP: legacy:unknown idle is never auto-reaped', async () => {
    seedSession('helm-legacy-seat', { status: 'idle', owner: 'legacy:unknown', ageSecs: 10 * 60 * 60 });
    await ws.sessionJanitorTick();
    expect(terminated).toEqual([]);
    expect(reg.get('helm-legacy-seat')!.status).toBe('idle');
  });

  it('KEEP: null owner is never auto-reaped', async () => {
    seedSession('helm-null-owner', { status: 'idle', owner: null, ageSecs: 10 * 60 * 60 });
    await ws.sessionJanitorTick();
    expect(terminated).toEqual([]);
    expect(reg.get('helm-null-owner')!.status).toBe('idle');
  });

  it('KEEP: live worker_runtime vetoes REAP even when idle+live', async () => {
    seedSession('helm-w-cards-live', { status: 'idle' });
    seedLiveWorker('helm-w-cards-live', null);
    await ws.sessionJanitorTick();
    expect(terminated).toEqual([]);
    expect(reg.get('helm-w-cards-live')!.status).toBe('idle');
  });

  it('KEEP: non-terminal mapped run vetoes REAP even when idle+live', async () => {
    const runId = seedRun('active', 'executing');
    seedSession('helm-batch-A1-implementer-active', { status: 'idle', runId });
    await ws.sessionJanitorTick();
    expect(terminated).toEqual([]);
    expect(reg.get('helm-batch-A1-implementer-active')!.status).toBe('idle');
  });

  it('REAP still works when run is terminal + idle (run status is not kill authority, only veto)', async () => {
    const runId = seedRun('complete', 'complete');
    seedSession('helm-batch-A1-implementer-done', { status: 'idle', runId });
    await ws.sessionJanitorTick();
    expect(terminated).toEqual(['helm-batch-A1-implementer-done']);
    expect(reg.get('helm-batch-A1-implementer-done')!.status).toBe('reaped');
  });

  it('F3 DELETED: run_id null + active is NOT reaped (no orphan/TTL kill path)', async () => {
    seedSession('helm-batch-A1-implementer-noRun', { status: 'active', runId: null, ageSecs: 25 * 60 });
    await ws.sessionJanitorTick();
    expect(terminated).toEqual([]);
    expect(reg.get('helm-batch-A1-implementer-noRun')!.status).toBe('active');
  });

  it('TTL retired: fresh idle (would have been within-TTL keep under legacy) IS reaped when asserted', async () => {
    // Proof that TTL is no longer authority — idle assertion alone is enough when live.
    seedSession('helm-w-cards-fresh-idle', { status: 'idle', ageSecs: 30 });
    await ws.sessionJanitorTick();
    expect(terminated).toEqual(['helm-w-cards-fresh-idle']);
    expect(reg.get('helm-w-cards-fresh-idle')!.status).toBe('reaped');
  });

  it('NEVER terminates a non-helm-named session even if registered/idle (prefix guard)', async () => {
    seedSession('03_impl_grokbuild_rscf', { status: 'idle', ageSecs: 60 * 60 });
    seedSession('01_impl_something', { status: 'idle', ageSecs: 60 * 60 });
    await ws.sessionJanitorTick();
    expect(terminated).toEqual([]);
    expect(reg.get('03_impl_grokbuild_rscf')!.status).toBe('idle');
  });

  it('NEVER terminates an unregistered session (registry membership)', async () => {
    seedSession('helm-w-cards-2', { status: 'idle' });
    await ws.sessionJanitorTick();
    expect(terminated).toEqual(['helm-w-cards-2']);
    // Phantom helm-orphan-live is not in registry → never a terminate target
    expect(terminated).not.toContain('helm-orphan-live');
  });

  it('HELM_SESSION_JANITOR=0 disables the sweep entirely', async () => {
    process.env.HELM_SESSION_JANITOR = '0';
    seedSession('helm-w-cards-disabled', { status: 'idle' });
    await ws.sessionJanitorTick();
    expect(terminated).toEqual([]);
    expect(reg.get('helm-w-cards-disabled')!.status).toBe('idle');
  });

  it('SHADOW: REAP candidate is logged and never terminated', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      process.env.HELM_SESSION_JANITOR = 'shadow';
      seedSession('helm-w-cards-shadow', { status: 'idle' });
      await ws.sessionJanitorTick();
      expect(terminated).toEqual([]);
      expect(reg.get('helm-w-cards-shadow')!.status).toBe('idle');
      const log = warnSpy.mock.calls.some((entry) =>
        String(entry[0]).includes('[session-janitor][shadow]')
      );
      expect(log).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('SHADOW: gone session stays untouched (would converge only)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      process.env.HELM_SESSION_JANITOR = 'shadow';
      seedSession('helm-w-cards-shadow-gone', { status: 'active' });
      existsMap.set('helm-w-cards-shadow-gone', false);
      await ws.sessionJanitorTick();
      expect(terminated).toEqual([]);
      expect(reg.get('helm-w-cards-shadow-gone')!.status).toBe('active');
      const log = warnSpy.mock.calls.some((entry) =>
        String(entry[0]).includes('[session-janitor][shadow]')
      );
      expect(log).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('CONVERGE: sessionExists=false → markReaped with zero kill (AC14)', async () => {
    seedSession('helm-w-cards-gone', { status: 'active' });
    existsMap.set('helm-w-cards-gone', false);
    await ws.sessionJanitorTick();
    expect(terminated).toEqual([]);
    expect(reg.get('helm-w-cards-gone')!.status).toBe('reaped');
    expect(reg.get('helm-w-cards-gone')!.reason).toBe('reconcile:session_gone');
  });

  it('CONVERGE: gone + idle also converges without kill', async () => {
    seedSession('helm-w-cards-gone-idle', { status: 'idle' });
    existsMap.set('helm-w-cards-gone-idle', false);
    await ws.sessionJanitorTick();
    expect(terminated).toEqual([]);
    expect(reg.get('helm-w-cards-gone-idle')!.status).toBe('reaped');
  });

  it('KEEP: sessionExists=null (unknown probe) never kills or converges', async () => {
    seedSession('helm-w-cards-unknown', { status: 'idle' });
    existsMap.set('helm-w-cards-unknown', null);
    await ws.sessionJanitorTick();
    expect(terminated).toEqual([]);
    expect(reg.get('helm-w-cards-unknown')!.status).toBe('idle');
  });

  it('idempotent: second tick after REAP does not re-terminate', async () => {
    seedSession('helm-w-cards-idem', { status: 'idle' });
    await ws.sessionJanitorTick();
    expect(terminated).toEqual(['helm-w-cards-idem']);
    await ws.sessionJanitorTick();
    expect(terminated).toEqual(['helm-w-cards-idem']); // still exactly one
    expect(reg.get('helm-w-cards-idem')!.status).toBe('reaped');
  });

  it('idempotent: second tick after CONVERGE is a no-op', async () => {
    seedSession('helm-w-cards-conv-idem', { status: 'active' });
    existsMap.set('helm-w-cards-conv-idem', false);
    await ws.sessionJanitorTick();
    expect(terminated).toEqual([]);
    expect(reg.get('helm-w-cards-conv-idem')!.status).toBe('reaped');
    await ws.sessionJanitorTick();
    expect(terminated).toEqual([]);
    expect(reg.get('helm-w-cards-conv-idem')!.status).toBe('reaped');
  });

  it('startup sweep has parity with tick (REAP asserted live)', async () => {
    seedSession('helm-batch-A1-validator-startup', { status: 'idle' });
    await ws.sweepOrphanSessionsAtStartup();
    expect(terminated).toEqual(['helm-batch-A1-validator-startup']);
    expect(reg.get('helm-batch-A1-validator-startup')!.status).toBe('reaped');
  });

  it('startup sweep CONVERGE parity (gone → zero kill)', async () => {
    seedSession('helm-batch-A1-gone-startup', { status: 'active' });
    existsMap.set('helm-batch-A1-gone-startup', false);
    await ws.sweepOrphanSessionsAtStartup();
    expect(terminated).toEqual([]);
    expect(reg.get('helm-batch-A1-gone-startup')!.status).toBe('reaped');
  });

  it('registry.touch refreshes last_used_at (and does not resurrect a reaped row)', () => {
    seedSession('helm-plancore-touch', { status: 'active', runId: null, ageSecs: 60 * 60 });
    const before = reg.get('helm-plancore-touch')!.last_used_at;
    reg.touch('helm-plancore-touch');
    const after = reg.get('helm-plancore-touch')!.last_used_at;
    expect(after).not.toBe(before);
    const fresh = db.prepare(
      "SELECT (last_used_at > datetime('now', '-60 seconds')) AS ok FROM helm_sessions WHERE name = 'helm-plancore-touch'"
    ).get() as any;
    expect(fresh.ok).toBe(1);
    reg.markReaped('helm-plancore-touch');
    reg.touch('helm-plancore-touch');
    expect(reg.get('helm-plancore-touch')!.status).toBe('reaped');
  });

  it('onUse via active-input send methods flows through to touch', async () => {
    const { TmuxService } = await import('../tmux/tmux-service.js');
    const tmux = new (TmuxService as any)();
    tmux.setRegistryHook({
      onCreate: (n: string) => reg.register(n, { owner: 'helm' }),
      onTerminate: (n: string) => reg.markReaped(n),
      onUse: (n: string) => reg.touch(n),
    });

    seedSession('helm-chat-onuse', { status: 'active', runId: null, ageSecs: 60 * 60 });
    const beforeChat = reg.get('helm-chat-onuse')!.last_used_at;
    (tmux as any).touchSession('helm-chat-onuse:0.0');
    expect(reg.get('helm-chat-onuse')!.last_used_at).not.toBe(beforeChat);

    seedSession('helm-cmd-onuse', { status: 'active', runId: null, ageSecs: 60 * 60 });
    const beforeCmd = reg.get('helm-cmd-onuse')!.last_used_at;
    (tmux as any).touchSession('helm-cmd-onuse');
    expect(reg.get('helm-cmd-onuse')!.last_used_at).not.toBe(beforeCmd);
  });

  it('unasserted in-use chat (active, run_id null) is never reaped', async () => {
    seedSession('helm-batch-A1-implementer-chat', { status: 'active', runId: null, ageSecs: 90 * 60 });
    reg.touch('helm-batch-A1-implementer-chat');
    await ws.sessionJanitorTick();
    expect(terminated).toEqual([]);
    expect(reg.get('helm-batch-A1-implementer-chat')!.status).toBe('active');
  });

  // ST-R2 — @helm_child tag gate (REAP path only)
  it('ST-R2: missing @helm_child → NEVER terminate (KEEP idle)', async () => {
    tmuxSpy.sessionHasHelmChildTag = async (_name: string) => false;
    seedSession('helm-w-cards-untagged', { status: 'idle' });
    await ws.sessionJanitorTick();
    expect(terminated).toEqual([]);
    expect(reg.get('helm-w-cards-untagged')!.status).toBe('idle');
  });

  it('ST-R2: tag probe throw → NEVER terminate', async () => {
    tmuxSpy.sessionHasHelmChildTag = async (_name: string) => {
      throw new Error('tmux show-options: no such session');
    };
    seedSession('helm-w-cards-probeerr', { status: 'idle' });
    await expect(ws.sessionJanitorTick()).resolves.toBeUndefined();
    expect(terminated).toEqual([]);
    expect(reg.get('helm-w-cards-probeerr')!.status).toBe('idle');
  });

  it('ST-R2: only tagged peer is reaped on name-collision', async () => {
    tmuxSpy.sessionHasHelmChildTag = async (name: string) => name === 'helm-real-worker';
    seedSession('helm-real-worker', { status: 'idle' });
    seedSession('helm-user-lookalike', { status: 'idle' });
    await ws.sessionJanitorTick();
    expect(terminated).toEqual(['helm-real-worker']);
    expect(terminated).not.toContain('helm-user-lookalike');
    expect(reg.get('helm-user-lookalike')!.status).toBe('idle');
  });

  // S12-V1 — attached keep (fail-safe REAP veto)
  it('S12-V1: attached=true → KEEP (never terminate)', async () => {
    seedSession('helm-s12-attached-proof', { status: 'idle' });
    attachedMap.set('helm-s12-attached-proof', true);
    await ws.sessionJanitorTick();
    expect(terminated).toEqual([]);
    expect(reg.get('helm-s12-attached-proof')!.status).toBe('idle');
  });

  it('S12-V1: attached=null (unknown) → KEEP keep-biased', async () => {
    seedSession('helm-s12-attached-unknown', { status: 'idle' });
    attachedMap.set('helm-s12-attached-unknown', null);
    await ws.sessionJanitorTick();
    expect(terminated).toEqual([]);
    expect(reg.get('helm-s12-attached-unknown')!.status).toBe('idle');
  });

  it('S12-V1: sessionAttached throw → KEEP keep-biased', async () => {
    tmuxSpy.sessionAttached = async () => {
      throw new Error('display-message failed');
    };
    seedSession('helm-s12-attached-throw', { status: 'idle' });
    await ws.sessionJanitorTick();
    expect(terminated).toEqual([]);
    expect(reg.get('helm-s12-attached-throw')!.status).toBe('idle');
  });

  // S12-V2 — terminate failure must not false-mark reaped
  it('S12-V2: terminate throws + still live → leave idle, retryable on next tick', async () => {
    let attempts = 0;
    tmuxSpy.terminateSession = async (name: string) => {
      attempts += 1;
      terminated.push(name);
      throw new Error('permission denied: kill-session');
    };
    seedSession('helm-s12-kill-fail', { status: 'idle' });
    // still live after failed kill
    existsMap.set('helm-s12-kill-fail', true);

    await ws.sessionJanitorTick();
    expect(attempts).toBe(1);
    expect(reg.get('helm-s12-kill-fail')!.status).toBe('idle'); // not false-reaped

    await ws.sessionJanitorTick();
    expect(attempts).toBe(2); // level-triggered retry
    expect(reg.get('helm-s12-kill-fail')!.status).toBe('idle');
  });

  it('S12-V2: terminate throws + re-probe gone → CONVERGE markReaped without success kill', async () => {
    tmuxSpy.terminateSession = async (name: string) => {
      terminated.push(name);
      // session dies under us / already gone race
      existsMap.set(name, false);
      throw new Error('no such session');
    };
    seedSession('helm-s12-kill-race-gone', { status: 'idle' });
    existsMap.set('helm-s12-kill-race-gone', true); // pre-decision live → REAP path

    await ws.sessionJanitorTick();
    expect(terminated).toEqual(['helm-s12-kill-race-gone']);
    expect(reg.get('helm-s12-kill-race-gone')!.status).toBe('reaped');
    expect(reg.get('helm-s12-kill-race-gone')!.reason).toBe('reconcile:session_gone');
  });

  it('HARD SAFETY: deploy HELM_SESSION_JANITOR remains 0', () => {
    const root = path.resolve(__dirname, '../..');
    const env = fs.readFileSync(path.join(root, '.env'), 'utf8');
    const eco = fs.readFileSync(path.join(root, 'ecosystem.config.cjs'), 'utf8');
    expect(env).toMatch(/HELM_SESSION_JANITOR\s*=\s*0/);
    expect(eco).toMatch(/HELM_SESSION_JANITOR:\s*["']0["']/);
  });

  it('source: tick does not use TTL/age kill authority', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, 'worker-service.ts'),
      'utf8'
    );
    // Janitor tick body must not consult HELM_SESSION_TTL_MS or datetime aged checks for kill.
    const tickStart = src.indexOf('async sessionJanitorTick');
    const tickEnd = src.indexOf('async sweepOrphanSessionsAtStartup');
    expect(tickStart).toBeGreaterThan(-1);
    expect(tickEnd).toBeGreaterThan(tickStart);
    const tickBody = src.slice(tickStart, tickEnd);
    expect(tickBody).not.toMatch(/HELM_SESSION_TTL_MS/);
    expect(tickBody).not.toMatch(/pastTtl|ttlSecs|ttlMs/);
    expect(tickBody).toMatch(/decideSessionReconcile/);
  });
});
