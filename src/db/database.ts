import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { SCHEMA_VERSION, SCHEMA_SQL, V89_IBRAIN_DEFINITION_MD, V89_KNOWN_CANONICAL_PLANCORE_HASHES, V89_PLANCORE_DEFINITION_MD, applyFreshDbExtras, applyB04CanonicalModelSeeds, applyB12bRoleTierSeeds, applyB17TeamTierSeeds, applyB1TeamsSeeds, applyB3AgentRoleCapabilitySeeds, applyB2HelmAgentSeeds, applyB09aCanonicalRosterSeeds, applyB09bPruneNonCanonicalAgents, applyB25OrphanModelHygiene, applyB25dDeleteUnknownProviderMasterRuntimes, applyB6AgentMemorySeeds, applyB11PanelistRetirement, applyHousekeeperSeed, seedRoutingRules } from "./schema.js";
import { deriveSessionOwner } from "../services/session-registry-service.js";

// Schema-data constants live in ./schema.ts. Migration logic stub here
// ready for P1-2 to extend (per brief: seed schema_version to 1 only).

export class DatabaseService {
  private db: Database.Database;

  constructor(dbPath: string) {
    const resolvedDbPath = path.resolve(dbPath);
    const liveDbPath = path.resolve(process.cwd(), 'data/helm.db');
    if (
      process.env.VITEST
      && resolvedDbPath === liveDbPath
      && process.env.HELM_ALLOW_LIVE_DB !== '1'
    ) {
      throw new Error('Vitest must not open write-capable live data/helm.db; use a temp HELM_DB_PATH');
    }
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initSchema();
  }

  /**
   * B19-fix1: run `fn` with the cascade-delete-allow flag set (a row in `_cascade_delete_allow`,
   * see schema.ts), so immutability triggers that key off it (e.g. `cycle_topology_freezes`'s
   * no-delete trigger) permit deletes that happen as a side effect of `fn` (FK CASCADE from an
   * intentional parent delete), while still blocking any unrelated direct delete attempted outside
   * this wrapper. SQLite triggers cannot reference TEMP objects, so this must be a real (persisted)
   * table rather than a connection-scoped one.
   * B19-fix2: the INSERT/fn/DELETE now run inside one `this.db.transaction(...)` (better-sqlite3
   * native BEGIN/COMMIT) instead of three separate autocommit statements — nothing durably commits
   * until the trailing DELETE succeeds, so a process crash mid-`fn()` leaves the whole operation
   * unwritten (flag row absent on restart) instead of stuck durably open. A throw inside `fn()`
   * auto-ROLLBACKs via the transaction wrapper, so the flag never outlives the call either way.
   */
  withCascadeDeleteAllowed<T>(fn: () => T): T {
    const txn = this.db.transaction(() => {
      this.db.exec("INSERT INTO _cascade_delete_allow (v) VALUES (1)");
      const result = fn();
      this.db.exec("DELETE FROM _cascade_delete_allow");
      return result;
    });
    return txn();
  }

  private initSchema(): void {
    const versionRow = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
      .get() as { name: string } | undefined;

    if (!versionRow) {
      this.db.exec(SCHEMA_SQL);
      applyFreshDbExtras(this.db);
      applyB2HelmAgentSeeds(this.db);  // B2: SCHEMA_SQL agents includes agent_type; not inside applyFreshDbExtras (v18 mig safety)
      applyB09aCanonicalRosterSeeds(this.db);  // B09a: R2.8–R2.9 project+house canonical roster (after agent_type exists)
      applyB3AgentRoleCapabilitySeeds(this.db);  // v89: discovery exists after B09a, so bind its role default
      applyB09bPruneNonCanonicalAgents(this.db);  // B09b: R2.11 prune non-canonical + FK cleanup (after B09a seeds)
      applyHousekeeperSeed(this.db);  // S15: housekeeper house+tiered main+2 (after models + B09a so prune allowlist holds)
      applyB25OrphanModelHygiene(this.db);  // B25 fix1: remap orphan agents.model + prune unreferenced orphan models
      applyB25dDeleteUnknownProviderMasterRuntimes(this.db);  // B25d: no unknown-provider master_runtimes
      applyB1TeamsSeeds(this.db);  // B1: after full SCHEMA_SQL (teams present)
      applyB6AgentMemorySeeds(this.db);  // B6: HB13 three-color memory seeds (after agents/projects exist)
      seedRoutingRules(this.db);  // A3: seed the 9 core routing rules VERBATIM from OrchestratorLoop's hardcoded FSM
      // AC-2: name-map classification on fresh seeds (same map as v94 migration backfill)
      this.db.exec("UPDATE agents SET classification='tiered' WHERE name IN ('implementer','validator','housekeeper')");
      this.db.exec("UPDATE agents SET classification='team'   WHERE name = 'planner'");
      this.db.exec("UPDATE agents SET classification='solo'   WHERE name IN ('discovery','plancore','ibrain','panelist')");
      // B11 / AC-3: retire panelist as product seat (hidden seed + unbind role_defaults/bindings)
      applyB11PanelistRetirement(this.db);
      this.db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
      return;
    }

    // migration-runner stub — P1-2 will extend with version checks + DDL
    const current = this.db
      .prepare("SELECT version FROM schema_version")
      .get() as { version: number } | undefined;

    if (!current || current.version < SCHEMA_VERSION) {
      // GREEN-1: table-existence guard helper so *any* synthetic old-version seed (p1-4 v3/v4/v5/v6/v7/v8 etc)
        // migrates cleanly without "no such table" on agents or agent_events. Guards *every* block that
        // assumes/touches those tables (v5 UPDATE agent_events, v7/v10 agents, v14 rebuild copy).
        // Matches existing PRAGMA/sqlite_master defensive patterns (v5/v6/v7/v8/v10).
        const hasTable = (name: string) =>
          !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name);
        /** B07a: historical migrations wrote 'helm'; post-v63 CHECK is house|project. Pick a value the current CHECK accepts. */
        const houseAgentTypeValue = (): 'helm' | 'house' => {
          if (!hasTable('agents')) return 'house';
          const sql = (this.db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='agents'`).get() as any)?.sql as string | undefined;
          if (sql && sql.includes("'helm'") && !sql.includes("'house'")) return 'helm';
          return 'house';
        };
        const projectAgentsAgentFkCascades = () => {
          if (!hasTable('project_agents')) return true;
          const fks = this.db.prepare('PRAGMA foreign_key_list(project_agents)').all() as any[];
          return fks.some((fk: any) =>
            fk.table === 'agents'
            && fk.from === 'agent_id'
            && String(fk.on_delete || '').toUpperCase() === 'CASCADE'
          );
        };
        const rebuildProjectAgentsWithAgentCascade = () => {
          if (!hasTable('project_agents') || projectAgentsAgentFkCascades()) return;
          const countValidChildRows = (table: 'project_agent_toolkits' | 'project_agent_escalations') => {
            if (!hasTable(table) || !hasTable('project_agents')) return 0;
            return (this.db.prepare(`
              SELECT COUNT(*) as c FROM ${table} tk
              WHERE EXISTS (
                SELECT 1 FROM project_agents pa
                WHERE pa.project_id = tk.project_id AND pa.agent_id = tk.agent_id
              )
            `).get() as any).c as number;
          };
          const beforeProjectAgents = (this.db.prepare('SELECT COUNT(*) as c FROM project_agents').get() as any).c as number;
          const beforeToolkits = countValidChildRows('project_agent_toolkits');
          const beforeEscalations = countValidChildRows('project_agent_escalations');

          this.db.exec(`
DROP TABLE IF EXISTS temp.b9_project_agent_toolkits_copy;
DROP TABLE IF EXISTS temp.b9_project_agent_escalations_copy;
`);
          if (hasTable('project_agent_toolkits')) {
            this.db.exec(`
CREATE TEMP TABLE b9_project_agent_toolkits_copy AS
  SELECT id, project_id, agent_id, toolkit_id, position FROM project_agent_toolkits;
DROP TABLE project_agent_toolkits;
`);
          }
          if (hasTable('project_agent_escalations')) {
            this.db.exec(`
CREATE TEMP TABLE b9_project_agent_escalations_copy AS
  SELECT id, project_id, agent_id, position, model_id, trigger FROM project_agent_escalations;
DROP TABLE project_agent_escalations;
`);
          }
          this.db.exec(`
CREATE TABLE project_agents_new (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  model_id INTEGER REFERENCES models(id),
  use_dynamic INTEGER NOT NULL DEFAULT 0,
  backup_model_id INTEGER REFERENCES models(id),
  effort_override TEXT,
  spawn_pref_override TEXT,
  disabled_override INTEGER CHECK(disabled_override IN (0,1)),
  definition_md_override TEXT,
  toolkits_overridden INTEGER NOT NULL DEFAULT 0 CHECK(toolkits_overridden IN (0,1)),
  escalations_overridden INTEGER NOT NULL DEFAULT 0 CHECK(escalations_overridden IN (0,1)),
  is_primary_driver INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, agent_id)
);
INSERT INTO project_agents_new (
  id, project_id, agent_id, model_id, use_dynamic, backup_model_id, effort_override,
  spawn_pref_override, disabled_override, definition_md_override, toolkits_overridden,
  escalations_overridden, is_primary_driver, created_at, updated_at
)
SELECT
  id, project_id, agent_id, model_id, use_dynamic, backup_model_id, effort_override,
  spawn_pref_override, disabled_override, definition_md_override, toolkits_overridden,
  escalations_overridden, is_primary_driver, created_at, updated_at
FROM project_agents;
DROP TABLE project_agents;
ALTER TABLE project_agents_new RENAME TO project_agents;

CREATE TABLE IF NOT EXISTS project_agent_toolkits (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  toolkit_id INTEGER NOT NULL REFERENCES toolkits(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(project_id, agent_id) REFERENCES project_agents(project_id, agent_id) ON DELETE CASCADE,
  UNIQUE(project_id, agent_id, toolkit_id)
);
CREATE INDEX IF NOT EXISTS idx_project_agent_toolkits_agent ON project_agent_toolkits(project_id, agent_id);

CREATE TABLE IF NOT EXISTS project_agent_escalations (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  model_id INTEGER NOT NULL REFERENCES models(id),
  trigger TEXT NOT NULL DEFAULT 'on-fail',
  FOREIGN KEY(project_id, agent_id) REFERENCES project_agents(project_id, agent_id) ON DELETE CASCADE,
  UNIQUE(project_id, agent_id, position)
);
CREATE INDEX IF NOT EXISTS idx_project_agent_escalations_agent ON project_agent_escalations(project_id, agent_id);
`);
          if (beforeToolkits > 0) {
            this.db.exec(`
INSERT INTO project_agent_toolkits (id, project_id, agent_id, toolkit_id, position)
  SELECT c.id, c.project_id, c.agent_id, c.toolkit_id, c.position
  FROM temp.b9_project_agent_toolkits_copy c
  INNER JOIN project_agents pa ON pa.project_id = c.project_id AND pa.agent_id = c.agent_id;
`);
          }
          if (beforeEscalations > 0) {
            this.db.exec(`
INSERT INTO project_agent_escalations (id, project_id, agent_id, position, model_id, trigger)
  SELECT c.id, c.project_id, c.agent_id, c.position, c.model_id, c.trigger
  FROM temp.b9_project_agent_escalations_copy c
  INNER JOIN project_agents pa ON pa.project_id = c.project_id AND pa.agent_id = c.agent_id;
`);
          }
          this.db.exec(`
DROP TABLE IF EXISTS temp.b9_project_agent_toolkits_copy;
DROP TABLE IF EXISTS temp.b9_project_agent_escalations_copy;
`);

          const afterProjectAgents = (this.db.prepare('SELECT COUNT(*) as c FROM project_agents').get() as any).c as number;
          const afterToolkits = countValidChildRows('project_agent_toolkits');
          const afterEscalations = countValidChildRows('project_agent_escalations');
          if (afterProjectAgents !== beforeProjectAgents) throw new Error(`project_agents migration row-count mismatch: before=${beforeProjectAgents} after=${afterProjectAgents}`);
          if (afterToolkits !== beforeToolkits) throw new Error(`project_agent_toolkits migration row-count mismatch: before=${beforeToolkits} after=${afterToolkits}`);
          if (afterEscalations !== beforeEscalations) throw new Error(`project_agent_escalations migration row-count mismatch: before=${beforeEscalations} after=${afterEscalations}`);
        };
        const applyV49ProjectAgentsRebuild = () => {
          const fkWasOn = this.db.pragma('foreign_keys', { simple: true }) === 1;
          this.db.pragma('foreign_keys = OFF');
          this.db.exec('BEGIN IMMEDIATE;');
          try {
            rebuildProjectAgentsWithAgentCascade();
            this.db.pragma('foreign_keys = ON');
            const fkProblems = this.db.prepare('PRAGMA foreign_key_check').all() as any[];
            if (fkProblems.length > 0) {
              throw new Error(`foreign_key_check failed during v49 project_agents rebuild: ${JSON.stringify(fkProblems.slice(0, 5))}`);
            }
            this.db.prepare('UPDATE schema_version SET version = 49').run();
            this.db.exec('COMMIT;');
          } catch (e) {
            try { this.db.exec('ROLLBACK;'); } catch {}
            this.db.pragma(`foreign_keys = ${fkWasOn ? 'ON' : 'OFF'}`);
            throw e;
          }
          this.db.pragma('foreign_keys = ON');
        };

        // v51 (kloo B1): widen the agents.provider + models.provider CHECK to include 'kloo' and add a
        // new models.route column (D6 — the kloo route/openrouter-vs-local home). SQLite cannot ALTER a
        // CHECK in place, so this is a table rebuild — same legacy-ALTER pattern as
        // applyV49ProjectAgentsRebuild (FK OFF, rebuild, FK ON, foreign_key_check, then bump version).
        //
        // A table is only rebuilt when its stored CREATE SQL carries the OLD restrictive provider CHECK
        // (i.e. lacks 'kloo'). That guard is precise: the canonical restrictive CHECK is only ever emitted
        // by SCHEMA_SQL or the guarded migration blocks that ALSO bring the table up to its full canonical
        // column set — so any table matching it is guaranteed to have every column the rebuild copies. It
        // cleanly SKIPS ad-hoc synthetic-fixture tables (e.g. `agents(id, name)` or a nullable `created_at`
        // with no default) that never had the CHECK, and it is naturally idempotent (once rebuilt, the SQL
        // contains 'kloo', so a re-open with an un-bumped version would not re-fire). Every OTHER table's FK
        // to agents(id)/models(id) lives on the CHILD table and resolves by name, staying valid across the
        // rename — verified by foreign_key_check below. Version is bumped to 51 unconditionally.
        const providerCheckNeedsKloo = (table: string): boolean => {
          const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?").get(table) as { sql: string } | undefined;
          if (!row || !row.sql) return false;
          return /CHECK\s*\(\s*provider\s+IN/i.test(row.sql) && !/kloo/i.test(row.sql);
        };
        const applyV51KlooProviderRebuild = () => {
          const fkWasOn = this.db.pragma('foreign_keys', { simple: true }) === 1;
          this.db.pragma('foreign_keys = OFF');
          this.db.exec('BEGIN IMMEDIATE;');
          try {
            // models first (agents FKs reference models(id); rebuild order does not matter with FK OFF,
            // but keep models before agents for readability).
            if (hasTable('models') && providerCheckNeedsKloo('models')) {
              const beforeModels = (this.db.prepare('SELECT COUNT(*) as c FROM models').get() as any).c as number;
              this.db.exec(`
CREATE TABLE models_new (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('claude','codex','grok','kloo')),
  model_id TEXT NOT NULL,
  effort TEXT NOT NULL DEFAULT 'medium',
  approval TEXT NOT NULL DEFAULT 'auto',
  flags TEXT,
  approval_policy TEXT,
  sandbox_mode TEXT,
  permission_mode TEXT,
  bypass INTEGER NOT NULL DEFAULT 0,
  validation_status TEXT NOT NULL DEFAULT 'untested' CHECK(validation_status IN ('untested','valid','invalid')),
  validated_at TEXT,
  validation_detail TEXT,
  route TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO models_new (
  id, name, provider, model_id, effort, approval, flags, approval_policy, sandbox_mode,
  permission_mode, bypass, validation_status, validated_at, validation_detail, route, created_at, updated_at
)
SELECT
  id, name, provider, model_id, effort, approval, flags, approval_policy, sandbox_mode,
  permission_mode, bypass, validation_status, validated_at, validation_detail, NULL, created_at, updated_at
FROM models;
DROP TABLE models;
ALTER TABLE models_new RENAME TO models;
`);
              const afterModels = (this.db.prepare('SELECT COUNT(*) as c FROM models').get() as any).c as number;
              if (afterModels !== beforeModels) throw new Error(`models migration row-count mismatch (v51 kloo rebuild): before=${beforeModels} after=${afterModels}`);
            }

            if (hasTable('agents') && providerCheckNeedsKloo('agents')) {
              const beforeAgents = (this.db.prepare('SELECT COUNT(*) as c FROM agents').get() as any).c as number;
              this.db.exec(`
CREATE TABLE agents_new (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('claude', 'codex', 'grok', 'kloo')),
  model TEXT NOT NULL,
  default_effort TEXT NOT NULL DEFAULT 'medium',
  definition_md TEXT,
  default_model_id INTEGER REFERENCES models(id),
  backup_model_id INTEGER REFERENCES models(id),
  spawn_pref TEXT NOT NULL DEFAULT 'tmux',
  in_development INTEGER NOT NULL DEFAULT 0 CHECK(in_development IN (0,1)),
  agent_type TEXT NOT NULL DEFAULT 'project' CHECK(agent_type IN ('helm','project')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO agents_new (
  id, name, provider, model, default_effort, definition_md, default_model_id, backup_model_id,
  spawn_pref, in_development, agent_type, created_at, updated_at
)
SELECT
  id,
  name,
  IFNULL(provider, 'claude'),
  IFNULL(model, 'unknown'),
  IFNULL(default_effort, 'medium'),
  definition_md,
  default_model_id,
  backup_model_id,
  IFNULL(spawn_pref, 'tmux'),
  IFNULL(in_development, 0),
  IFNULL(agent_type, 'project'),
  COALESCE(created_at, datetime('now')),
  COALESCE(updated_at, datetime('now'))
FROM agents;
DROP TABLE agents;
ALTER TABLE agents_new RENAME TO agents;
`);
              const afterAgents = (this.db.prepare('SELECT COUNT(*) as c FROM agents').get() as any).c as number;
              if (afterAgents !== beforeAgents) throw new Error(`agents migration row-count mismatch (v51 kloo rebuild): before=${beforeAgents} after=${afterAgents}`);
            }

            this.db.pragma('foreign_keys = ON');
            const fkProblems = this.db.prepare('PRAGMA foreign_key_check').all() as any[];
            if (fkProblems.length > 0) {
              throw new Error(`foreign_key_check failed during v51 kloo-provider rebuild: ${JSON.stringify(fkProblems.slice(0, 5))}`);
            }
            this.db.prepare('UPDATE schema_version SET version = 51').run();
            this.db.exec('COMMIT;');
          } catch (e) {
            try { this.db.exec('ROLLBACK;'); } catch {}
            this.db.pragma(`foreign_keys = ${fkWasOn ? 'ON' : 'OFF'}`);
            throw e;
          }
          this.db.pragma('foreign_keys = ON');
        };

      // First-pass migration txn (v1–v31 blocks).
      this.db.exec('BEGIN IMMEDIATE;');
      try {
        // B11 slice3: v18 → v19 additive horizon for memories (long|short). UI3 long-term vs short-term + promote/purge.
        if (current && current.version < 19) {
          if (hasTable('memories')) {
            const cols = this.db.prepare("PRAGMA table_info(memories)").all().map((c: any) => c.name);
            if (!cols.includes('horizon')) {
              this.db.exec(`ALTER TABLE memories ADD COLUMN horizon TEXT NOT NULL DEFAULT 'long' CHECK(horizon IN ('long','short'))`);
              this.db.exec(`UPDATE memories SET horizon = 'long' WHERE horizon IS NULL OR horizon = ''`);
              this.db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_horizon ON memories(horizon, scope, status)`);
            }
          }
        }

