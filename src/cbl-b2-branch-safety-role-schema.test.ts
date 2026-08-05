/**
 * cycle-branch-lifecycle B2 — schema v114: role_bindings, role_defaults, and role_capabilities
 * CHECK lists gain the house role 'branch-safety' (R3.1); its role_capabilities row is seeded
 * facts-only — can_write_code=0, panel_participant=0, can_escalate=0, session_policy='fresh'
 * (R3.3). Table rebuild — SQLite cannot ALTER a CHECK (precedent: v89's rebuild of these same
 * three tables). Neither role_bindings, role_defaults, nor role_capabilities is an FK target
 * elsewhere, so unlike v113's cycles rebuild this needs no foreign_keys pragma toggling.
 *
 * FORWARD RECONCILE: live data/helm.db was independently brought to v114 (with the branch-safety
 * row already seeded) before this code catch-up landed. The last describe block below opens it
 * strictly read-only (never via DatabaseService) to prove that without writing a single byte.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { DatabaseService } from './db/database.js';
import { SCHEMA_VERSION } from './db/schema.js';

const ROLE_CHECK_TABLES = ['role_bindings', 'role_defaults', 'role_capabilities'] as const;

function withTempDb<T>(fn: (dbPath: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-cbl-b2-'));
  const dbPath = path.join(dir, 't.db');
  try {
    return fn(dbPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Pre-v114 (11-role) CHECK vocabulary — the shape immediately before this slice. */
const V113_ROLE_LIST =
  "'discovery', 'plancore', 'ibrain', 'coord', 'implementer', 'validator', 'deliberation', 'red-team', 'planner', 'routine-implementer', 'panelist'";

