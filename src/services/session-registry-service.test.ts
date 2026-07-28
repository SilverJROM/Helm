import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
// SL-R3/R4 janitor tests — spy tmux to assert terminate calls without real tmux.
// ---------------------------------------------------------------------------
describe('SL-R3/R4 session janitor (WorkerService.sessionJanitorTick)', () => {
  let db: DatabaseService;
  let cleanup: () => void;
  let reg: SessionRegistryService;
  let terminated: string[];
  let tmuxSpy: any;
  let ws: WorkerService;

  // Build a helm_sessions row with created_at/last_used_at offset by N seconds in the past.
  function seedSession(name: string, opts: { status?: string; runId?: number | null; ageSecs?: number } = {}) {
    const status = opts.status ?? 'active';
    const runId = opts.runId ?? null;
    const ageSecs = opts.ageSecs ?? 0;
    db.prepare(
      `INSERT INTO helm_sessions (name, kind, project_id, run_id, status, created_at, last_used_at)
       VALUES (?, 'test', 1, ?, ?, datetime('now', ?), datetime('now', ?))`
    ).run(name, runId, status, `-${ageSecs} seconds`, `-${ageSecs} seconds`);
  }

  function seedRun(status: string, phase: string): number {
    // project_id NULL (nullable FK) — the janitor only reads runs.status/phase, not the project.
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
    tmuxSpy = {
      terminateSession: async (name: string) => { terminated.push(name); },
      // ST-R2: janitor gates its kill on this. Default TRUE so every pre-existing janitor test still reaps
      // exactly as before; individual tests override it to false to exercise the untagged/error fail-safe.
      sessionHasHelmChildTag: async (_name: string) => true,
    };
    // Only the janitor path is exercised — other WorkerService deps are unused here.
    ws = new WorkerService(db, {} as any, tmuxSpy as any, {} as any, {} as any, undefined, reg);
    // Force janitor on + a tiny TTL floor via env (default 20min; we age rows past it explicitly).
    delete process.env.HELM_SESSION_JANITOR;
    delete process.env.HELM_SESSION_TTL_MS;
  });
  afterEach(() => {
    cleanup();
    delete process.env.HELM_SESSION_JANITOR;
    delete process.env.HELM_SESSION_TTL_MS;
  });

  it('reaps a done (idle) + past-TTL registered helm- session (terminate called + status reaped)', async () => {
    // idle + aged 21min (past default 20min TTL) + no live worker.
    seedSession('helm-w-cards-1', { status: 'idle', ageSecs: 21 * 60 });
    await ws.sessionJanitorTick();
    expect(terminated).toContain('helm-w-cards-1');
    expect(reg.get('helm-w-cards-1')!.status).toBe('reaped');
    expect(reg.get('helm-w-cards-1')!.reason).toBe('janitor-ttl');
  });

  it('reaps a session whose mapped run is terminal + past TTL', async () => {
    const runId = seedRun('complete', 'complete');
    seedSession('helm-batch-A1-implementer-x', { status: 'active', runId, ageSecs: 25 * 60 });
    await ws.sessionJanitorTick();
    expect(terminated).toContain('helm-batch-A1-implementer-x');
    expect(reg.get('helm-batch-A1-implementer-x')!.status).toBe('reaped');
  });

  it('SKIPS a session whose mapped run is ACTIVE (never reap a running worker)', async () => {
    const runId = seedRun('active', 'executing');
    seedSession('helm-batch-A1-implementer-active', { status: 'active', runId, ageSecs: 30 * 60 });
    await ws.sessionJanitorTick();
    expect(terminated).toEqual([]);
    expect(reg.get('helm-batch-A1-implementer-active')!.status).toBe('active');
  });

  it('SKIPS a session with a LIVE worker_runtime even if idle + aged', async () => {
    seedSession('helm-w-cards-live', { status: 'idle', ageSecs: 30 * 60 });
    seedLiveWorker('helm-w-cards-live', null);
    await ws.sessionJanitorTick();
    expect(terminated).toEqual([]);
    expect(reg.get('helm-w-cards-live')!.status).toBe('idle');
  });

  it('SKIPS a within-TTL session (idle but too fresh)', async () => {
    seedSession('helm-w-cards-fresh', { status: 'idle', ageSecs: 60 }); // 1min < 20min
    await ws.sessionJanitorTick();
    expect(terminated).toEqual([]);
    expect(reg.get('helm-w-cards-fresh')!.status).toBe('idle');
  });

  it('NEVER terminates a non-helm-named session even if registered/idle/aged (SL-R4 prefix guard)', async () => {
    seedSession('03_impl_grokbuild_rscf', { status: 'idle', ageSecs: 60 * 60 });
    seedSession('01_impl_something', { status: 'idle', ageSecs: 60 * 60 });
    await ws.sessionJanitorTick();
    expect(terminated).toEqual([]);
    // rows remain untouched (not reaped)
    expect(reg.get('03_impl_grokbuild_rscf')!.status).toBe('idle');
  });

  it('NEVER terminates an UNregistered session (janitor only iterates registry rows)', async () => {
    // A live tmux session exists (helm-orphan-live) but is NOT in helm_sessions → janitor cannot see it.
    seedSession('helm-w-cards-2', { status: 'idle', ageSecs: 25 * 60 });
    await ws.sessionJanitorTick();
    expect(terminated).toEqual(['helm-w-cards-2']); // only the registered one; the phantom is never a target
  });

  it('HELM_SESSION_JANITOR=0 disables the sweep entirely', async () => {
    process.env.HELM_SESSION_JANITOR = '0';
    seedSession('helm-w-cards-disabled', { status: 'idle', ageSecs: 30 * 60 });
    await ws.sessionJanitorTick();
    expect(terminated).toEqual([]);
  });

  it('startup sweep reaps a terminal-run orphan past TTL', async () => {
    const runId = seedRun('failed', 'failed');
    seedSession('helm-batch-A1-validator-orphan', { status: 'active', runId, ageSecs: 40 * 60 });
    await ws.sweepOrphanSessionsAtStartup();
    expect(terminated).toContain('helm-batch-A1-validator-orphan');
    expect(reg.get('helm-batch-A1-validator-orphan')!.status).toBe('reaped');
  });

  it('reaps a GENUINELY-IDLE orphan with NO run mapping (run_id null, last_used_at stale past TTL)', async () => {
    // The leaked-test-session case: no run, no live worker, no recent use → last_used_at is stale.
    // This is the primary cleanup goal and must still work.
    seedSession('helm-batch-A1-implementer-noRun', { status: 'active', runId: null, ageSecs: 25 * 60 });
    await ws.sessionJanitorTick();
    expect(terminated).toContain('helm-batch-A1-implementer-noRun');
  });

  it('does NOT reap an IN-USE standalone session (active, run_id null, touched within TTL)', async () => {
    // Simulates an actively-used persistent planning session created long ago (past TTL).
    // but recently USED (touched). last_used_at is fresh → TTL means "idle for TTL" → kept alive.
    // Regression guard for the SL-R2/R4 over-reach the gate caught.
    seedSession('helm-plancore-cards', { status: 'active', runId: null, ageSecs: 60 * 60 }); // created 60min ago
    reg.touch('helm-plancore-cards'); // used just now → last_used_at = now
    await ws.sessionJanitorTick();
    expect(terminated).toEqual([]);
    expect(reg.get('helm-plancore-cards')!.status).toBe('active');
  });

  it('registry.touch refreshes last_used_at (and does not resurrect a reaped row)', () => {
    seedSession('helm-plancore-touch', { status: 'active', runId: null, ageSecs: 60 * 60 });
    const before = reg.get('helm-plancore-touch')!.last_used_at;
    reg.touch('helm-plancore-touch');
    const after = reg.get('helm-plancore-touch')!.last_used_at;
    expect(after).not.toBe(before);
    // last_used_at is now ~now (much fresher than the 60min-old created_at)
    const fresh = db.prepare(
      "SELECT (last_used_at > datetime('now', '-60 seconds')) AS ok FROM helm_sessions WHERE name = 'helm-plancore-touch'"
    ).get() as any;
    expect(fresh.ok).toBe(1);
    // touch is a no-op on a reaped row (never resurrect a closed session)
    reg.markReaped('helm-plancore-touch');
    reg.touch('helm-plancore-touch');
    expect(reg.get('helm-plancore-touch')!.status).toBe('reaped');
  });

  it('onUse via active-input send methods (sendAndSubmit/sendCommand/sendEnter/sendKeys) flows through to touch', async () => {
    // Assert the TmuxService active-input → onUse → touch wiring refreshes last_used_at. All of Helm's
    // active-input paths funnel through the private touchSession(target) helper, so exercising it with a
    // pane target (session:window.pane → bare session name) proves the exact call each send method makes.
    // (The real send methods shell out to tmux; touchSession is the pure, tmux-free unit under test.)
    const { TmuxService } = await import('../tmux/tmux-service.js');
    const tmux = new (TmuxService as any)();
    tmux.setRegistryHook({
      onCreate: (n: string) => reg.register(n, { owner: 'helm' }),
      onTerminate: (n: string) => reg.markReaped(n),
      onUse: (n: string) => reg.touch(n),
    });

    // 1) chat/message submission path (sendAndSubmit) — THE important one.
    seedSession('helm-chat-onuse', { status: 'active', runId: null, ageSecs: 60 * 60 });
    const beforeChat = reg.get('helm-chat-onuse')!.last_used_at;
    (tmux as any).touchSession('helm-chat-onuse:0.0'); // exactly what sendAndSubmit fires
    expect(reg.get('helm-chat-onuse')!.last_used_at).not.toBe(beforeChat);
    // refreshed to ~now (much fresher than the 60min-old created_at)
    const fresh = db.prepare(
      "SELECT (last_used_at > datetime('now', '-60 seconds')) AS ok FROM helm_sessions WHERE name = 'helm-chat-onuse'"
    ).get() as any;
    expect(fresh.ok).toBe(1);

    // 2) the same helper is what sendCommand/sendEnter/sendKeys also call (bare-name extraction).
    seedSession('helm-cmd-onuse', { status: 'active', runId: null, ageSecs: 60 * 60 });
    const beforeCmd = reg.get('helm-cmd-onuse')!.last_used_at;
    (tmux as any).touchSession('helm-cmd-onuse'); // bare session target (no :window.pane)
    expect(reg.get('helm-cmd-onuse')!.last_used_at).not.toBe(beforeCmd);
  });

  it('an actively-CHATTING session (touched via sendAndSubmit path) survives past the creation TTL', async () => {
    // End-to-end of the iter-2 fix: a chat session created >TTL ago but kept in active use (each message
    // → sendAndSubmit → touch) is NOT reaped. Mirrors the in-use planning-session chat path.
    seedSession('helm-batch-A1-implementer-chat', { status: 'active', runId: null, ageSecs: 90 * 60 });
    reg.touch('helm-batch-A1-implementer-chat'); // a chat message just landed
    await ws.sessionJanitorTick();
    expect(terminated).toEqual([]);
    expect(reg.get('helm-batch-A1-implementer-chat')!.status).toBe('active');
  });

  // ---------------------------------------------------------------------------
  // ST-R2/R5 — @helm_child tag gate: the janitor kills ONLY Helm-tagged sessions.
  // ---------------------------------------------------------------------------
  it('ST-R2 CORE GUARD: a registry+helm-prefix+past-TTL+no-worker session MISSING @helm_child is NEVER reaped', async () => {
    // The exact fatal scenario: a session that passes EVERY legacy guard (registered, helm- prefixed,
    // idle, past TTL, no live worker, terminal/no run) but is NOT Helm-tagged (someone else's session, or
    // an untagged pre-existing one) must never be terminated. This is the regression guard for the
    // whole-tmux-server death.
    tmuxSpy.sessionHasHelmChildTag = async (_name: string) => false; // not Helm's → must be skipped
    seedSession('helm-w-cards-untagged', { status: 'idle', ageSecs: 30 * 60 });
    await ws.sessionJanitorTick();
    expect(terminated).toEqual([]);                                  // NEVER killed
    expect(reg.get('helm-w-cards-untagged')!.status).toBe('idle');   // left intact (safe default: continue)
  });

  it('ST-R2 happy path: a fully-tagged idle + past-TTL session is STILL reaped', async () => {
    tmuxSpy.sessionHasHelmChildTag = async (_name: string) => true;  // Helm-tagged → reapable
    seedSession('helm-w-cards-tagged', { status: 'idle', ageSecs: 30 * 60 });
    await ws.sessionJanitorTick();
    expect(terminated).toContain('helm-w-cards-tagged');
    expect(reg.get('helm-w-cards-tagged')!.status).toBe('reaped');
  });

  it('ST-R2 fail-safe: a tag probe that ERRORS is treated as untagged → session NOT reaped', async () => {
    // sessionHasHelmChildTag itself is fail-safe (returns false on tmux error), but assert the janitor
    // honours a false/throwing probe here too: uncertainty must never escalate to a kill.
    tmuxSpy.sessionHasHelmChildTag = async (_name: string) => { throw new Error('tmux show-options: no such session'); };
    seedSession('helm-w-cards-probeerr', { status: 'idle', ageSecs: 30 * 60 });
    await expect(ws.sessionJanitorTick()).resolves.toBeUndefined();   // tick does not blow up
    expect(terminated).toEqual([]);                                   // never killed on probe error
    expect(reg.get('helm-w-cards-probeerr')!.status).toBe('idle');
  });

  it('ST-R2 NO-SPILLOVER name-collision: an untagged session that merely SHARES a helm- name is never killed', async () => {
    // A user/other-tool session that happens to be named like a Helm session (helm-ish prefix) and got
    // into the registry: it is idle + past-TTL + no worker (would reap under legacy guards) but carries NO
    // @helm_child tag → the janitor must NOT terminate it. Name similarity can never be a kill trigger;
    // only the positive Helm-applied tag can.
    tmuxSpy.sessionHasHelmChildTag = async (name: string) =>
      name === 'helm-real-worker'; // ONLY the genuine Helm session is tagged
    seedSession('helm-real-worker', { status: 'idle', ageSecs: 30 * 60 });   // Helm's own → tagged
    seedSession('helm-user-lookalike', { status: 'idle', ageSecs: 30 * 60 }); // collision → untagged
    await ws.sessionJanitorTick();
    expect(terminated).toEqual(['helm-real-worker']);                 // ONLY the tagged one
    expect(terminated).not.toContain('helm-user-lookalike');          // the look-alike is safe
    expect(reg.get('helm-user-lookalike')!.status).toBe('idle');      // untouched
  });

  it('ST-R2 NO-SPILLOVER sanity: a session NOT in the registry is never even a candidate', async () => {
    // The loop only SELECTs helm_sessions rows, so a live tmux session absent from the registry can never
    // be evaluated — let alone killed — regardless of its name or tag. Belt-and-suspenders over the tag gate.
    tmuxSpy.sessionHasHelmChildTag = async (_name: string) => true;   // even if it WERE tagged...
    seedSession('helm-registered-tagged', { status: 'idle', ageSecs: 30 * 60 });
    await ws.sessionJanitorTick();
    expect(terminated).toEqual(['helm-registered-tagged']);           // only the registered row; nothing else
  });

});