        // E-b2 (G13): ensure horizon column on memories if not present (defensive PRAGMA guard).
        // Two-track: fresh from SCHEMA_SQL (v29+), mig for any prior DBs missing it. Per-project short/long reviewable.
        if (current && current.version < 29) {
          if (hasTable('memories')) {
            const cols = this.db.prepare("PRAGMA table_info(memories)").all().map((c: any) => c.name);
            if (!cols.includes('horizon')) {
              this.db.exec(`ALTER TABLE memories ADD COLUMN horizon TEXT NOT NULL DEFAULT 'long' CHECK(horizon IN ('long','short'))`);
              this.db.exec(`UPDATE memories SET horizon = 'long' WHERE horizon IS NULL OR horizon = ''`);
              this.db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_horizon ON memories(horizon, scope, status)`);
            }
          }
        }

        // Migration: v1 → v2: agent_events table + indexes (additive, via P1-1 runner)
        if (current && current.version < 2) {
          this.db.exec(`
CREATE TABLE IF NOT EXISTS agent_events (
  id INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL,
  role TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  session TEXT,
  type TEXT NOT NULL CHECK(type IN ('message', 'status', 'tool', 'gate')),
  state TEXT,
  source TEXT NOT NULL CHECK(source IN ('callback', 'git', 'pane', 'post', 'chat')),
  correlation_id TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '{}',
  ts TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_events_run_ts ON agent_events(run_id, ts);
CREATE INDEX IF NOT EXISTS idx_agent_events_batch_type ON agent_events(run_id, batch_id, type);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_events_terminal_dedupe
  ON agent_events(run_id, batch_id, state, correlation_id)
  WHERE type = 'status' AND state IN ('DONE', 'BLOCKED');
`);
        }
        // Migration: v2 → v3: agents + role_bindings + role_defaults + project_master_models (additive, via P1-1 runner; P1-4 Project Setup)
        if (current && current.version < 3) {
          this.db.exec(`
CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('claude', 'codex', 'grok', 'kloo')),
  model TEXT NOT NULL,
  default_effort TEXT NOT NULL DEFAULT 'medium',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS role_bindings (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('projcore', 'coord', 'implementer', 'validator', 'deliberation', 'red-team', 'planner', 'routine-implementer', 'panelist')),
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, role)
);

CREATE TABLE IF NOT EXISTS role_defaults (
  role TEXT PRIMARY KEY CHECK(role IN ('projcore', 'coord', 'implementer', 'validator', 'deliberation', 'red-team', 'planner', 'routine-implementer', 'panelist')),
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS project_master_models (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  UNIQUE(project_id, position)
);
CREATE INDEX IF NOT EXISTS idx_pmm_project ON project_master_models(project_id);
`);
        }
        // Migration: v3 → v4: master_runtimes (P1-5a: launchMaster + real readyProbe + master-launched provenance gate). Single source of truth (SCHEMA_SQL for fresh, this block for upgrade).
        if (current && current.version < 4) {
          this.db.exec(`
CREATE TABLE IF NOT EXISTS master_runtimes (
  project_id INTEGER PRIMARY KEY,
  master_run_id TEXT NOT NULL,
  tmux_session TEXT NOT NULL,
  tmux_pane TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('launching','running','parked','failed')),
  core_sha TEXT,
  overlay_sha TEXT,
  intentional_park_until TEXT,
  last_launched_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);
        }
        // Migration: v4 → v5 (P1-6b): additive seq for agent_events (digest citation) + master_switches (swap lock + audit per consensus §2/§5). Single source. H8: guarded + in txn.
        if (current && current.version < 5) {
          if (hasTable('agent_events')) {
            const cols = this.db.prepare("PRAGMA table_info(agent_events)").all().map((c: any) => c.name);
            if (!cols.includes('seq')) {
              this.db.exec(`ALTER TABLE agent_events ADD COLUMN seq INTEGER DEFAULT 0;`);
            }
            // backfill for citation order on legacy rows (guarded so pre-v2 seeds don't explode)
            this.db.exec(`UPDATE agent_events SET seq = id WHERE seq = 0 OR seq IS NULL;`);
          }
          this.db.exec(`
CREATE TABLE IF NOT EXISTS master_switches (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL,
  from_provider TEXT NOT NULL,
  from_model TEXT NOT NULL,
  to_provider TEXT NOT NULL,
  to_model TEXT NOT NULL,
  correlation TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('requested','parking','ingesting','launching','resuming','switched','failed')),
  reason TEXT NOT NULL DEFAULT 'manual',
  digest_hash TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  switched_at TEXT
);
`);
          this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_master_switches_corr ON master_switches(correlation);`);
          this.db.exec(`CREATE INDEX IF NOT EXISTS idx_master_switches_proj ON master_switches(project_id);`);
        }
        // P2-1 v6 worker_runtimes (CREATE-only, guarded, inside txn)
        if (current && current.version < 6) {
          const cols = this.db.prepare("PRAGMA table_info(worker_runtimes)").all().map((c: any) => c.name);
          if (cols.length === 0) {
            this.db.exec(`
CREATE TABLE IF NOT EXISTS worker_runtimes (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  session TEXT,
  task_brief TEXT,
  correlation_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('launching','running','done','failed','reaped')),
  pane_pid INTEGER,
  spawned_by TEXT,
  master_run_id TEXT,
  exit_reason TEXT,
  started_at TEXT,
  ended_at TEXT,
  ts TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_worker_runtimes_proj_state ON worker_runtimes(project_id, state);
`);
          }
        }
        // P3-1 v7: agents.definition_md (ALTER-only per consensus MED#6; PRAGMA table_info guard; inside txn; no CREATE TABLE agents; additive nullable TEXT)
        if (current && current.version < 7) {
          // defensive: agents is created at v3, so any real v5/v6 DB has it — but guard table existence
          // so a partial/hand-rolled upgrade DB can't crash the whole migration on ALTER.
          const cols = this.db.prepare("PRAGMA table_info(agents)").all().map((c: any) => c.name);
          if (cols.length > 0 && !cols.includes('definition_md')) {
            this.db.exec(`ALTER TABLE agents ADD COLUMN definition_md TEXT;`);
          }
        }
        // P3-2 v8: toolkits + agent_toolkits (two new tables, exact FK CASCADE for agent_id / RESTRICT for toolkit_id per consensus) + toolkits_sha col on master_runtimes.
        // Two-track: CREATE IF guarded + PRAGMA table_info for the ALTER; inside the BEGIN IMMEDIATE txn; idempotent run-twice.
        if (current && current.version < 8) {
          // toolkits tables (new) — both CREATE IF NOT EXISTS run UNCONDITIONALLY (idempotent) so a
          // partial prior state (toolkits present, agent_toolkits missing) still gets both created.
          // red-team M2: dropped the `tCols.length===0` gate that would skip agent_toolkits in that case.
          this.db.exec(`
CREATE TABLE IF NOT EXISTS toolkits (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  description TEXT,
  body_md TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_toolkits (
  id INTEGER PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  toolkit_id INTEGER NOT NULL REFERENCES toolkits(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL DEFAULT 0,
  UNIQUE(agent_id, toolkit_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_toolkits_agent ON agent_toolkits(agent_id);
`);
          // master_runtimes col (additive, guarded)
          const mrCols = this.db.prepare("PRAGMA table_info(master_runtimes)").all().map((c: any) => c.name);
          if (mrCols.length > 0 && !mrCols.includes('toolkits_sha')) {
            this.db.exec(`ALTER TABLE master_runtimes ADD COLUMN toolkits_sha TEXT;`);
          }
        }
        // B1 v9: models shared library (S1). Two-track: CREATE TABLE IF NOT EXISTS here (for existing DBs)
        // + idempotent seed OR IGNORE. Matches exact pattern of v8 toolkits (CREATE IF unconditional for partial states).
        // Seeds also in applyFreshDbExtras for fresh DBs. No PRAGMA guard needed (new table).
        if (current && current.version < 9) {
          this.db.exec(`
CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('claude','codex','grok','kloo')),
  model_id TEXT NOT NULL,
  effort TEXT NOT NULL DEFAULT 'medium',
  approval TEXT NOT NULL DEFAULT 'auto',
  flags TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);
          const seeds = [
            {name:'claude-opus', provider:'claude', model_id:'claude-opus-5', effort:'high', approval:'auto', flags:null},
            {name:'grok-4.5', provider:'grok', model_id:'grok-4.5', effort:'medium', approval:'always-approve', flags:null},
            {name:'codex-5.5', provider:'codex', model_id:'gpt-5.5', effort:'medium', approval:'bypass-sandbox', flags:'--dangerously-bypass-approvals-and-sandbox'},
            {name:'spark', provider:'codex', model_id:'gpt-5.3-codex-spark', effort:'dynamic', approval:'bypass', flags:'--dangerously-bypass-approvals-and-sandbox'},
            {name:'claude-sonnet', provider:'claude', model_id:'claude-sonnet-4-6', effort:'dynamic', approval:'auto', flags:null}
          ];
          for (const s of seeds) {
            this.db.prepare(`INSERT OR IGNORE INTO models (name, provider, model_id, effort, approval, flags) VALUES (?,?,?,?,?,?)`).run(s.name, s.provider, s.model_id, s.effort, s.approval, s.flags);
          }
        }
        // B2 v10: agents model bindings (S2). Two-track additive per brief. PRAGMA table_info guard per col (defensive, like v7/v8). Inside BEGIN IMMEDIATE. Backfill ONLY default_model_id by exact name match to models (e.g. 'grok-4.5' agent → 'grok-4.5' model); backup/spawn leave default (NULL/'tmux'). Standing gate (1).
        // GREEN-1: full guard with hasTable so v4/v5/etc synthetic seeds (no agents table, v3 create skipped) don't hit "no such table: agents" on the UPDATE backfill.
        if (current && current.version < 10) {
          if (hasTable('agents')) {
            const aCols = this.db.prepare("PRAGMA table_info(agents)").all().map((c: any) => c.name);
            if (!aCols.includes('default_model_id')) {
              this.db.exec(`ALTER TABLE agents ADD COLUMN default_model_id INTEGER REFERENCES models(id);`);
            }
            if (!aCols.includes('backup_model_id')) {
              this.db.exec(`ALTER TABLE agents ADD COLUMN backup_model_id INTEGER REFERENCES models(id);`);
            }
            if (!aCols.includes('spawn_pref')) {
              this.db.exec(`ALTER TABLE agents ADD COLUMN spawn_pref TEXT NOT NULL DEFAULT 'tmux';`);
            }
            // backfill default only (name match); leave NULL if no match (per brief + standing gate 1)
            this.db.exec(`UPDATE agents SET default_model_id = (SELECT id FROM models WHERE name = agents.name) WHERE default_model_id IS NULL;`);
          }
        }
        // B3a v11: plumbing watcher-of-watchers (S3). Additive 3 tables only (consensus §5). Two-track: CREATE IF NOT EXISTS inside txn (idempotent). No PRAGMA guards needed for brand new tables. Matches v8/v9 pattern exactly. v1 scope: configs (bounded self+JROM), watch_states (live per coordinator from master_runtimes), checkpoint_log (for Context Steward). Heartbeat/ hash precedence and dedupe enforced in service.
        if (current && current.version < 11) {
          this.db.exec(`
CREATE TABLE IF NOT EXISTS plumbing_configs (
  project_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'plancore',
  poll_ms INTEGER NOT NULL DEFAULT 30000,
  heartbeat_ttl_ms INTEGER NOT NULL DEFAULT 120000,
  checkin_policy_json TEXT,
  hard_cap_policy_json TEXT,
  refresh_every_tasks INTEGER NOT NULL DEFAULT 10,
  context_watermark_pct INTEGER NOT NULL DEFAULT 80,
  brain_agent_id INTEGER REFERENCES agents(id),
  backup_brain_agent_id INTEGER REFERENCES agents(id),
  jrom_override_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, role)
);
CREATE INDEX IF NOT EXISTS idx_plumbing_configs_proj ON plumbing_configs(project_id);

CREATE TABLE IF NOT EXISTS coordinator_watch_states (
  project_id INTEGER PRIMARY KEY,
  state TEXT NOT NULL CHECK(state IN ('active','stuck','recovering','closed')) DEFAULT 'active',
  last_heartbeat_at TEXT,
  last_task_hash TEXT,
  last_progress_at TEXT,
  current_task_id TEXT,
  tasks_since_refresh INTEGER NOT NULL DEFAULT 0,
  refresh_due INTEGER NOT NULL DEFAULT 0,
  last_watch_reason TEXT,
  dedupe_key TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_wakeup_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS plumbing_checkpoint_log (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL,
  checkpoint_type TEXT NOT NULL,
  task_id TEXT,
  reason TEXT,
  action TEXT,
  digest_hash TEXT,
  event_id INTEGER,
  ts TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_plumbing_checkpoint_proj_ts ON plumbing_checkpoint_log(project_id, ts);
`);
        }
        // C1 v12: projects table (A0/P1 — Helm source of truth). Two-track: CREATE IF NOT EXISTS (idempotent for partials). No PRAGMA guards needed (brand new table). Inside BEGIN IMMEDIATE txn. Matches v8/v9/v11 pattern exactly. v8→v12 verified on live db copy in test.
        if (current && current.version < 12) {
          this.db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  directory TEXT NOT NULL,
  tmux_session TEXT,
  primary_driver_agent_id INTEGER REFERENCES agents(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);
        }
        // C2 v13: project_agents table (P2 — per-project agent team + model overrides incl. Dynamic=coordinator picks from GLOBAL model pool; Set-to-default; Add-all; add/delete; exactly-one primary driver).
        // Two-track: CREATE IF NOT EXISTS (idempotent for partials, like v9/v11/v12). No PRAGMA guards (brand new table). Inside BEGIN IMMEDIATE txn. v8→v13 verified on COPY of live db in test (preserves agents/models/projects counts + data).
        if (current && current.version < 13) {
          this.db.exec(`
CREATE TABLE IF NOT EXISTS project_agents (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  model_id INTEGER REFERENCES models(id),
  use_dynamic INTEGER NOT NULL DEFAULT 0,
  is_primary_driver INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, agent_id)
);
`);
        }
        // D1-fix1 v13→v14: REBUILD agent_events to add 'chat' to source CHECK (SQLite cannot ALTER CHECK).
        // Two-track, inside the BEGIN IMMEDIATE txn (per corrections/batch-D1-iter1.md).
        // New table w/ identical cols (incl seq from v5) + updated source CHECK, copy rows, drop/rename, recreate all 3 indexes (incl terminal-dedupe UNIQUE).
        // GREEN-1: guarded with hasTable so synthetic minimal pre-v2 seeds (v5/v6/v7/v8 in p1-4 that lack agent_events) migrate cleanly.
        if (current && current.version < 14) {
          if (hasTable('agent_events')) {
            this.db.exec(`
CREATE TABLE IF NOT EXISTS agent_events_new (
  id INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL,
  role TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  session TEXT,
  type TEXT NOT NULL CHECK(type IN ('message', 'status', 'tool', 'gate')),
  state TEXT,
  source TEXT NOT NULL CHECK(source IN ('callback', 'git', 'pane', 'post', 'chat')),
  correlation_id TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '{}',
  seq INTEGER DEFAULT 0,
  ts TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO agent_events_new SELECT * FROM agent_events;
DROP TABLE agent_events;
ALTER TABLE agent_events_new RENAME TO agent_events;
CREATE INDEX IF NOT EXISTS idx_agent_events_run_ts ON agent_events(run_id, ts);
CREATE INDEX IF NOT EXISTS idx_agent_events_batch_type ON agent_events(run_id, batch_id, type);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_events_terminal_dedupe
  ON agent_events(run_id, batch_id, state, correlation_id)
  WHERE type = 'status' AND state IN ('DONE', 'BLOCKED');
`);
          }
          // else: no agent_events table (pre-v2 synthetic seed) — skip rebuild/copy; the final SCHEMA_SQL + version bump at end already provide the 'chat' CHECK + full schema.
        }
        // D3 v15: tasks table (C3r). Two-track: CREATE IF NOT EXISTS (idempotent for partial upgrade DBs) + indexes.
        // Inside the BEGIN IMMEDIATE txn (matches v12/v13/v11/v9 pattern exactly). No PRAGMA table_info needed (new table).
        // v14->v15 (base from v8) verified on COPY of live data/helm.db in p2-1.test (preserves all prior rows/counts/indexes, new table + version).
        if (current && current.version < 15) {
          this.db.exec(`
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_key TEXT,
  label TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('completed','working','pending')) DEFAULT 'pending',
  agent TEXT,
  position INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_proj_status ON tasks(project_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_proj_pos ON tasks(project_id, position);
`);
        }
        // E1 v16 (M1 + M2-backend): memories table for app-global + per-project notes (JIT query + propose→approve).
        // Two-track: CREATE IF NOT EXISTS (idempotent for partial upgrade DBs) + index. Inside the BEGIN IMMEDIATE txn.
        // Matches v12/v13/v15 pattern exactly. No PRAGMA needed (new table).
        // v15->v16 (and v8 base) verified on COPY of live data/helm.db in p2-1.test.ts (preserves prior rows/counts, new table+index+version, supports inserts + query filters).
        if (current && current.version < 16) {
          this.db.exec(`
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY,
  scope TEXT NOT NULL CHECK(scope IN ('app','project')),
  project_id INTEGER REFERENCES projects(id),
  title TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL CHECK(type IN ('user','feedback','project','reference')) DEFAULT 'reference',
  body TEXT,
  status TEXT NOT NULL CHECK(status IN ('proposed','approved')) DEFAULT 'approved',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_memories_scope_proj_status ON memories(scope, project_id, status);
`);
        }
        // B1 v17 (ST1/ST2/ST3/MIG1): additive only (never drop/overwrite user rows or edited definition_md).
        // 7 tables per notes-for-B1 (incl. callbacks.acked_at + source). run_id on worker_runtimes (ST3 run-scoped; master_runtimes untouched).
        // Two-track: CREATE IF inside txn (idempotent) + hasTable+PRAGMA guarded ALTER for the col (like v5/v7/v8/v10).
        // Must be proven on COPY of live data/helm.db (see p2-1.test.ts); version assert uses toBe(SCHEMA_VERSION).
        if (current && current.version < 17) {
          // New tables first (runs before any FK ref in worker alter or other creates).
          this.db.exec(`
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  batch_id TEXT,
  north_star_ref TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending','active','complete','failed')) DEFAULT 'active',
  phase TEXT NOT NULL DEFAULT 'planning',
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);

CREATE TABLE IF NOT EXISTS run_tasks (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_key TEXT,
  label TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','working','complete')) DEFAULT 'pending',
  attempts_count INTEGER NOT NULL DEFAULT 0,
  current_attempt_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_run_tasks_run_status ON run_tasks(run_id, status);

CREATE TABLE IF NOT EXISTS task_attempts (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES run_tasks(id) ON DELETE CASCADE,
  attempt_num INTEGER NOT NULL,
  impl_dispatch_id INTEGER,
  validator_dispatch_id INTEGER,
  status TEXT NOT NULL CHECK(status IN ('pending','working','complete','failed')) DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_task_attempts_task ON task_attempts(task_id);

CREATE TABLE IF NOT EXISTS dispatches (
  id INTEGER PRIMARY KEY,
  attempt_id INTEGER NOT NULL REFERENCES task_attempts(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  brief_path TEXT,
  transport_handle TEXT,
  spawned_at TEXT NOT NULL DEFAULT (datetime('now')),
  reaped_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_dispatches_attempt ON dispatches(attempt_id);

CREATE TABLE IF NOT EXISTS callbacks (
  id INTEGER PRIMARY KEY,
  dispatch_id INTEGER NOT NULL REFERENCES dispatches(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  state TEXT NOT NULL,
  raw_line TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  acked_at TEXT,
  source TEXT NOT NULL CHECK(source IN ('file','seam')) DEFAULT 'file'
);
CREATE INDEX IF NOT EXISTS idx_callbacks_dispatch ON callbacks(dispatch_id);

CREATE TABLE IF NOT EXISTS validations (
  id INTEGER PRIMARY KEY,
  attempt_id INTEGER NOT NULL REFERENCES task_attempts(id) ON DELETE CASCADE,
  result TEXT NOT NULL CHECK(result IN ('PASS','FAIL','DONE','BLOCKED')),
  note TEXT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  validator_brief_ref TEXT
);
CREATE INDEX IF NOT EXISTS idx_validations_attempt ON validations(attempt_id);

CREATE TABLE IF NOT EXISTS artifacts (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  path TEXT NOT NULL,
  sha TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id);
`);

          // ST3 additive col (guarded; runs table now exists).
          if (hasTable('worker_runtimes')) {
            const wrCols = this.db.prepare("PRAGMA table_info(worker_runtimes)").all().map((c: any) => c.name);
            if (!wrCols.includes('run_id')) {
              this.db.exec(`ALTER TABLE worker_runtimes ADD COLUMN run_id INTEGER REFERENCES runs(id);`);
            }
            this.db.exec(`CREATE INDEX IF NOT EXISTS idx_worker_runtimes_run ON worker_runtimes(run_id);`);
          }
        }
        // B3 v18 (AG1/AG2/MDL2/ESC1): role_capabilities (typed caps), agent_escalations (ladders table),
        // models structured approval cols (approval_policy/sandbox_mode/permission_mode/bypass; flags rendered from structured in seeds/providers).
        // Two-track: CREATE IF (new tables) + guarded ALTER (cols) inside txn. Seeds via applyFresh (idempotent + MIG1).
        // Live COPY test in p2-1 must preserve prior rows + any edited definition_md.
        if (current && current.version < 18) {
          // New tables (exact per specs; idempotent for partial states)
          this.db.exec(`
CREATE TABLE IF NOT EXISTS role_capabilities (
  role TEXT PRIMARY KEY CHECK(role IN ('projcore', 'coord', 'implementer', 'validator', 'deliberation', 'red-team', 'planner', 'routine-implementer', 'panelist')),
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
          this.db.exec(`
CREATE TABLE IF NOT EXISTS agent_escalations (
  id INTEGER PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  model_id INTEGER NOT NULL REFERENCES models(id),
  trigger TEXT NOT NULL DEFAULT 'on-fail',
  UNIQUE(agent_id, position)
);
`);

          // Models structured cols (additive, guarded like v7/v8/v10)
          if (hasTable('models')) {
            const mcols = this.db.prepare("PRAGMA table_info(models)").all().map((c: any) => c.name);
            if (!mcols.includes('approval_policy')) {
              this.db.exec(`ALTER TABLE models ADD COLUMN approval_policy TEXT;`);
            }
            if (!mcols.includes('sandbox_mode')) {
              this.db.exec(`ALTER TABLE models ADD COLUMN sandbox_mode TEXT;`);
            }
            if (!mcols.includes('permission_mode')) {
              this.db.exec(`ALTER TABLE models ADD COLUMN permission_mode TEXT;`);
            }
            if (!mcols.includes('bypass')) {
              this.db.exec(`ALTER TABLE models ADD COLUMN bypass INTEGER NOT NULL DEFAULT 0;`);
            }
          }

          // GREEN-1 defensive: ensure foundational tables for B3 seeds (agents/role_defaults/models) exist even for
          // synthetic jump DBs (e.g. pre-v3/v6 test setups that set version=5 and skip early create blocks this open).
          // Matches patterns used in v5/v7/v8/etc guarded migs. CREATE IF is idempotent.
          this.db.exec(`
CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('claude', 'codex', 'grok', 'kloo')),
  model TEXT NOT NULL,
  default_effort TEXT NOT NULL DEFAULT 'medium',
  definition_md TEXT,
  default_model_id INTEGER REFERENCES models(id),
  backup_model_id INTEGER REFERENCES models(id),
  spawn_pref TEXT NOT NULL DEFAULT 'tmux',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS role_defaults (
  role TEXT PRIMARY KEY CHECK(role IN ('projcore', 'coord', 'implementer', 'validator', 'deliberation', 'red-team', 'planner', 'routine-implementer', 'panelist')),
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('claude','codex','grok','kloo')),
  model_id TEXT NOT NULL,
  effort TEXT NOT NULL DEFAULT 'medium',
  approval TEXT NOT NULL DEFAULT 'auto',
  flags TEXT,
  approval_policy TEXT,
  sandbox_mode TEXT,
  permission_mode TEXT,
  bypass INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

          // Re-apply seeds (models + agents/roles/caps/escalations). Fresh path + mig both land here.
          applyFreshDbExtras(this.db);
        }

        // B1 v23: teams + team_members tables + default roster seeds (resolve by model name; skip absent).
        // Two-track: CREATE IF NOT EXISTS (idempotent) + index + seeds. Matches v9/v11/v15 patterns.
        if (current && current.version < 23) {
          this.db.exec(`
CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL CHECK(type IN('deliberation','red-team','generic')),
  consensus_rule TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS team_members (
  id INTEGER PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  model_id INTEGER NOT NULL REFERENCES models(id),
  lens TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  context_meta TEXT,
  UNIQUE(team_id, model_id)
);
CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members(team_id);
`);
          // seeds (models should exist from earlier v9/v18 seeds; skip members whose model absent)
          applyB1TeamsSeeds(this.db);
        }

        // B2 v24: role_team_bindings table (contract only; binding team to deliberation/red-team roles).
        // Lower-risk separate table chosen (see B2 rationale in changes.md). Does not touch role_bindings.
        if (current && current.version < 24) {
          this.db.exec(`
CREATE TABLE IF NOT EXISTS role_team_bindings (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('deliberation','red-team')),
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, role)
);
CREATE INDEX IF NOT EXISTS idx_role_team_bindings_proj ON role_team_bindings(project_id);
`);
        }

        // B4 v25: relax run_tasks.status CHECK to include 'failed'+'deferred' (G5; new states for terminal task outcomes before deferral).
        // Rebuild (SQLite cannot ALTER CHECK); copy data; recreate index. Two-track guarded. NEW only, no old row mig.
        // failed/deferred rows do not block independent siblings in queue (getNextReady already skips + continues).
        if (current && current.version < 25) {
          if (hasTable('run_tasks')) {
            this.db.exec(`
CREATE TABLE IF NOT EXISTS run_tasks_new (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_key TEXT,
  label TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','working','complete','failed','deferred')) DEFAULT 'pending',
  attempts_count INTEGER NOT NULL DEFAULT 0,
  current_attempt_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO run_tasks_new SELECT id, run_id, task_key, label, status, attempts_count, current_attempt_id, created_at, updated_at FROM run_tasks;
DROP TABLE run_tasks;
ALTER TABLE run_tasks_new RENAME TO run_tasks;
CREATE INDEX IF NOT EXISTS idx_run_tasks_run_status ON run_tasks(run_id, status);
`);
          }
        }

        // B5 v26: artifacts.task_id (nullable) for run/task ids recorded on artifact rows (NEW runs only; no backfill of old).
        // + index. Two-track ALTER guarded (like v5/v7/v8/v10 cols).
        if (current && current.version < 26) {
          if (hasTable('artifacts')) {
            const acols = this.db.prepare("PRAGMA table_info(artifacts)").all().map((c: any) => c.name);
            if (!acols.includes('task_id')) {
              this.db.exec(`ALTER TABLE artifacts ADD COLUMN task_id INTEGER REFERENCES run_tasks(id) ON DELETE SET NULL;`);
            }
            this.db.exec(`CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(task_id);`);
          }
        }

        // D-a1: v27 additive: projcore_session per-project (editable default helm-projcore-<slug> for run-owned projcore session name).
        // Two-track ALTER guarded.
        if (current && current.version < 27) {
          if (hasTable('projects')) {
            const pcols = this.db.prepare("PRAGMA table_info(projects)").all().map((c: any) => c.name);
            if (!pcols.includes('projcore_session')) {
              this.db.exec(`ALTER TABLE projects ADD COLUMN projcore_session TEXT;`);
            }
          }
        }

        // D-a2: v28 additive: closed_reason flag (and 'closed' state allowed) on master_runtimes for intentional close / run-complete.
        // Supervisor + plumbing must NOT auto-respawn when closed_reason set (run-owned completed/closed stay down).
        if (current && current.version < 28) {
          if (hasTable('master_runtimes')) {
            const mrCols = this.db.prepare("PRAGMA table_info(master_runtimes)").all().map((c: any) => c.name);
            if (!mrCols.includes('closed_reason')) {
              this.db.exec(`ALTER TABLE master_runtimes ADD COLUMN closed_reason TEXT;`);
            }
          }
        }

        // B1 (R-01B1): v29→v30 additive — models.validation_status + validated_at + validation_detail (flag storage only; runner is B2).
        if (current && current.version < 30) {
          if (hasTable('models')) {
            const mcols = this.db.prepare("PRAGMA table_info(models)").all().map((c: any) => c.name);
            if (!mcols.includes('validation_status')) {
              this.db.exec(`ALTER TABLE models ADD COLUMN validation_status TEXT NOT NULL DEFAULT 'untested' CHECK(validation_status IN ('untested','valid','invalid'));`);
            }
            if (!mcols.includes('validated_at')) {
              this.db.exec(`ALTER TABLE models ADD COLUMN validated_at TEXT;`);
            }
            if (!mcols.includes('validation_detail')) {
              this.db.exec(`ALTER TABLE models ADD COLUMN validation_detail TEXT;`);
            }
          }
        }

        // D1 (R-02E): v30→v31 additive — agents.in_development flag (0=project ready / 1=in development).
        if (current && current.version < 31) {
          if (hasTable('agents')) {
            const acols = this.db.prepare('PRAGMA table_info(agents)').all().map((c: any) => c.name);
            if (!acols.includes('in_development')) {
              this.db.exec("ALTER TABLE agents ADD COLUMN in_development INTEGER NOT NULL DEFAULT 0 CHECK(in_development IN (0,1))");
            }
          }
        }

        // B9fix5 (F8): end first-pass txn here — do NOT bump schema_version prematurely.
        this.db.exec('COMMIT;');
      } catch (e) {
        try { this.db.exec('ROLLBACK;'); } catch {}
        throw e;
      }

      // Second-pass migration txn (v20–v48). Version bumps stay inside txn; v49 is separate (FK pragma).
      this.db.exec('BEGIN IMMEDIATE;');
      try {
        // A2 v20 additive: phase column on runs for run state machine (planning/executing/escalating/validating/complete/blocked)
        if (current && current.version < 20) {
          if (hasTable('runs')) {
            const rcols = this.db.prepare("PRAGMA table_info(runs)").all().map((c: any) => c.name);
            if (!rcols.includes('phase')) {
              this.db.exec(`ALTER TABLE runs ADD COLUMN phase TEXT NOT NULL DEFAULT 'planning';`);
            }
          }
        }

        // A4: v20 → v21: relax role_bindings UNIQUE(project_id, role) → UNIQUE(project_id, role, agent_id)
        // to support MULTI red-team + panelist (A2b run path already reads via listProjectBindings for red-team agents).
        // Singles remain 1:1 enforced in service (clear-then-insert). Rebuild (SQLite cannot ALTER unique easily).
        // Matches v14 agent_events rebuild pattern exactly (inside txn, guarded).
        if (current && current.version < 21) {
          if (hasTable('role_bindings')) {
            this.db.exec(`
CREATE TABLE IF NOT EXISTS role_bindings_new (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('projcore', 'coord', 'implementer', 'validator', 'deliberation', 'red-team', 'planner', 'routine-implementer', 'panelist')),
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, role, agent_id)
);
INSERT INTO role_bindings_new (id, project_id, role, agent_id, created_at, updated_at)
  SELECT id, project_id, role, agent_id, created_at, updated_at FROM role_bindings;
DROP TABLE role_bindings;
ALTER TABLE role_bindings_new RENAME TO role_bindings;
`);
          }
        }

        // POCFIX1 gap fix (live DBs only; fresh covered by schema.ts agentSeeds + applyFreshDbExtras):
        // v21 → v22 additive migration. INSERT OR IGNORE the 3 studio agents (grok-composer, spark, codex-5.4)
        // so they appear in agents table (read by role-binding dropdowns) on pre-existing/live dbs (e.g. data/helm.db).
        // Also ensure their models (if the v9 seed or structured update missed them on this live copy).
        // Two-track pattern: guarded, idempotent OR IGNORE, inside the BEGIN txn; mirrors fresh seed data exactly.
        // (v18 block re-applies fresh seeds only for dbs <18; this covers v18+ existing dbs.)
        if (current && current.version < 22) {
          if (hasTable('models')) {
            const modelSeeds = [
              {name:'grok-composer-2.5-fast', provider:'grok', model_id:'grok-composer-2.5-fast', effort:'low', approval:'auto', flags:null, approval_policy:'auto', sandbox_mode:null, permission_mode:null, bypass:0},
              {name:'spark', provider:'codex', model_id:'gpt-5.3-codex-spark', effort:'dynamic', approval:'bypass', flags:'--dangerously-bypass-approvals-and-sandbox', approval_policy:'bypass', sandbox_mode:null, permission_mode:null, bypass:1},
              {name:'codex-5.4', provider:'codex', model_id:'gpt-5.4', effort:'medium', approval:'on-request', flags:null, approval_policy:'on-request', sandbox_mode:'workspace-write', permission_mode:null, bypass:0},
            ];
            for (const s of modelSeeds) {
              this.db.prepare(`INSERT OR IGNORE INTO models (name, provider, model_id, effort, approval, flags, approval_policy, sandbox_mode, permission_mode, bypass) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(s.name, s.provider, s.model_id, s.effort, s.approval, s.flags, s.approval_policy, s.sandbox_mode, s.permission_mode, s.bypass);
            }
            for (const s of modelSeeds) {
              this.db.prepare(`UPDATE models SET approval_policy = ?, sandbox_mode = ?, permission_mode = ?, bypass = ?, flags = ?, updated_at = datetime('now') WHERE name = ?`).run(s.approval_policy, s.sandbox_mode, s.permission_mode, s.bypass, s.flags, s.name);
            }
          }
          if (hasTable('agents')) {
            const agentSeeds = [
              {
                name: 'grok-composer',
                provider: 'grok',
                model: 'grok-composer-2.5-fast',
                default_effort: 'low',
                spawn_pref: 'tmux',
                definition_md: `---
role: grok-composer
default_provider: grok
default_model: grok-composer-2.5-fast
default_effort: low
spawn_pref: tmux
---
# grok-composer — fast grok composer (cheap-fast band) for panelist/routine-implementer bindings
`
              },
              {
                name: 'spark',
                provider: 'codex',
                model: 'gpt-5.3-codex-spark',
                default_effort: 'medium',
                spawn_pref: 'tmux',
                definition_md: `---
role: spark
default_provider: codex
default_model: gpt-5.3-codex-spark
default_effort: medium
spawn_pref: tmux
---
# spark — fast codex spark (cheap-fast, bypass) for red-team/panelist bindings (see A2b)
`
              },
              {
                name: 'codex-5.4',
                provider: 'codex',
                model: 'gpt-5.4',
                default_effort: 'medium',
                spawn_pref: 'tmux',
                definition_md: `---
role: codex-5.4
default_provider: codex
default_model: gpt-5.4
default_effort: medium
spawn_pref: tmux
---
# codex-5.4 — mid-tier codex (sensible approval) for implementer/validator use in role bindings
`
              },
            ];
            for (const a of agentSeeds) {
              this.db.prepare(`INSERT OR IGNORE INTO agents (name, provider, model, default_effort, spawn_pref, definition_md) VALUES (?,?,?,?,?,NULL)`).run(a.name, a.provider, a.model, a.default_effort, a.spawn_pref);
              this.db.prepare(`UPDATE agents SET definition_md = ? , updated_at = datetime('now') WHERE name = ? AND (definition_md IS NULL OR TRIM(IFNULL(definition_md, '')) = '')`).run(a.definition_md, a.name);
            }
          }
        }

        // v32: D2 (R-02A) — purge model-named stub agents + their stale role_bindings.
        // Placed LAST in the runner ON PURPOSE: the v22 block above re-seeds these same stub agents
        // (INSERT OR IGNORE) for DBs migrating from <22, so the purge must run AFTER it to win — otherwise
        // a <22→32 migration would delete then immediately resurrect the stubs. Name-based (env-safe, NULL-safe).
        // role_defaults stay intact, so affected project bindings fall back to the real role agents.
        if (current && current.version < 32 && hasTable('agents')) {
          const stubNames = ['grok-4.5', 'grok-composer', 'spark', 'codex-5.4'];
          const stubIds = stubNames
            .map(n => (this.db.prepare('SELECT id FROM agents WHERE name = ?').get(n) as { id: number } | undefined)?.id)
            .filter((id): id is number => id !== undefined);
          if (stubIds.length > 0) {
            // Step 1: clear stale role_bindings first (agents FK is ON DELETE RESTRICT).
            if (hasTable('role_bindings')) {
              this.db.exec(`DELETE FROM role_bindings WHERE agent_id IN (${stubIds.join(',')})`);
            }
            // Step 2: delete the stub agents (agent_toolkits is ON DELETE CASCADE; no other FK refs).
            this.db.exec(`DELETE FROM agents WHERE id IN (${stubIds.join(',')})`);
          }
        }

        // v33: E1 (KEY-E1) — agent_proposals (propose→approve substrate for agent definition changes).
        // CREATE with a forward FK to agents is safe even on agents-less fixtures (SQLite enforces FK at DML time).
        if (current && current.version < 33) {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS agent_proposals (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
              chat_session_id TEXT,
              proposed_definition_md TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
              created_at TEXT NOT NULL DEFAULT (datetime('now')),
              resolved_at TEXT
            )
          `);
          this.db.prepare('UPDATE schema_version SET version = 33').run();
        }

        // v34: E2 (R-02F) — seed master_agent (receptionist/co-planner) for existing DBs.
        // Data migration only (no DDL). INSERT OR IGNORE + MIG1 guard mirror applyB3AgentRoleCapabilitySeeds.
        // The master_agent INSERT is guarded by hasTable('agents'), but the version bump is NOT — otherwise an
        // agents-less fixture (e.g. the v29→v30 models-only test) would be left at v33 (the post-COMMIT v33 block
        // sets version=33, undoing the COMMIT finalize) and never reach SCHEMA_VERSION.
        if (current && current.version < 34) {
          if (hasTable('agents')) {
            const masterMd = `---
role: master_agent
lifecycle: conversational
default_provider: claude
default_model: claude-sonnet-4-6
default_effort: medium
spawn_pref: tmux
agent_type: helm
---
# master_agent — receptionist & co-planner for JROM's Helm agent roster

You are master_agent. Agent Studio is your home — JROM works with you here directly to shape his agent
roster. This is NOT a disposable test chat; it is your real workplace.

## Your job
Help JROM design, refine, and maintain the prompts (definition_md) of EVERY agent in the Helm roster — the
HELM agents (master_agent [you], overseer, jkagebunshin) AND the PROJECT agents (discovery, plancore, ibrain, lead, fast_lead, coord,
mockup, dev, qa, reviewer, arch, deployer, curator, flm, and any others present). You can propose
changes to ANY agent, including yourself.

## How you work — propose → JROM approves → Helm writes
1. Discuss: talk through the desired change (behavior tweak, new agent, role clarification, workflow change,
   model/effort change). Ask focused questions when requirements are vague; narrow before drafting.
2. Discover the roster: to target an agent you need its id. Look it up with
   GET http://localhost:3110/api/ingest/agents — returns each agent's id, name, agent_type, provider, model, and
   current definition_md. (Loopback agent endpoint — no token needed.) Read the current prompt before proposing changes.
3. Draft: produce a COMPLETE replacement definition_md for the target agent (the full file, including the
   --- frontmatter --- block), not a diff.
4. Propose: submit it via
   POST http://localhost:3110/api/ingest/agent-propose  body {"agent_id": <id>, "proposed_definition_md": "<full md>"}.
   This is your ONLY sanctioned write path.
5. Confirm honestly: a proposal is PENDING until JROM approves it in Agent Studio → the agent's detail →
   Proposals. NEVER claim a change is live after proposing. You do not write/apply directly — JROM approves,
   then Helm applies it.

## Self-modification
You may propose changes to your OWN definition_md (find your agent_id via the roster lookup) using the same
propose → approve → write flow. Be conservative and precise with self-edits.

## Scope & guardrails
- Keep recommendations practical, scoped, and compatible with the existing Helm roster and its protocols.
- Memory: use Helm app/project memory from the UI context; do not rely on native CLI memory.
- Use only the Helm API endpoints above for roster discovery and proposals.`;
            this.db.prepare(`INSERT OR IGNORE INTO agents (name, provider, model, default_effort, spawn_pref, definition_md) VALUES (?, ?, ?, ?, ?, NULL)`).run('master_agent', 'claude', 'claude-sonnet-4-6', 'medium', 'tmux');
            this.db.prepare(`UPDATE agents SET definition_md = ?, updated_at = datetime('now') WHERE name = ? AND (definition_md IS NULL OR TRIM(IFNULL(definition_md, '')) = '')`).run(masterMd, 'master_agent');
          }
          this.db.prepare('UPDATE schema_version SET version = 34').run();
        }
        // v35: F1 (R-03B/C) — teams.protocol_note + team_members table rebuild (mixed membership, position-only UNIQUE)
        // SQLite cannot DROP CONSTRAINT so team_members is rebuilt. Positions preserved from existing rows.
        // Column/shape guards (matches v18-area PRAGMA pattern) so synthetic downgrade-then-reopen seeds — whose
        // tables were created with the latest DDL — migrate idempotently instead of hitting "duplicate column".
        if (current && current.version < 35) {
          if (hasTable('teams')) {
            const tCols = this.db.prepare("PRAGMA table_info(teams)").all().map((c: any) => c.name);
            if (!tCols.includes('protocol_note')) {
              this.db.prepare("ALTER TABLE teams ADD COLUMN protocol_note TEXT").run();
            }
          }
          const tmCols = hasTable('team_members')
            ? this.db.prepare("PRAGMA table_info(team_members)").all().map((c: any) => c.name)
            : [];
          if (hasTable('team_members') && !tmCols.includes('member_type')) {
          this.db.exec(`
CREATE TABLE team_members_new (
  id INTEGER PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  member_type TEXT NOT NULL DEFAULT 'model' CHECK(member_type IN ('agent','model')),
  agent_id INTEGER REFERENCES agents(id) ON DELETE CASCADE,
  model_id INTEGER NOT NULL REFERENCES models(id),
  lens TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  context_meta TEXT,
  UNIQUE(team_id, position)
);
INSERT INTO team_members_new (id, team_id, member_type, agent_id, model_id, lens, position, context_meta)
SELECT id, team_id, 'model', NULL, model_id, lens, position, context_meta FROM team_members;
DROP TABLE team_members;
ALTER TABLE team_members_new RENAME TO team_members;
CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members(team_id);
`);
          }
          this.db.prepare('UPDATE schema_version SET version = 35').run();
        }
        // v36: F4 (R-03D) — backfill master_agent.default_model_id so it is team-eligible.
        // The v34 master_agent seed omitted a default model binding; without it master_agent
        // cannot be added to a team (F3 vetted-membership guard). UPDATE-only (no row added);
        // idempotent (fills only when NULL). Guarded on agents+models presence.
        if (current && current.version < 36) {
          if (hasTable('agents') && hasTable('models')) {
            this.db.prepare(`UPDATE agents SET default_model_id = (SELECT id FROM models WHERE model_id = 'claude-sonnet-4-6' LIMIT 1) WHERE name = 'master_agent' AND default_model_id IS NULL`).run();
          }
          this.db.prepare('UPDATE schema_version SET version = 36').run();
        }
        // v37: I3 (R-05F) — seed project_maintainer (app-agnostic, ephemeral docs keeper).
        // Re-runs applyB3AgentRoleCapabilitySeeds (idempotent: INSERT OR IGNORE) which now includes
        // project_maintainer. Avoids duplicating the definition_md template here.
        if (current && current.version < 37) {
          this.db.prepare("UPDATE schema_version SET version = 37").run();
          if (hasTable('agents')) {
            applyB3AgentRoleCapabilitySeeds(this.db);
          }
        }
        // v38: B2 (R-03/R-04) — agents.agent_type + HELM stub seeds (jkagebunshin, overseer).
        // Additive ALTER (PRAGMA guard) + backfill house-kind for master_agent/jkage/overseer + applyB2HelmAgentSeeds.
        // Pre-B07a CHECK is helm|project; post-v63 CHECK is house|project — write the accepted value.
        if (current && current.version < 38) {
          if (hasTable('agents')) {
            const acols = this.db.prepare('PRAGMA table_info(agents)').all().map((c: any) => c.name);
            if (!acols.includes('agent_type')) {
              this.db.exec("ALTER TABLE agents ADD COLUMN agent_type TEXT NOT NULL DEFAULT 'project' CHECK(agent_type IN ('helm','project'))");
            }
            const houseVal = houseAgentTypeValue();
            this.db.prepare(`UPDATE agents SET agent_type = ? WHERE name IN ('master_agent', 'jkagebunshin', 'overseer')`).run(houseVal);
            applyB2HelmAgentSeeds(this.db);
          }
          this.db.prepare('UPDATE schema_version SET version = 38').run();
        }
        // v39: B6 (H11-enabler) — memories.agent_id + scope='agent'. Rebuild (SQLite cannot ALTER CHECK).
        if (current && current.version < 39) {
          if (hasTable('memories')) {
            const mcols = this.db.prepare('PRAGMA table_info(memories)').all().map((c: any) => c.name);
            if (!mcols.includes('agent_id')) {
              const memSel = (col: string, fallback: string) => (mcols.includes(col) ? col : fallback);
              this.db.exec(`
CREATE TABLE IF NOT EXISTS memories_new (
  id INTEGER PRIMARY KEY,
  scope TEXT NOT NULL CHECK(scope IN ('app','project','agent')),
  project_id INTEGER REFERENCES projects(id),
  agent_id INTEGER REFERENCES agents(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL CHECK(type IN ('user','feedback','project','reference')) DEFAULT 'reference',
  body TEXT,
  status TEXT NOT NULL CHECK(status IN ('proposed','approved')) DEFAULT 'approved',
  horizon TEXT NOT NULL CHECK(horizon IN ('long','short')) DEFAULT 'long',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO memories_new (id, scope, project_id, agent_id, title, description, type, body, status, horizon, created_at, updated_at)
  SELECT id, scope, project_id, NULL, title, ${memSel('description', 'NULL')}, ${memSel('type', "'reference'")}, ${memSel('body', 'NULL')}, ${memSel('status', "'approved'")}, ${memSel('horizon', "'long'")}, ${memSel('created_at', "datetime('now')")}, ${memSel('updated_at', "datetime('now')")} FROM memories;
DROP TABLE memories;
ALTER TABLE memories_new RENAME TO memories;
CREATE INDEX IF NOT EXISTS idx_memories_scope_proj_status ON memories(scope, project_id, status);
CREATE INDEX IF NOT EXISTS idx_memories_scope_agent_status ON memories(scope, agent_id, status);
CREATE INDEX IF NOT EXISTS idx_memories_horizon ON memories(horizon, scope, status);
`);
            }
            applyB6AgentMemorySeeds(this.db);
          }
          this.db.prepare('UPDATE schema_version SET version = 39').run();
        }
        // v40: AGENTROLE T4 — update master_agent definition_md to workspace-aware prompt on ALL existing DBs.
        // UNCONDITIONAL UPDATE: the live record holds the old v34 prompt (NOT NULL), so a MIG1 IS NULL guard
        // would skip it. This one-time update is intentional — no user-edited prompt exists to clobber (JROM confirmed).
        if (current && current.version < 40) {
          if (hasTable('agents')) {
            const newMasterMd = `---
role: master_agent
lifecycle: conversational
default_provider: claude
default_model: claude-sonnet-4-6
default_effort: medium
spawn_pref: tmux
agent_type: helm
---
# master_agent — receptionist & co-planner for JROM's Helm agent roster

You are master_agent. Agent Studio is your home — JROM works with you here directly to shape his agent
roster. This is NOT a disposable test chat; it is your real workplace.

## Your job
Help JROM design, refine, and maintain the prompts (definition_md) of EVERY agent in the Helm roster — the
HELM agents (master_agent [you], overseer, jkagebunshin) AND the PROJECT agents (discovery, plancore, ibrain, lead, fast_lead, coord,
mockup, dev, qa, reviewer, arch, deployer, curator, flm, and any others present). You can propose
changes to ANY agent, including yourself.

## How you work — propose → JROM approves → Helm writes
1. Discuss: talk through the desired change (behavior tweak, new agent, role clarification, workflow change,
   model/effort change). Ask focused questions when requirements are vague; narrow before drafting.
2. Discover the roster: to target an agent you need its id. Look it up with
   GET http://localhost:3110/api/ingest/agents — returns each agent's id, name, agent_type, provider, model, and
   current definition_md. (Loopback agent endpoint — no token needed.) Read the current prompt before proposing changes.
3. Draft: produce a COMPLETE replacement definition_md for the target agent (the full file, including the
   --- frontmatter --- block), not a diff.
4. Propose: submit it via
   POST http://localhost:3110/api/ingest/agent-propose  body {"agent_id": <id>, "proposed_definition_md": "<full md>"}.
   This is your ONLY sanctioned write path.
5. Confirm honestly: a proposal is PENDING until JROM approves it in Agent Studio → the agent's detail →
   Proposals. NEVER claim a change is live after proposing. You do not write/apply directly — JROM approves,
   then Helm applies it.

## Self-modification
You may propose changes to your OWN definition_md (find your agent_id via the roster lookup) using the same
propose → approve → write flow. Be conservative and precise with self-edits.

## Scope & guardrails
- Keep recommendations practical, scoped, and compatible with the existing Helm roster and its protocols.
- Memory: use Helm app/project memory from the UI context; do not rely on native CLI memory.
- Use only the Helm API endpoints above for roster discovery and proposals.`;
            this.db.prepare(`UPDATE agents SET definition_md = ?, agent_type = ?, updated_at = datetime('now') WHERE name = 'master_agent'`).run(newMasterMd, houseAgentTypeValue());
          }
          this.db.prepare('UPDATE schema_version SET version = 40').run();
        }
        if (current && current.version < 41) {
          if (hasTable('agents')) {
            const v41MasterMd = this.db.prepare(`SELECT definition_md FROM agents WHERE name = 'master_agent'`).get() as any;
            if (v41MasterMd?.definition_md) {
              const updated = v41MasterMd.definition_md.replace(
                'GET http://localhost:3110/api/agents — returns each agent\'s id, name, agent_type, provider, model, and\n   current definition_md. Read the current prompt before proposing changes.',
                'GET http://localhost:3110/api/ingest/agents — returns each agent\'s id, name, agent_type, provider, model, and\n   current definition_md. (Loopback agent endpoint — no token needed.) Read the current prompt before proposing changes.'
              );
              this.db.prepare(`UPDATE agents SET definition_md = ?, updated_at = datetime('now') WHERE name = 'master_agent'`).run(updated);
            }
          }
          this.db.prepare('UPDATE schema_version SET version = 41').run();
        }
        if (current && current.version < 42) {
          this.db.exec(`
CREATE TABLE IF NOT EXISTS tg_login_challenges (
  id TEXT PRIMARY KEY,
  display_number INTEGER NOT NULL CHECK(display_number BETWEEN 10 AND 99),
  buttons_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','pass','fail','expired')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tg_login_challenges_status_expires ON tg_login_challenges(status, expires_at);
`);
          this.db.prepare('UPDATE schema_version SET version = 42').run();
        }
        if (current && current.version < 43) {
          if (hasTable('projects')) {
            const pcols = this.db.prepare("PRAGMA table_info(projects)").all().map((c: any) => c.name);
            if (!pcols.includes('description')) {
              this.db.exec(`ALTER TABLE projects ADD COLUMN description TEXT;`);
            }
          }
          this.db.prepare('UPDATE schema_version SET version = 43').run();
        }
        if (current && current.version < 44) {
          if (hasTable('projects')) {
            const pcols = this.db.prepare("PRAGMA table_info(projects)").all().map((c: any) => c.name);
            if (!pcols.includes('dev_url')) {
              this.db.exec(`ALTER TABLE projects ADD COLUMN dev_url TEXT;`);
            }
            if (!pcols.includes('qa_url')) {
              this.db.exec(`ALTER TABLE projects ADD COLUMN qa_url TEXT;`);
            }
          }
          this.db.prepare('UPDATE schema_version SET version = 44').run();
        }
        if (current && current.version < 45) {
          if (hasTable('projects')) {
            const pcols = this.db.prepare("PRAGMA table_info(projects)").all().map((c: any) => c.name);
            if (!pcols.includes('tags')) {
              this.db.exec(`ALTER TABLE projects ADD COLUMN tags TEXT;`);
            }
          }
          this.db.prepare('UPDATE schema_version SET version = 45').run();
        }
        if (current && current.version < 46) {
          if (hasTable('project_agents')) {
            const pacols = this.db.prepare("PRAGMA table_info(project_agents)").all().map((c: any) => c.name);
            if (!pacols.includes('backup_model_id')) {
              this.db.exec(`ALTER TABLE project_agents ADD COLUMN backup_model_id INTEGER REFERENCES models(id);`);
            }
            if (!pacols.includes('effort_override')) {
              this.db.exec(`ALTER TABLE project_agents ADD COLUMN effort_override TEXT;`);
            }
            if (!pacols.includes('spawn_pref_override')) {
              this.db.exec(`ALTER TABLE project_agents ADD COLUMN spawn_pref_override TEXT;`);
            }
            if (!pacols.includes('disabled_override')) {
              this.db.exec(`ALTER TABLE project_agents ADD COLUMN disabled_override INTEGER CHECK(disabled_override IN (0,1));`);
            }
          }
          this.db.prepare('UPDATE schema_version SET version = 46').run();
        }
        if (current && current.version < 47) {
          if (hasTable('project_agents')) {
            const pacols = this.db.prepare("PRAGMA table_info(project_agents)").all().map((c: any) => c.name);
            if (!pacols.includes('toolkits_overridden')) {
              this.db.exec(`ALTER TABLE project_agents ADD COLUMN toolkits_overridden INTEGER NOT NULL DEFAULT 0 CHECK(toolkits_overridden IN (0,1));`);
            }
            if (!pacols.includes('escalations_overridden')) {
              this.db.exec(`ALTER TABLE project_agents ADD COLUMN escalations_overridden INTEGER NOT NULL DEFAULT 0 CHECK(escalations_overridden IN (0,1));`);
            }
          }
          this.db.exec(`
CREATE TABLE IF NOT EXISTS project_agent_toolkits (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  toolkit_id INTEGER NOT NULL REFERENCES toolkits(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(project_id, agent_id) REFERENCES project_agents(project_id, agent_id) ON DELETE CASCADE,
  UNIQUE(project_id, agent_id, toolkit_id)
);
CREATE INDEX IF NOT EXISTS idx_project_agent_toolkits_agent ON project_agent_toolkits(project_id, agent_id);

CREATE TABLE IF NOT EXISTS project_agent_escalations (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  model_id INTEGER NOT NULL REFERENCES models(id),
  trigger TEXT NOT NULL DEFAULT 'on-fail',
  FOREIGN KEY(project_id, agent_id) REFERENCES project_agents(project_id, agent_id) ON DELETE CASCADE,
  UNIQUE(project_id, agent_id, position)
);
CREATE INDEX IF NOT EXISTS idx_project_agent_escalations_agent ON project_agent_escalations(project_id, agent_id);
`);
          this.db.prepare('UPDATE schema_version SET version = 47').run();
        }
        if (current && current.version < 48) {
          if (hasTable('project_agents')) {
            const pacols = this.db.prepare("PRAGMA table_info(project_agents)").all().map((c: any) => c.name);
            if (!pacols.includes('definition_md_override')) {
              this.db.exec(`ALTER TABLE project_agents ADD COLUMN definition_md_override TEXT;`);
            }
          }
          this.db.prepare('UPDATE schema_version SET version = 48').run();
        }
        this.db.exec('COMMIT;');
      } catch (e) {
        try { this.db.exec('ROLLBACK;'); } catch {}
        throw e;
      }

      // v49: atomic project_agents rebuild — FK pragma must be set outside txn (SQLite constraint).
      if (current && current.version < 49) {
        applyV49ProjectAgentsRebuild();
      }

      // v50 (A3): routing_rules table + seed. Additive-only (CREATE TABLE IF NOT EXISTS + seed), matches the
      // v47 in-txn pattern in spirit, but placed here (after the v49 rebuild, which unconditionally sets
      // version=49 on any pre-49 DB) so it can never be clobbered by v49's own version bump.
      if (current && current.version < 50) {
        this.db.exec(`
CREATE TABLE IF NOT EXISTS routing_rules (
  id INTEGER PRIMARY KEY,
  emitter_role TEXT NOT NULL,
  when_status TEXT NOT NULL,
  handler_role TEXT NOT NULL,
  action TEXT NOT NULL,
  is_core INTEGER NOT NULL DEFAULT 0 CHECK(is_core IN (0,1)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_routing_rules_emitter_status ON routing_rules(emitter_role, when_status);
`);
        seedRoutingRules(this.db);
        this.db.prepare('UPDATE schema_version SET version = 50').run();
      }

      // v51 (kloo B1): widen agents.provider/models.provider CHECK to include 'kloo' + add models.route.
      // FK pragma must be set outside a txn (SQLite constraint), same reason as the v49 call site.
      if (current && current.version < 51) {
        applyV51KlooProviderRebuild();
      }

      // v52 (B1-T02): per-project autonomy default for new cycles (R-E1).
      if (current && current.version < 52) {
        if (hasTable('projects')) {
          const pcols = this.db.prepare("PRAGMA table_info(projects)").all().map((c: any) => c.name);
          if (!pcols.includes('autonomy_default')) {
            this.db.exec(`ALTER TABLE projects ADD COLUMN autonomy_default TEXT NOT NULL DEFAULT 'pause_after_planning' CHECK(autonomy_default IN ('autonomous_after_discovery', 'pause_after_planning'));`);
          }
        }
        this.db.prepare('UPDATE schema_version SET version = 52').run();
      }

      // v53 (B2-T01): cycles table for named cycle entity + folder lifecycle (R-B1, R-B2 create, R-B4, R-E2).
      if (current && current.version < 53) {
        if (hasTable('projects')) {
          this.db.exec(`
CREATE TABLE IF NOT EXISTS cycles (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  folder_name TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'discovery' CHECK(phase IN ('discovery', 'planning', 'implementation', 'final_tests', 'complete')),
  autonomy TEXT NOT NULL CHECK(autonomy IN ('autonomous_after_discovery', 'pause_after_planning')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'completed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, folder_name)
);
`);
        }
        this.db.prepare('UPDATE schema_version SET version = 53').run();
      }

      // v54 (B2-T02): widen cycles.status CHECK to include 'pending' for Overview Pending tab (R-A2).
      // Rebuild (SQLite cannot ALTER CHECK). B2-T01 create default remains 'active'.
      if (current && current.version < 54) {
        if (hasTable('cycles')) {
          this.db.exec(`
CREATE TABLE IF NOT EXISTS cycles_new (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  folder_name TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'discovery' CHECK(phase IN ('discovery', 'planning', 'implementation', 'final_tests', 'complete')),
  autonomy TEXT NOT NULL CHECK(autonomy IN ('autonomous_after_discovery', 'pause_after_planning')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('pending', 'active', 'completed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, folder_name)
);
INSERT INTO cycles_new SELECT id, project_id, name, folder_name, phase, autonomy, status, created_at FROM cycles;
DROP TABLE cycles;
ALTER TABLE cycles_new RENAME TO cycles;
`);
        }
        this.db.prepare('UPDATE schema_version SET version = 54').run();
      }

      // v55 (B6-T03): cycles.awaiting_approval gate sub-state after planning (R-E3).
      if (current && current.version < 55) {
        if (hasTable('cycles')) {
          const ccols = this.db.prepare("PRAGMA table_info(cycles)").all().map((c: any) => c.name);
          if (!ccols.includes('awaiting_approval')) {
            this.db.exec(`ALTER TABLE cycles ADD COLUMN awaiting_approval INTEGER NOT NULL DEFAULT 0;`);
          }
        }
        this.db.prepare('UPDATE schema_version SET version = 55').run();
      }

      // v56 (B10-T01): add cycle_id to runs for cycle→run bridge (execution_plan.md as canonical task queue for helm-algo).
      // Two-track: fresh covered in SCHEMA_SQL; this is for live/pre-existing DBs. Guarded + idempotent.
      if (current && current.version < 56) {
        if (hasTable('runs')) {
          const rcols = this.db.prepare("PRAGMA table_info(runs)").all().map((c: any) => c.name);
          if (!rcols.includes('cycle_id')) {
            this.db.exec(`ALTER TABLE runs ADD COLUMN cycle_id INTEGER REFERENCES cycles(id);`);
            this.db.exec(`CREATE INDEX IF NOT EXISTS idx_runs_cycle ON runs(cycle_id);`);
          }
        }
        this.db.prepare('UPDATE schema_version SET version = 56').run();
      }

      // v57 (B11-T01): final_tests_default on projects + final_tests_enabled on cycles (R-G1 default-on + Discovery override).
      if (current && current.version < 57) {
        if (hasTable('projects')) {
          const pcols = this.db.prepare("PRAGMA table_info(projects)").all().map((c: any) => c.name);
          if (!pcols.includes('final_tests_default')) {
            this.db.exec(`ALTER TABLE projects ADD COLUMN final_tests_default INTEGER NOT NULL DEFAULT 1 CHECK(final_tests_default IN (0, 1));`);
          }
        }
        if (hasTable('cycles')) {
          const ccols = this.db.prepare("PRAGMA table_info(cycles)").all().map((c: any) => c.name);
          if (!ccols.includes('final_tests_enabled')) {
            this.db.exec(`ALTER TABLE cycles ADD COLUMN final_tests_enabled INTEGER NOT NULL DEFAULT 1 CHECK(final_tests_enabled IN (0, 1));`);
          }
        }
        this.db.prepare('UPDATE schema_version SET version = 57').run();
      }

      // v58 (SL-R1 session-lifecycle): helm_sessions registry of every tmux session Helm creates.
      // Two-track: fresh DBs get it via SCHEMA_SQL; this covers live/pre-existing DBs. New table so no
      // PRAGMA guard needed — CREATE IF NOT EXISTS is idempotent.
      if (current && current.version < 58) {
        this.db.exec(`
CREATE TABLE IF NOT EXISTS helm_sessions (
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
CREATE INDEX IF NOT EXISTS idx_helm_sessions_status ON helm_sessions(status);
CREATE INDEX IF NOT EXISTS idx_helm_sessions_run ON helm_sessions(run_id);
`);
        this.db.prepare('UPDATE schema_version SET version = 58').run();
      }

      // v59: L1 defaults for implementer/validator. L2/L3 already live in agent_escalations
      // positions 1/2; the base L1 is agents.default_model_id and was missing on upgraded DBs.
      // Guard: synthetic/minimal fixtures may lack default_model_id until an earlier ADD COLUMN;
      // never assume the column exists (B25 crash-safety for partial upgrade paths).
      if (current && current.version < 59) {
        if (hasTable('agents') && hasTable('models')) {
          const aCols = this.db.prepare('PRAGMA table_info(agents)').all().map((c: any) => c.name);
          if (!aCols.includes('default_model_id')) {
            this.db.exec(`ALTER TABLE agents ADD COLUMN default_model_id INTEGER REFERENCES models(id);`);
          }
          this.db.prepare(`UPDATE agents SET default_model_id = (SELECT id FROM models WHERE model_id = 'grok-4.5' LIMIT 1) WHERE name = 'implementer' AND default_model_id IS NULL`).run();
          this.db.prepare(`UPDATE agents SET default_model_id = (SELECT id FROM models WHERE model_id IN ('claude-sonnet-4-6', 'claude-sonnet-5') OR name = 'claude-sonnet' ORDER BY CASE WHEN model_id = 'claude-sonnet-4-6' THEN 0 WHEN name = 'claude-sonnet' THEN 1 ELSE 2 END LIMIT 1) WHERE name = 'validator' AND default_model_id IS NULL`).run();
        }
        this.db.prepare('UPDATE schema_version SET version = 59').run();
      }

      // v60: repair validator L1 fallback for DBs whose model registry uses claude-sonnet/claude-sonnet-5
      // instead of the legacy agent frontmatter string claude-sonnet-4-6.
      if (current && current.version < 60) {
        if (hasTable('agents') && hasTable('models')) {
          const aCols = this.db.prepare('PRAGMA table_info(agents)').all().map((c: any) => c.name);
          if (aCols.includes('default_model_id')) {
            this.db.prepare(`UPDATE agents SET default_model_id = (SELECT id FROM models WHERE model_id IN ('claude-sonnet-4-6', 'claude-sonnet-5') OR name = 'claude-sonnet' ORDER BY CASE WHEN model_id = 'claude-sonnet-4-6' THEN 0 WHEN name = 'claude-sonnet' THEN 1 ELSE 2 END LIMIT 1) WHERE name = 'validator' AND default_model_id IS NULL`).run();
          }
        }
        this.db.prepare('UPDATE schema_version SET version = 60').run();
      }

      // v61 (B03a / c01 R1.2–R1.3): models.cli + models.slug + models.display_name.
      // Two-track: fresh SCHEMA_SQL has NOT NULL + UNIQUE(slug); this block upgrades live DBs.
      // Backfill: cli←provider (historical provider-as-cli); display_name←name; slug←slugify(name).
      // Unique collisions: append -<id> honestly (never drop/merge rows). Does NOT seed the 10 registry models (B04).
      if (current && current.version < 61) {
        if (hasTable('models')) {
          const mcols = this.db.prepare('PRAGMA table_info(models)').all().map((c: any) => c.name) as string[];
          if (!mcols.includes('cli')) {
            this.db.exec(`ALTER TABLE models ADD COLUMN cli TEXT;`);
          }
          if (!mcols.includes('slug')) {
            this.db.exec(`ALTER TABLE models ADD COLUMN slug TEXT;`);
          }
          if (!mcols.includes('display_name')) {
            this.db.exec(`ALTER TABLE models ADD COLUMN display_name TEXT;`);
          }
          // Synthetic/partial fixtures may lack provider; backfill cli from name when absent.
          const hasProvider = mcols.includes('provider');
          const hasUpdatedAt = mcols.includes('updated_at');
          const selectCols = ['id', 'name', 'cli', 'slug', 'display_name']
            .concat(hasProvider ? ['provider'] : [])
            .join(', ');
          const rows = this.db.prepare(`SELECT ${selectCols} FROM models ORDER BY id`).all() as any[];
          const used = new Set<string>();
          for (const r of rows) {
            if (r.slug && String(r.slug).trim()) used.add(String(r.slug).trim());
          }
          const slugify = (name: string): string => {
            const s = String(name || '')
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '-')
              .replace(/^-+|-+$/g, '');
            return s || 'model';
          };
          for (const r of rows) {
            const cli = r.cli && String(r.cli).trim()
              ? String(r.cli).trim()
              : String(r.provider || '').trim();
            const display_name = r.display_name && String(r.display_name).trim()
              ? String(r.display_name).trim()
              : String(r.name || '');
            let slug = r.slug && String(r.slug).trim()
              ? String(r.slug).trim()
              : slugify(String(r.name || ''));
            if (!r.slug || !String(r.slug).trim()) {
              if (used.has(slug)) {
                // Honest collision handling: keep both rows; disambiguate with id suffix.
                slug = `${slug}-${r.id}`;
              }
              used.add(slug);
            }
            if (hasUpdatedAt) {
              this.db.prepare(
                `UPDATE models SET cli = ?, slug = ?, display_name = ?, updated_at = datetime('now') WHERE id = ?`
              ).run(cli || null, slug, display_name || String(r.name || ''), r.id);
            } else {
              this.db.prepare(
                `UPDATE models SET cli = ?, slug = ?, display_name = ? WHERE id = ?`
              ).run(cli || null, slug, display_name || String(r.name || ''), r.id);
            }
          }

          // UNIQUE on slug after all rows filled (nulls would weaken uniqueness in SQLite).
          this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_models_slug ON models(slug);`);
        }
        this.db.prepare('UPDATE schema_version SET version = 61').run();
      }

      // v62 (B04 / c01 R1.4): seed the original Helm-canonical models (cli→provider→model_id + slug + display_name).
      // Two-track: fresh path calls applyB04CanonicalModelSeeds from applyFreshDbExtras; this block covers live DBs.
      // codex54min → model_id gpt-5.4-mini (B01 verified).
      if (current && current.version < 62) {
        if (hasTable('models')) {
          applyB04CanonicalModelSeeds(this.db);
        }
        this.db.prepare('UPDATE schema_version SET version = 62').run();
      }

      // v63 (B07a / c01 R2.7): agent kind enum project|house; legacy agent_type 'helm' → 'house'.
      // Column name stays agent_type (API exposes kind). CHECK must be rebuilt (SQLite cannot ALTER CHECK).
      // Two-track: fresh SCHEMA_SQL already has house|project; this block upgrades live DBs.
      // No B07b dispatch fence / B07c registry-edit fence here.
      if (current && current.version < 63) {
        if (hasTable('agents')) {
          const acols = this.db.prepare('PRAGMA table_info(agents)').all().map((c: any) => c.name);
          if (acols.includes('agent_type')) {
            const beforeAgents = (this.db.prepare('SELECT COUNT(*) as c FROM agents').get() as any).c as number;
            this.db.pragma('foreign_keys = OFF');
            this.db.exec(`
CREATE TABLE agents_new (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('claude', 'codex', 'grok', 'kloo')),
  model TEXT NOT NULL,
  default_effort TEXT NOT NULL DEFAULT 'medium',
  definition_md TEXT,
  default_model_id INTEGER REFERENCES models(id),
  backup_model_id INTEGER REFERENCES models(id),
  spawn_pref TEXT NOT NULL DEFAULT 'tmux',
  in_development INTEGER NOT NULL DEFAULT 0 CHECK(in_development IN (0,1)),
  agent_type TEXT NOT NULL DEFAULT 'project' CHECK(agent_type IN ('house','project')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO agents_new (
  id, name, provider, model, default_effort, definition_md, default_model_id, backup_model_id,
  spawn_pref, in_development, agent_type, created_at, updated_at
)
SELECT
  id,
  name,
  IFNULL(provider, 'claude'),
  IFNULL(model, 'unknown'),
  IFNULL(default_effort, 'medium'),
  definition_md,
  default_model_id,
  backup_model_id,
  IFNULL(spawn_pref, 'tmux'),
  IFNULL(in_development, 0),
  CASE
    WHEN lower(IFNULL(agent_type,'')) IN ('helm','house') THEN 'house'
    ELSE 'project'
  END,
  COALESCE(created_at, datetime('now')),
  COALESCE(updated_at, datetime('now'))
FROM agents;
DROP TABLE agents;
ALTER TABLE agents_new RENAME TO agents;
`);
            const afterAgents = (this.db.prepare('SELECT COUNT(*) as c FROM agents').get() as any).c as number;
            if (afterAgents !== beforeAgents) {
              throw new Error(`agents migration row-count mismatch (v63 kind helm→house): before=${beforeAgents} after=${afterAgents}`);
            }
            this.db.pragma('foreign_keys = ON');
            // Only fail on agents-related FK issues introduced by the rebuild.
            // Live DBs may carry pre-existing orphans in unrelated tables (e.g. dispatches).
            const fkProblems = (this.db.prepare('PRAGMA foreign_key_check').all() as any[]).filter(
              (p: any) => p.table === 'agents' || p.parent === 'agents'
            );
            if (fkProblems.length > 0) {
              throw new Error(`foreign_key_check failed during v63 kind rebuild: ${JSON.stringify(fkProblems.slice(0, 5))}`);
            }
          }
        }
        this.db.prepare('UPDATE schema_version SET version = 63').run();
      }

      // v64 (B09a / c01 R2.8–R2.9): seed canonical project + house roster (north, agent-master, jkage, …).
      // Two-track: fresh path calls applyB09aCanonicalRosterSeeds after B2; this block covers live DBs.
      // Additive only — no prune / FK cleanup (B09b).
      if (current && current.version < 64) {
        if (hasTable('agents')) {
          applyB09aCanonicalRosterSeeds(this.db);
        }
        this.db.prepare('UPDATE schema_version SET version = 64').run();
      }

      // v65 (B09b / c01 R2.11): prune agents outside B09a canonical set; explicit FK cleanup (no orphans).
      // Two-track: fresh path calls applyB09b after B09a; this block covers live DBs.
      // Idempotent. Remaps master_agent→agent-master, jkagebunshin→jkage on FK children.
      if (current && current.version < 65) {
        if (hasTable('agents')) {
          // Ensure remap targets exist before prune (live DBs may be mid-cycle).
          applyB09aCanonicalRosterSeeds(this.db);
          applyB09bPruneNonCanonicalAgents(this.db);
        }
        this.db.prepare('UPDATE schema_version SET version = 65').run();
      }

      // v66 (B12a / c01 R3.12): role_tiers studio table — implementer|validator × L1|L2|L3 × primary+backup.
      // Two-track: fresh SCHEMA_SQL already has the table; this block upgrades live DBs.
      // Seeds land in v67 (B12b). No B13 invariants. No B08 agent_escalations reopen.
      if (current && current.version < 66) {
        this.db.exec(`
CREATE TABLE IF NOT EXISTS role_tiers (
  id INTEGER PRIMARY KEY,
  role TEXT NOT NULL CHECK(role IN ('implementer', 'validator')),
  tier TEXT NOT NULL CHECK(tier IN ('L1', 'L2', 'L3')),
  primary_model_id INTEGER REFERENCES models(id),
  backup_model_id INTEGER REFERENCES models(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(role, tier)
);
CREATE INDEX IF NOT EXISTS idx_role_tiers_role ON role_tiers(role);
`);
        this.db.prepare('UPDATE schema_version SET version = 66').run();
      }

      // v67 (B12b / c01 R3.12): seed role_tiers from topology intent using B04 model slugs.
      // Two-track: fresh path calls applyB12bRoleTierSeeds from applyFreshDbExtras; this covers live DBs.
      // Idempotent upsert. No B13 save-time invariants. No UI.
      if (current && current.version < 67) {
        // Ensure table exists if a synthetic fixture jumped past incomplete v66.
        this.db.exec(`
CREATE TABLE IF NOT EXISTS role_tiers (
  id INTEGER PRIMARY KEY,
  role TEXT NOT NULL CHECK(role IN ('implementer', 'validator')),
  tier TEXT NOT NULL CHECK(tier IN ('L1', 'L2', 'L3')),
  primary_model_id INTEGER REFERENCES models(id),
  backup_model_id INTEGER REFERENCES models(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(role, tier)
);
CREATE INDEX IF NOT EXISTS idx_role_tiers_role ON role_tiers(role);
`);
        // B04 models should already exist (hard dep); re-apply is safe/idempotent if present.
        applyB04CanonicalModelSeeds(this.db);
        applyB12bRoleTierSeeds(this.db);
        this.db.prepare('UPDATE schema_version SET version = 67').run();
      }

      // v68 (B16 / c01 R4.18–R4.19): team_tiers + team_tier_models — deliberation|red-team × budget|standard|elite.
      // Two-track: fresh SCHEMA_SQL already has the tables; this block upgrades live DBs.
      // Empty until B17 seeds (v69). Flat teams/team_members (B1) untouched.
      if (current && current.version < 68) {
        this.db.exec(`
CREATE TABLE IF NOT EXISTS team_tiers (
  id INTEGER PRIMARY KEY,
  team_type TEXT NOT NULL CHECK(team_type IN ('deliberation', 'red-team')),
  tier TEXT NOT NULL CHECK(tier IN ('budget', 'standard', 'elite')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(team_type, tier)
);
CREATE INDEX IF NOT EXISTS idx_team_tiers_type ON team_tiers(team_type);

CREATE TABLE IF NOT EXISTS team_tier_models (
  id INTEGER PRIMARY KEY,
  team_type TEXT NOT NULL CHECK(team_type IN ('deliberation', 'red-team')),
  tier TEXT NOT NULL CHECK(tier IN ('budget', 'standard', 'elite')),
  model_id INTEGER NOT NULL REFERENCES models(id),
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(team_type, tier, position),
  UNIQUE(team_type, tier, model_id)
);
CREATE INDEX IF NOT EXISTS idx_team_tier_models_tt ON team_tier_models(team_type, tier);
`);
        this.db.prepare('UPDATE schema_version SET version = 68').run();
      }

      // v69 (B17 / c01 R4): seed team_tiers from topology intent (budget|standard|elite).
      // Two-track: fresh path calls applyB17TeamTierSeeds from applyFreshDbExtras; this covers live DBs.
      if (current && current.version < 69) {
        this.db.exec(`
CREATE TABLE IF NOT EXISTS team_tiers (
  id INTEGER PRIMARY KEY,
  team_type TEXT NOT NULL CHECK(team_type IN ('deliberation', 'red-team')),
  tier TEXT NOT NULL CHECK(tier IN ('budget', 'standard', 'elite')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(team_type, tier)
);
CREATE INDEX IF NOT EXISTS idx_team_tiers_type ON team_tiers(team_type);

CREATE TABLE IF NOT EXISTS team_tier_models (
  id INTEGER PRIMARY KEY,
  team_type TEXT NOT NULL CHECK(team_type IN ('deliberation', 'red-team')),
  tier TEXT NOT NULL CHECK(tier IN ('budget', 'standard', 'elite')),
  model_id INTEGER NOT NULL REFERENCES models(id),
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(team_type, tier, position),
  UNIQUE(team_type, tier, model_id)
);
CREATE INDEX IF NOT EXISTS idx_team_tier_models_tt ON team_tier_models(team_type, tier);
`);
        applyB04CanonicalModelSeeds(this.db);
        applyB17TeamTierSeeds(this.db);
        this.db.prepare('UPDATE schema_version SET version = 69').run();
      }

      // v70 (B18 / c01 R5.20–R5.21): sparse project overrides for role_tiers + team_tiers (inheritance).
      // Row presence = project override; absence = inherit Studio. No cycle tier store (freeze = B19).
      if (current && current.version < 70) {
        this.db.exec(`
CREATE TABLE IF NOT EXISTS project_role_tiers (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('implementer', 'validator')),
  tier TEXT NOT NULL CHECK(tier IN ('L1', 'L2', 'L3')),
  primary_model_id INTEGER REFERENCES models(id),
  backup_model_id INTEGER REFERENCES models(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, role, tier)
);
CREATE INDEX IF NOT EXISTS idx_project_role_tiers_project ON project_role_tiers(project_id);

CREATE TABLE IF NOT EXISTS project_team_tiers (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  team_type TEXT NOT NULL CHECK(team_type IN ('deliberation', 'red-team')),
  tier TEXT NOT NULL CHECK(tier IN ('budget', 'standard', 'elite')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, team_type, tier)
);
CREATE INDEX IF NOT EXISTS idx_project_team_tiers_project ON project_team_tiers(project_id);

CREATE TABLE IF NOT EXISTS project_team_tier_models (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  team_type TEXT NOT NULL CHECK(team_type IN ('deliberation', 'red-team')),
  tier TEXT NOT NULL CHECK(tier IN ('budget', 'standard', 'elite')),
  model_id INTEGER NOT NULL REFERENCES models(id),
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, team_type, tier, position),
  UNIQUE(project_id, team_type, tier, model_id)
);
CREATE INDEX IF NOT EXISTS idx_project_team_tier_models_ptt ON project_team_tier_models(project_id, team_type, tier);
`);
        this.db.prepare('UPDATE schema_version SET version = 70').run();
      }

      // v71 (B19 / c01 R5.22): frozen cycle-start topology snapshot. UNIQUE(cycle_id) = writer
      // exclusivity; triggers = immutability (no UPDATE/DELETE). See schema.ts for full comment.
      if (current && current.version < 71) {
        this.db.exec(`
CREATE TABLE IF NOT EXISTS cycle_topology_freezes (
  id INTEGER PRIMARY KEY,
  cycle_id INTEGER NOT NULL UNIQUE REFERENCES cycles(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  snapshot_json TEXT NOT NULL,
  frozen_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cycle_topology_freezes_project ON cycle_topology_freezes(project_id);

CREATE TRIGGER IF NOT EXISTS trg_cycle_topology_freezes_no_update
BEFORE UPDATE ON cycle_topology_freezes
BEGIN
  SELECT RAISE(ABORT, 'topology freeze is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_cycle_topology_freezes_no_delete
BEFORE DELETE ON cycle_topology_freezes
BEGIN
  SELECT RAISE(ABORT, 'topology freeze is immutable');
END;
`);
        this.db.prepare('UPDATE schema_version SET version = 71').run();
      }

      // v72 (B19-fix1): add the _cascade_delete_allow flag table and narrow the freeze-row DELETE
      // trigger to allow an admin cascade cleanup (DatabaseService.withCascadeDeleteAllowed, used by
      // deleteProject) through, while still blocking any direct delete attempted outside that
      // wrapper. See schema.ts for the fresh-DB definition.
      if (current && current.version < 72) {
        this.db.exec(`
CREATE TABLE IF NOT EXISTS _cascade_delete_allow (v INTEGER);
DROP TRIGGER IF EXISTS trg_cycle_topology_freezes_no_delete;
CREATE TRIGGER trg_cycle_topology_freezes_no_delete
BEFORE DELETE ON cycle_topology_freezes
WHEN NOT EXISTS (SELECT 1 FROM _cascade_delete_allow)
BEGIN
  SELECT RAISE(ABORT, 'topology freeze is immutable');
END;
`);
        this.db.prepare('UPDATE schema_version SET version = 72').run();
      }

      // v73 (B20 / c01 R5.23): intended vs actual team deltas with structural reason NOT NULL.
      if (current && current.version < 73) {
        this.db.exec(`
CREATE TABLE IF NOT EXISTS cycle_team_deltas (
  id INTEGER PRIMARY KEY,
  cycle_id INTEGER NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
  resolve_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('implementer','validator')),
  intended_tier TEXT NOT NULL,
  actual_tier TEXT NOT NULL,
  intended_slug TEXT,
  actual_slug TEXT,
  reason TEXT NOT NULL CHECK(reason IN ('AVAILABILITY','DIFFICULTY','COUPLING')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(cycle_id, resolve_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_cycle_team_deltas_cycle ON cycle_team_deltas(cycle_id);
`);
        this.db.prepare('UPDATE schema_version SET version = 73').run();
      }

      // v74 (B20-fix1): widen cycle_team_deltas.reason CHECK with SEAT_CHANGED
      // (post-freeze seat re-point: cause=AS_INTENDED but actual≠intended). SQLite cannot ALTER CHECK.
      if (current && current.version < 74) {
        if (hasTable('cycle_team_deltas')) {
          this.db.pragma('foreign_keys = OFF');
          this.db.exec(`
CREATE TABLE cycle_team_deltas_new (
  id INTEGER PRIMARY KEY,
  cycle_id INTEGER NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
  resolve_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('implementer','validator')),
  intended_tier TEXT NOT NULL,
  actual_tier TEXT NOT NULL,
  intended_slug TEXT,
  actual_slug TEXT,
  reason TEXT NOT NULL CHECK(reason IN ('AVAILABILITY','DIFFICULTY','COUPLING','SEAT_CHANGED')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(cycle_id, resolve_id, seq)
);
INSERT INTO cycle_team_deltas_new (
  id, cycle_id, resolve_id, seq, role, intended_tier, actual_tier,
  intended_slug, actual_slug, reason, created_at
)
SELECT
  id, cycle_id, resolve_id, seq, role, intended_tier, actual_tier,
  intended_slug, actual_slug, reason, created_at
FROM cycle_team_deltas;
DROP TABLE cycle_team_deltas;
ALTER TABLE cycle_team_deltas_new RENAME TO cycle_team_deltas;
CREATE INDEX IF NOT EXISTS idx_cycle_team_deltas_cycle ON cycle_team_deltas(cycle_id);
`);
          this.db.pragma('foreign_keys = ON');
        } else {
          this.db.exec(`
CREATE TABLE IF NOT EXISTS cycle_team_deltas (
  id INTEGER PRIMARY KEY,
  cycle_id INTEGER NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
  resolve_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('implementer','validator')),
  intended_tier TEXT NOT NULL,
  actual_tier TEXT NOT NULL,
  intended_slug TEXT,
  actual_slug TEXT,
  reason TEXT NOT NULL CHECK(reason IN ('AVAILABILITY','DIFFICULTY','COUPLING','SEAT_CHANGED')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(cycle_id, resolve_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_cycle_team_deltas_cycle ON cycle_team_deltas(cycle_id);
`);
        }
        this.db.prepare('UPDATE schema_version SET version = 74').run();
      }

      // v75 (B25 fix1 / c01 R1.5 + R6.25 + R2.11): remap agents.model off orphan launch slugs
      // and prune unreferenced models rows outside the PROVIDERS/B04 launch allow-list.
      if (current && current.version < 75) {
        applyB25OrphanModelHygiene(this.db);
        this.db.prepare('UPDATE schema_version SET version = 75').run();
      }

      // v76 (B25 fix2 / R6.25 master path): extend orphan hygiene to TEXT-slug launch-path tables
      // (project_master_models.model, master_runtimes.model), harden remap allow-list (N3),
      // rebind cross-provider default_model_id (N5 data), TEXT-slug prune ref-guard (N2).
      // Idempotent re-run of applyB25OrphanModelHygiene (safe on DBs already cleaned by v75).
      if (current && current.version < 76) {
        applyB25OrphanModelHygiene(this.db);
        this.db.prepare('UPDATE schema_version SET version = 76').run();
      }

      // v77 (B25d / R6.25): delete master_runtimes rows whose provider is not in PROVIDERS
      // (JROM: delete projcore/run-projcore orphan; never register provider). Idempotent.
      if (current && current.version < 77) {
        applyB25dDeleteUnknownProviderMasterRuntimes(this.db);
        this.db.prepare('UPDATE schema_version SET version = 77').run();
      }

      // v78 (Q-13 / R1.4): register the CLI-smoked gpt-5.6 Codex family.
      // Fresh DBs receive these through applyFreshDbExtras; this idempotent re-apply covers live DBs.
      if (current && current.version < 78) {
        if (hasTable('models')) {
          applyB04CanonicalModelSeeds(this.db);
        }
        this.db.prepare('UPDATE schema_version SET version = 78').run();
      }

      // v79 (B01.s1 / R3): append-only run event substrate.
      if (current && current.version < 79) {
        this.db.exec(`
CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL,
  batch_id TEXT,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_run_events_run_created ON run_events(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_run_events_run_batch ON run_events(run_id, batch_id);
CREATE TRIGGER IF NOT EXISTS run_events_no_replace
BEFORE INSERT ON run_events
WHEN NEW.id IS NOT NULL AND EXISTS (SELECT 1 FROM run_events WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'run events are append-only');
END;
CREATE TRIGGER IF NOT EXISTS run_events_no_update
BEFORE UPDATE ON run_events
BEGIN
  SELECT RAISE(ABORT, 'run events are append-only');
END;
CREATE TRIGGER IF NOT EXISTS run_events_no_delete
BEFORE DELETE ON run_events
BEGIN
  SELECT RAISE(ABORT, 'run events are append-only');
END;
`);
        this.db.prepare('UPDATE schema_version SET version = 79').run();
      }

      // v80 (B01.s1 fix3): heal already-v79 databases that predate append-only triggers.
      if (current && current.version < 80) {
        this.db.exec(`
CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL,
  batch_id TEXT,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_run_events_run_created ON run_events(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_run_events_run_batch ON run_events(run_id, batch_id);
CREATE TRIGGER IF NOT EXISTS run_events_no_replace
BEFORE INSERT ON run_events
WHEN NEW.id IS NOT NULL AND EXISTS (SELECT 1 FROM run_events WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'run events are append-only');
END;
CREATE TRIGGER IF NOT EXISTS run_events_no_update
BEFORE UPDATE ON run_events
BEGIN
  SELECT RAISE(ABORT, 'run events are append-only');
END;
CREATE TRIGGER IF NOT EXISTS run_events_no_delete
BEFORE DELETE ON run_events
BEGIN
  SELECT RAISE(ABORT, 'run events are append-only');
END;
`);
        this.db.prepare('UPDATE schema_version SET version = 80').run();
      }

      // v81 (B01.s3): durable convergence stall lineage substrate.
      if (current && current.version < 81) {
        this.db.exec(`
CREATE TABLE IF NOT EXISTS stall_lineages (
  stall_lineage_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  scope_generation INTEGER NOT NULL DEFAULT 0 CHECK(scope_generation >= 0),
  initial_signature TEXT NOT NULL,
  canonical_signature TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  class_history_json TEXT NOT NULL DEFAULT '[]',
  blocker_owner TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_stall_lineages_run ON stall_lineages(run_id);
CREATE INDEX IF NOT EXISTS idx_stall_lineages_batch ON stall_lineages(batch_id);
`);
        this.db.prepare('UPDATE schema_version SET version = 81').run();
      }

      // v82 (B01.s4 / R6.25): validator FAILs retain their required defect class.
      if (current && current.version < 82) {
        if (hasTable('validations')) {
          const cols = (this.db.prepare('PRAGMA table_info(validations)').all() as any[]).map((column) => column.name);
          if (!cols.includes('defect_class')) this.db.exec('ALTER TABLE validations ADD COLUMN defect_class TEXT');
        }
        this.db.prepare('UPDATE schema_version SET version = 82').run();
      }

      // v83 (O1.1): project identity is a generated, read-only basename projection.
      // Keep DDL, validation, index creation, and the version bump atomic so invalid
      // legacy directories leave the database entirely at its prior version.
      if (current && current.version < 83) {
        const migrateV83 = this.db.transaction(() => {
          if (hasTable('projects')) {
            // table_info intentionally omits generated columns; table_xinfo is required
            // for idempotent detection of directory_name on a reopened v83 database.
            const projectColumns = () => this.db.prepare('PRAGMA table_xinfo(projects)').all() as any[];
            let columns = projectColumns();
            if (!columns.some((column) => column.name === 'directory')) {
              throw new Error('v83 project identity migration requires projects.directory');
            }
            const directoryName = columns.find((column) => column.name === 'directory_name');
            if (directoryName && directoryName.hidden !== 2) {
              throw new Error('v83 project identity migration rejected writable directory_name');
            }
            if (!directoryName) {
              this.db.exec(`ALTER TABLE projects ADD COLUMN directory_name TEXT GENERATED ALWAYS AS (
  substr(
    rtrim(directory, '/'),
    length(
      rtrim(
        rtrim(directory, '/'),
        replace(rtrim(directory, '/'), '/', '')
      )
    ) + 1
  )
) VIRTUAL
  CHECK(length(directory_name) > 0)
  CHECK(directory_name NOT GLOB '*[^A-Za-z0-9_-]*')`);
              columns = projectColumns();
            }
            if (!columns.some((column) => column.name === 'status')) {
              this.db.exec("ALTER TABLE projects ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived'))");
              columns = projectColumns();
            }
            if (!columns.some((column) => column.name === 'active')) {
              this.db.exec('ALTER TABLE projects ADD COLUMN active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1))');
            }

            const invalid = this.db.prepare(`
            SELECT id, directory FROM projects
            WHERE directory_name IS NULL
              OR length(directory_name) = 0
              OR directory_name GLOB '*[^A-Za-z0-9_-]*'
            LIMIT 1
          `).get() as { id: number; directory: string } | undefined;
            if (invalid) {
              throw new Error(`v83 project identity migration rejected unsafe directory for project ${invalid.id}`);
            }
            this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_directory_name ON projects(directory_name)');
          }
          this.db.prepare('UPDATE schema_version SET version = 83').run();
        });
        migrateV83();
      }

      // v84 (O2.1): native Helm users. The table and its partial unique index
      // are created together with the version bump, so an upgrade either gains
      // the complete contract or remains at its prior version.
      if (current && current.version < 84) {
        const migrateV84 = this.db.transaction(() => {
          this.db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  telegram_id INTEGER UNIQUE NOT NULL,
  username TEXT,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'viewer' CHECK(role IN ('owner', 'viewer')),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_one_active_owner
  ON users(role) WHERE role = 'owner' AND active = 1;
`);
          this.db.prepare('UPDATE schema_version SET version = 84').run();
        });
        migrateV84();
      }

      // v85 (O5.1): sealed external run identity and append-only ingest receipts.
      // The complete additive contract and version bump share one transaction so a
      // failed upgrade cannot leave a partially durable ingest surface behind.
      if (current && current.version < 85) {
        const migrateV85 = this.db.transaction(() => {
          if (hasTable('runs')) {
            const runColumns = new Set(
              (this.db.prepare('PRAGMA table_info(runs)').all() as any[]).map((column) => column.name)
            );
            if (!runColumns.has('external_run_id')) this.db.exec('ALTER TABLE runs ADD COLUMN external_run_id TEXT');
            if (!runColumns.has('generation')) this.db.exec('ALTER TABLE runs ADD COLUMN generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0)');
            if (!runColumns.has('source')) this.db.exec("ALTER TABLE runs ADD COLUMN source TEXT NOT NULL DEFAULT 'native' CHECK(source IN ('native', 'ingest'))");
            if (!runColumns.has('state_revision')) this.db.exec('ALTER TABLE runs ADD COLUMN state_revision INTEGER NOT NULL DEFAULT 0 CHECK(state_revision >= 0)');
            if (!runColumns.has('register_seal_hash')) this.db.exec('ALTER TABLE runs ADD COLUMN register_seal_hash TEXT');
            if (!runColumns.has('terminal_seal_hash')) this.db.exec('ALTER TABLE runs ADD COLUMN terminal_seal_hash TEXT');
            this.db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_project_external_generation
  ON runs(project_id, external_run_id, generation)
  WHERE project_id IS NOT NULL AND external_run_id IS NOT NULL;
`);
          }
          this.db.exec(`
CREATE TABLE IF NOT EXISTS run_ingest_receipts (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  event_id TEXT NOT NULL UNIQUE,
  semantic_key TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_run_ingest_receipts_run ON run_ingest_receipts(run_id);
CREATE TRIGGER IF NOT EXISTS run_ingest_receipts_no_replace
BEFORE INSERT ON run_ingest_receipts
WHEN NEW.id IS NOT NULL AND EXISTS (SELECT 1 FROM run_ingest_receipts WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'run ingest receipts are append-only');
END;
CREATE TRIGGER IF NOT EXISTS run_ingest_receipts_no_update
BEFORE UPDATE ON run_ingest_receipts
BEGIN
  SELECT RAISE(ABORT, 'run ingest receipts are append-only');
END;
CREATE TRIGGER IF NOT EXISTS run_ingest_receipts_no_delete
BEFORE DELETE ON run_ingest_receipts
BEGIN
  SELECT RAISE(ABORT, 'run ingest receipts are append-only');
END;
`);
          this.db.prepare('UPDATE schema_version SET version = 85').run();
        });
        migrateV85();
      }

      // B-ISO1 (2026-07-16 cheat-isolation): v85→v86 additive — master_runtimes.strict_read_allow
      // (JSON array of THIS run's opt-in strict READ allowlist, or NULL for default read-all). Lets
      // a supervisor respawn / model swap re-read + re-apply the same strict fence instead of silently
      // reverting to read-all mid-run. Guarded PRAGMA table_info + idempotent (matches v28 closed_reason).
      if (current && current.version < 86) {
        const migrateV86 = this.db.transaction(() => {
          if (hasTable('master_runtimes')) {
            const mrCols = this.db.prepare("PRAGMA table_info(master_runtimes)").all().map((c: any) => c.name);
            if (!mrCols.includes('strict_read_allow')) {
              this.db.exec(`ALTER TABLE master_runtimes ADD COLUMN strict_read_allow TEXT;`);
            }
          }
          this.db.prepare('UPDATE schema_version SET version = 86').run();
        });
        migrateV86();
      }

      // v87 (NAME-LAYER agent rename, 2026-07-16): rename EXISTING project agents by name only —
      //   north → discovery, projcore → plancore.
      // Function-preserving: agents.id is unchanged, so every role_bindings/role_defaults/project_agents
      // row (all keyed on agent_id) keeps pointing at the same agent — the ROLE 'projcore' still resolves
      // to this agent, whose worker-face stays 'helm_pm'. No role enum / role-alias / callback token touched.
      // Idempotent + collision-safe (skip if the target name already exists) so it is safe to re-run.
      if (current && current.version < 87) {
        const migrateV87 = this.db.transaction(() => {
          // Schema-agnostic: reference ONLY columns guaranteed to exist across every historical/synthetic
          // agents schema (name). Ancient/minimal fixtures lack `updated_at`, so we do not touch it here —
          // a rename is not a user edit and updated_at is non-load-bearing for identity.
          if (hasTable('agents')) {
            const nameExists = (name: string): boolean =>
              !!this.db.prepare('SELECT 1 FROM agents WHERE name = ?').get(name);
            // F4: COLLISION policy. A live DB naturally holds EITHER the old OR the new name of a pair,
            // never both. If BOTH exist, silently renaming (skipping via NOT EXISTS) would leave two
            // distinct agent identities with bindings split across them and the projcore role default
            // possibly moved off its original row — corrupting the DB-global rename AND function
            // preservation. Merging two identities' FKs across ~11 child tables risks worse silent
            // corruption, so we FAIL LOUD and do NOT advance the schema version: the operator resolves
            // the collision (merge/remove one), then re-open migrates cleanly. (Transaction rolls back.)
            const collisions: string[] = [];
            if (nameExists('north') && nameExists('discovery')) collisions.push("'north' + 'discovery'");
            if (nameExists('projcore') && nameExists('plancore')) collisions.push("'projcore' + 'plancore'");
            if (collisions.length > 0) {
              throw new Error(
                `v87 agent-rename collision: both old and new names present for ${collisions.join(' and ')}. ` +
                `Refusing to migrate (schema stays at v86) to avoid splitting bindings across two identities. ` +
                `Resolve by merging/removing the duplicate agent row(s), then reopen.`
              );
            }
            // No collision → straightforward rename (each pair: old present, new absent → rename; or already
            // renamed → no-op). NOT EXISTS guard keeps it idempotent + UNIQUE-safe on re-run.
            this.db.prepare(
              `UPDATE agents SET name = 'discovery'
               WHERE name = 'north' AND NOT EXISTS (SELECT 1 FROM agents WHERE name = 'discovery')`
            ).run();
            this.db.prepare(
              `UPDATE agents SET name = 'plancore'
               WHERE name = 'projcore' AND NOT EXISTS (SELECT 1 FROM agents WHERE name = 'plancore')`
            ).run();
            // Repoint the sole name-based reference (role_defaults binds role→agent BY NAME at seed time,
            // stored as agent_id): ensure the 'projcore' ROLE default points at the renamed 'plancore' agent.
            // The rename above already preserves it (agent_id unchanged); this is a belt-and-suspenders
            // for any drifted live DB and only fires when a 'plancore' agent actually exists.
            if (hasTable('role_defaults')) {
              this.db.prepare(
                `UPDATE role_defaults
                   SET agent_id = (SELECT id FROM agents WHERE name = 'plancore')
                 WHERE role = 'projcore' AND EXISTS (SELECT 1 FROM agents WHERE name = 'plancore')`
              ).run();
            }
          }
          this.db.prepare('UPDATE schema_version SET version = 87').run();
        });
        migrateV87();
      }

      // v88 (Leg D batch barrier): make the normalized plan `batch` first-class durable state on
      // run_tasks so dispatch ordering (queue admission barrier), the deploy gate, and pending-after-
      // drain classification all read ONE durable batch identity — not the task_key prefix. Additive,
      // guarded (table-exists + column-absent PRAGMA check), idempotent — a partial/hand-rolled upgrade
      // DB must not crash. Mirrors the v28 closed_reason / v86 strict_read_allow pattern. Legacy rows
      // keep batch NULL (resolved to the synthetic 'default' batch at read time); the complete additive
      // change and the version bump share one transaction.
      if (current && current.version < 88) {
        const migrateV88 = this.db.transaction(() => {
          if (hasTable('run_tasks')) {
            const rtCols = this.db.prepare('PRAGMA table_info(run_tasks)').all().map((c: any) => c.name);
            if (!rtCols.includes('batch')) {
              this.db.exec(`ALTER TABLE run_tasks ADD COLUMN batch TEXT;`);
            }
          }
          this.db.prepare('UPDATE schema_version SET version = 88').run();
        });
        migrateV88();
      }

      // v89 (iBrain split, Stage 1): additive role vocabulary + migration substrate.
      // `projcore` deliberately remains valid until the later call-site migration removes it.
      if (current && current.version < 89) {
        const migrateV89 = this.db.transaction(() => {
          if (hasTable('projects')) {
            const projectColumns = new Set(
              (this.db.prepare('PRAGMA table_info(projects)').all() as any[]).map((column) => column.name)
            );
            if (!projectColumns.has('plancore_session')) {
              this.db.exec('ALTER TABLE projects ADD COLUMN plancore_session TEXT');
            }
            if (projectColumns.has('projcore_session')) this.db.exec(`
UPDATE projects
SET plancore_session = projcore_session
WHERE plancore_session IS NULL;
`);
          }

          if (hasTable('master_runtimes')) {
            const runtimeColumns = new Set(
              (this.db.prepare('PRAGMA table_info(master_runtimes)').all() as any[]).map((column) => column.name)
            );
            if (!runtimeColumns.has('role')) {
              this.db.exec('ALTER TABLE master_runtimes ADD COLUMN role TEXT');
            }
            if (hasTable('runs')) {
              this.db.exec(`
UPDATE master_runtimes AS mr
SET role = CASE
  WHEN EXISTS (
    SELECT 1 FROM runs AS r
    WHERE r.project_id = mr.project_id
      AND r.status = 'active'
      AND r.phase IN ('executing', 'implementation', 'final_tests')
  ) THEN 'ibrain'
  ELSE 'plancore'
END
WHERE role IS NULL;
`);
            } else {
              this.db.exec("UPDATE master_runtimes SET role = 'plancore' WHERE role IS NULL");
            }
          }

          if (hasTable('role_bindings')) {
            this.db.exec(`
DROP TABLE IF EXISTS role_bindings_v89;
CREATE TABLE role_bindings_v89 (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('projcore', 'discovery', 'plancore', 'ibrain', 'coord', 'implementer', 'validator', 'deliberation', 'red-team', 'planner', 'routine-implementer', 'panelist')),
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, role, agent_id)
);
INSERT INTO role_bindings_v89 (id, project_id, role, agent_id, created_at, updated_at)
SELECT id, project_id, role, agent_id, created_at, updated_at FROM role_bindings;
DROP TABLE role_bindings;
ALTER TABLE role_bindings_v89 RENAME TO role_bindings;
`);
          }

          if (hasTable('role_defaults')) {
            this.db.exec(`
DROP TABLE IF EXISTS role_defaults_v89;
CREATE TABLE role_defaults_v89 (
  role TEXT PRIMARY KEY CHECK(role IN ('projcore', 'discovery', 'plancore', 'ibrain', 'coord', 'implementer', 'validator', 'deliberation', 'red-team', 'planner', 'routine-implementer', 'panelist')),
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO role_defaults_v89 (role, agent_id, updated_at)
SELECT role, agent_id, updated_at FROM role_defaults;
DROP TABLE role_defaults;
ALTER TABLE role_defaults_v89 RENAME TO role_defaults;
`);
          }

          if (hasTable('role_capabilities')) {
            this.db.exec(`
DROP TABLE IF EXISTS role_capabilities_v89;
CREATE TABLE role_capabilities_v89 (
  role TEXT PRIMARY KEY CHECK(role IN ('projcore', 'discovery', 'plancore', 'ibrain', 'coord', 'implementer', 'validator', 'deliberation', 'red-team', 'planner', 'routine-implementer', 'panelist')),
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
INSERT INTO role_capabilities_v89 (
  role, allowed_statuses, terminal_statuses, can_write_code, requires_repro_first,
  panel_participant, can_escalate, session_policy, required_artifacts, timeout_ms,
  checkin_ms, created_at, updated_at
)
SELECT role, allowed_statuses, terminal_statuses, can_write_code, requires_repro_first,
       panel_participant, can_escalate, session_policy, required_artifacts, timeout_ms,
       checkin_ms, created_at, updated_at
FROM role_capabilities;
DROP TABLE role_capabilities;
ALTER TABLE role_capabilities_v89 RENAME TO role_capabilities;
`);
          }

          if (hasTable('agents')) {
            const agentColumns = new Set(
              (this.db.prepare('PRAGMA table_info(agents)').all() as any[]).map((column) => column.name)
            );
            if (agentColumns.has('definition_md')) {
              const plancore = this.db.prepare(
                "SELECT id, definition_md FROM agents WHERE name = 'plancore' LIMIT 1"
              ).get() as { id: number; definition_md: string | null } | undefined;
              if (plancore) {
                const currentDefinition = plancore.definition_md || '';
                const definitionHash = createHash('sha256').update(currentDefinition, 'utf8').digest('hex');
                if (!currentDefinition.trim() || V89_KNOWN_CANONICAL_PLANCORE_HASHES.has(definitionHash)) {
                  const timestampSet = agentColumns.has('updated_at') ? ", updated_at = datetime('now')" : '';
                  this.db.prepare(
                    `UPDATE agents SET definition_md = ?${timestampSet} WHERE id = ?`
                  ).run(V89_PLANCORE_DEFINITION_MD, plancore.id);
                } else if (currentDefinition !== V89_PLANCORE_DEFINITION_MD) {
                  console.warn(
                    `[v89] custom plancore definition_md preserved (agent_id=${plancore.id}, sha256=${definitionHash})`
                  );
                }
              }
            }

            const fullAgentSeedColumns = [
              'provider', 'model', 'default_effort', 'spawn_pref', 'definition_md', 'agent_type'
            ];
            if (fullAgentSeedColumns.every((column) => agentColumns.has(column))) {
              this.db.prepare(`
INSERT OR IGNORE INTO agents (
  name, provider, model, default_effort, spawn_pref, definition_md, agent_type
) VALUES ('ibrain', 'claude', 'claude-opus-5', 'high', 'tmux', ?, 'project')
`).run(V89_IBRAIN_DEFINITION_MD);
              const timestampSet = agentColumns.has('updated_at') ? ", updated_at = datetime('now')" : '';
              this.db.prepare(`
UPDATE agents
SET definition_md = ?${timestampSet}
WHERE name = 'ibrain' AND (definition_md IS NULL OR TRIM(definition_md) = '')
`).run(V89_IBRAIN_DEFINITION_MD);
            }
            if (hasTable('models') && agentColumns.has('default_model_id')) {
              const modelColumns = new Set(
                (this.db.prepare('PRAGMA table_info(models)').all() as any[]).map((column) => column.name)
              );
              if (modelColumns.has('model_id')) this.db.prepare(`
UPDATE agents
SET default_model_id = (SELECT id FROM models WHERE model_id = 'claude-opus-5' LIMIT 1)
WHERE name = 'ibrain' AND default_model_id IS NULL
`).run();
            }
          }

          if (hasTable('role_bindings') && hasTable('agents')) {
            this.db.exec(`
INSERT OR IGNORE INTO role_bindings (project_id, role, agent_id, created_at, updated_at)
SELECT project_id, 'plancore', agent_id, created_at, updated_at
FROM role_bindings WHERE role = 'projcore';

INSERT OR IGNORE INTO role_bindings (project_id, role, agent_id, created_at, updated_at)
SELECT project_id, 'ibrain', agent_id, created_at, updated_at
FROM role_bindings WHERE role = 'projcore';
`);
          }

          if (hasTable('role_defaults') && hasTable('agents')) {
            this.db.exec(`
INSERT OR IGNORE INTO role_defaults (role, agent_id)
SELECT 'discovery', id FROM agents WHERE name = 'discovery';
INSERT OR IGNORE INTO role_defaults (role, agent_id)
SELECT 'plancore', id FROM agents WHERE name = 'plancore';
INSERT OR IGNORE INTO role_defaults (role, agent_id)
SELECT 'ibrain', id FROM agents WHERE name = 'ibrain';
`);
          }

          if (hasTable('role_capabilities')) {
            const insertCapability = this.db.prepare(`
INSERT OR IGNORE INTO role_capabilities (
  role, allowed_statuses, terminal_statuses, can_write_code, requires_repro_first,
  panel_participant, can_escalate, session_policy, required_artifacts, timeout_ms, checkin_ms
) VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, NULL, ?)
`);
            insertCapability.run(
              'discovery',
              '["INTERVIEWING","NORTH-STAR-READY","HANDOFF","BLOCKED"]',
              '["NORTH-STAR-READY","HANDOFF","BLOCKED"]',
              0,
              0,
              'fresh',
              '["north-star.md","decisions/"]',
              null
            );
            insertCapability.run(
              'plancore',
              '["PLANNING","PLAN-READY","IDLE","BLOCKED"]',
              '["PLAN-READY","BLOCKED"]',
              0,
              1,
              'clear+rehydrate',
              '["north-star.md","og-requirements.md","plan.md","decisions/"]',
              300000
            );
            insertCapability.run(
              'ibrain',
              '["DECIDING","DECISION-READY","IDLE","HANDHOLD-DIRECTIONS","BLOCKED"]',
              '["DECISION-READY","BLOCKED"]',
              0,
              1,
              'clear+rehydrate',
              '["plan.md","decisions/","failure-history"]',
              300000
            );
          }

          if (hasTable('projects') && hasTable('project_agents') && hasTable('agents')) {
            const projectAgentColumns = new Set(
              (this.db.prepare('PRAGMA table_info(project_agents)').all() as any[]).map((column) => column.name)
            );
            if (projectAgentColumns.has('project_id') && projectAgentColumns.has('agent_id')) {
              const insertColumns = ['project_id', 'agent_id'];
              const selectExpressions = ['p.id', 'ib.id'];
              const inheritedColumns: Array<[string, string]> = [
                ['model_id', 'pcpa.model_id'],
                ['use_dynamic', 'COALESCE(pcpa.use_dynamic, 0)'],
                ['effort_override', 'pcpa.effort_override'],
                ['spawn_pref_override', 'pcpa.spawn_pref_override']
              ];
              for (const [column, expression] of inheritedColumns) {
                if (!projectAgentColumns.has(column)) continue;
                insertColumns.push(column);
                selectExpressions.push(expression);
              }
              this.db.exec(`
INSERT OR IGNORE INTO project_agents (${insertColumns.join(', ')})
SELECT ${selectExpressions.join(', ')}
FROM projects AS p
JOIN agents AS ib ON ib.name = 'ibrain'
LEFT JOIN agents AS pc ON pc.name = 'plancore'
LEFT JOIN project_agents AS pcpa
  ON pcpa.project_id = p.id AND pcpa.agent_id = pc.id;
`);
            }
          }

          this.db.prepare('UPDATE schema_version SET version = 89').run();
        });
        migrateV89();
      }

      // v90 (iBrain split, Stage 7): delete the compatibility role and rebuild every
      // constrained role table with the final vocabulary. Residue cleanup MUST precede
      // the projcore-less INSERT...SELECT rebuilds or SQLite will reject the copy.
      if (current && current.version < 90) {
        const migrateV90 = this.db.transaction(() => {
          const foreignKeyViolationsBefore = this.db.prepare('PRAGMA foreign_key_check').all().length;
          if (hasTable('role_bindings')) {
            this.db.exec(`
INSERT OR IGNORE INTO role_bindings (project_id, role, agent_id, created_at, updated_at)
SELECT project_id, 'plancore', agent_id, created_at, updated_at
FROM role_bindings WHERE role = 'projcore';
INSERT OR IGNORE INTO role_bindings (project_id, role, agent_id, created_at, updated_at)
SELECT project_id, 'ibrain', agent_id, created_at, updated_at
FROM role_bindings WHERE role = 'projcore';
DELETE FROM role_bindings WHERE role = 'projcore';
`);
          }

          if (hasTable('role_defaults')) {
            this.db.exec(`
INSERT OR IGNORE INTO role_defaults (role, agent_id, updated_at)
SELECT 'plancore', agent_id, updated_at FROM role_defaults WHERE role = 'projcore';
INSERT OR IGNORE INTO role_defaults (role, agent_id, updated_at)
SELECT 'ibrain', agent_id, updated_at FROM role_defaults WHERE role = 'projcore';
DELETE FROM role_defaults WHERE role = 'projcore';
`);
          }

          if (hasTable('role_capabilities')) {
            this.db.exec(`
INSERT OR IGNORE INTO role_capabilities (
  role, allowed_statuses, terminal_statuses, can_write_code, requires_repro_first,
  panel_participant, can_escalate, session_policy, required_artifacts, timeout_ms,
  checkin_ms, created_at, updated_at
)
SELECT 'plancore', allowed_statuses, terminal_statuses, can_write_code, requires_repro_first,
       panel_participant, can_escalate, session_policy, required_artifacts, timeout_ms,
       checkin_ms, created_at, updated_at
FROM role_capabilities WHERE role = 'projcore';
INSERT OR IGNORE INTO role_capabilities (
  role, allowed_statuses, terminal_statuses, can_write_code, requires_repro_first,
  panel_participant, can_escalate, session_policy, required_artifacts, timeout_ms,
  checkin_ms, created_at, updated_at
)
SELECT 'ibrain', allowed_statuses, terminal_statuses, can_write_code, requires_repro_first,
       panel_participant, can_escalate, session_policy, required_artifacts, timeout_ms,
       checkin_ms, created_at, updated_at
FROM role_capabilities WHERE role = 'projcore';
DELETE FROM role_capabilities WHERE role = 'projcore';
`);
          }

          // Current mutable config/runtime state moves to the implementation brain. A live runtime
          // is translated in place so its existing tmux session remains supervised and recoverable;
          // only already-terminal rows are pruned. Every disposition is append-only audited.
          if (hasTable('plumbing_configs')) {
            const columns = new Set(
              (this.db.prepare('PRAGMA table_info(plumbing_configs)').all() as any[]).map((column) => column.name)
            );
            if (columns.has('role')) this.db.exec(`
DELETE FROM plumbing_configs AS legacy
WHERE role = 'projcore'
  AND EXISTS (
    SELECT 1 FROM plumbing_configs AS current
    WHERE current.project_id = legacy.project_id AND current.role = 'ibrain'
  );
UPDATE plumbing_configs SET role = 'ibrain' WHERE role = 'projcore';
`);
          }
          if (hasTable('routing_rules')) {
            this.db.exec("UPDATE routing_rules SET handler_role = 'ibrain' WHERE handler_role = 'projcore'");
          }
          if (hasTable('agent_escalations')) {
            this.db.exec("UPDATE agent_escalations SET trigger = 'ibrain' WHERE trigger = 'projcore'");
          }
          if (hasTable('project_agent_escalations')) {
            this.db.exec("UPDATE project_agent_escalations SET trigger = 'ibrain' WHERE trigger = 'projcore'");
          }
          if (hasTable('master_runtimes')) {
            const columns = new Set(
              (this.db.prepare('PRAGMA table_info(master_runtimes)').all() as any[]).map((column) => column.name)
            );
            const predicates = [columns.has('provider') ? "provider = 'projcore'" : '', columns.has('role') ? "role = 'projcore'" : '']
              .filter(Boolean);
            if (predicates.length > 0) {
              const legacyRows = this.db.prepare(`
SELECT project_id, master_run_id, tmux_session, provider, model, state, role
FROM master_runtimes
WHERE ${predicates.join(' OR ')}
`).all() as Array<{
                project_id: number;
                master_run_id: string;
                tmux_session: string;
                provider: string;
                model: string;
                state: string;
                role: string | null;
              }>;
              if (legacyRows.length > 0 && !hasTable('run_events')) {
                throw new Error('v90 cannot translate legacy master runtime without durable run_events audit substrate');
              }
              const brainAgent = hasTable('agents')
                ? this.db.prepare("SELECT provider, model FROM agents WHERE name = 'ibrain'").get() as { provider: string; model: string } | undefined
                : undefined;
              const insertEvent = hasTable('run_events')
                ? this.db.prepare('INSERT INTO run_events (run_id, batch_id, event_type, payload_json) VALUES (?, NULL, ?, ?)')
                : null;
              const updateRuntime = this.db.prepare(`
UPDATE master_runtimes
SET provider = ?, model = ?, role = 'ibrain', updated_at = datetime('now')
WHERE project_id = ?
`);
              const deleteRuntime = this.db.prepare('DELETE FROM master_runtimes WHERE project_id = ?');

              for (const row of legacyRows) {
                const terminal = ['closed', 'failed'].includes(String(row.state || '').toLowerCase());
                if (terminal) {
                  insertEvent!.run(row.master_run_id, 'V90_MASTER_RUNTIME_PRUNED', JSON.stringify({
                    project_id: row.project_id,
                    tmux_session: row.tmux_session,
                    state: row.state,
                    from: { provider: row.provider, model: row.model, role: row.role },
                    reason: 'terminal legacy projcore runtime',
                  }));
                  deleteRuntime.run(row.project_id);
                  continue;
                }

                if (row.provider === 'projcore' && !brainAgent) {
                  throw new Error(`v90 cannot recover live projcore runtime for project ${row.project_id}: ibrain launch identity missing`);
                }
                const nextProvider = row.provider === 'projcore' ? brainAgent!.provider : row.provider;
                const nextModel = row.provider === 'projcore' ? brainAgent!.model : row.model;
                insertEvent!.run(row.master_run_id, 'V90_MASTER_RUNTIME_TRANSLATED', JSON.stringify({
                  project_id: row.project_id,
                  tmux_session: row.tmux_session,
                  state: row.state,
                  from: { provider: row.provider, model: row.model, role: row.role },
                  to: { provider: nextProvider, model: nextModel, role: 'ibrain' },
                }));
                updateRuntime.run(nextProvider, nextModel, row.project_id);
              }
            }
          }

          for (const table of ['role_bindings', 'role_defaults', 'role_capabilities']) {
            if (!hasTable(table)) continue;
            const residue = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE role = 'projcore'`)
              .get() as { count: number };
            if (residue.count !== 0) {
              throw new Error(`v90 pre-rebuild safety check failed: ${table} still has ${residue.count} retired role row(s)`);
            }
          }

          if (hasTable('role_bindings')) {
            const before = this.db.prepare('SELECT COUNT(*) AS count FROM role_bindings').get() as { count: number };
            this.db.exec(`
DROP TABLE IF EXISTS role_bindings_v90;
CREATE TABLE role_bindings_v90 (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('discovery', 'plancore', 'ibrain', 'coord', 'implementer', 'validator', 'deliberation', 'red-team', 'planner', 'routine-implementer', 'panelist')),
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, role, agent_id)
);
INSERT INTO role_bindings_v90 (id, project_id, role, agent_id, created_at, updated_at)
SELECT id, project_id, role, agent_id, created_at, updated_at FROM role_bindings;
DROP TABLE role_bindings;
ALTER TABLE role_bindings_v90 RENAME TO role_bindings;
`);
            const after = this.db.prepare('SELECT COUNT(*) AS count FROM role_bindings').get() as { count: number };
            if (after.count !== before.count) throw new Error(`v90 role_bindings row-count mismatch: before=${before.count} after=${after.count}`);
          }

          if (hasTable('role_defaults')) {
            const before = this.db.prepare('SELECT COUNT(*) AS count FROM role_defaults').get() as { count: number };
            this.db.exec(`
DROP TABLE IF EXISTS role_defaults_v90;
CREATE TABLE role_defaults_v90 (
  role TEXT PRIMARY KEY CHECK(role IN ('discovery', 'plancore', 'ibrain', 'coord', 'implementer', 'validator', 'deliberation', 'red-team', 'planner', 'routine-implementer', 'panelist')),
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO role_defaults_v90 (role, agent_id, updated_at)
SELECT role, agent_id, updated_at FROM role_defaults;
DROP TABLE role_defaults;
ALTER TABLE role_defaults_v90 RENAME TO role_defaults;
`);
            const after = this.db.prepare('SELECT COUNT(*) AS count FROM role_defaults').get() as { count: number };
            if (after.count !== before.count) throw new Error(`v90 role_defaults row-count mismatch: before=${before.count} after=${after.count}`);
          }

          if (hasTable('role_capabilities')) {
            const before = this.db.prepare('SELECT COUNT(*) AS count FROM role_capabilities').get() as { count: number };
            this.db.exec(`
DROP TABLE IF EXISTS role_capabilities_v90;
CREATE TABLE role_capabilities_v90 (
  role TEXT PRIMARY KEY CHECK(role IN ('discovery', 'plancore', 'ibrain', 'coord', 'implementer', 'validator', 'deliberation', 'red-team', 'planner', 'routine-implementer', 'panelist')),
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
INSERT INTO role_capabilities_v90 (
  role, allowed_statuses, terminal_statuses, can_write_code, requires_repro_first,
  panel_participant, can_escalate, session_policy, required_artifacts, timeout_ms,
  checkin_ms, created_at, updated_at
)
SELECT role, allowed_statuses, terminal_statuses, can_write_code, requires_repro_first,
       panel_participant, can_escalate, session_policy, required_artifacts, timeout_ms,
       checkin_ms, created_at, updated_at
FROM role_capabilities;
DROP TABLE role_capabilities;
ALTER TABLE role_capabilities_v90 RENAME TO role_capabilities;
`);
            const after = this.db.prepare('SELECT COUNT(*) AS count FROM role_capabilities').get() as { count: number };
            if (after.count !== before.count) throw new Error(`v90 role_capabilities row-count mismatch: before=${before.count} after=${after.count}`);
          }

          if (hasTable('projects')) {
            const projectColumns = new Set(
              (this.db.prepare('PRAGMA table_info(projects)').all() as any[]).map((column) => column.name)
            );
            if (projectColumns.has('projcore_session')) {
              this.db.exec('ALTER TABLE projects DROP COLUMN projcore_session');
            }
          }

          const foreignKeyViolations = this.db.prepare('PRAGMA foreign_key_check').all();
          if (foreignKeyViolations.length > foreignKeyViolationsBefore) {
            throw new Error(
              `v90 introduced foreign-key violations: before=${foreignKeyViolationsBefore} after=${foreignKeyViolations.length}`
            );
          }
          this.db.prepare('UPDATE schema_version SET version = 90').run();
        });
        migrateV90();
      }

      // v91: widen runs.status CHECK to include 'paused' (operator-recoverable halt: missing final-test
      // config, or a grok seat that lost auth). SQLite cannot ALTER a CHECK, so rebuild the table
      // INSERT...SELECT preserving every row and all columns. Because run_tasks/run_events/etc reference
      // runs(id), FKs must be OFF for the DROP+rename (mirrors the v49 project_agents rebuild pattern):
      // toggle off BEFORE BEGIN, re-validate with foreign_key_check, restore on both paths.
      if (current && current.version < 91) {
        if (hasTable('runs')) {
          const before = (this.db.prepare('SELECT COUNT(*) AS c FROM runs').get() as { c: number }).c;
          const fkWasOn = this.db.pragma('foreign_keys', { simple: true }) === 1;
          this.db.pragma('foreign_keys = OFF');
          this.db.exec('BEGIN IMMEDIATE;');
          try {
            this.db.exec(`
CREATE TABLE runs_new (
  id INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  cycle_id INTEGER REFERENCES cycles(id),
  batch_id TEXT,
  north_star_ref TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending','active','complete','failed','paused')) DEFAULT 'active',
  phase TEXT NOT NULL DEFAULT 'planning',
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  external_run_id TEXT,
  generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0),
  source TEXT NOT NULL DEFAULT 'native' CHECK(source IN ('native', 'ingest')),
  state_revision INTEGER NOT NULL DEFAULT 0 CHECK(state_revision >= 0),
  register_seal_hash TEXT,
  terminal_seal_hash TEXT
);
INSERT INTO runs_new (id, project_id, cycle_id, batch_id, north_star_ref, status, phase, started_at,
  ended_at, external_run_id, generation, source, state_revision, register_seal_hash, terminal_seal_hash)
SELECT id, project_id, cycle_id, batch_id, north_star_ref, status, phase, started_at,
  ended_at, external_run_id, generation, source, state_revision, register_seal_hash, terminal_seal_hash
FROM runs;
DROP TABLE runs;
ALTER TABLE runs_new RENAME TO runs;
`);
            const after = (this.db.prepare('SELECT COUNT(*) AS c FROM runs').get() as { c: number }).c;
            if (after !== before) throw new Error(`v91 runs rebuild row-count mismatch: before=${before} after=${after}`);
            this.db.pragma('foreign_keys = ON');
            const fkProblems = this.db.prepare('PRAGMA foreign_key_check').all() as any[];
            if (fkProblems.length > 0) {
              throw new Error(`foreign_key_check failed during v91 runs rebuild: ${JSON.stringify(fkProblems.slice(0, 5))}`);
            }
            this.db.prepare('UPDATE schema_version SET version = 91').run();
            this.db.exec('COMMIT;');
          } catch (e) {
            try { this.db.exec('ROLLBACK;'); } catch {}
            this.db.pragma(`foreign_keys = ${fkWasOn ? 'ON' : 'OFF'}`);
            throw e;
          }
          this.db.pragma('foreign_keys = ON');
        } else {
          this.db.prepare('UPDATE schema_version SET version = 91').run();
        }
      }

      // v92: opt-in adaptive-planning flag on projects (plain ADD COLUMN — no CHECK rebuild needed).
      if (current && current.version < 92) {
        if (hasTable('projects')) {
          const cols = this.db.prepare('PRAGMA table_info(projects)').all() as any[];
          if (!cols.some((c) => c.name === 'adaptive_planning')) {
            this.db.exec(
              "ALTER TABLE projects ADD COLUMN adaptive_planning INTEGER NOT NULL DEFAULT 0 CHECK(adaptive_planning IN (0, 1))"
            );
          }
        }
        this.db.prepare('UPDATE schema_version SET version = 92').run();
      }

      // v93: per-project planner panel config (members + backups) + projects.planner_default_effort.
      if (current && current.version < 93) {
        if (hasTable('projects')) {
          const cols = this.db.prepare('PRAGMA table_info(projects)').all() as any[];
          if (!cols.some((c) => c.name === 'planner_default_effort')) {
            this.db.exec(
              "ALTER TABLE projects ADD COLUMN planner_default_effort TEXT DEFAULT 'med' CHECK(planner_default_effort IS NULL OR planner_default_effort IN ('low','med','high','xhigh'))"
            );
          }
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS project_planner_panel (
              id INTEGER PRIMARY KEY,
              project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
              slot_index INTEGER NOT NULL,
              role TEXT NOT NULL CHECK(role IN ('member','backup')),
              model_id INTEGER REFERENCES models(id),
              is_lead INTEGER NOT NULL DEFAULT 0 CHECK(is_lead IN (0,1)),
              effort TEXT CHECK(effort IS NULL OR effort IN ('low','med','high','xhigh')),
              created_at TEXT NOT NULL DEFAULT (datetime('now')),
              UNIQUE(project_id, role, slot_index)
            );
            CREATE INDEX IF NOT EXISTS idx_project_planner_panel_project ON project_planner_panel(project_id);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_project_planner_panel_one_lead
              ON project_planner_panel(project_id) WHERE role = 'member' AND is_lead = 1;
          `);
        }
        this.db.prepare('UPDATE schema_version SET version = 93').run();
      }

      // v94: agents.classification (solo|tiered|team) — drives override-editor layout + list chip. Additive.
      if (current && current.version < 94) {
        if (hasTable('agents')) {
          const cols = this.db.prepare('PRAGMA table_info(agents)').all() as any[];
          if (!cols.some((c) => c.name === 'classification')) {
            this.db.exec(
              "ALTER TABLE agents ADD COLUMN classification TEXT NOT NULL DEFAULT 'solo' CHECK(classification IN ('solo','tiered','team'))"
            );
          }
          // AC-2 backfill by agent NAME (deliberation/red-team are NOT agents — do not touch them here)
          this.db.exec("UPDATE agents SET classification='tiered' WHERE name IN ('implementer','validator')");
          this.db.exec("UPDATE agents SET classification='team'   WHERE name = 'planner'");
          this.db.exec("UPDATE agents SET classification='solo'   WHERE name IN ('discovery','plancore','ibrain','panelist')");
        }
        this.db.prepare('UPDATE schema_version SET version = 94').run();
      }

      // v95 / B5 AC-10: nullable per-rung effort on studio + project escalation ladders.
      // Whitelist matches agent effort_override (low|medium|high|xhigh|max). NULL = inherit L1/agent.
      if (current && current.version < 95) {
        const effortColSql =
          "TEXT CHECK(effort IS NULL OR effort IN ('low','medium','high','xhigh','max'))";
        if (hasTable('agent_escalations')) {
          const cols = this.db.prepare('PRAGMA table_info(agent_escalations)').all() as any[];
          if (!cols.some((c) => c.name === 'effort')) {
            this.db.exec(`ALTER TABLE agent_escalations ADD COLUMN effort ${effortColSql}`);
          }
        }
        if (hasTable('project_agent_escalations')) {
          const cols = this.db.prepare('PRAGMA table_info(project_agent_escalations)').all() as any[];
          if (!cols.some((c) => c.name === 'effort')) {
            this.db.exec(`ALTER TABLE project_agent_escalations ADD COLUMN effort ${effortColSql}`);
          }
        }
        this.db.prepare('UPDATE schema_version SET version = 95').run();
      }

      // v96: normalize orphaned/legacy escalation triggers to the valid vocabulary
      // (on-fail | plan-summon | ibrain). Older DBs seeded implementer/validator ladders with
      // trigger='escalate' (never in the app-validated set), so toggling a project escalation-
      // override copied the invalid value and the set-escalations validator rejected it (400).
      // Mirrors the earlier projcore->ibrain normalization; app-level validators already block new
      // bad values, this repairs pre-existing rows. Invalid → 'on-fail' (schema default).
      if (current && current.version < 96) {
        const validTriggers = "('on-fail','plan-summon','ibrain')";
        if (hasTable('agent_escalations')) {
          this.db.exec(`UPDATE agent_escalations SET trigger = 'on-fail' WHERE trigger NOT IN ${validTriggers}`);
        }
        if (hasTable('project_agent_escalations')) {
          this.db.exec(`UPDATE project_agent_escalations SET trigger = 'on-fail' WHERE trigger NOT IN ${validTriggers}`);
        }
        this.db.prepare('UPDATE schema_version SET version = 96').run();
      }

      // v97 / B8a AC-12: opt-in project role roster override (deliberation|red-team).
      // Additive empty table only — zero rows ⇒ resolveProjectRole keeps today's team-binding path.
      if (current && current.version < 97) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS project_role_roster_members (
            id INTEGER PRIMARY KEY,
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            role TEXT NOT NULL CHECK(role IN ('deliberation','red-team')),
            position INTEGER NOT NULL,
            model_id INTEGER NOT NULL REFERENCES models(id),
            lens TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            UNIQUE(project_id, role, position)
          );
          CREATE INDEX IF NOT EXISTS idx_project_role_roster_members_proj_role
            ON project_role_roster_members(project_id, role);
        `);
        this.db.prepare('UPDATE schema_version SET version = 97').run();
      }

      // v98 / B11 AC-3: retire panelist as a first-class product agent (SAFE path).
      // Keep hidden seed (solo + in_development) for runtime panel/OFF-adaptive role='panelist'
      // spawn; unbind role_defaults / role_bindings / project_agents. Idempotent helper.
      if (current && current.version < 98) {
        applyB11PanelistRetirement(this.db);
        this.db.prepare('UPDATE schema_version SET version = 98').run();
      }

      // v99 / A10 (R1.3): per-project planning panel size (1/2/3/N, default 2) for the CORE (non-adaptive)
      // planning path — replaces guessing seat count from selectCoPlannerMode's north-star regex (that
      // function only ever chose planner/deliberation *lens*, not seat count). Distinct from the
      // opt-in adaptive planner's own PlannerPanel.size (project_planner_panel table, v93) and from
      // topology.yaml's deliberation_panel — this row changes seat count only for the default path.
      if (current && current.version < 99) {
        if (hasTable('projects')) {
          const cols = this.db.prepare('PRAGMA table_info(projects)').all() as any[];
          if (!cols.some((c) => c.name === 'planning_panel_size')) {
            this.db.exec(
              "ALTER TABLE projects ADD COLUMN planning_panel_size INTEGER NOT NULL DEFAULT 2 CHECK(planning_panel_size >= 1)"
            );
          }
        }
        this.db.prepare('UPDATE schema_version SET version = 99').run();
      }

      // v100 / A11 (R1.6 + D7/R1.30): per-project agreement round cap for the co-planner planning gate
      // — default 3, mirroring (not reusing) the unenforced topology.yaml deliberation_panel.max_rounds
      // convention so an operator learns one rule. Exhausting the cap is the SAME bounded-exit mechanism
      // as the R1.6 wall-clock timeout (D7: "shares R1.6's mechanism and owning row"), never a silent
      // pass — see PlanningPhaseService.runPlanningPhase's effectiveTimeoutMs (perRoundMs * roundCap).
      if (current && current.version < 100) {
        if (hasTable('projects')) {
          const cols = this.db.prepare('PRAGMA table_info(projects)').all() as any[];
          if (!cols.some((c) => c.name === 'planning_round_cap')) {
            this.db.exec(
              "ALTER TABLE projects ADD COLUMN planning_round_cap INTEGER NOT NULL DEFAULT 3 CHECK(planning_round_cap >= 1)"
            );
          }
        }
        this.db.prepare('UPDATE schema_version SET version = 100').run();
      }

      // v101 / S04 AC1: helm_sessions.owner — decision authority for reaping (helm|human|legacy:unknown).
      // Two-track: fresh SCHEMA_SQL has the column; this upgrades live/pre-existing DBs.
      // Nullable until S07 name/context backfill. Janitor remains off for the whole effort.
      if (current && current.version < 101) {
        if (hasTable('helm_sessions')) {
          const cols = this.db.prepare('PRAGMA table_info(helm_sessions)').all() as any[];
          if (!cols.some((c) => c.name === 'owner')) {
            this.db.exec(
              "ALTER TABLE helm_sessions ADD COLUMN owner TEXT CHECK(owner IS NULL OR owner IN ('helm','human','legacy:unknown'))"
            );
          }
        }
        this.db.prepare('UPDATE schema_version SET version = 101').run();
      }

      // v102 / S07 AC5: one-time fail-safe owner backfill (name + kind context).
      // Only WHERE owner IS NULL; already-set authority is never rewritten. Remainder → legacy:unknown.
      // Uses deriveSessionOwner (single source of truth). Janitor remains off.
      if (current && current.version < 102) {
        if (hasTable('helm_sessions')) {
          const cols = this.db.prepare('PRAGMA table_info(helm_sessions)').all() as any[];
          if (cols.some((c) => c.name === 'owner')) {
            const nullRows = this.db
              .prepare(`SELECT name, kind FROM helm_sessions WHERE owner IS NULL`)
              .all() as Array<{ name: string; kind: string | null }>;
            const setOwner = this.db.prepare(
              `UPDATE helm_sessions SET owner = ? WHERE name = ? AND owner IS NULL`
            );
            for (const row of nullRows) {
              setOwner.run(deriveSessionOwner(row.name, row.kind), row.name);
            }
          }
        }
        this.db.prepare('UPDATE schema_version SET version = 102').run();
      }

      // v103 / S15 AC28+AC31: seed housekeeper house+tiered main grok45 + spark/haiku backups.
      // Idempotent; definition_md + default_model_id only when empty/NULL; escalations INSERT OR IGNORE.
      // Janitor remains off. No new agent-configuration schema.
      if (current && current.version < 103) {
        applyHousekeeperSeed(this.db);
        this.db.prepare('UPDATE schema_version SET version = 103').run();
      }
    }
  }

  get raw(): Database.Database {
    return this.db;
  }

  prepare(sql: string): Database.Statement {
    return this.db.prepare(sql);
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  close(): void {
    this.db.close();
  }
}