function makeV113RoleShapeDb(dbPath: string): { agentId: number } {
  const raw = new Database(dbPath);
  raw.exec(`
    CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
    INSERT INTO schema_version (version) VALUES (113);

    CREATE TABLE agents (
      id INTEGER PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      default_effort TEXT NOT NULL DEFAULT 'medium',
      spawn_pref TEXT NOT NULL DEFAULT 'tmux',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE role_bindings (
      id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL,
      role TEXT NOT NULL CHECK(role IN (${V113_ROLE_LIST})),
      agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project_id, role, agent_id)
    );

    CREATE TABLE role_defaults (
      role TEXT PRIMARY KEY CHECK(role IN (${V113_ROLE_LIST})),
      agent_id INTEGER NOT NULL REFERENCES agents(id),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE role_capabilities (
      role TEXT PRIMARY KEY CHECK(role IN (${V113_ROLE_LIST})),
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
  const agentId = (raw.prepare(
    `INSERT INTO agents (name, provider, model) VALUES ('cbl-b2-legacy-agent', 'claude', 'claude-opus-5') RETURNING id`
  ).get() as any).id;
  raw.prepare(
    `INSERT INTO role_bindings (project_id, role, agent_id) VALUES (5, 'implementer', ?)`
  ).run(agentId);
  raw.prepare(`INSERT INTO role_defaults (role, agent_id) VALUES ('implementer', ?)`).run(agentId);
  raw.prepare(`
    INSERT INTO role_capabilities (role, allowed_statuses, terminal_statuses, can_write_code, can_escalate)
    VALUES ('implementer', '["WORKING","DONE"]', '["DONE"]', 1, 1)
  `).run();
  raw.close();
  return { agentId };
}

describe('cycle-branch-lifecycle B2: branch-safety role schema v114 (fresh DB)', () => {
  it('SCHEMA_VERSION is ≥114 (B2 floor; later slices may bump further)', () => {
    withTempDb((dbPath) => {
      const dbs = new DatabaseService(dbPath);
      expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(114);
      expect((dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version).toBe(
        SCHEMA_VERSION
      );
      dbs.close();
    });
  });

  it("role_bindings and role_defaults CHECK accepts role='branch-safety', rejects an unknown role", () => {
    withTempDb((dbPath) => {
      const dbs = new DatabaseService(dbPath);
      dbs.raw.prepare(
        `INSERT INTO agents (name, provider, model) VALUES ('cbl-b2-agent', 'claude', 'claude-opus-5')`
      ).run();
      const agentId = (dbs.raw.prepare(`SELECT id FROM agents WHERE name = 'cbl-b2-agent'`).get() as any).id;

      expect(() =>
        dbs.raw
          .prepare(`INSERT INTO role_bindings (project_id, role, agent_id) VALUES (1, 'branch-safety', ?)`)
          .run(agentId)
      ).not.toThrow();
      // B3 seeds role_defaults.branch-safety; vacate so this insert exercises the CHECK itself.
      dbs.raw.prepare(`DELETE FROM role_defaults WHERE role = 'branch-safety'`).run();
      expect(() =>
        dbs.raw.prepare(`INSERT INTO role_defaults (role, agent_id) VALUES ('branch-safety', ?)`).run(agentId)
      ).not.toThrow();

      expect(() =>
        dbs.raw
          .prepare(`INSERT INTO role_bindings (project_id, role, agent_id) VALUES (1, 'not-a-real-role', ?)`)
          .run(agentId)
      ).toThrow();
      expect(() =>
        dbs.raw.prepare(`INSERT INTO role_defaults (role, agent_id) VALUES ('not-a-real-role', ?)`).run(agentId)
      ).toThrow();

      dbs.close();
    });
  });

  it("role_capabilities CHECK accepts role='branch-safety' and rejects an unknown role", () => {
    withTempDb((dbPath) => {
      const dbs = new DatabaseService(dbPath);
      // A branch-safety row is already seeded (applyB2BranchSafetyCapabilitySeed); vacate it first
      // so this insert exercises the CHECK itself rather than colliding on the role PK.
      dbs.raw.prepare(`DELETE FROM role_capabilities WHERE role = 'branch-safety'`).run();

      expect(() =>
        dbs.raw
          .prepare(
            `INSERT INTO role_capabilities (role, allowed_statuses, terminal_statuses) VALUES ('branch-safety', '[]', '[]')`
          )
          .run()
      ).not.toThrow();

      expect(() =>
        dbs.raw
          .prepare(
            `INSERT INTO role_capabilities (role, allowed_statuses, terminal_statuses) VALUES ('not-a-real-role', '[]', '[]')`
          )
          .run()
      ).toThrow();

      dbs.close();
    });
  });

  it('role_capabilities.branch-safety is pre-seeded facts-only: can_write_code=0, panel_participant=0, can_escalate=0, session_policy=fresh', () => {
    withTempDb((dbPath) => {
      const dbs = new DatabaseService(dbPath);
      const row = dbs.raw.prepare(`SELECT * FROM role_capabilities WHERE role = 'branch-safety'`).get() as any;
      expect(row).toBeTruthy();
      expect(row.can_write_code).toBe(0);
      expect(row.panel_participant).toBe(0);
      expect(row.can_escalate).toBe(0);
      expect(row.session_policy).toBe('fresh');
      dbs.close();
    });
  });
});

describe('cycle-branch-lifecycle B2: branch-safety role schema v114 (v113 upgrade fixture)', () => {
  it('v113→v114: existing rows survive the rebuild, branch-safety accepted, unknown role still rejected, capabilities row seeded facts-only', () => {
    withTempDb((dbPath) => {
      const { agentId } = makeV113RoleShapeDb(dbPath);

      const pre = new Database(dbPath, { readonly: true });
      const countsBefore = Object.fromEntries(
        ROLE_CHECK_TABLES.map((t) => [t, (pre.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as any).c])
      );
      pre.close();

      const dbs = new DatabaseService(dbPath);
      expect((dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version).toBe(SCHEMA_VERSION);
      expect((dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version).toBeGreaterThanOrEqual(114);

      // Pre-existing rows preserved by the rebuild (id + values untouched).
      const existingBinding = dbs.raw
        .prepare(`SELECT project_id, role, agent_id FROM role_bindings WHERE role = 'implementer'`)
        .get() as any;
      expect(existingBinding).toEqual({ project_id: 5, role: 'implementer', agent_id: agentId });
      expect(
        (dbs.raw.prepare(`SELECT agent_id FROM role_defaults WHERE role = 'implementer'`).get() as any).agent_id
      ).toBe(agentId);
      const existingCap = dbs.raw.prepare(`SELECT * FROM role_capabilities WHERE role = 'implementer'`).get() as any;
      expect(existingCap.can_write_code).toBe(1);
      expect(existingCap.can_escalate).toBe(1);

      // Row counts: +0 role_bindings/role_defaults on this minimal fixture (no agent_type column,
      // so B3's applyBranchSafetyAgentSeed is a deliberate no-op here); +1 role_capabilities (B2 seed).
      // Full agent-row + role_defaults bind is covered by cbl-b3-branch-safety-agent-seed.test.ts.
      expect((dbs.raw.prepare('SELECT COUNT(*) AS c FROM role_bindings').get() as any).c).toBe(
        countsBefore.role_bindings
      );
      expect((dbs.raw.prepare('SELECT COUNT(*) AS c FROM role_defaults').get() as any).c).toBe(
        countsBefore.role_defaults
      );
      expect((dbs.raw.prepare('SELECT COUNT(*) AS c FROM role_capabilities').get() as any).c).toBe(
        countsBefore.role_capabilities + 1
      );

      // CHECK now accepts branch-safety, still rejects an unknown role.
      expect(() =>
        dbs.raw
          .prepare(`INSERT INTO role_bindings (project_id, role, agent_id) VALUES (5, 'branch-safety', ?)`)
          .run(agentId)
      ).not.toThrow();
      expect(() =>
        dbs.raw
          .prepare(`INSERT INTO role_bindings (project_id, role, agent_id) VALUES (5, 'not-a-real-role', ?)`)
          .run(agentId)
      ).toThrow();

      // The migration seeded the facts-only branch-safety capabilities row (same shape as fresh DB).
      const seededCap = dbs.raw.prepare(`SELECT * FROM role_capabilities WHERE role = 'branch-safety'`).get() as any;
      expect(seededCap).toBeTruthy();
      expect(seededCap.can_write_code).toBe(0);
      expect(seededCap.panel_participant).toBe(0);
      expect(seededCap.can_escalate).toBe(0);
      expect(seededCap.session_policy).toBe('fresh');

      expect(dbs.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      dbs.close();

      // Idempotent re-open: no duplicate rows, no CHECK regression.
      const again = new DatabaseService(dbPath);
      expect((again.raw.prepare('SELECT version FROM schema_version').get() as any).version).toBe(
        SCHEMA_VERSION
      );
      expect((again.raw.prepare('SELECT COUNT(*) AS c FROM role_capabilities').get() as any).c).toBe(
        countsBefore.role_capabilities + 1
      );
      again.close();
    });
  });
});

describe('cycle-branch-lifecycle B2: live data/helm.db (read-only assertion, never mutated)', () => {
  it('already reports ≥v114 with a facts-only branch-safety role_capabilities row', () => {
    const liveDbPath = path.resolve('data/helm.db');
    if (!fs.existsSync(liveDbPath)) {
      // No live DB present in this environment (e.g. a clean CI checkout) — nothing to assert.
      return;
    }
    const live = new Database(liveDbPath, { readonly: true });
    try {
      const version = (live.prepare('SELECT version FROM schema_version').get() as any).version;
      expect(version).toBeGreaterThanOrEqual(114);

      for (const table of ROLE_CHECK_TABLES) {
        const ddl = (live
          .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?")
          .get(table) as any).sql;
        expect(ddl).toContain('branch-safety');
      }

      const row = live.prepare(`SELECT * FROM role_capabilities WHERE role = 'branch-safety'`).get() as any;
      expect(row).toBeTruthy();
      expect(row.can_write_code).toBe(0);
      expect(row.panel_participant).toBe(0);
      expect(row.can_escalate).toBe(0);
      expect(row.session_policy).toBe('fresh');
    } finally {
      live.close();
    }
  });
});
