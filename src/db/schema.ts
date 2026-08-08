import type Database from "better-sqlite3";
import { assertAllRoleTiersInvariants } from "./role-tier-invariants.js";
import { PROVIDERS } from "../config/providers.js";

export const SCHEMA_VERSION = 118;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);

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
  seq INTEGER DEFAULT 0,
  ts TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_events_run_ts ON agent_events(run_id, ts);
CREATE INDEX IF NOT EXISTS idx_agent_events_batch_type ON agent_events(run_id, batch_id, type);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_events_terminal_dedupe
  ON agent_events(run_id, batch_id, state, correlation_id)
  WHERE type = 'status' AND state IN ('DONE', 'BLOCKED');

-- B01.s1: append-only substrate for run/batch lifecycle events.
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

-- B01.s3: scope_generation starts at 0 and changes only for redesign, split,
-- or requirements-scope changes; a lineage's initial signature is immutable.
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
  in_development INTEGER NOT NULL DEFAULT 0 CHECK(in_development IN (0,1)),
  agent_type TEXT NOT NULL DEFAULT 'project' CHECK(agent_type IN ('house','project')),
  classification TEXT NOT NULL DEFAULT 'solo' CHECK(classification IN ('solo','tiered','team')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  directory TEXT NOT NULL,
  directory_name TEXT GENERATED ALWAYS AS (
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
    CHECK(directory_name NOT GLOB '*[^A-Za-z0-9_-]*'),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active', 'archived')),
  active INTEGER NOT NULL DEFAULT 1
    CHECK(active IN (0, 1)),
  description TEXT,
  dev_url TEXT,
  qa_url TEXT,
  tags TEXT,
  tmux_session TEXT,
  plancore_session TEXT,
  primary_driver_agent_id INTEGER REFERENCES agents(id),
  autonomy_default TEXT NOT NULL DEFAULT 'pause_after_planning' CHECK(autonomy_default IN ('autonomous_after_discovery', 'pause_after_planning')),
  final_tests_default INTEGER NOT NULL DEFAULT 1 CHECK(final_tests_default IN (0, 1)),
  -- v92: opt-in switch for the adaptive tiered planner (plancore=driver, panel authors, depth-routed).
  -- Default 0 → the existing single-author planning path runs untouched.
  adaptive_planning INTEGER NOT NULL DEFAULT 0 CHECK(adaptive_planning IN (0, 1)),
  -- v93: default effort for adaptive planner panel slots that omit a per-slot effort override.
  planner_default_effort TEXT DEFAULT 'med' CHECK(planner_default_effort IS NULL OR planner_default_effort IN ('low','med','high','xhigh')),
  -- v99 / A10 + S05 AC20: N co-planners excluding plancore (Agent Studio panel member count).
  -- Default 2. Orchestrator converts to A10 total seats via N+1 until S06 ordered seat specs.
  -- Panel save (PlannerPanelService.replaceConfig) sets this to members.length transactionally.
  planning_panel_size INTEGER NOT NULL DEFAULT 2 CHECK(planning_panel_size >= 1),
  -- v100 / A11 (R1.6 + D7): per-project agreement round cap for the co-planner gate, default 3.
  planning_round_cap INTEGER NOT NULL DEFAULT 3 CHECK(planning_round_cap >= 1),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_directory_name ON projects(directory_name);

-- v93: per-project adaptive planner panel (ordered member slots + ordered backups).
-- role=member slots form the active panel (exactly one is_lead=1); role=backup is fallback
-- when a member's CLI is unavailable at spawn. UNIQUE(project_id, role, slot_index).
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
-- At most one lead member per project (partial unique index).
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_planner_panel_one_lead
  ON project_planner_panel(project_id) WHERE role = 'member' AND is_lead = 1;

-- O2.1: native Helm user identities. Exactly one active owner is enforced by
-- the partial index; inactive historical owner rows remain valid.
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

-- B1 (cycle-branch-lifecycle) / v113: 'archived' added to status CHECK (R1.1) + nullable
-- server-owned git identity (R4.2) + awaiting_merge/git_cleanup_pending flags (R6.1). SQLite
-- cannot ALTER a CHECK, so this is the canonical post-rebuild shape; see database.ts v113 for the
-- live-DB table rebuild. awaiting_merge is distinct from awaiting_approval (planning-gate only).
CREATE TABLE IF NOT EXISTS cycles (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  folder_name TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'discovery' CHECK(phase IN ('discovery', 'planning', 'implementation', 'final_tests', 'complete')),
  autonomy TEXT NOT NULL CHECK(autonomy IN ('autonomous_after_discovery', 'pause_after_planning')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('pending', 'active', 'completed', 'archived')),
  awaiting_approval INTEGER NOT NULL DEFAULT 0,
  final_tests_enabled INTEGER NOT NULL DEFAULT 1 CHECK(final_tests_enabled IN (0, 1)),
  git_base_branch TEXT,
  git_branch TEXT,
  git_worktree_path TEXT,
  git_worktree_id TEXT,
  git_merged_at TEXT,
  awaiting_merge INTEGER NOT NULL DEFAULT 0,
  git_cleanup_pending INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, folder_name)
);

-- C2 v13: project_agents (P2). Per-project agent team + model overrides (dynamic from GLOBAL pool / per-proj model_id / agent default) + is_primary_driver (exactly one enforced).
-- Two-track: CREATE IF NOT EXISTS here (fresh DBs) + guarded block in database.ts (upgrades). UNIQUE per (project,agent). model_id nullable. ON DELETE CASCADE on project.
CREATE TABLE IF NOT EXISTS project_agents (
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
  -- B5 / AC-10: optional per-rung effort (NULL = inherit L1/agent default)
  effort TEXT CHECK(effort IS NULL OR effort IN ('low','medium','high','xhigh','max')),
  FOREIGN KEY(project_id, agent_id) REFERENCES project_agents(project_id, agent_id) ON DELETE CASCADE,
  UNIQUE(project_id, agent_id, position)
);
CREATE INDEX IF NOT EXISTS idx_project_agent_escalations_agent ON project_agent_escalations(project_id, agent_id);

-- v114 (cycle-branch-lifecycle B2 / R3.1, R3.3): 'branch-safety' added to the role CHECK on
-- role_bindings, role_defaults, and role_capabilities — a facts-only house role that reports
-- branch/git safety facts and never decides, writes code, panels, or escalates (see
-- applyB2BranchSafetyCapabilitySeed). SQLite cannot ALTER a CHECK, so database.ts v114 rebuilds
-- all three live tables; this is the canonical post-rebuild shape for fresh DBs.
CREATE TABLE IF NOT EXISTS role_bindings (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('discovery', 'plancore', 'ibrain', 'coord', 'implementer', 'validator', 'deliberation', 'red-team', 'planner', 'routine-implementer', 'panelist', 'branch-safety')),
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, role, agent_id)
);

CREATE TABLE IF NOT EXISTS role_defaults (
  role TEXT PRIMARY KEY CHECK(role IN ('discovery', 'plancore', 'ibrain', 'coord', 'implementer', 'validator', 'deliberation', 'red-team', 'planner', 'routine-implementer', 'panelist', 'branch-safety')),
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- B3 (AG2): typed role-capability schema. Stored queryably so Helm/orchestrator can spawn/drive/escalate without hardcoding the 9 roles' contracts.
-- Capabilities derived from the authoritative agents/*.md frontmatter + body (source of truth per brief).
-- JSON for list fields (allowed/terminal/required_artifacts) for simplicity + query via json_extract if needed later.
CREATE TABLE IF NOT EXISTS role_capabilities (
  role TEXT PRIMARY KEY CHECK(role IN ('discovery', 'plancore', 'ibrain', 'coord', 'implementer', 'validator', 'deliberation', 'red-team', 'planner', 'routine-implementer', 'panelist', 'branch-safety')),
  allowed_statuses TEXT NOT NULL,      -- JSON array e.g. ["PROPOSED","WORKING","DONE","BLOCKED"]
  terminal_statuses TEXT NOT NULL,
  can_write_code INTEGER NOT NULL DEFAULT 0,
  requires_repro_first INTEGER NOT NULL DEFAULT 0,
  panel_participant INTEGER NOT NULL DEFAULT 0,
  can_escalate INTEGER NOT NULL DEFAULT 0,
  session_policy TEXT NOT NULL DEFAULT 'fresh',  -- 'fresh' | 'clear+rehydrate'
  required_artifacts TEXT,                       -- JSON array e.g. ["changes.md"]
  timeout_ms INTEGER,
  checkin_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
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

CREATE TABLE IF NOT EXISTS master_runtimes (
  project_id INTEGER PRIMARY KEY,
  master_run_id TEXT NOT NULL,
  tmux_session TEXT NOT NULL,
  tmux_pane TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('launching','running','parked','failed','closed')),
  core_sha TEXT,
  overlay_sha TEXT,
  toolkits_sha TEXT,
  intentional_park_until TEXT,
  last_launched_at TEXT,
  closed_reason TEXT,
  role TEXT,
  -- B-ISO1 (2026-07-16 cheat-isolation): JSON array of THIS run's opt-in strict READ allowlist,
  -- or NULL for the default read-all profile. Persisted at launch so a supervisor respawn / model
  -- swap can re-read + re-apply the same strict fence (the fence must survive recovery, not silently
  -- revert to read-all mid-run). NULL/absent => non-strict (byte-identical default).
  strict_read_allow TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

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
CREATE UNIQUE INDEX IF NOT EXISTS idx_master_switches_corr ON master_switches(correlation);
CREATE INDEX IF NOT EXISTS idx_master_switches_proj ON master_switches(project_id);

-- B1 v17 (ST1/ST2/ST3/MIG1): durable orchestration state (per notes-for-B1).
-- runs + run_tasks + task_attempts + dispatches + callbacks (with acked_at + source) + validations + artifacts.
-- run_id col added to worker_runtimes for run-scoped runtime relation (ST3; master_runtimes left untouched as project singleton).
-- Two-track: CREATE IF NOT EXISTS here (fresh) + guarded block in database.ts (upgrades). Verified on live v16 copy.
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  cycle_id INTEGER REFERENCES cycles(id),
  batch_id TEXT,
  north_star_ref TEXT,
  -- v91: 'paused' added. A run that HALTS awaiting an operator action it can recover from — missing
  -- final-test config, or a grok seat that lost auth (JROM's 6h-relogin rule) — is NOT 'failed'. It is
  -- paused+resumable. Keeping it 'failed' contradicted the run's own completion-summary and false-alarmed
  -- any status-keyed monitoring. 'paused' is terminal-for-now but explicitly resumable (never auto-resumed).
  status TEXT NOT NULL CHECK(status IN ('pending','active','complete','failed','paused')) DEFAULT 'active',
  phase TEXT NOT NULL DEFAULT 'planning',  -- interview (D-b north-star Q&A in CC before planning), planning, executing, complete/failed/blocked/paused
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  external_run_id TEXT,
  generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0),
  source TEXT NOT NULL DEFAULT 'native' CHECK(source IN ('native', 'ingest')),
  state_revision INTEGER NOT NULL DEFAULT 0 CHECK(state_revision >= 0),
  register_seal_hash TEXT,
  terminal_seal_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_cycle ON runs(cycle_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_project_external_generation
  ON runs(project_id, external_run_id, generation)
  WHERE project_id IS NOT NULL AND external_run_id IS NOT NULL;

-- S08 v111: durable Discovery→Planning handoff / CAS repository.
-- Raw one-use credential is NEVER stored — only credential_hash (sha256 hex).
-- One live handoff per cycle: state IN (pending, starting) via partial unique index.
CREATE TABLE IF NOT EXISTS discovery_handoffs (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  cycle_id INTEGER NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
  chat_session_id TEXT,
  agent_id INTEGER REFERENCES agents(id),
  credential_hash TEXT NOT NULL,
  credential_consumed_at TEXT,
  callback_role TEXT,
  callback_status TEXT,
  state TEXT NOT NULL CHECK(state IN (
    'pending', 'declined', 'starting', 'started', 'quarantined', 'failed'
  )),
  manifest_json TEXT,
  manifest_digest TEXT,
  planning_run_id INTEGER REFERENCES runs(id),
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_discovery_handoffs_cycle ON discovery_handoffs(cycle_id);
CREATE INDEX IF NOT EXISTS idx_discovery_handoffs_project ON discovery_handoffs(project_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_discovery_handoffs_one_live
  ON discovery_handoffs(cycle_id)
  WHERE state IN ('pending', 'starting');

-- S13 v112: durable Planning agreement provenance (cycle-linked).
-- Written only on whole-plan agreement; Start Implementation rechecks run id + digest + plan SHA.
CREATE TABLE IF NOT EXISTS planning_provenance (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  cycle_id INTEGER NOT NULL UNIQUE REFERENCES cycles(id) ON DELETE CASCADE,
  planning_run_id INTEGER NOT NULL REFERENCES runs(id),
  manifest_digest TEXT NOT NULL,
  plan_sha256 TEXT NOT NULL,
  agreed_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_planning_provenance_project ON planning_provenance(project_id);
CREATE INDEX IF NOT EXISTS idx_planning_provenance_run ON planning_provenance(planning_run_id);

-- O5.1: immutable deduplication receipts for sealed run-ingest transitions.
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

CREATE TABLE IF NOT EXISTS run_tasks (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_key TEXT,
  label TEXT NOT NULL,
  -- Leg D (batch barrier): first-class durable normalized batch label. The resolved trimmed batch from
  -- the shared execution-plan validator (all-labeled plans) or the synthetic 'default' batch (legacy
  -- all-unlabeled plans). Governs dispatch ordering (queue admission barrier), the deploy gate, and
  -- pending-after-drain classification. Two-track: here for fresh DBs + guarded ALTER in database.ts
  -- (upgrades). Legacy rows keep NULL (resolved to 'default' at read time).
  batch TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending','working','complete','failed','deferred')) DEFAULT 'pending',
  attempts_count INTEGER NOT NULL DEFAULT 0,
  current_attempt_id INTEGER,
  -- v118 / fence-workflow-upgrade R1 (R5.1, R5.5): current repair admission marker.
  -- Staged repair never overloads status='deferred'; these nullable fields identify
  -- the repair round/generation while the task keeps its ordinary status until the
  -- later atomic reopen slice moves it back to pending.
  reopen_reason TEXT CHECK(reopen_reason IS NULL OR reopen_reason = 'repair'),
  repair_generation INTEGER NOT NULL DEFAULT 0 CHECK(repair_generation >= 0),
  repair_round_id INTEGER REFERENCES fence_repair_rounds(id) ON DELETE SET NULL,
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
  defect_class TEXT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  validator_brief_ref TEXT
);
CREATE INDEX IF NOT EXISTS idx_validations_attempt ON validations(attempt_id);

CREATE TABLE IF NOT EXISTS artifacts (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id INTEGER REFERENCES run_tasks(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  path TEXT NOT NULL,
  sha TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(task_id);

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
  run_id INTEGER REFERENCES runs(id),
  exit_reason TEXT,
  started_at TEXT,
  ended_at TEXT,
  ts TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_worker_runtimes_proj_state ON worker_runtimes(project_id, state);
CREATE INDEX IF NOT EXISTS idx_worker_runtimes_run ON worker_runtimes(run_id);

-- SL-R1 v58 (session-lifecycle): registry of EVERY tmux session Helm creates via the single
-- TmuxService.createSession choke point (RealTransport, WorkerService, MasterRuntimeService,
-- ChatSessionService, ModelValidationService). One row per session name (last-wins upsert).
-- kind derived from the name (helm-<batch>-<role>-* → role;
-- helm-*-test → 'test'; else 'other'). status active→idle→reaped. The janitor (SL-R3) only ever
-- acts on rows in THIS table AND matching the helm- prefix (SL-R4 safety contract).
CREATE TABLE IF NOT EXISTS helm_sessions (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  kind TEXT,
  project_id INTEGER,
  run_id INTEGER,
  -- S04 / AC1: binary decision authority (+ closed legacy sentinel). S07 backfilled historical nulls;
  -- B15 / AC20: NOT NULL — every row now carries decision authority at insert time (fail-closed create).
  owner TEXT NOT NULL CHECK(owner IN ('helm','human','legacy:unknown')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','idle','reaped')),
  -- B01 / D01 / AC4: lifecycle nonce allocated from lifecycle_seq on every insert and every
  -- upsert-conflict branch of register(). Discriminates a freshly re-registered row from a stale
  -- snapshot of the same name, which the row id alone cannot (the upsert retains row id).
  generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  ended_at TEXT,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_helm_sessions_status ON helm_sessions(status);
CREATE INDEX IF NOT EXISTS idx_helm_sessions_run ON helm_sessions(run_id);

-- B01 / D01: one durable, monotonic, never-reset sequence shared by runs.generation and
-- helm_sessions.generation. A cascading DELETE of either table never touches this row, so a
-- recycled runs.id or a re-registered helm_sessions.name can never be handed a generation that
-- collides with the lifecycle it replaced.
CREATE TABLE IF NOT EXISTS lifecycle_seq (
  name TEXT PRIMARY KEY,
  next INTEGER NOT NULL
);
INSERT INTO lifecycle_seq (name, next) VALUES ('global', 1) ON CONFLICT(name) DO NOTHING;

-- v104 / S18a + v105 / S18b: durable housekeeper investigation dispatch/apply evidence.
-- v107 / B11: session CAS token frozen at dispatch (id already via helm_session_id + session_name + owner).
CREATE TABLE IF NOT EXISTS housekeeper_investigations (
  id INTEGER PRIMARY KEY,
  helm_session_id INTEGER REFERENCES helm_sessions(id) ON DELETE SET NULL,
  session_name TEXT NOT NULL,
  owner TEXT NOT NULL CHECK(owner = 'helm'),
  -- B11 / AC16: expectedStatus + generation captured at investigation open; apply must not re-fetch by name.
  session_status TEXT NOT NULL DEFAULT 'active' CHECK(session_status IN ('active','idle','reaped')),
  session_generation INTEGER NOT NULL DEFAULT 0 CHECK(session_generation >= 0),
  status TEXT NOT NULL CHECK(status IN ('no_dispatch','dispatching','dispatched','applied_done','needs_human','apply_rejected')) DEFAULT 'dispatching',
  trigger_reason TEXT NOT NULL,
  state_signature TEXT,
  observation_json TEXT NOT NULL,
  pane_tail TEXT NOT NULL,
  pane_tail_provenance TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  usage_json TEXT NOT NULL,
  selected_provider TEXT,
  selected_model TEXT,
  selected_slug TEXT,
  selected_rung_index INTEGER,
  selected_reason TEXT,
  dispatch_handle TEXT,
  dispatched_at TEXT,
  callback_verdict TEXT CHECK(callback_verdict IS NULL OR callback_verdict IN ('done','needs-human')),
  callback_evidence TEXT,
  callback_rationale TEXT,
  applied_at TEXT,
  apply_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_housekeeper_investigations_session ON housekeeper_investigations(session_name, created_at);
CREATE INDEX IF NOT EXISTS idx_housekeeper_investigations_status ON housekeeper_investigations(status);

-- B3a v11 (consensus §5): 3 additive tables for watcher-of-watchers substrate (plumbing only; no worker watcher table in v1).
-- plumbing_configs: per-project/role (for coord/plancore/ibrain) with bounded self + JROM override.
-- coordinator_watch_states: live row per coordinator (from master_runtimes).
-- plumbing_checkpoint_log: append-only for Context Steward safe-boundary detection (v1: log only).
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

CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('claude','codex','grok','kloo')),
  model_id TEXT NOT NULL,
  -- B03a (c01 R1.2–R1.3): CLI is required (I1); slug is Helm-canonical unique id; display_name is UI label.
  cli TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
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

-- B1 (teams): teams + team_members for deliberation/red-team + generic rosters (ordered by position).
-- Two-track CREATE IF + seeds in apply + mig. model_id resolved by name at seed time.
CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL CHECK(type IN('deliberation','red-team','generic')),
  consensus_rule TEXT,
  protocol_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS team_members (
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
CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members(team_id);

-- B2: role->team binding contract (lower-risk separate table, see changes.md).
-- Keeps role_bindings 100% agent-only (agent_id NOT NULL + ON DELETE RESTRICT stays untouched).
-- deliberation/red-team can bind to a team_id without ever touching agent FK delete-409 path.
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

-- B8a / AC-12: opt-in per-project role roster override (deliberation|red-team).
-- Presence of ≥1 row for (project_id, role) = override ACTIVE; absence = inherit Studio team
-- (role_team_bindings → team_members) — today's resolveProjectRole path unchanged.
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

-- B3 (ESC1): agent_escalations per escalation-ladders-spec.md (table + seed only; walking logic is B8).
-- agent_id + position (rung 1/2); model_id FK; base rung0 lives in agents.default_model_id.
-- UNIQUE(agent_id, position). ON DELETE CASCADE from agent.
CREATE TABLE IF NOT EXISTS agent_escalations (
  id INTEGER PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,                 -- 1 = first escalation, 2 = second
  model_id INTEGER NOT NULL REFERENCES models(id),
  trigger TEXT NOT NULL DEFAULT 'on-fail',   -- on-fail | plan-summon | ibrain
  -- B5 / AC-10: optional per-rung effort (NULL = inherit L1/agent default)
  effort TEXT CHECK(effort IS NULL OR effort IN ('low','medium','high','xhigh','max')),
  UNIQUE(agent_id, position)
);

-- B12a (c01 R3.12): studio role×tier bindings (implementer/validator × L1/L2/L3 × primary+backup).
-- Studio-level source of truth for topology freezes / B12b seeds / B12c UI.
-- B12b seeds topology intent via applyB12bRoleTierSeeds (fresh + v67 mig).
-- B13 / R3.16 save-time invariants enforced in RoleTierService + post-seed reval (role-tier-invariants.ts).
-- Does not replace B08 per-agent tier bind (agent_escalations).
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

-- B16 (c01 R4.18–R4.19): studio team×tier model lists (deliberation|red-team × budget|standard|elite).
-- Ordered roster per (team_type, tier); B17 seeds topology intent via applyB17TeamTierSeeds.
-- Flat teams/team_members (B1) left untouched. Does not stamp topology or resolve at cycle start (B18/B19).
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

-- B18 (c01 R5.20–R5.21): sparse project overrides for Studio role/team tiers.
-- Row presence = project override; absence = inherit Studio. Cycle inherits project effective (no cycle tier store; freeze = B19).
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

-- B19 (c01 R5.22): frozen cycle-start snapshot of the project-effective topology (Studio→Project
-- composed role_tiers + team_tiers). UNIQUE(cycle_id) = writer exclusivity (a second freeze attempt
-- for the same cycle fails at the DB layer). Triggers below = immutability (no UPDATE/DELETE, ever).
-- Written exactly once, by TopologyFreezeService.freezeForCycle, at the single cycle-start call site
-- in CycleService (setCyclePhase→implementation and approveCycle). Studio/Project edits after freeze
-- do not reach a running cycle (R5.22 proof).
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

-- B19-fix1: single-row flag table backing DatabaseService.withCascadeDeleteAllowed (deleteProject).
-- Row present = an intentional cascade cleanup is in flight; absent (the steady state) = any delete
-- on cycle_topology_freezes is direct/explicit and must be blocked. Must be a real table, not TEMP —
-- SQLite triggers cannot reference objects in another (e.g. temp) database.
CREATE TABLE IF NOT EXISTS _cascade_delete_allow (v INTEGER);

-- B19-fix1: WHEN guard lets an admin cascade cleanup (DatabaseService.withCascadeDeleteAllowed,
-- used by deleteProject) through, while still blocking any direct/explicit delete attempted outside
-- that wrapper.
CREATE TRIGGER IF NOT EXISTS trg_cycle_topology_freezes_no_delete
BEFORE DELETE ON cycle_topology_freezes
WHEN NOT EXISTS (SELECT 1 FROM _cascade_delete_allow)
BEGIN
  SELECT RAISE(ABORT, 'topology freeze is immutable');
END;

-- B20 (c01 R5.23): intended vs actual team deltas. topology freeze = intended; resolve stamps =
-- actual. Every actual≠intended row MUST carry a structural reason (NOT NULL + CHECK). Multi-cause
-- via ordered (resolve_id, seq). AS_INTENDED is not a delta reason (happy path has no row).
-- B20-fix1: SEAT_CHANGED covers post-freeze seat re-point (cause=AS_INTENDED but slug/tier differs).
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

-- D3 v15 (C3r): app-owned tasks table for per-project tasklist (completed/working/pending) + coordinator-updated via ingest.
-- task_key for idempotent upserts by coordinators (e.g. plan items). position for ordering. FK cascade on project delete.
-- Two-track: here for fresh DBs + guarded block in database.ts for upgrades. Verified v14->v15 (and v8 base) on live copy.
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

-- E1 v16 (M1 + M2-backend): memories table (app + per-project scopes).
-- Each memory: title + description + type (user|feedback|project|reference default) + body.
-- status proposed/approved (agent via token proposes app-global as 'proposed'; JROM owner creates app as 'approved' directly; any project-scope create = 'approved' immediately; no approval gate for project).
-- queryMemory (JIT for agents): returns *only* approved app (project_id IS NULL) + this project's approved (cross-project reads allowed via owner list for reference; writes siloed by claim).
-- Two-track: CREATE IF NOT EXISTS here for fresh DBs + guarded block in database.ts for upgrades. Index on (scope, project_id, status).
CREATE TABLE IF NOT EXISTS memories (
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
CREATE INDEX IF NOT EXISTS idx_memories_scope_proj_status ON memories(scope, project_id, status);
CREATE INDEX IF NOT EXISTS idx_memories_scope_agent_status ON memories(scope, agent_id, status);
CREATE INDEX IF NOT EXISTS idx_memories_horizon ON memories(horizon, scope, status);

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

CREATE TABLE IF NOT EXISTS agent_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  chat_session_id TEXT,
  proposed_definition_md TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

-- A3: routing_rules — externalizes OrchestratorLoop's currently-hardcoded routing FSM into data.
-- Data-model batch only: this table is inert until A4 makes OrchestratorLoop consult it (NOT touched here).
-- Seeded VERBATIM from today's hardcoded transitions (see seedRoutingRules); is_core=1 marks the 9
-- protected core transitions so validateConfig() can flag an accidental gap.
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

-- v109 / E8 FIX2 (R-cycle-session-continuity): durable, resumable PROVIDER conversation id per chat
-- session identity (project, agent, cycle). ChatSessionService's live session bookkeeping is an
-- in-memory Map that a server restart erases entirely; this table survives so a reopened chat can
-- \`--resume <uuid>\` the same provider-side conversation instead of cold-spawning and re-prompting.
-- cycle_id uses a 0 sentinel (not NULL) for "no active cycle" so the UNIQUE constraint below actually
-- de-dupes that case (SQLite treats distinct NULLs as non-equal for UNIQUE).
CREATE TABLE IF NOT EXISTS chat_session_identities (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL,
  agent_id INTEGER NOT NULL,
  cycle_id INTEGER NOT NULL DEFAULT 0,
  provider TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, agent_id, cycle_id)
);

-- v116 / fence-workflow-upgrade A1 (R1.1, R1.2, R1.4): durable per-fence object + membership.
-- Crash-legible lifecycle_state (plan-preamble §8.1): declared → opening → draining → closing →
-- repairing → closed, plus terminal plan_blocked. Contract fields mirror fence-contract.json;
-- OPEN baseline columns (open_failed_ids, open_test_hash, open_at) stay NULL until OPEN commits.
-- Two-track: here for fresh DBs + guarded CREATE IF NOT EXISTS in database.ts for upgrades.
CREATE TABLE IF NOT EXISTS fences (
  id INTEGER PRIMARY KEY,
  fence_key TEXT NOT NULL,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  cycle_id INTEGER REFERENCES cycles(id) ON DELETE SET NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'declared' CHECK(
    lifecycle_state IN (
      'declared',
      'opening',
      'draining',
      'closing',
      'repairing',
      'closed',
      'plan_blocked'
    )
  ),
  integration_cmd TEXT NOT NULL,
  negative_control_cmd TEXT NOT NULL,
  acceptance_ids TEXT NOT NULL DEFAULT '[]',
  test_path TEXT,
  authored_by TEXT,
  label TEXT,
  open_failed_ids TEXT,
  open_test_hash TEXT,
  open_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(run_id, fence_key)
);
CREATE INDEX IF NOT EXISTS idx_fences_run_state ON fences(run_id, lifecycle_state);
CREATE INDEX IF NOT EXISTS idx_fences_fence_key ON fences(fence_key);

CREATE TABLE IF NOT EXISTS fence_members (
  id INTEGER PRIMARY KEY,
  fence_id INTEGER NOT NULL REFERENCES fences(id) ON DELETE CASCADE,
  task_key TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(fence_id, task_key)
);
CREATE INDEX IF NOT EXISTS idx_fence_members_fence ON fence_members(fence_id);
CREATE INDEX IF NOT EXISTS idx_fence_members_task_key ON fence_members(task_key);

-- v117 / fence-workflow-upgrade A4 (R1.6, R9.1, R9.3, R9.4): persist integration_test_agent
-- authoring / composition-judgment session identity per fence (verifier≠fixer by session).
CREATE TABLE IF NOT EXISTS fence_authoring_sessions (
  id INTEGER PRIMARY KEY,
  fence_id INTEGER NOT NULL REFERENCES fences(id) ON DELETE CASCADE,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  fence_key TEXT NOT NULL,
  role TEXT NOT NULL,
  model TEXT NOT NULL,
  session_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('plan_time_author', 'composition_judgment')),
  test_path TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(fence_id, purpose)
);
CREATE INDEX IF NOT EXISTS idx_fence_authoring_sessions_run
  ON fence_authoring_sessions(run_id, fence_key);
CREATE INDEX IF NOT EXISTS idx_fence_authoring_sessions_session
  ON fence_authoring_sessions(session_id);

-- v118 / fence-workflow-upgrade R1 (R5.1, R5.5): append-only staged repair history.
-- A repair round localizes an implementation-class fence failure to one or two named
-- fence member units. fence_repair_units snapshots each task's status before later
-- slices reopen/requeue it; the history itself is immutable after insert.
CREATE TABLE IF NOT EXISTS fence_repair_rounds (
  id INTEGER PRIMARY KEY,
  fence_id INTEGER NOT NULL REFERENCES fences(id) ON DELETE CASCADE,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  fence_key TEXT NOT NULL,
  round_number INTEGER NOT NULL CHECK(round_number >= 1),
  fault_class TEXT NOT NULL CHECK(fault_class = 'implementation'),
  status TEXT NOT NULL DEFAULT 'staged' CHECK(status IN ('staged','active','closed','plan_blocked')),
  failing_units TEXT NOT NULL DEFAULT '[]',
  verdict_fingerprint TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(fence_id, round_number)
);
CREATE INDEX IF NOT EXISTS idx_fence_repair_rounds_run
  ON fence_repair_rounds(run_id, fence_key, round_number);
CREATE TRIGGER IF NOT EXISTS fence_repair_rounds_no_update
BEFORE UPDATE ON fence_repair_rounds
BEGIN
  SELECT RAISE(ABORT, 'fence repair rounds are append-only');
END;
CREATE TRIGGER IF NOT EXISTS fence_repair_rounds_no_delete
BEFORE DELETE ON fence_repair_rounds
BEGIN
  SELECT RAISE(ABORT, 'fence repair rounds are append-only');
END;

CREATE TABLE IF NOT EXISTS fence_repair_units (
  id INTEGER PRIMARY KEY,
  repair_round_id INTEGER NOT NULL REFERENCES fence_repair_rounds(id) ON DELETE CASCADE,
  fence_id INTEGER NOT NULL REFERENCES fences(id) ON DELETE CASCADE,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  run_task_id INTEGER NOT NULL REFERENCES run_tasks(id) ON DELETE CASCADE,
  task_key TEXT NOT NULL,
  repair_generation INTEGER NOT NULL CHECK(repair_generation >= 1),
  prior_status TEXT NOT NULL CHECK(prior_status IN ('pending','working','complete','failed','deferred')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(repair_round_id, task_key)
);
CREATE INDEX IF NOT EXISTS idx_fence_repair_units_task
  ON fence_repair_units(run_task_id, repair_generation);
CREATE TRIGGER IF NOT EXISTS fence_repair_units_no_update
BEFORE UPDATE ON fence_repair_units
BEGIN
  SELECT RAISE(ABORT, 'fence repair units are append-only');
END;
CREATE TRIGGER IF NOT EXISTS fence_repair_units_no_delete
BEFORE DELETE ON fence_repair_units
BEGIN
  SELECT RAISE(ABORT, 'fence repair units are append-only');
END;
`;

/** B03a: slugify a model name for Helm-canonical slug backfill (not the B04 registry map). */
export function slugifyModelName(name: string): string {
  const s = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'model';
}

/**
 * B04 + Q-13 (c01 R1.4): the Helm-canonical registry models.
 * Each row is cli → provider → model_id + slug + display_name.
 * codex54min model_id is B01-verified gpt-5.4-mini (see validation/q02-codex54min.md).
 */
export type B04CanonicalModelSeed = {
  slug: string;
  display_name: string;
  /** UNIQUE models.name (defaults to slug when omitted). */
  name?: string;
  cli: 'claude' | 'codex' | 'grok' | 'kloo';
  provider: 'claude' | 'codex' | 'grok' | 'kloo';
  model_id: string;
  effort?: string;
  approval?: string;
  flags?: string | null;
  approval_policy?: string | null;
  sandbox_mode?: string | null;
  permission_mode?: string | null;
  bypass?: number;
  route?: string | null;
};

export const B04_CANONICAL_MODEL_SEEDS: readonly B04CanonicalModelSeed[] = [
  {
    slug: 'opus5',
    display_name: 'Opus 5',
    cli: 'claude',
    provider: 'claude',
    model_id: 'claude-opus-5',
    effort: 'high',
    approval: 'bypassPermissions',
    flags: '--permission-mode bypassPermissions --dangerously-skip-permissions',
    approval_policy: 'bypassPermissions',
    permission_mode: 'bypassPermissions',
    bypass: 1,
  },
  {
    slug: 'sonnet5',
    display_name: 'Sonnet 5',
    cli: 'claude',
    provider: 'claude',
    model_id: 'claude-sonnet-5',
    effort: 'medium',
    approval: 'auto',
    flags: null,
    approval_policy: 'auto',
    bypass: 0,
  },
  {
    slug: 'haiku',
    display_name: 'Haiku',
    cli: 'claude',
    provider: 'claude',
    model_id: 'claude-haiku-4-5',
    effort: 'low',
    approval: 'auto',
    flags: null,
    approval_policy: 'auto',
    bypass: 0,
  },
  {
    slug: 'codex55',
    display_name: 'Codex 5.5',
    cli: 'codex',
    provider: 'codex',
    model_id: 'gpt-5.5',
    effort: 'medium',
    approval: 'bypass-sandbox',
    flags: '--dangerously-bypass-approvals-and-sandbox',
    approval_policy: 'bypass',
    bypass: 1,
  },
  {
    slug: 'codex56sol',
    display_name: 'Codex 5.6 Sol',
    cli: 'codex',
    provider: 'codex',
    model_id: 'gpt-5.6-sol',
    effort: 'high',
    approval: 'bypass-sandbox',
    flags: '--dangerously-bypass-approvals-and-sandbox',
    approval_policy: 'bypass',
    bypass: 1,
  },
  {
    slug: 'codex56terra',
    display_name: 'Codex 5.6 Terra',
    cli: 'codex',
    provider: 'codex',
    model_id: 'gpt-5.6-terra',
    effort: 'medium',
    approval: 'on-request',
    flags: null,
    approval_policy: 'on-request',
    sandbox_mode: 'workspace-write',
    bypass: 0,
  },
  {
    slug: 'codex56luna',
    display_name: 'Codex 5.6 Luna',
    cli: 'codex',
    provider: 'codex',
    model_id: 'gpt-5.6-luna',
    effort: 'low',
    approval: 'auto',
    flags: null,
    approval_policy: 'auto',
    sandbox_mode: 'read-only',
    bypass: 0,
  },
  {
    slug: 'codex54',
    display_name: 'Codex 5.4',
    cli: 'codex',
    provider: 'codex',
    model_id: 'gpt-5.4',
    effort: 'medium',
    approval: 'on-request',
    flags: null,
    approval_policy: 'on-request',
    sandbox_mode: 'workspace-write',
    bypass: 0,
  },
  {
    // B01 VERDICT EXISTS: CLI id is gpt-5.4-mini (not inventing; not the absent codex54min CLI slug).
    slug: 'codex54min',
    display_name: 'Codex 5.4 Mini',
    cli: 'codex',
    provider: 'codex',
    model_id: 'gpt-5.4-mini',
    effort: 'low',
    approval: 'auto',
    flags: null,
    approval_policy: 'auto',
    sandbox_mode: 'read-only',
    bypass: 0,
  },
  {
    slug: 'spark',
    display_name: 'Spark',
    // name matches pre-B3 seed row so upsert reuses it (no duplicate spark).
    name: 'spark',
    cli: 'codex',
    provider: 'codex',
    model_id: 'gpt-5.3-codex-spark',
    effort: 'dynamic',
    approval: 'bypass',
    flags: '--dangerously-bypass-approvals-and-sandbox',
    approval_policy: 'bypass',
    bypass: 1,
  },
  {
    slug: 'grok45',
    display_name: 'Grok 4.5',
    cli: 'grok',
    provider: 'grok',
    model_id: 'grok-4.5',
    effort: 'medium',
    approval: 'always-approve',
    flags: '--always-approve',
    approval_policy: 'always-approve',
    bypass: 1,
  },
  {
    slug: 'grokcompose',
    display_name: 'Grok Compose',
    cli: 'grok',
    provider: 'grok',
    model_id: 'grok-composer-2.5-fast',
    effort: 'low',
    approval: 'auto',
    flags: null,
    approval_policy: 'auto',
    bypass: 0,
  },
  {
    // kloo launch: kloo --provider <route> --model <model>; verified openrouter/deepseek-v4-flash path.
    slug: 'deepseek-v4-flash',
    display_name: 'DeepSeek V4 Flash',
    cli: 'kloo',
    provider: 'kloo',
    model_id: 'deepseek-v4-flash',
    effort: 'low',
    approval: 'auto',
    flags: null,
    approval_policy: 'auto',
    route: 'openrouter',
    bypass: 0,
  },
] as const;

export const B04_CANONICAL_SLUGS: readonly string[] = B04_CANONICAL_MODEL_SEEDS.map((s) => s.slug);

/**
 * B12b / R3.12: default studio role_tiers from topology intent (c01 topology.yaml).
 * Slugs are B04-canonical. Validator backups null (plan: validator seats backup-less).
 * opus never implements (no implementer primary/backup is opus5).
 */
export type B12bRoleTierSeed = {
  role: 'implementer' | 'validator';
  tier: 'L1' | 'L2' | 'L3';
  primary_slug: string;
  /** null = no backup (validator seats; optional backup_less). */
  backup_slug: string | null;
};

export const B12B_ROLE_TIER_SEEDS: readonly B12bRoleTierSeed[] = [
  // implementer — topology.yaml implementer.L1/L2/L3 primary+backup
  { role: 'implementer', tier: 'L1', primary_slug: 'grokcompose', backup_slug: 'spark' },
  { role: 'implementer', tier: 'L2', primary_slug: 'grok45', backup_slug: 'haiku' },
  { role: 'implementer', tier: 'L3', primary_slug: 'codex55', backup_slug: 'sonnet5' },
  // validator — topology.yaml validator.L1/L2/L3 primary only (backup-less)
  { role: 'validator', tier: 'L1', primary_slug: 'grok45', backup_slug: null },
  { role: 'validator', tier: 'L2', primary_slug: 'sonnet5', backup_slug: null },
  { role: 'validator', tier: 'L3', primary_slug: 'opus5', backup_slug: null },
] as const;

/**
 * B12b: seed role_tiers from topology intent using B04 model slugs (idempotent upsert).
 * Requires role_tiers + models.slug. Skips a row if primary slug is missing (partial synthetic DBs).
 * Missing backup slug → null backup. Re-run restores seed primary/backup (no dupes).
 * B13 / R3.16: after apply, re-validate all rows fail-closed (opus never implements; backup≠same-tier val).
 */
export function applyB12bRoleTierSeeds(db: Database.Database): void {
  const hasRoleTiers = !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='role_tiers'")
    .get();
  if (!hasRoleTiers) return;
  const hasModels = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='models'").get();
  if (!hasModels) return;
  const mcols = new Set((db.prepare('PRAGMA table_info(models)').all() as any[]).map((c) => c.name));
  if (!mcols.has('slug')) return;

  const idBySlug = (slug: string): number | null => {
    const row = db.prepare('SELECT id FROM models WHERE slug = ?').get(slug) as { id: number } | undefined;
    return row?.id ?? null;
  };

  for (const s of B12B_ROLE_TIER_SEEDS) {
    const primaryId = idBySlug(s.primary_slug);
    if (primaryId == null) continue; // hard dep B04 incomplete on this DB — skip row
    const backupId = s.backup_slug != null ? idBySlug(s.backup_slug) : null;
    // If backup slug was declared but missing, leave backup null rather than failing the seed.

    const existing = db
      .prepare('SELECT id FROM role_tiers WHERE role = ? AND tier = ?')
      .get(s.role, s.tier) as { id: number } | undefined;

    if (existing) {
      db.prepare(
        `UPDATE role_tiers SET primary_model_id = ?, backup_model_id = ?, updated_at = datetime('now')
         WHERE role = ? AND tier = ?`
      ).run(primaryId, backupId, s.role, s.tier);
    } else {
      db.prepare(
        `INSERT INTO role_tiers (role, tier, primary_model_id, backup_model_id)
         VALUES (?, ?, ?, ?)`
      ).run(s.role, s.tier, primaryId, backupId);
    }
  }

  // B13: re-validate seeded rows fail-closed (seeds must satisfy R3.16).
  // Only when every seed primary resolved (full topology set present) — partial synthetic DBs skip reval.
  const allPrimariesPresent = B12B_ROLE_TIER_SEEDS.every((s) => idBySlug(s.primary_slug) != null);
  if (allPrimariesPresent) {
    assertAllRoleTiersInvariants(db);
  }
}

/**
 * B17 / R4.18–R4.19: default studio team_tiers from topology intent (c01 topology.yaml).
 * Slugs are B04-canonical. Red-team tiers match topology redteam_panel.tiers stamped roster.
 * Deliberation: topology lists panelists only (no per-tier); standard = panelists; budget = cheaper; elite = fuller.
 */
export type B17TeamTierSeed = {
  team_type: 'deliberation' | 'red-team';
  tier: 'budget' | 'standard' | 'elite';
  /** Ordered B04 model slugs. */
  model_slugs: readonly string[];
};

export const B17_TEAM_TIER_SEEDS: readonly B17TeamTierSeed[] = [
  // red-team — topology.yaml redteam_panel.tiers (sonnet→sonnet5, opus→opus5)
  { team_type: 'red-team', tier: 'budget', model_slugs: ['spark', 'sonnet5', 'haiku'] },
  { team_type: 'red-team', tier: 'standard', model_slugs: ['sonnet5', 'grok45', 'spark'] },
  {
    team_type: 'red-team',
    tier: 'elite',
    model_slugs: ['opus5', 'sonnet5', 'grok45', 'grokcompose', 'spark', 'haiku'],
  },
  // deliberation — topology panelists as standard; budget cheaper; elite fuller
  { team_type: 'deliberation', tier: 'budget', model_slugs: ['sonnet5', 'haiku', 'spark'] },
  { team_type: 'deliberation', tier: 'standard', model_slugs: ['opus5', 'grok45', 'sonnet5'] },
  {
    team_type: 'deliberation',
    tier: 'elite',
    model_slugs: ['opus5', 'sonnet5', 'grok45', 'grokcompose', 'spark', 'haiku'],
  },
] as const;

/**
 * B17: seed team_tiers + ordered team_tier_models from topology intent (idempotent upsert).
 * Requires team_tiers + team_tier_models + models.slug. Skips a tier if any slug is missing.
 * Re-run restores seed rosters (full replace of models for each seeded tier).
 */
export function applyB17TeamTierSeeds(db: Database.Database): void {
  const hasTiers = !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='team_tiers'")
    .get();
  const hasModelsTbl = !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='team_tier_models'")
    .get();
  if (!hasTiers || !hasModelsTbl) return;
  const hasModels = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='models'").get();
  if (!hasModels) return;
  const mcols = new Set((db.prepare('PRAGMA table_info(models)').all() as any[]).map((c) => c.name));
  if (!mcols.has('slug')) return;

  const idBySlug = (slug: string): number | null => {
    const row = db.prepare('SELECT id FROM models WHERE slug = ?').get(slug) as { id: number } | undefined;
    return row?.id ?? null;
  };

  for (const s of B17_TEAM_TIER_SEEDS) {
    const ids: number[] = [];
    let missing = false;
    for (const slug of s.model_slugs) {
      const id = idBySlug(slug);
      if (id == null) {
        missing = true;
        break;
      }
      ids.push(id);
    }
    if (missing) continue; // hard dep B04 incomplete — skip tier

    const existing = db
      .prepare('SELECT id FROM team_tiers WHERE team_type = ? AND tier = ?')
      .get(s.team_type, s.tier) as { id: number } | undefined;

    const apply = db.transaction(() => {
      if (!existing) {
        db.prepare('INSERT INTO team_tiers (team_type, tier) VALUES (?, ?)').run(s.team_type, s.tier);
      } else {
        db.prepare(
          `UPDATE team_tiers SET updated_at = datetime('now') WHERE team_type = ? AND tier = ?`
        ).run(s.team_type, s.tier);
      }
      db.prepare('DELETE FROM team_tier_models WHERE team_type = ? AND tier = ?').run(
        s.team_type,
        s.tier
      );
      const ins = db.prepare(
        `INSERT INTO team_tier_models (team_type, tier, model_id, position) VALUES (?, ?, ?, ?)`
      );
      ids.forEach((mid, i) => {
        ins.run(s.team_type, s.tier, mid, i);
      });
    });
    apply();
  }
}

/**
 * B04 + Q-13: upsert the Helm-canonical models by slug (idempotent).
 * Requires models.cli/slug/display_name (B03a). No-op on pre-v61 shapes.
 * Column-aware for optional structured cols (approval_policy/sandbox/permission/route) so
 * synthetic mid-migration tables (e.g. b03a v60 fixture after v61 backfill) still work.
 * Does not remove legacy B3 rows; only ensures the R1.4 slugs are present and correct.
 */
export function applyB04CanonicalModelSeeds(db: Database.Database): void {
  const hasModels = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='models'").get();
  if (!hasModels) return;
  const mcols = new Set((db.prepare('PRAGMA table_info(models)').all() as any[]).map((c) => c.name));
  // Require full B03a + base shape (provider/model_id). Synthetic mid-migration fixtures
  // that only have (id,name,model_id) no-op here; live/fresh paths always have provider.
  if (!mcols.has('cli') || !mcols.has('slug') || !mcols.has('display_name') || !mcols.has('provider') || !mcols.has('model_id')) return;

  for (const s of B04_CANONICAL_MODEL_SEEDS) {
    const name = (s.name && s.name.trim()) ? s.name.trim() : s.slug;
    // Core fields always present post-B03a + B3 base shape.
    const fieldMap: Record<string, unknown> = {
      name,
      provider: s.provider,
      model_id: s.model_id,
      cli: s.cli,
      slug: s.slug,
      display_name: s.display_name,
    };
    if (mcols.has('effort')) fieldMap.effort = s.effort ?? 'medium';
    if (mcols.has('approval')) fieldMap.approval = s.approval ?? 'auto';
    if (mcols.has('flags')) fieldMap.flags = s.flags ?? null;
    if (mcols.has('approval_policy')) fieldMap.approval_policy = s.approval_policy ?? null;
    if (mcols.has('sandbox_mode')) fieldMap.sandbox_mode = s.sandbox_mode ?? null;
    if (mcols.has('permission_mode')) fieldMap.permission_mode = s.permission_mode ?? null;
    if (mcols.has('bypass')) fieldMap.bypass = s.bypass ?? 0;
    if (mcols.has('route')) fieldMap.route = s.route ?? null;

    const bySlug = db.prepare('SELECT id FROM models WHERE slug = ?').get(s.slug) as { id: number } | undefined;
    const byName = db.prepare('SELECT id FROM models WHERE name = ?').get(name) as { id: number } | undefined;

    let targetId: number | undefined = bySlug?.id;
    if (targetId == null && byName) {
      const slugOwner = db.prepare('SELECT id FROM models WHERE slug = ?').get(s.slug) as { id: number } | undefined;
      if (!slugOwner || slugOwner.id === byName.id) {
        targetId = byName.id;
      }
    }

    if (targetId != null) {
      // When reusing by name only, skip name (already matches). When by slug, allow name rewrite.
      const keys = Object.keys(fieldMap).filter((k) => !(k === 'name' && bySlug == null));
      const vals = keys.map((k) => fieldMap[k]);
      const setSql = keys.map((k) => `${k} = ?`).join(', ');
      db.prepare(
        `UPDATE models SET ${setSql}${mcols.has('updated_at') ? ", updated_at = datetime('now')" : ''} WHERE id = ?`
      ).run(...vals, targetId);
      continue;
    }

    // Fresh insert (name/slug free).
    const keys = Object.keys(fieldMap);
    const placeholders = keys.map(() => '?').join(',');
    try {
      db.prepare(
        `INSERT INTO models (${keys.join(',')}) VALUES (${placeholders})`
      ).run(...keys.map((k) => fieldMap[k]));
    } catch (e: any) {
      const again = db.prepare('SELECT id FROM models WHERE slug = ?').get(s.slug) as { id: number } | undefined;
      if (!again) throw e;
    }
  }
}

/**
 * B1: seed the canonical models library (idempotent via OR IGNORE).
 * Also seeded in the v8→v9 migration block (two-track).
 * B3: extended for structured approval cols (defaults ok); full list + structured values + providers sync in slice 2.
 * B03a: when models.cli/slug/display_name exist, seed them (cli←provider for pre-B04 rows; slug←slugify(name); display_name←name).
 * B04: after legacy seeds, upsert the Helm-canonical slugs (R1.4).
 * Column-aware so pre-v61 mig blocks that call this still work on older models shapes.
 */
export function applyFreshDbExtras(db: Database.Database): void {
  // B3 MDL1/MDL2: ALL models from agent-studio-models-spec (17 total).
  // Structured: approval_policy / sandbox_mode / permission_mode / bypass (flags rendered from them, not free-text).
  // Matches spec dropdowns + CLI (grok/claude --permission-mode, codex -a/-s or bypass).
  const seeds = [
    // grok (2)
    {name:'claude-opus', provider:'claude', model_id:'claude-opus-5', effort:'high', approval:'bypassPermissions', flags:'--permission-mode bypassPermissions --dangerously-skip-permissions', approval_policy:'bypassPermissions', sandbox_mode:null, permission_mode:'bypassPermissions', bypass:1},
    {name:'grok-4.5', provider:'grok', model_id:'grok-4.5', effort:'medium', approval:'always-approve', flags:'--always-approve', approval_policy:'always-approve', sandbox_mode:null, permission_mode:null, bypass:1},
    {name:'grok-composer-2.5-fast', provider:'grok', model_id:'grok-composer-2.5-fast', effort:'low', approval:'auto', flags:null, approval_policy:'auto', sandbox_mode:null, permission_mode:null, bypass:0},
    // codex (7)
    {name:'codex-5.5', provider:'codex', model_id:'gpt-5.5', effort:'medium', approval:'bypass-sandbox', flags:'--dangerously-bypass-approvals-and-sandbox', approval_policy:'bypass', sandbox_mode:null, permission_mode:null, bypass:1},
    {name:'spark', provider:'codex', model_id:'gpt-5.3-codex-spark', effort:'dynamic', approval:'bypass', flags:'--dangerously-bypass-approvals-and-sandbox', approval_policy:'bypass', sandbox_mode:null, permission_mode:null, bypass:1},
    {name:'codex-5.4', provider:'codex', model_id:'gpt-5.4', effort:'medium', approval:'on-request', flags:null, approval_policy:'on-request', sandbox_mode:'workspace-write', permission_mode:null, bypass:0},
    {name:'codex-5.2', provider:'codex', model_id:'gpt-5.2-codex', effort:'medium', approval:'on-failure', flags:null, approval_policy:'on-failure', sandbox_mode:'workspace-write', permission_mode:null, bypass:0},
    {name:'codex-5.1-max', provider:'codex', model_id:'gpt-5.1-codex-max', effort:'high', approval:'bypass-sandbox', flags:'--dangerously-bypass-approvals-and-sandbox', approval_policy:'never', sandbox_mode:'danger-full-access', permission_mode:null, bypass:1},
    {name:'codex-5.1', provider:'codex', model_id:'gpt-5.1-codex', effort:'medium', approval:'on-request', flags:null, approval_policy:'on-request', sandbox_mode:'workspace-write', permission_mode:null, bypass:0},
    {name:'codex-5.1-mini', provider:'codex', model_id:'gpt-5.1-codex-mini', effort:'low', approval:'auto', flags:null, approval_policy:'auto', sandbox_mode:'read-only', permission_mode:null, bypass:0},
    // claude (8)
    {name:'claude-sonnet', provider:'claude', model_id:'claude-sonnet-4-6', effort:'dynamic', approval:'auto', flags:null, approval_policy:'auto', sandbox_mode:null, permission_mode:null, bypass:0},
    {name:'claude-sonnet-4-5', provider:'claude', model_id:'claude-sonnet-4-5', effort:'medium', approval:'acceptEdits', flags:'--permission-mode acceptEdits', approval_policy:'acceptEdits', sandbox_mode:null, permission_mode:'acceptEdits', bypass:0},
    {name:'claude-haiku', provider:'claude', model_id:'claude-haiku-4-5', effort:'low', approval:'auto', flags:null, approval_policy:'auto', sandbox_mode:null, permission_mode:null, bypass:0},
    {name:'claude-fable', provider:'claude', model_id:'claude-fable-5', effort:'low', approval:'auto', flags:null, approval_policy:'auto', sandbox_mode:null, permission_mode:null, bypass:0},
    {name:'claude-opus-4-7', provider:'claude', model_id:'claude-opus-4-7', effort:'high', approval:'bypassPermissions', flags:'--permission-mode bypassPermissions --dangerously-skip-permissions', approval_policy:'bypassPermissions', sandbox_mode:null, permission_mode:'bypassPermissions', bypass:1},
    {name:'claude-opus-4-6', provider:'claude', model_id:'claude-opus-4-6', effort:'high', approval:'bypassPermissions', flags:'--permission-mode bypassPermissions --dangerously-skip-permissions', approval_policy:'bypassPermissions', sandbox_mode:null, permission_mode:'bypassPermissions', bypass:1},
    {name:'claude-opus-4-5', provider:'claude', model_id:'claude-opus-4-5', effort:'high', approval:'bypassPermissions', flags:'--permission-mode bypassPermissions --dangerously-skip-permissions', approval_policy:'bypassPermissions', sandbox_mode:null, permission_mode:'bypassPermissions', bypass:1}
  ];
  const hasModels = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='models'").get();
  if (!hasModels) {
    applyB3AgentRoleCapabilitySeeds(db);
    return;
  }
  const mcols = new Set((db.prepare('PRAGMA table_info(models)').all() as any[]).map((c) => c.name));
  const hasB03a = mcols.has('cli') && mcols.has('slug') && mcols.has('display_name');
  for (const s of seeds) {
    if (hasB03a) {
      // Pre-B04: cli mirrors provider (historical provider-as-cli); real registry map is B04.
      const cli = s.provider;
      const slug = slugifyModelName(s.name);
      const display_name = s.name;
      db.prepare(
        `INSERT OR IGNORE INTO models (name, provider, model_id, cli, slug, display_name, effort, approval, flags, approval_policy, sandbox_mode, permission_mode, bypass) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(s.name, s.provider, s.model_id, cli, slug, display_name, s.effort, s.approval, s.flags, s.approval_policy, s.sandbox_mode, s.permission_mode, s.bypass);
    } else {
      db.prepare(
        `INSERT OR IGNORE INTO models (name, provider, model_id, effort, approval, flags, approval_policy, sandbox_mode, permission_mode, bypass) VALUES (?,?,?,?,?,?,?,?,?,?)`
      ).run(s.name, s.provider, s.model_id, s.effort, s.approval, s.flags, s.approval_policy, s.sandbox_mode, s.permission_mode, s.bypass);
    }
  }
  // Ensure structured + rendered flags for all (covers mig on pre-B3 rows + any partial)
  for (const s of seeds) {
    db.prepare(`UPDATE models SET approval_policy = ?, sandbox_mode = ?, permission_mode = ?, bypass = ?, flags = ?, updated_at = datetime('now') WHERE name = ?`).run(s.approval_policy, s.sandbox_mode, s.permission_mode, s.bypass, s.flags, s.name);
  }
  // B03a: fill cli/slug/display_name on any rows that still lack them (partial seeds / pre-mig inserts).
  if (hasB03a) {
    const rows = db.prepare('SELECT id, name, provider, cli, slug, display_name FROM models').all() as any[];
    const used = new Set<string>();
    for (const r of rows) {
      if (r.slug) used.add(String(r.slug));
    }
    for (const r of rows) {
      const cli = r.cli && String(r.cli).trim() ? String(r.cli).trim() : String(r.provider || '').trim();
      const display_name = r.display_name && String(r.display_name).trim() ? String(r.display_name).trim() : String(r.name);
      let slug = r.slug && String(r.slug).trim() ? String(r.slug).trim() : slugifyModelName(String(r.name));
      if (!cli) {
        // Honest: cannot invent a CLI; leave empty so NOT NULL fresh path is the only strict gate for new rows.
        // Upgraded partial rows without provider are pathological.
      }
      if (!r.slug || !String(r.slug).trim()) {
        if (used.has(slug)) {
          // Collision: append -<id> so UNIQUE holds without silently dropping a row.
          slug = `${slug}-${r.id}`;
        }
        used.add(slug);
      }
      db.prepare(
        `UPDATE models SET cli = COALESCE(NULLIF(TRIM(cli), ''), ?), slug = COALESCE(NULLIF(TRIM(slug), ''), ?), display_name = COALESCE(NULLIF(TRIM(display_name), ''), ?), updated_at = datetime('now') WHERE id = ?`
      ).run(cli, slug, display_name, r.id);
    }
  }
  // B04 + Q-13 (R1.4): ensure Helm-canonical registry rows after legacy B3 seeds + B03a backfill.
  if (hasB03a) {
    applyB04CanonicalModelSeeds(db);
  }
  // B12b (R3.12): seed role_tiers from topology intent (needs role_tiers + B04 model slugs).
  applyB12bRoleTierSeeds(db);
  // B17 (R4.18–R4.19): seed team_tiers from topology intent (needs team_tiers + B04 model slugs).
  applyB17TeamTierSeeds(db);
  applyB3AgentRoleCapabilitySeeds(db);
  // B2 HELM stubs NOT here: applyFreshDbExtras runs from v18 mig when agents may lack agent_type.
  // applyB2HelmAgentSeeds is called from fresh init (post-SCHEMA_SQL) and v38 mig only.
  // teams seeds NOT called here (would break old mig v<18 synthetic DBs that hit applyFresh via v18 block before our <23 create executes).
  // Fresh path explicitly calls after SCHEMA_SQL; mig <23 calls after its CREATE IF.
}

/**
 * B2 (R-03/R-04) + B07a (R2.7): house-agent stubs + kind classification.
 * Idempotent: INSERT OR IGNORE stubs, MIG1 definition_md guard, classify master_agent + stubs as house.
 * Column remains `agent_type` (legacy name); allowed values are project|house (helm→house).
 * Called only when agents.agent_type is present: fresh init (post-SCHEMA_SQL) and v38 migration.
 */
export function applyB2HelmAgentSeeds(db: Database.Database): void {
  const hasAgents = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agents'").get();
  if (!hasAgents) return;
  const cols = db.prepare('PRAGMA table_info(agents)').all().map((c: any) => c.name);
  if (!cols.includes('agent_type')) return;

  // Detect pre-B07a CHECK (helm|project): historical v38 path may still hold 'helm' until v63.
  // Prefer writing the value the current CHECK allows.
  const sql = (db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='agents'`).get() as any)?.sql as string | undefined;
  const houseValue = sql && sql.includes("'helm'") && !sql.includes("'house'") ? 'helm' : 'house';

  const helmStubs = [
    {
      name: 'master_agent',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      default_effort: 'medium',
      spawn_pref: 'tmux',
      definition_md: `---
role: master_agent
lifecycle: conversational
default_provider: claude
default_model: claude-sonnet-4-6
default_effort: medium
spawn_pref: tmux
kind: house
agent_type: house
---
# master_agent — receptionist & co-planner for JROM's Helm agent roster

You are master_agent. Agent Studio is your home — JROM works with you here directly to shape his agent
roster. This is NOT a disposable test chat; it is your real workplace.

## Your job
Help JROM design, refine, and maintain the prompts (definition_md) of EVERY agent in the Helm roster — the
house agents (master_agent [you], overseer, jkagebunshin) AND the PROJECT agents (discovery, plancore, ibrain, lead, fast_lead, coord,
mockup, dev, qa, reviewer, arch, deployer, curator, flm, and any others present). You can propose
changes to ANY agent, including yourself.

## How you work — propose → JROM approves → Helm writes
1. Discuss: talk through the desired change (behavior tweak, new agent, role clarification, workflow change,
   model/effort change). Ask focused questions when requirements are vague; narrow before drafting.
2. Discover the roster: to target an agent you need its id. Look it up with
   GET http://localhost:3110/api/ingest/agents — returns each agent's id, name, kind, agent_type, provider, model, and
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
- Use only the Helm API endpoints above for roster discovery and proposals.
`,
    },
    {
      name: 'jkagebunshin',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      default_effort: 'medium',
      spawn_pref: 'tmux',
      definition_md: `---
role: jkagebunshin
kind: house
agent_type: house
lifecycle: stub
---
# jkagebunshin — house-agent stub placeholder
`,
    },
    {
      name: 'overseer',
      provider: 'claude',
      model: 'claude-haiku-4-5',
      default_effort: 'low',
      spawn_pref: 'tmux',
      definition_md: `---
role: overseer
kind: house
agent_type: house
lifecycle: stub
---
# overseer — house-agent stub placeholder
`,
    },
  ];
  for (const a of helmStubs) {
    db.prepare(`INSERT OR IGNORE INTO agents (name, provider, model, default_effort, spawn_pref, definition_md, agent_type) VALUES (?,?,?,?,?,NULL,?)`).run(a.name, a.provider, a.model, a.default_effort, a.spawn_pref, houseValue);
    db.prepare(`UPDATE agents SET definition_md = ?, updated_at = datetime('now') WHERE name = ? AND (definition_md IS NULL OR TRIM(IFNULL(definition_md, '')) = '')`).run(a.definition_md, a.name);
    db.prepare(`UPDATE agents SET agent_type = ?, updated_at = datetime('now') WHERE name = ?`).run(houseValue, a.name);
  }
  db.prepare(`UPDATE agents SET agent_type = ?, updated_at = datetime('now') WHERE name = 'master_agent'`).run(houseValue);
}

export const V89_PLANCORE_DEFINITION_MD = `---
role: plancore
lifecycle: per-run                 # plans at start; idles after the plan is accepted
default_provider: claude
default_model: claude-opus-5
default_effort: high
spawn_pref: tmux
context_policy: clear-and-rehydrate # Helm /clears it; it re-reads the run folder on each wake
planning_partner:
  mode: auto                        # auto | planner | deliberation (default auto; never solo)
  agree_before_proceed: true
callback_contract: "[helm callback] plancore <run-id> STATUS: <PLANNING|PLAN-READY|IDLE|BLOCKED>"
briefing_inputs: [north-star.md, conversation-log.md, repo-path]
---
# plancore — planning brain

## You are the planning brain, not the loop
Helm owns dispatch, watching, callbacks, context resets, the implementation loop, escalation, and final
test decisions. You author the agreed requirements and execution plan; you do not implement or make
implementation-phase escalation decisions.

## Planning
1. Consume \`north-star.md\` and the discovery conversation log.
2. Pick a co-planner per \`planning_partner.mode\`; you are never solo. Use one opposite-runtime planner
   for clear, single-module work and deliberation for cross-module, schema, architecture, security,
   ambiguous, or multi-approach work. Record the choice and reason in \`decisions/\`.
3. Author \`og-requirements.md\` and \`plan.md\` with the co-planner. Iterate until both agree before
   handing the plan to Helm.
4. Every task must carry atomic work, complexity, recommended model, effort, information gaps, task type,
   and validation criteria. Keep each task under 30 minutes and independently demonstrable.
5. Keep \`req-matrix.md\` aligned with the accepted plan and emit \`STATUS: PLAN-READY\`.

After handoff, emit \`STATUS: IDLE\`. Everything durable belongs in the run folder, not session memory.
`;

export const V89_IBRAIN_DEFINITION_MD = `---
role: ibrain
lifecycle: per-run                 # wakes for implementation escalation and final-test decisions
default_provider: claude
default_model: claude-opus-5
default_effort: high
spawn_pref: tmux
context_policy: clear-and-rehydrate # Helm /clears it; it re-reads the run folder on each wake
callback_contract: "[helm callback] ibrain <run-id> STATUS: <DECIDING|DECISION-READY|IDLE|HANDHOLD-DIRECTIONS|BLOCKED>"
briefing_inputs: [plan.md, req-matrix.md, decisions/, failure-history, final-test evidence]
escalation_authority: true
---
# ibrain — implementation escalation and final-test decision brain

## You decide; Helm executes
Helm owns dispatch, retries, callbacks, worker sessions, and context resets. You never write code, edit
tests, or operate the task loop. Rehydrate from the durable run artifacts on every wake.

## Implementation escalation
At the escalation gate, read \`plan.md\`, \`decisions/\`, and the complete failure history, then choose one:
- sound approach with implementation thrash: advance the implementer rung and preserve failed-attempt context;
- wrong approach: convene deliberation and return the corrected direction;
- thin briefing or missing information: emit precise \`HANDHOLD-DIRECTIONS\` for the next attempt;
- exhausted rungs and deliberation: block and escalate to JROM with the audit and concrete options.

## Final-test decision
Review the plan, requirement matrix, validator evidence, and final-test results. Decide whether the run is
ready to complete, needs a targeted repair/retest, or is blocked on an owner decision. Never waive missing
evidence or repair code yourself.

Emit \`STATUS: DECISION-READY\` with the chosen action and evidence, then return to \`STATUS: IDLE\`.
`;

/** SHA-256 values of the two shipped dual-hat prompts observed in the pre-v89 Helm databases. */
export const V89_KNOWN_CANONICAL_PLANCORE_HASHES = new Set([
  '1b1a6157d0411bd86dcf499a1996a4cd370975e5d72bd9cb8fb7a287524f002e',
  '71da0f2fe231f5c828f6de33aa7fcc6543dde1763e6cdce0f21d7739e185b501'
]);

/**
 * S02 / AC2–4: canonical Discovery persona (aligned with discovery-contract.ts).
 * No HANDOFF; no Planning artifact authorship; exact ready ASK.
 */
export const V110_DISCOVERY_DEFINITION_MD = `---
role: discovery
kind: project
agent_type: project
lifecycle: per-effort
default_provider: claude
default_model: claude-opus-5
default_effort: high
spawn_pref: tmux
callback_contract: "[helm callback] discovery <run-id> STATUS: <INTERVIEWING|NORTH-STAR-READY|IDLE|BLOCKED>"
---
# discovery — strategy front-end

Author Discovery-owned documents only: north-star.md, conversation-log.md, decisions/, attachments/, and mockups/.
Interview and thin-context archaeology. You do not implement and you never plan.

Do NOT author, replace, or claim ownership of og-requirements.md, plan.md, or plan.json.
Do not write plan schema, task arrays, or claim Planning is complete. HANDOFF is NOT a Discovery state.

When Discovery documents are ready, emit STATUS: NORTH-STAR-READY and ask exactly:
Initial Discovery docs are ready. May I ask Helm to start the configured Planning team?
`;

/**
 * S02: SHA-256 of known-stale Discovery / north fingerprints that may be rewritten.
 * Only empty definitions or these exact hashes are repaired; any other body is preserved.
 * - pre-S02 B09a discovery seed (HANDOFF + og-requirements)
 * - same body with role: north in frontmatter
 * - full north-named legacy persona (callback role north + HANDOFF)
 */
export const V110_KNOWN_STALE_DISCOVERY_HASHES = new Set([
  '51f44f887aee4d74d69921af8dc17eb3ac778e5d5abb9fe260186cb3c3641f61',
  '0c9100a6fa6ae9cdf18563747e419281bb173822b2ad53cc7871ad9e98070ce2',
  'c0da12364a3c4d790d14238def7089669e1f3e3dc78f63baa8578ff8ea4d1d9b',
]);

/** S02: canonical discovery role_capabilities (matches discovery-contract enums). */
export const V110_DISCOVERY_ALLOWED_STATUSES =
  '["INTERVIEWING","NORTH-STAR-READY","IDLE","BLOCKED"]';
export const V110_DISCOVERY_TERMINAL_STATUSES = '["NORTH-STAR-READY","BLOCKED"]';
export const V110_DISCOVERY_REQUIRED_ARTIFACTS =
  '["north-star.md","conversation-log.md","decisions/"]';

/**
 * B09a / c01 R2.8–R2.9: canonical project + house roster seed set.
 * Project: discovery, plancore, ibrain, planner, implementer, validator, panelist.
 * House: agent-master, overseer, jkage, housekeeper (S15), branch-safety (cycle-branch-lifecycle B3).
 * Additive + idempotent (INSERT OR IGNORE by name). MIG1: never overwrite non-empty definition_md.
 * Forces kind (agent_type) for each seed. Does NOT prune extras (B09b).
 * Legacy house stubs (master_agent, jkagebunshin) remain until B09b prune.
 */
export type B09aCanonicalAgentSeed = {
  name: string;
  kind: 'project' | 'house';
  provider: 'claude' | 'codex' | 'grok' | 'kloo';
  model: string;
  default_effort: string;
  spawn_pref: string;
  definition_md: string;
};

/**
 * S15 / AC28+AC31: housekeeper prompt — four locked §1c guardrails + bounded-input contract.
 * Seeded empty-only (MIG1); Studio edits survive re-seed.
 */
export const HOUSEKEEPER_DEFINITION_MD = `---
role: housekeeper
kind: house
agent_type: house
classification: tiered
lifecycle: hours-idle-investigation
default_provider: grok
default_model: grok-4.5
default_effort: medium
spawn_pref: tmux
main_model_slug: grok45
backup_1_slug: spark
backup_2_slug: haiku
callback_contract: "[helm callback] housekeeper <session> STATUS: <done|needs-human>"
---
# housekeeper — tier-2 hours-idle status investigator (house)

You are the Helm **housekeeper**: a house agent spawned only for hours-idle anomalies on
**helm-owned** seats. You repair **status** when evidence shows work is done; you never reap
and never kill sessions. The deterministic reconciler remains the only reaper.

## Four guardrails (non-negotiable)

1. **Keep-biased.** If you cannot establish that the work is done, write **needs-human**,
   never **done**. Uncertainty must never resolve to a kill. A cheap model is not an
   authority on destroying work.
2. **Evidence recorded, verdict auditable.** Persist *what you examined* and *why you
   concluded* (pane tail, terminal callback present/absent, run + task state, last dispatch).
   A status written with no recorded basis is forbidden.
3. **helm-owned seats only.** You are structurally incapable of marking a **human**-owned
   session done. Ownership is enforced at the query/apply path, not by prompt alone — still
   refuse any non-helm owner you are handed.
4. **Cooldown / one investigation per seat per state.** Do not re-investigate a seat already
   marked needs-human for the same unchanged state. Wait until state changes.

## Bounded-input contract

You investigate from a **bounded diagnosis envelope only** — not open-ended judgement:

- seat pane tail
- whether a terminal callback was emitted
- owning run / task state
- callbacks.md (if present in the envelope)
- last dispatch record

Do not invent extra sources. Do not improvise outside this envelope. Verdicts are only
**done** (status repair toward idle via markIdle path) or **needs-human**. Never reap.
`;

/**
 * cycle-branch-lifecycle B3 / R3.1+R3.3: house branch-safety agent — facts-only contract.
 * Reports branch/git facts; never decides, blocks, or deletes. Model binding: topology default
 * (grok45 / grok-4.5, same preferred house/implementer L2 tier). Seeded empty-only (MIG1).
 */
export const BRANCH_SAFETY_DEFINITION_MD = `---
role: branch-safety
kind: house
agent_type: house
lifecycle: on-demand
default_provider: grok
default_model: grok-4.5
default_effort: medium
spawn_pref: tmux
main_model_slug: grok45
callback_contract: "[helm callback] branch-safety <session> STATUS: DONE"
---
# branch-safety — house facts-only branch reporter

You are the Helm **branch-safety** house agent. Given a branch (and project context), you
**report facts only**: whether the branch is merged anywhere, whether it is tied to any
currently-active cycle, how stale it is, and related git state (ahead/behind, dirty worktree).

## Facts-only contract (non-negotiable)

1. **Report facts. Never decides, blocks, or deletes.** You never merge, delete, force-push,
   or mutate git state. You never autonomously gate a human action.
2. **No decision field.** Your output is a factual report only — never a decision, verdict,
   allow, deny, or recommendation-to-act as an authority. JROM (or the human-in-the-loop
   moment) always makes the actual call.
3. **House-level, reusable.** One role serves pre-delete safety, merge-conflict context, and
   discovery-time repo-hygiene survey — never three separate roles that re-litigate the same
   facts.
4. **Bounded input.** Work from the facts envelope handed to you (project dir, branch name,
   cycle linkage, git porcelain). Do not invent extra sources or improvise outside it.
`;

export const B09A_CANONICAL_AGENT_SEEDS: readonly B09aCanonicalAgentSeed[] = [
  {
    name: 'discovery',
    kind: 'project',
    provider: 'claude',
    model: 'claude-opus-5',
    default_effort: 'high',
    spawn_pref: 'tmux',
    definition_md: V110_DISCOVERY_DEFINITION_MD,
  },
  {
    name: 'plancore',
    kind: 'project',
    provider: 'claude',
    model: 'claude-opus-5',
    default_effort: 'high',
    spawn_pref: 'tmux',
    definition_md: V89_PLANCORE_DEFINITION_MD,
  },
  {
    name: 'ibrain',
    kind: 'project',
    provider: 'claude',
    model: 'claude-opus-5',
    default_effort: 'high',
    spawn_pref: 'tmux',
    definition_md: V89_IBRAIN_DEFINITION_MD,
  },
  {
    name: 'planner',
    kind: 'project',
    provider: 'codex',
    model: 'gpt-5.5',
    default_effort: 'high',
    spawn_pref: 'tmux',
    definition_md: `---
role: planner
kind: project
agent_type: project
lifecycle: convened
---
# planner — plancore's co-planner
`,
  },
  {
    name: 'implementer',
    kind: 'project',
    provider: 'grok',
    model: 'grok-4.5',
    default_effort: 'medium',
    spawn_pref: 'tmux',
    definition_md: `---
role: implementer
kind: project
agent_type: project
lifecycle: per-task
---
# implementer — the builder
`,
  },
  {
    name: 'validator',
    kind: 'project',
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    default_effort: 'high',
    spawn_pref: 'tmux',
    definition_md: `---
role: validator
kind: project
agent_type: project
lifecycle: per-task
---
# validator — the judge
`,
  },
  {
    name: 'panelist',
    kind: 'project',
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    default_effort: 'high',
    spawn_pref: 'tmux',
    definition_md: `---
role: panelist
kind: project
agent_type: project
lifecycle: convened
---
# panelist — a single seat in a panel
`,
  },
  {
    name: 'agent-master',
    kind: 'house',
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    default_effort: 'medium',
    spawn_pref: 'tmux',
    definition_md: `---
role: agent-master
kind: house
agent_type: house
lifecycle: conversational
default_provider: claude
default_model: claude-sonnet-4-6
default_effort: medium
spawn_pref: tmux
---
# agent-master — receptionist & co-planner for JROM's Helm agent roster

You are agent-master (house). Help JROM design, refine, and maintain agent prompts (definition_md).
Propose via /api/ingest/agent-propose; never claim live until JROM approves. Never dispatch into a
project run.
`,
  },
  {
    name: 'overseer',
    kind: 'house',
    provider: 'claude',
    model: 'claude-haiku-4-5',
    default_effort: 'low',
    spawn_pref: 'tmux',
    definition_md: `---
role: overseer
kind: house
agent_type: house
lifecycle: stub
---
# overseer — house-agent observer (stub)

Watches runs across projects; recommends improvements. Never fenced into one project. Never
dispatched into a project run.
`,
  },
  {
    name: 'jkage',
    kind: 'house',
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    default_effort: 'medium',
    spawn_pref: 'tmux',
    definition_md: `---
role: jkage
kind: house
agent_type: house
lifecycle: stub
authority: L0
authority_label: learner
routing: none
decision_authority: none
---
# jkage — house-agent L0 learner (stub)

JROM's clone (jkagebunshin / jkage). Registered at **L0 (learner)**: no routing, no decision
authority, no approval path. Capture/profile layer is queued, not built. Never dispatched into a
project run.
`,
  },
  {
    name: 'housekeeper',
    kind: 'house',
    provider: 'grok',
    model: 'grok-4.5',
    default_effort: 'medium',
    spawn_pref: 'tmux',
    definition_md: HOUSEKEEPER_DEFINITION_MD,
  },
  {
    name: 'branch-safety',
    kind: 'house',
    provider: 'grok',
    model: 'grok-4.5',
    default_effort: 'medium',
    spawn_pref: 'tmux',
    definition_md: BRANCH_SAFETY_DEFINITION_MD,
  },
] as const;

export const B09A_PROJECT_NAMES: readonly string[] = B09A_CANONICAL_AGENT_SEEDS.filter(
  (s) => s.kind === 'project'
).map((s) => s.name);

export const B09A_HOUSE_NAMES: readonly string[] = B09A_CANONICAL_AGENT_SEEDS.filter(
  (s) => s.kind === 'house'
).map((s) => s.name);

export const B09A_CANONICAL_NAMES: readonly string[] = B09A_CANONICAL_AGENT_SEEDS.map((s) => s.name);

/**
 * B09a: upsert the R2.8–R2.9 canonical roster by name (idempotent).
 * Requires agents.agent_type (B2/B07a). No-op when agents table or column absent.
 */
export function applyB09aCanonicalRosterSeeds(db: Database.Database): void {
  const hasAgents = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agents'").get();
  if (!hasAgents) return;
  const cols = (db.prepare('PRAGMA table_info(agents)').all() as any[]).map((c) => c.name);
  if (!cols.includes('agent_type')) return;

  // Pre-B07a CHECK (helm|project): write 'helm' until v63 rebuild; else 'house'.
  const sql = (db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='agents'`).get() as any)
    ?.sql as string | undefined;
  const houseValue = sql && sql.includes("'helm'") && !sql.includes("'house'") ? 'helm' : 'house';

  for (const a of B09A_CANONICAL_AGENT_SEEDS) {
    const kindValue = a.kind === 'house' ? houseValue : 'project';
    db.prepare(
      `INSERT OR IGNORE INTO agents (name, provider, model, default_effort, spawn_pref, definition_md, agent_type)
       VALUES (?,?,?,?,?,NULL,?)`
    ).run(a.name, a.provider, a.model, a.default_effort, a.spawn_pref, kindValue);
    // MIG1: only fill empty definition_md (preserve user edits + richer B3 prompts).
    db.prepare(
      `UPDATE agents SET definition_md = ?, updated_at = datetime('now')
       WHERE name = ? AND (definition_md IS NULL OR TRIM(IFNULL(definition_md, '')) = '')`
    ).run(a.definition_md, a.name);
    // Force kind every run so house seeds stay house / project seeds stay project.
    db.prepare(`UPDATE agents SET agent_type = ?, updated_at = datetime('now') WHERE name = ?`).run(
      kindValue,
      a.name
    );
  }

  // agent-master team-eligible (default_model_id) — same pattern as master_agent F4.
  // Guard: some upgrade fixtures (phase-role-migration) have agents without models yet.
  const hasModels = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='models'").get();
  if (hasModels) {
    db.prepare(
      `UPDATE agents SET default_model_id = (SELECT id FROM models WHERE model_id = 'claude-sonnet-4-6' LIMIT 1)
       WHERE name = 'agent-master' AND default_model_id IS NULL`
    ).run();
  }
}

/**
 * S15 / AC28+AC31: housekeeper tiered house seed (idempotent, Studio-edit safe).
 * - Row + agent_type via B09a-style INSERT OR IGNORE + force house.
 * - definition_md: MIG1 empty-only (four guardrails + bounded-input).
 * - classification: tiered (contract for Studio tier editor).
 * - default_model_id: main grok45 only when NULL.
 * - agent_escalations: pos1=spark, pos2=haiku via INSERT OR IGNORE only.
 * No new agent-configuration schema. No-op when agents/models tables missing.
 */
export function applyHousekeeperSeed(db: Database.Database): void {
  const hasAgents = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agents'").get();
  if (!hasAgents) return;
  const cols = (db.prepare('PRAGMA table_info(agents)').all() as Array<{ name: string }>).map((c) => c.name);
  if (!cols.includes('agent_type')) return;

  const sql = (db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='agents'`).get() as
    | { sql?: string }
    | undefined)?.sql;
  const houseValue = sql && sql.includes("'helm'") && !sql.includes("'house'") ? 'helm' : 'house';

  db.prepare(
    `INSERT OR IGNORE INTO agents (name, provider, model, default_effort, spawn_pref, definition_md, agent_type)
     VALUES (?,?,?,?,?,NULL,?)`
  ).run('housekeeper', 'grok', 'grok-4.5', 'medium', 'tmux', houseValue);

  db.prepare(
    `UPDATE agents SET definition_md = ?, updated_at = datetime('now')
     WHERE name = 'housekeeper' AND (definition_md IS NULL OR TRIM(IFNULL(definition_md, '')) = '')`
  ).run(HOUSEKEEPER_DEFINITION_MD);

  db.prepare(
    `UPDATE agents SET agent_type = ?, updated_at = datetime('now') WHERE name = 'housekeeper'`
  ).run(houseValue);

  if (cols.includes('classification')) {
    db.prepare(
      `UPDATE agents SET classification = 'tiered', updated_at = datetime('now') WHERE name = 'housekeeper'`
    ).run();
  }

  const resolveModelId = (slug: string, modelId: string, nameHint?: string): number | undefined => {
    const hasModels = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='models'").get();
    if (!hasModels) return undefined;
    const mcols = new Set((db.prepare('PRAGMA table_info(models)').all() as Array<{ name: string }>).map((c) => c.name));
    if (mcols.has('slug')) {
      const bySlug = db.prepare('SELECT id FROM models WHERE slug = ? LIMIT 1').get(slug) as { id: number } | undefined;
      if (bySlug) return bySlug.id;
    }
    const byModelId = db
      .prepare('SELECT id FROM models WHERE model_id = ? LIMIT 1')
      .get(modelId) as { id: number } | undefined;
    if (byModelId) return byModelId.id;
    if (nameHint) {
      const byName = db.prepare('SELECT id FROM models WHERE name = ? LIMIT 1').get(nameHint) as
        | { id: number }
        | undefined;
      if (byName) return byName.id;
    }
    return undefined;
  };

  if (cols.includes('default_model_id')) {
    const mainId = resolveModelId('grok45', 'grok-4.5', 'grok-4.5');
    if (mainId != null) {
      db.prepare(
        `UPDATE agents SET default_model_id = ?, updated_at = datetime('now')
         WHERE name = 'housekeeper' AND default_model_id IS NULL`
      ).run(mainId);
    }
  }

  const hasEsc = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_escalations'").get();
  if (!hasEsc) return;
  const agent = db.prepare("SELECT id FROM agents WHERE name = 'housekeeper'").get() as { id: number } | undefined;
  if (!agent) return;

  const ladder: Array<{ position: number; slug: string; modelId: string; nameHint: string }> = [
    { position: 1, slug: 'spark', modelId: 'gpt-5.3-codex-spark', nameHint: 'spark' },
    { position: 2, slug: 'haiku', modelId: 'claude-haiku-4-5', nameHint: 'claude-haiku' },
  ];
  for (const rung of ladder) {
    const mid = resolveModelId(rung.slug, rung.modelId, rung.nameHint);
    if (mid == null) continue;
    db.prepare(
      `INSERT OR IGNORE INTO agent_escalations (agent_id, position, model_id, trigger) VALUES (?,?,?, 'on-fail')`
    ).run(agent.id, rung.position, mid);
  }
}

/**
 * cycle-branch-lifecycle B3 / R3.1+R3.3: house branch-safety agent seed (idempotent, Studio-edit safe).
 * - Row + agent_type via B09a-style INSERT OR IGNORE + force house.
 * - definition_md: MIG1 empty-only (facts-only / never-decides contract).
 * - default_model_id: topology default grok45 only when NULL.
 * - role_defaults: bind role='branch-safety' → this agent (B2 deferred this bind to B3).
 * No escalations (solo facts reporter). No-op when agents table missing.
 */
export function applyBranchSafetyAgentSeed(db: Database.Database): void {
  const hasAgents = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agents'").get();
  if (!hasAgents) return;
  const cols = (db.prepare('PRAGMA table_info(agents)').all() as Array<{ name: string }>).map((c) => c.name);
  if (!cols.includes('agent_type')) return;

  const sql = (db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='agents'`).get() as
    | { sql?: string }
    | undefined)?.sql;
  const houseValue = sql && sql.includes("'helm'") && !sql.includes("'house'") ? 'helm' : 'house';

  db.prepare(
    `INSERT OR IGNORE INTO agents (name, provider, model, default_effort, spawn_pref, definition_md, agent_type)
     VALUES (?,?,?,?,?,NULL,?)`
  ).run('branch-safety', 'grok', 'grok-4.5', 'medium', 'tmux', houseValue);

  db.prepare(
    `UPDATE agents SET definition_md = ?, updated_at = datetime('now')
     WHERE name = 'branch-safety' AND (definition_md IS NULL OR TRIM(IFNULL(definition_md, '')) = '')`
  ).run(BRANCH_SAFETY_DEFINITION_MD);

  db.prepare(
    `UPDATE agents SET agent_type = ?, updated_at = datetime('now') WHERE name = 'branch-safety'`
  ).run(houseValue);

  if (cols.includes('classification')) {
    db.prepare(
      `UPDATE agents SET classification = 'solo', updated_at = datetime('now')
       WHERE name = 'branch-safety' AND (classification IS NULL OR TRIM(IFNULL(classification, '')) = '')`
    ).run();
  }

  const resolveModelId = (slug: string, modelId: string, nameHint?: string): number | undefined => {
    const hasModels = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='models'").get();
    if (!hasModels) return undefined;
    const mcols = new Set((db.prepare('PRAGMA table_info(models)').all() as Array<{ name: string }>).map((c) => c.name));
    if (mcols.has('slug')) {
      const bySlug = db.prepare('SELECT id FROM models WHERE slug = ? LIMIT 1').get(slug) as { id: number } | undefined;
      if (bySlug) return bySlug.id;
    }
    const byModelId = db
      .prepare('SELECT id FROM models WHERE model_id = ? LIMIT 1')
      .get(modelId) as { id: number } | undefined;
    if (byModelId) return byModelId.id;
    if (nameHint) {
      const byName = db.prepare('SELECT id FROM models WHERE name = ? LIMIT 1').get(nameHint) as
        | { id: number }
        | undefined;
      if (byName) return byName.id;
    }
    return undefined;
  };

  if (cols.includes('default_model_id')) {
    const mainId = resolveModelId('grok45', 'grok-4.5', 'grok-4.5');
    if (mainId != null) {
      db.prepare(
        `UPDATE agents SET default_model_id = ?, updated_at = datetime('now')
         WHERE name = 'branch-safety' AND default_model_id IS NULL`
      ).run(mainId);
    }
  }

  // role_defaults bind (role CHECK must already accept branch-safety — v114+).
  const hasRoleDefaults = !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='role_defaults'")
    .get();
  if (hasRoleDefaults) {
    const agent = db.prepare("SELECT id FROM agents WHERE name = 'branch-safety'").get() as
      | { id: number }
      | undefined;
    if (agent) {
      try {
        db.prepare(`INSERT OR IGNORE INTO role_defaults (role, agent_id) VALUES ('branch-safety', ?)`).run(
          agent.id
        );
      } catch {
        // Older role_defaults CHECK without branch-safety: skip bind (pre-v114 upgrade path).
      }
    }
  }
}

/**
 * B25 fix1 / R1.5 + R6.25: launch-path allow-list of static model ids from PROVIDERS + B04.
 * Dynamic providers (kloo) are unconstrained here (runtime discovery).
 */
export function buildLaunchAllowlistedModelIds(): Set<string> {
  const allowed = new Set<string>();
  for (const p of Object.values(PROVIDERS)) {
    if ((p as { dynamicModels?: boolean }).dynamicModels) continue;
    for (const m of p.models) allowed.add(m.model);
  }
  for (const s of B04_CANONICAL_MODEL_SEEDS) allowed.add(s.model_id);
  return allowed;
}

/**
 * B25d / R6.25 write-time guard: reject writes to master_runtimes / project_master_models
 * when provider ∉ PROVIDERS or model is not launch-legal for that provider.
 * Fail closed with a clear error. Does NOT invent providers (never projcore).
 * State-only upserts of already-legal rows pass (provider/model already registered).
 */
export function assertMasterWriteAllowed(provider: string, model: string): void {
  if (!provider || !Object.prototype.hasOwnProperty.call(PROVIDERS, provider)) {
    throw new Error(`unknown provider (not in PROVIDERS): ${provider}`);
  }
  const p = (PROVIDERS as Record<string, { dynamicModels?: boolean; models?: { model: string }[] }>)[
    provider
  ];
  if (p?.dynamicModels) return;
  if (!model || model === 'dynamic') {
    throw new Error(`unknown {provider,model}: ${provider}/${model}`);
  }
  const inRegistry = Array.isArray(p?.models) && p.models.some((m) => m.model === model);
  if (inRegistry) return;
  if (buildLaunchAllowlistedModelIds().has(model)) return;
  throw new Error(`unknown {provider,model}: ${provider}/${model}`);
}

export type B25dDeleteUnknownProviderCounts = {
  deleted: number;
  deleted_rows: Array<{ project_id: number; provider: string; model: string; state: string }>;
};

/**
 * B25d: delete master_runtimes rows whose provider is not in PROVIDERS
 * (JROM disposition: delete projcore/run-projcore orphan; never register the provider).
 * Idempotent. Safe on DBs with no unknown-provider rows.
 */
export function applyB25dDeleteUnknownProviderMasterRuntimes(
  db: Database.Database
): B25dDeleteUnknownProviderCounts {
  const counts: B25dDeleteUnknownProviderCounts = { deleted: 0, deleted_rows: [] };
  if (!tableExists(db, 'master_runtimes')) return counts;
  const cols = new Set(
    (db.prepare('PRAGMA table_info(master_runtimes)').all() as Array<{ name: string }>).map(
      (c) => c.name
    )
  );
  if (!cols.has('provider') || !cols.has('project_id')) return counts;

  const known = new Set(Object.keys(PROVIDERS));
  const rows = db
    .prepare('SELECT project_id, provider, model, state FROM master_runtimes')
    .all() as Array<{ project_id: number; provider: string; model: string; state: string }>;
  const del = db.prepare(
    'DELETE FROM master_runtimes WHERE project_id = ? AND provider = ? AND model = ?'
  );
  for (const r of rows) {
    if (known.has(r.provider)) continue;
    del.run(r.project_id, r.provider, r.model);
    counts.deleted += 1;
    counts.deleted_rows.push(r);
  }
  return counts;
}

/**
 * B25c / R6.25: exhaustive model-bearing column enumeration (oracle, not citation).
 * 7 product-id TEXT + 3 helm-canonical slug + 13 FK→models(id) = 23.
 * Domain rules:
 *  - product-id: value ∈ buildLaunchAllowlistedModelIds() (dynamic providers unconstrained)
 *  - helm-slug: value ∈ B04_CANONICAL_SLUGS (models.slug dual-identity: also ok if product-id legal)
 *  - fk-models-id: resolved models.model_id must be product-allowlisted; same-provider when parent has provider
 * Provider rule: when a provider column is present, provider ∈ PROVIDERS (fail-not-skip unknown, e.g. projcore).
 */
export type ModelBearingDomain = 'product-id' | 'helm-slug' | 'fk-models-id';

export type ModelBearingColumn = {
  table: string;
  column: string;
  domain: ModelBearingDomain;
  /** Same-row provider column when present (master_switches uses from_provider / to_provider). */
  providerColumn?: string;
};

export const MODEL_BEARING_COLUMNS: readonly ModelBearingColumn[] = [
  // product-id domain (7)
  { table: 'agents', column: 'model', domain: 'product-id', providerColumn: 'provider' },
  { table: 'models', column: 'model_id', domain: 'product-id', providerColumn: 'provider' },
  { table: 'master_runtimes', column: 'model', domain: 'product-id', providerColumn: 'provider' },
  { table: 'project_master_models', column: 'model', domain: 'product-id', providerColumn: 'provider' },
  { table: 'master_switches', column: 'from_model', domain: 'product-id', providerColumn: 'from_provider' },
  { table: 'master_switches', column: 'to_model', domain: 'product-id', providerColumn: 'to_provider' },
  { table: 'worker_runtimes', column: 'model', domain: 'product-id', providerColumn: 'provider' },
  // helm-canonical slug domain (3)
  { table: 'models', column: 'slug', domain: 'helm-slug', providerColumn: 'provider' },
  { table: 'cycle_team_deltas', column: 'intended_slug', domain: 'helm-slug' },
  { table: 'cycle_team_deltas', column: 'actual_slug', domain: 'helm-slug' },
  // FK → models(id) (13) — same set as applyB25OrphanModelHygiene refChecks
  { table: 'agents', column: 'default_model_id', domain: 'fk-models-id', providerColumn: 'provider' },
  { table: 'agents', column: 'backup_model_id', domain: 'fk-models-id', providerColumn: 'provider' },
  { table: 'role_tiers', column: 'primary_model_id', domain: 'fk-models-id' },
  { table: 'role_tiers', column: 'backup_model_id', domain: 'fk-models-id' },
  { table: 'team_tier_models', column: 'model_id', domain: 'fk-models-id' },
  { table: 'team_members', column: 'model_id', domain: 'fk-models-id' },
  { table: 'project_agents', column: 'model_id', domain: 'fk-models-id' },
  { table: 'project_agents', column: 'backup_model_id', domain: 'fk-models-id' },
  { table: 'project_role_tiers', column: 'primary_model_id', domain: 'fk-models-id' },
  { table: 'project_role_tiers', column: 'backup_model_id', domain: 'fk-models-id' },
  { table: 'project_team_tier_models', column: 'model_id', domain: 'fk-models-id' },
  { table: 'agent_escalations', column: 'model_id', domain: 'fk-models-id' },
  { table: 'project_agent_escalations', column: 'model_id', domain: 'fk-models-id' },
] as const;

/**
 * B25d-fix1 / F1: noisy-by-default discovery — substring match over ALL column names.
 * Closed name-alternation (pre-fix1) was citation-shaped: a future `fallback_model_id` /
 * `escalation_model` / `router_model` was invisible. Substring flips the default to loud.
 */
export const MODEL_BEARING_COLUMN_NAME_RE = /model|slug/i;

/**
 * Known non-bearing columns that may match the substring predicate (or are listed in writing
 * per decision 2026-07-10 CORRECTION). New false-positives must be deliberately excused HERE —
 * never by narrowing the discovery regex.
 *
 * - models.name / models.display_name — display identity, not launch product-id / helm slug
 * - cycle_team_deltas.intended_tier / actual_tier — tier labels, not model slugs
 * - plumbing_configs.brain_agent_id / backup_brain_agent_id — agent FKs, not models
 * - projects.primary_driver_agent_id — agent FK, not models
 */
export const MODEL_BEARING_DISCOVERY_DENYLIST: ReadonlySet<string> = new Set([
  'models.name',
  'models.display_name',
  'cycle_team_deltas.intended_tier',
  'cycle_team_deltas.actual_tier',
  'plumbing_configs.brain_agent_id',
  'plumbing_configs.backup_brain_agent_id',
  'projects.primary_driver_agent_id',
]);

export type ModelBearingDiscovery = { table: string; column: string };

/** Derive candidate model-bearing columns from live schema (sqlite_master + PRAGMA table_info). */
export function discoverModelBearingColumns(db: Database.Database): ModelBearingDiscovery[] {
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
    )
    .all() as Array<{ name: string }>;
  const found: ModelBearingDiscovery[] = [];
  for (const { name: table } of tables) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    for (const c of cols) {
      if (!MODEL_BEARING_COLUMN_NAME_RE.test(c.name)) continue;
      const key = `${table}.${c.name}`;
      if (MODEL_BEARING_DISCOVERY_DENYLIST.has(key)) continue;
      found.push({ table, column: c.name });
    }
  }
  return found;
}

export type ModelBearingExhaustivenessResult = {
  ok: boolean;
  missingFromList: ModelBearingDiscovery[];
  missingFromSchema: ModelBearingDiscovery[];
};

/** FAIL if schema has a model-bearing column not in MODEL_BEARING_COLUMNS, or list entry missing from schema. */
export function assertModelBearingColumnsExhaustive(
  db: Database.Database
): ModelBearingExhaustivenessResult {
  const discovered = discoverModelBearingColumns(db);
  const discSet = new Set(discovered.map((d) => `${d.table}.${d.column}`));
  const listSet = new Set(MODEL_BEARING_COLUMNS.map((c) => `${c.table}.${c.column}`));

  const missingFromList = discovered.filter((d) => !listSet.has(`${d.table}.${d.column}`));
  const missingFromSchema = MODEL_BEARING_COLUMNS.filter(
    (c) => tableExists(db, c.table) && !discSet.has(`${c.table}.${c.column}`)
  ).map((c) => ({ table: c.table, column: c.column }));

  // List entries for tables that do not exist yet are not schema-staleness (partial synthetic DBs).
  return {
    ok: missingFromList.length === 0 && missingFromSchema.length === 0,
    missingFromList,
    missingFromSchema,
  };
}

export type ModelBearingViolation = {
  table: string;
  column: string;
  domain: ModelBearingDomain;
  provider: string | null;
  value: string | number | null;
  reason: string;
  row: Record<string, unknown>;
};

/**
 * DEBT-F3 / historical JROM-disposed orphan identity (v77 deleted live rows).
 * Exact tuple only: master_runtimes + provider=projcore + value=run-projcore.
 * NEVER keys on reason.includes('projcore') or any reason substring — identity ≠ substring.
 * Live post-v77 must have zero such rows; this is not a live green carve-out.
 */
export function isHistoricalProjcoreOrphanResidual(
  v: Pick<ModelBearingViolation, 'table' | 'provider' | 'value'>
): boolean {
  return (
    v.table === 'master_runtimes' &&
    v.provider === 'projcore' &&
    String(v.value) === 'run-projcore'
  );
}

function isRegisteredProvider(provider: string): boolean {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, provider);
}

function isDynamicProvider(provider: string): boolean {
  const p = (PROVIDERS as Record<string, { dynamicModels?: boolean }>)[provider];
  return !!p?.dynamicModels;
}

function productIdAllowed(modelId: string, provider: string | null): boolean {
  if (provider && isDynamicProvider(provider)) return true;
  return buildLaunchAllowlistedModelIds().has(modelId);
}

function helmSlugAllowed(
  slug: string,
  table: string,
  row: Record<string, unknown>,
  provider: string | null
): boolean {
  if ((B04_CANONICAL_SLUGS as readonly string[]).includes(slug)) return true;
  // models.slug dual-identity: legacy name-derived slugs OK when product-id side is legal / dynamic.
  if (table === 'models') {
    if (provider && isDynamicProvider(provider)) return true;
    const mid = row.model_id;
    if (typeof mid === 'string' && buildLaunchAllowlistedModelIds().has(mid)) return true;
  }
  return false;
}

/**
 * Sweep every MODEL_BEARING_COLUMNS cell on the DB. Returns concrete violations (never silent-skips
 * unknown providers). Nullable empty values are skipped for value checks only.
 */
export function sweepModelBearingAllowList(db: Database.Database): ModelBearingViolation[] {
  const violations: ModelBearingViolation[] = [];
  const b04 = new Set<string>(B04_CANONICAL_SLUGS as readonly string[]);

  for (const spec of MODEL_BEARING_COLUMNS) {
    if (!tableExists(db, spec.table)) continue;
    const colNames = new Set(
      (db.prepare(`PRAGMA table_info(${spec.table})`).all() as Array<{ name: string }>).map(
        (c) => c.name
      )
    );
    if (!colNames.has(spec.column)) continue;

    const selectCols = new Set<string>([spec.column]);
    if (spec.providerColumn && colNames.has(spec.providerColumn)) selectCols.add(spec.providerColumn);
    // models dual-identity needs model_id when checking slug
    if (spec.table === 'models' && colNames.has('model_id')) selectCols.add('model_id');
    if (spec.table === 'models' && colNames.has('provider')) selectCols.add('provider');
    // helpful row identity for messages
    for (const idCol of ['id', 'project_id', 'name', 'role']) {
      if (colNames.has(idCol)) selectCols.add(idCol);
    }

    const rows = db
      .prepare(`SELECT ${[...selectCols].join(', ')} FROM ${spec.table}`)
      .all() as Array<Record<string, unknown>>;

    for (const row of rows) {
      const rawVal = row[spec.column];
      const provider =
        spec.providerColumn && row[spec.providerColumn] != null
          ? String(row[spec.providerColumn])
          : row.provider != null
            ? String(row.provider)
            : null;

      // (a) provider in PROVIDERS when present — fail-not-skip (projcore/run-projcore).
      if (provider != null && provider !== '' && !isRegisteredProvider(provider)) {
        violations.push({
          table: spec.table,
          column: spec.column,
          domain: spec.domain,
          provider,
          value: rawVal as string | number | null,
          reason: `provider_not_in_PROVIDERS:${provider}`,
          row,
        });
        // still check value below so both reasons surface
      }

      // NULL / empty → no value assert
      if (rawVal == null || rawVal === '') continue;

      if (spec.domain === 'product-id') {
        const v = String(rawVal);
        if (!productIdAllowed(v, provider)) {
          violations.push({
            table: spec.table,
            column: spec.column,
            domain: spec.domain,
            provider,
            value: v,
            reason: `product_id_not_allowlisted:${v}`,
            row,
          });
        }
      } else if (spec.domain === 'helm-slug') {
        const v = String(rawVal);
        if (!helmSlugAllowed(v, spec.table, row, provider)) {
          violations.push({
            table: spec.table,
            column: spec.column,
            domain: spec.domain,
            provider,
            value: v,
            reason: `helm_slug_not_allowlisted:${v}`,
            row,
          });
        } else if (spec.table !== 'models' && !b04.has(v)) {
          // belt: non-models helm columns must be B04 (helmSlugAllowed already enforces)
        }
      } else if (spec.domain === 'fk-models-id') {
        const id = Number(rawVal);
        if (!Number.isFinite(id)) {
          violations.push({
            table: spec.table,
            column: spec.column,
            domain: spec.domain,
            provider,
            value: rawVal as string | number | null,
            reason: `fk_not_numeric:${rawVal}`,
            row,
          });
          continue;
        }
        if (!tableExists(db, 'models')) continue;
        const bound = db
          .prepare('SELECT id, provider, model_id FROM models WHERE id = ?')
          .get(id) as { id: number; provider: string; model_id: string } | undefined;
        if (!bound) {
          violations.push({
            table: spec.table,
            column: spec.column,
            domain: spec.domain,
            provider,
            value: id,
            reason: `fk_dangling_models_id:${id}`,
            row,
          });
          continue;
        }
        if (!isRegisteredProvider(bound.provider)) {
          violations.push({
            table: spec.table,
            column: spec.column,
            domain: spec.domain,
            provider: bound.provider,
            value: id,
            reason: `fk_target_provider_not_in_PROVIDERS:${bound.provider}`,
            row,
          });
        }
        if (!productIdAllowed(bound.model_id, bound.provider)) {
          violations.push({
            table: spec.table,
            column: spec.column,
            domain: spec.domain,
            provider: bound.provider,
            value: id,
            reason: `fk_target_product_id_not_allowlisted:${bound.model_id}`,
            row,
          });
        }
        // in-provider clause (N5): parent provider must match models.provider when both known
        if (
          provider != null &&
          provider !== '' &&
          isRegisteredProvider(provider) &&
          !isDynamicProvider(provider) &&
          bound.provider !== provider
        ) {
          violations.push({
            table: spec.table,
            column: spec.column,
            domain: spec.domain,
            provider,
            value: id,
            reason: `fk_cross_provider:${provider}->${bound.provider}/${bound.model_id}`,
            row,
          });
        }
      }
    }
  }

  return violations;
}

export type B25OrphanHygieneCounts = {
  agents_remapped: number;
  models_pruned: number;
  fk_rebound: number;
  pruned_model_ids: string[];
  /** B25 fix2: TEXT-slug remaps on project_master_models / master_runtimes */
  master_models_remapped: number;
  master_runtimes_remapped: number;
  chain_collapsed: number;
  default_model_rebound: number;
};

/**
 * B25 fix1+fix2 / R2.11 prune-not-wipe:
 * 1) Remap agents.model off orphan/banned launch slugs onto allow-listed default_model_id
 *    (same-provider only) else first allow-listed id for the agent provider. Never write banned.
 * 2) Remap TEXT-slug launch-path tables (project_master_models.model, master_runtimes.model)
 *    onto same-provider allow-listed ids; collapse duplicate master-chain entries.
 * 3) Rebind cross-provider default_model_id / backup_model_id onto same-provider allow-listed.
 * 4) Rebind FK children of orphan models rows onto a same-provider allow-listed replacement.
 * 5) Prune models rows whose model_id is outside the launch allow-list and unreferenced
 *    (FK ids + TEXT-slug columns). Idempotent. Does not wipe allow-listed rows.
 */
export function applyB25OrphanModelHygiene(db: Database.Database): B25OrphanHygieneCounts {
  const counts: B25OrphanHygieneCounts = {
    agents_remapped: 0,
    models_pruned: 0,
    fk_rebound: 0,
    pruned_model_ids: [],
    master_models_remapped: 0,
    master_runtimes_remapped: 0,
    chain_collapsed: 0,
    default_model_rebound: 0,
  };
  if (!tableExists(db, 'agents') || !tableExists(db, 'models')) return counts;

  const mcols = new Set((db.prepare('PRAGMA table_info(models)').all() as any[]).map((c) => c.name));
  const acols = new Set((db.prepare('PRAGMA table_info(agents)').all() as any[]).map((c) => c.name));
  if (!mcols.has('model_id') || !mcols.has('provider') || !acols.has('model')) return counts;

  const allowed = buildLaunchAllowlistedModelIds();
  const dynamicProviders = new Set(
    Object.values(PROVIDERS)
      .filter((p) => (p as { dynamicModels?: boolean }).dynamicModels)
      .map((p) => p.provider)
  );

  const firstAllowedForProvider = (provider: string): string | null => {
    const p = (PROVIDERS as Record<string, { models: { model: string }[] }>)[provider];
    if (!p?.models?.length) return null;
    return p.models[0]?.model ?? null;
  };

  /** Prefer same-provider allow-listed models row id as replacement target. */
  const replacementModelRowId = (provider: string, excludeId: number): number | null => {
    const preferred = firstAllowedForProvider(provider);
    if (preferred) {
      const byId = db
        .prepare('SELECT id FROM models WHERE model_id = ? AND id != ? ORDER BY id LIMIT 1')
        .get(preferred, excludeId) as { id: number } | undefined;
      if (byId) return byId.id;
    }
    const anyAllowed = db
      .prepare('SELECT id, model_id, provider FROM models WHERE id != ? ORDER BY id')
      .all(excludeId) as Array<{ id: number; model_id: string; provider: string }>;
    const sameProv = anyAllowed.find((r) => r.provider === provider && allowed.has(r.model_id));
    if (sameProv) return sameProv.id;
    const any = anyAllowed.find((r) => allowed.has(r.model_id));
    return any?.id ?? null;
  };

  // --- 1) Remap orphan agents.model (N3: never leave/write banned slug) ---
  if (acols.has('default_model_id')) {
    const agents = db
      .prepare('SELECT id, provider, model, default_model_id FROM agents')
      .all() as Array<{ id: number; provider: string; model: string; default_model_id: number | null }>;
    const updateModel = db.prepare(
      `UPDATE agents SET model = ?${acols.has('updated_at') ? ", updated_at = datetime('now')" : ''} WHERE id = ?`
    );
    for (const a of agents) {
      if (dynamicProviders.has(a.provider)) continue;
      if (allowed.has(a.model)) continue;

      let next: string | null = null;
      if (a.default_model_id != null) {
        const bound = db
          .prepare('SELECT model_id, provider FROM models WHERE id = ?')
          .get(a.default_model_id) as { model_id: string; provider: string } | undefined;
        // Same-provider + allow-listed only — never copy another orphan / cross-provider slug.
        if (
          bound?.model_id &&
          allowed.has(bound.model_id) &&
          bound.provider === a.provider
        ) {
          next = bound.model_id;
        }
      }
      if (!next || !allowed.has(next)) next = firstAllowedForProvider(a.provider);
      if (!next || !allowed.has(next)) continue;
      if (next === a.model) continue;
      updateModel.run(next, a.id);
      counts.agents_remapped += 1;
    }
  }

  // --- 1b) B25 fix2: TEXT-slug launch-path tables (invisible to model-id FK rebind) ---
  // project_master_models.model / master_runtimes.model store the product slug as TEXT.
  if (tableExists(db, 'project_master_models')) {
    const pmmCols = new Set(
      (db.prepare('PRAGMA table_info(project_master_models)').all() as any[]).map((c) => c.name)
    );
    if (pmmCols.has('model') && pmmCols.has('provider')) {
      const rows = db
        .prepare('SELECT id, project_id, position, provider, model FROM project_master_models ORDER BY project_id, position')
        .all() as Array<{
        id: number;
        project_id: number;
        position: number;
        provider: string;
        model: string;
      }>;
      const upd = db.prepare('UPDATE project_master_models SET model = ? WHERE id = ?');
      for (const r of rows) {
        if (dynamicProviders.has(r.provider)) continue;
        if (allowed.has(r.model)) continue;
        const next = firstAllowedForProvider(r.provider);
        if (!next || !allowed.has(next) || next === r.model) continue;
        upd.run(next, r.id);
        counts.master_models_remapped += 1;
        r.model = next;
      }

      // Collapse duplicate (provider, model) chain entries per project; renumber positions 0..n-1.
      const byProject = new Map<number, typeof rows>();
      for (const r of rows) {
        const list = byProject.get(r.project_id) ?? [];
        list.push(r);
        byProject.set(r.project_id, list);
      }
      const delPmm = db.prepare('DELETE FROM project_master_models WHERE id = ?');
      const setPos = db.prepare('UPDATE project_master_models SET position = ? WHERE id = ?');
      for (const [, list] of byProject) {
        list.sort((a, b) => a.position - b.position);
        const seen = new Set<string>();
        const keep: typeof rows = [];
        const drop: number[] = [];
        for (const r of list) {
          const key = `${r.provider}\0${r.model}`;
          if (seen.has(key)) drop.push(r.id);
          else {
            seen.add(key);
            keep.push(r);
          }
        }
        if (drop.length === 0 && keep.every((r, i) => r.position === i)) continue;
        for (const id of drop) {
          delPmm.run(id);
          counts.chain_collapsed += 1;
        }
        // Two-pass renumber avoids UNIQUE(project_id, position) collisions mid-update.
        for (let i = 0; i < keep.length; i++) setPos.run(1_000_000 + i, keep[i].id);
        for (let i = 0; i < keep.length; i++) setPos.run(i, keep[i].id);
      }
    }
  }

  if (tableExists(db, 'master_runtimes')) {
    const mrCols = new Set(
      (db.prepare('PRAGMA table_info(master_runtimes)').all() as any[]).map((c) => c.name)
    );
    if (mrCols.has('model') && mrCols.has('provider')) {
      const rows = db
        .prepare('SELECT project_id, provider, model FROM master_runtimes')
        .all() as Array<{ project_id: number; provider: string; model: string }>;
      const upd = db.prepare('UPDATE master_runtimes SET model = ? WHERE project_id = ?');
      for (const r of rows) {
        if (dynamicProviders.has(r.provider)) continue;
        if (allowed.has(r.model)) continue;
        const next = firstAllowedForProvider(r.provider);
        if (!next || !allowed.has(next) || next === r.model) continue;
        upd.run(next, r.project_id);
        counts.master_runtimes_remapped += 1;
      }
    }
  }

  // --- 1c) Rebind cross-provider default_model_id / backup_model_id (N5 data debt) ---
  if (acols.has('default_model_id')) {
    const agents = db
      .prepare(
        `SELECT id, provider, default_model_id${acols.has('backup_model_id') ? ', backup_model_id' : ''} FROM agents`
      )
      .all() as Array<{
      id: number;
      provider: string;
      default_model_id: number | null;
      backup_model_id?: number | null;
    }>;
    for (const a of agents) {
      if (dynamicProviders.has(a.provider)) continue;
      for (const col of ['default_model_id', 'backup_model_id'] as const) {
        if (col === 'backup_model_id' && !acols.has('backup_model_id')) continue;
        const curId = (a as any)[col] as number | null | undefined;
        if (curId == null) continue;
        const bound = db
          .prepare('SELECT id, provider, model_id FROM models WHERE id = ?')
          .get(curId) as { id: number; provider: string; model_id: string } | undefined;
        if (!bound) continue;
        const ok =
          bound.provider === a.provider &&
          (dynamicProviders.has(bound.provider) || allowed.has(bound.model_id));
        if (ok) continue;
        const repl = replacementModelRowId(a.provider, curId);
        if (repl == null || repl === curId) continue;
        db.prepare(`UPDATE agents SET ${col} = ? WHERE id = ?`).run(repl, a.id);
        counts.default_model_rebound += 1;
      }
    }
  }

  // --- 2) Rebind FK children of orphan models, then prune ---
  const refChecks: Array<{ table: string; col: string }> = [
    { table: 'agents', col: 'default_model_id' },
    { table: 'agents', col: 'backup_model_id' },
    { table: 'role_tiers', col: 'primary_model_id' },
    { table: 'role_tiers', col: 'backup_model_id' },
    { table: 'team_tier_models', col: 'model_id' },
    { table: 'team_members', col: 'model_id' },
    { table: 'project_agents', col: 'model_id' },
    { table: 'project_agents', col: 'backup_model_id' },
    { table: 'project_role_tiers', col: 'primary_model_id' },
    { table: 'project_role_tiers', col: 'backup_model_id' },
    { table: 'project_team_tier_models', col: 'model_id' },
    { table: 'agent_escalations', col: 'model_id' },
    { table: 'project_agent_escalations', col: 'model_id' },
  ];

  // N2: TEXT-slug columns that name models.model_id (not FK ids) — must block prune while present.
  const textSlugRefChecks: Array<{ table: string; col: string }> = [
    { table: 'agents', col: 'model' },
    { table: 'project_master_models', col: 'model' },
    { table: 'master_runtimes', col: 'model' },
  ];

  const activeRefs = refChecks.filter((r) => {
    if (!tableExists(db, r.table)) return false;
    const cols = new Set((db.prepare(`PRAGMA table_info(${r.table})`).all() as any[]).map((c) => c.name));
    return cols.has(r.col);
  });

  const activeTextSlugRefs = textSlugRefChecks.filter((r) => {
    if (!tableExists(db, r.table)) return false;
    const cols = new Set((db.prepare(`PRAGMA table_info(${r.table})`).all() as any[]).map((c) => c.name));
    return cols.has(r.col);
  });

  const modelRows = db
    .prepare('SELECT id, provider, model_id FROM models')
    .all() as Array<{ id: number; provider: string; model_id: string }>;
  const del = db.prepare('DELETE FROM models WHERE id = ?');

  for (const row of modelRows) {
    if (dynamicProviders.has(row.provider)) continue;
    if (allowed.has(row.model_id)) continue;

    const replacement = replacementModelRowId(row.provider, row.id);
    if (replacement != null) {
      for (const r of activeRefs) {
        // UNIQUE(team_type,tier,model_id) style constraints: skip rows that would collide.
        // Best-effort: UPDATE, and on constraint failure leave the row (then we won't prune).
        try {
          const info = db.prepare(`UPDATE ${r.table} SET ${r.col} = ? WHERE ${r.col} = ?`).run(replacement, row.id);
          counts.fk_rebound += Number(info.changes || 0);
        } catch {
          /* unique/check collision — leave reference; prune skipped if still referenced */
        }
      }
    }

    let stillReferenced = false;
    for (const r of activeRefs) {
      const hit = db.prepare(`SELECT 1 FROM ${r.table} WHERE ${r.col} = ? LIMIT 1`).get(row.id);
      if (hit) {
        stillReferenced = true;
        break;
      }
    }
    if (!stillReferenced) {
      for (const r of activeTextSlugRefs) {
        const hit = db
          .prepare(`SELECT 1 FROM ${r.table} WHERE ${r.col} = ? LIMIT 1`)
          .get(row.model_id);
        if (hit) {
          stillReferenced = true;
          break;
        }
      }
    }
    if (stillReferenced) continue;

    del.run(row.id);
    counts.models_pruned += 1;
    counts.pruned_model_ids.push(row.model_id);
  }

  return counts;
}

/** B09b: legacy house names → canonical house names (rebind FK children before prune). */
export const B09B_LEGACY_NAME_REMAP: Readonly<Record<string, string>> = {
  master_agent: 'agent-master',
  jkagebunshin: 'jkage',
};

export type B09bPruneCounts = {
  agents_before: number;
  agents_after: number;
  pruned_names: string[];
  role_bindings_deleted: number;
  role_defaults_deleted: number;
  role_defaults_rebound: number;
  project_agents_deleted: number;
  team_members_deleted: number;
  agent_toolkits_deleted: number;
  agent_escalations_deleted: number;
  agent_proposals_deleted: number;
  memories_rebound: number;
  memories_nulled: number;
  plumbing_rebound: number;
  plumbing_nulled: number;
  projects_primary_nulled: number;
};

function tableExists(db: Database.Database, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name);
}

/**
 * B09b / c01 R2.11: prune agents outside the B09a canonical set; explicit FK cleanup first.
 * Idempotent. Never deletes a B09A_CANONICAL_NAMES row. Safe migration (no wipe of canonical seeds).
 */
export function applyB09bPruneNonCanonicalAgents(db: Database.Database): B09bPruneCounts {
  const empty: B09bPruneCounts = {
    agents_before: 0,
    agents_after: 0,
    pruned_names: [],
    role_bindings_deleted: 0,
    role_defaults_deleted: 0,
    role_defaults_rebound: 0,
    project_agents_deleted: 0,
    team_members_deleted: 0,
    agent_toolkits_deleted: 0,
    agent_escalations_deleted: 0,
    agent_proposals_deleted: 0,
    memories_rebound: 0,
    memories_nulled: 0,
    plumbing_rebound: 0,
    plumbing_nulled: 0,
    projects_primary_nulled: 0,
  };
  if (!tableExists(db, 'agents')) return empty;

  const agentsBefore = (db.prepare('SELECT COUNT(*) AS c FROM agents').get() as { c: number }).c;
  const placeholders = B09A_CANONICAL_NAMES.map(() => '?').join(',');
  const pruneRows = db
    .prepare(`SELECT id, name FROM agents WHERE name NOT IN (${placeholders}) ORDER BY name`)
    .all(...B09A_CANONICAL_NAMES) as Array<{ id: number; name: string }>;

  if (pruneRows.length === 0) {
    return { ...empty, agents_before: agentsBefore, agents_after: agentsBefore };
  }

  const pruneIds = pruneRows.map((r) => r.id);
  const prunedNames = pruneRows.map((r) => r.name);
  const idList = pruneIds.join(',');
  const counts: B09bPruneCounts = {
    ...empty,
    agents_before: agentsBefore,
    pruned_names: prunedNames,
  };

  // Resolve remap targets (canonical ids) for legacy house renames.
  const remapTargetId = (legacyName: string): number | null => {
    const targetName = B09B_LEGACY_NAME_REMAP[legacyName];
    if (!targetName) return null;
    const row = db.prepare('SELECT id FROM agents WHERE name = ?').get(targetName) as { id: number } | undefined;
    return row?.id ?? null;
  };
  const pruneIdToTarget = new Map<number, number | null>();
  for (const r of pruneRows) {
    pruneIdToTarget.set(r.id, remapTargetId(r.name));
  }

  // Explicit child cleanup under FK-off so partial/synthetic DBs (missing intermediate
  // tables) still prune safely. Children are deleted/rebound before agents; FK re-enabled after.
  db.pragma('foreign_keys = OFF');

  // 1) role_bindings — ON DELETE RESTRICT
  if (tableExists(db, 'role_bindings')) {
    counts.role_bindings_deleted = (
      db.prepare(`SELECT COUNT(*) AS c FROM role_bindings WHERE agent_id IN (${idList})`).get() as { c: number }
    ).c;
    db.exec(`DELETE FROM role_bindings WHERE agent_id IN (${idList})`);
  }

  // 2) role_defaults — NO ACTION; rebind when role name matches a surviving agent, else delete
  if (tableExists(db, 'role_defaults')) {
    const defs = db
      .prepare(`SELECT role, agent_id FROM role_defaults WHERE agent_id IN (${idList})`)
      .all() as Array<{ role: string; agent_id: number }>;
    for (const d of defs) {
      const sameName = db.prepare('SELECT id FROM agents WHERE name = ?').get(d.role) as { id: number } | undefined;
      const target =
        sameName && !pruneIds.includes(sameName.id)
          ? sameName.id
          : pruneIdToTarget.get(d.agent_id) ?? null;
      if (target != null && !pruneIds.includes(target)) {
        db.prepare('UPDATE role_defaults SET agent_id = ?, updated_at = datetime(\'now\') WHERE role = ?').run(
          target,
          d.role
        );
        counts.role_defaults_rebound += 1;
      } else {
        db.prepare('DELETE FROM role_defaults WHERE role = ?').run(d.role);
        counts.role_defaults_deleted += 1;
      }
    }
  }

  // 3) project_agents (+ cascade children via FK; delete explicit for R2.11)
  // Guard both parent+child: synthetic old DBs may have partial tables; FK DML needs parent present.
  if (tableExists(db, 'project_agents') && tableExists(db, 'project_agent_toolkits')) {
    db.exec(`DELETE FROM project_agent_toolkits WHERE agent_id IN (${idList})`);
  }
  if (tableExists(db, 'project_agents') && tableExists(db, 'project_agent_escalations')) {
    db.exec(`DELETE FROM project_agent_escalations WHERE agent_id IN (${idList})`);
  }
  if (tableExists(db, 'project_agents')) {
    counts.project_agents_deleted = (
      db.prepare(`SELECT COUNT(*) AS c FROM project_agents WHERE agent_id IN (${idList})`).get() as { c: number }
    ).c;
    db.exec(`DELETE FROM project_agents WHERE agent_id IN (${idList})`);
  }

  // 4) team_members
  if (tableExists(db, 'team_members')) {
    counts.team_members_deleted = (
      db.prepare(`SELECT COUNT(*) AS c FROM team_members WHERE agent_id IN (${idList})`).get() as { c: number }
    ).c;
    db.exec(`DELETE FROM team_members WHERE agent_id IN (${idList})`);
  }

  // 5) agent_toolkits / agent_escalations / agent_proposals (CASCADE, explicit)
  if (tableExists(db, 'agent_toolkits')) {
    counts.agent_toolkits_deleted = (
      db.prepare(`SELECT COUNT(*) AS c FROM agent_toolkits WHERE agent_id IN (${idList})`).get() as { c: number }
    ).c;
    db.exec(`DELETE FROM agent_toolkits WHERE agent_id IN (${idList})`);
  }
  if (tableExists(db, 'agent_escalations')) {
    counts.agent_escalations_deleted = (
      db.prepare(`SELECT COUNT(*) AS c FROM agent_escalations WHERE agent_id IN (${idList})`).get() as { c: number }
    ).c;
    db.exec(`DELETE FROM agent_escalations WHERE agent_id IN (${idList})`);
  }
  if (tableExists(db, 'agent_proposals')) {
    counts.agent_proposals_deleted = (
      db.prepare(`SELECT COUNT(*) AS c FROM agent_proposals WHERE agent_id IN (${idList})`).get() as { c: number }
    ).c;
    db.exec(`DELETE FROM agent_proposals WHERE agent_id IN (${idList})`);
  }

  // 6) memories — rebind legacy house → canonical, else NULL agent_id
  if (tableExists(db, 'memories')) {
    const memCols = (db.prepare('PRAGMA table_info(memories)').all() as any[]).map((c) => c.name);
    if (memCols.includes('agent_id')) {
      for (const r of pruneRows) {
        const target = pruneIdToTarget.get(r.id);
        if (target != null) {
          const n = db.prepare('UPDATE memories SET agent_id = ? WHERE agent_id = ?').run(target, r.id).changes;
          counts.memories_rebound += n;
        } else {
          const n = db.prepare('UPDATE memories SET agent_id = NULL WHERE agent_id = ?').run(r.id).changes;
          counts.memories_nulled += n;
        }
      }
    }
  }

  // 7) plumbing_configs brain / backup brain
  if (tableExists(db, 'plumbing_configs')) {
    const pcols = (db.prepare('PRAGMA table_info(plumbing_configs)').all() as any[]).map((c) => c.name);
    for (const col of ['brain_agent_id', 'backup_brain_agent_id'] as const) {
      if (!pcols.includes(col)) continue;
      for (const r of pruneRows) {
        const target = pruneIdToTarget.get(r.id);
        if (target != null) {
          const n = db.prepare(`UPDATE plumbing_configs SET ${col} = ? WHERE ${col} = ?`).run(target, r.id).changes;
          counts.plumbing_rebound += n;
        } else {
          const n = db.prepare(`UPDATE plumbing_configs SET ${col} = NULL WHERE ${col} = ?`).run(r.id).changes;
          counts.plumbing_nulled += n;
        }
      }
    }
  }

  // 8) projects.primary_driver_agent_id
  if (tableExists(db, 'projects')) {
    const pcols = (db.prepare('PRAGMA table_info(projects)').all() as any[]).map((c) => c.name);
    if (pcols.includes('primary_driver_agent_id')) {
      for (const r of pruneRows) {
        const target = pruneIdToTarget.get(r.id);
        if (target != null) {
          db.prepare('UPDATE projects SET primary_driver_agent_id = ? WHERE primary_driver_agent_id = ?').run(
            target,
            r.id
          );
        } else {
          const n = db
            .prepare('UPDATE projects SET primary_driver_agent_id = NULL WHERE primary_driver_agent_id = ?')
            .run(r.id).changes;
          counts.projects_primary_nulled += n;
        }
      }
    }
  }

  // 9) Delete non-canonical agents
  db.exec(`DELETE FROM agents WHERE id IN (${idList})`);

  db.pragma('foreign_keys = ON');

  counts.agents_after = (db.prepare('SELECT COUNT(*) AS c FROM agents').get() as { c: number }).c;
  return counts;
}

/**
 * B6 (H11-enabler): idempotent app + project + agent-meta memory seeds for HB13 three-color cards.
 * Requires memories.agent_id column (v39). Resolves project/agent FKs by name; skips missing targets.
 */
export function applyB6AgentMemorySeeds(db: Database.Database): void {
  const hasMemories = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memories'").get();
  if (!hasMemories) return;
  const mcols = db.prepare('PRAGMA table_info(memories)').all().map((c: any) => c.name);
  if (!mcols.includes('agent_id')) return;

  const now = new Date().toISOString();
  const insertIfAbsent = (
    scope: 'app' | 'project' | 'agent',
    title: string,
    description: string,
    type: string,
    body: string,
    projectId: number | null,
    agentId: number | null
  ) => {
    const exists = db.prepare('SELECT 1 FROM memories WHERE scope = ? AND title = ?').get(scope, title);
    if (exists) return;
    db.prepare(
      `INSERT INTO memories (scope, project_id, agent_id, title, description, type, body, status, horizon, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,'approved','long',?,?)`
    ).run(scope, projectId, agentId, title, description, type, body, now, now);
  };

  insertIfAbsent(
    'app',
    'Helm orchestration conventions',
    'Platform-wide rules for Helm phase-brain batches, callbacks, and evidence gates.',
    'reference',
    'Helm batches use PROPOSED→APPROVED-PLAN→DONE. Validators are independent. Owner cred gates mutations on :3110.',
    null,
    null
  );

  const project = db.prepare("SELECT id FROM projects ORDER BY id LIMIT 1").get() as { id: number } | undefined;
  if (project) {
    insertIfAbsent(
      'project',
      'Cards project delivery notes',
      'Per-project memory for the cards workspace — scope-tagged green in HB13.',
      'project',
      'Primary driver uses the Helm phase-brain coordination pattern. Keep queue.md and req-matrix aligned before dispatch.',
      project.id,
      null
    );
  }

  // Prefer B09a canonical agent-master; fall back to legacy master_agent if still present (pre-B09b).
  const master =
    (db.prepare("SELECT id FROM agents WHERE name = 'agent-master' LIMIT 1").get() as { id: number } | undefined) ||
    (db.prepare("SELECT id FROM agents WHERE name = 'master_agent' LIMIT 1").get() as { id: number } | undefined);
  if (master) {
    insertIfAbsent(
      'agent',
      'agent-master receptionist persona',
      'Agent-meta memory for agent-master — purple scope in HB13 right rail.',
      'user',
      'Discuss agent upgrades with JROM; propose definition_md via /api/ingest/agent-propose; never claim live until approved.',
      null,
      master.id
    );
  }
}

/**
 * B3 (AG1+AG2+ESC1 prep): seed the canonical role agents from the authoritative run-folder agents/*.md (verbatim definition_md).
 * - ADDITIVE + idempotent.
 * - MIG1: never overwrite a user-edited definition_md (only set if current IS NULL or empty).
 * - Bind exactly one role_default per role.
 * - role_capabilities (typed, queryable) seeded from md frontmatter/body analysis.
 * - Escalations ladder seed (implementer/validator +2 rungs) also here for table completeness (guards in slice 3).
 * Source of truth: the 9 .md files in the orchestrator-rebuild dispatch folder (read per brief).
 */
export function applyB3AgentRoleCapabilitySeeds(db: Database.Database): void {
  // Role agents: name=role (from md), provider/model/effort/spawn from frontmatter "default_*", definition_md = FULL verbatim file content.
  // Verbatim includes the leading --- frontmatter + body exactly.
  const agentSeeds = [
    {
      name: 'implementer',
      provider: 'grok',
      model: 'grok-4.5',
      default_effort: 'medium',
      spawn_pref: 'tmux',
      definition_md: `---
role: implementer
lifecycle: per-task                # fresh context per task; Helm /clears between tasks
default_provider: grok            # base rung; JROM may repoint
default_model: grok-4.5
default_effort: medium
spawn_pref: tmux
escalation: [gpt-5.5, claude-opus-5]   # +2 rungs (see escalation-ladders-spec.md)
callback_contract: "[helm callback] implementer <task-id> STATUS: <PROPOSED|WORKING|DONE|BLOCKED>"
briefing_inputs: [task briefing (plan.md or plancore), req item, repo-path, prior-attempts (on rung>=1)]
---
# implementer — the builder

Build ONE atomic task from your briefing. Fresh context — the briefing is everything you need.
**First tool call in every reply: the callback STATUS line, before any prose.**

- **Feature task:** build the vertical slice; write tests that prove the *requirement* (right level —
  rendered UI for UI behavior), not just that a call fired. PROPOSED (plan) → WORKING → DONE.
- **Issue task:** do **ZERO work until the validator has reproduced it**. Your fix is built against the
  validator's confirmed reproduction (the fix contract), never a guess off a code/API read.
- **Do not game the gate:** no fake-green, no reusing a screenshot/mockup as proof, no editing tests to
  pass. The validator and red-team will catch it — you'll just burn a rung.
- On **rung ≥ 1** you're handed the failed attempts 1–3 — do NOT re-walk those paths.
- Tight diff, atomic commit, \`changes.md\`. \`STATUS: DONE\` only when it actually builds + tests pass.
`
    },
    {
      name: 'validator',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      default_effort: 'high',
      spawn_pref: 'tmux',
      definition_md: `---
role: validator
lifecycle: per-task                # fresh context per task
default_provider: claude
default_model: claude-sonnet-4-6
default_effort: high
spawn_pref: tmux
escalation: [gpt-5.5, claude-opus-5]   # +2 rungs
modes: [feature, issue]
callback_contract: "[helm callback] validator <task-id> STATUS: <REPRO-CONFIRMED|REPRO-FAILED|PASS|FAIL>"
briefing_inputs: [original north_star/req item (NOT the implementer's diff), task_type, repo-path, deployed URL]
---
# validator — the judge (the user's clone)

You validate as JROM would, anchored to the **ORIGINAL ask** (north_star → req/plan), never to what the
implementer built. **First tool call every reply: the callback STATUS line.**

## feature mode
- Map every acceptance criterion in the req item to the assertion that covers it, or mark **GAP**.
  Any GAP = FAIL.
- **Audit the implementer's OWN tests for validity** — right scenario, right level, asserts the
  OUTCOME not the attempt. A green test over a still-broken requirement = FAIL.
- **UI-proof:** for anything a user can see, acceptance = the rendered app (DOM/Playwright on the
  shipped env + screenshot). An API/code-read result is NEVER acceptance for a UI requirement.
- You do NOT edit code (verifier ≠ fixer). Specify the gap precisely.

## issue mode (you go FIRST)
- **Reproduce the issue on the rendered app BEFORE the implementer does anything.**
  \`REPRO-CONFIRMED\` (the reproduction IS the fix contract + a retained regression check) or
  \`REPRO-FAILED\` (hard blocker — nothing goes to the implementer).
- After the fix: re-run the reproduction; it must be **cleared on the rendered app** before \`PASS\`.
- Always reference the original report/docs, never the implementer's work as source of truth.
`
    },
    {
      name: 'planner',
      provider: 'codex',
      model: 'gpt-5.5',
      default_effort: 'high',
      spawn_pref: 'tmux',
      definition_md: `---
role: planner
lifecycle: convened               # spawned by plancore during planning; killed when the plan is agreed
default_provider: codex
default_model: gpt-5.5            # codex-5.5
default_effort: high
spawn_pref: tmux
callback_contract: "[helm callback] planner <run-id> STATUS: <REVIEWING|REVIEW-READY>"
briefing_inputs: [north_star.md, draft req.md, draft plan.md, repo-path]
---
# planner — plancore's co-planner (bounce-off partner)

Opposite-runtime lens on the req/plan plancore is drafting. You do NOT author the plan; you
**pressure-test** it and you must **reach agreement** with plancore before execution:
- missing or mis-scoped requirements
- wrong decomposition; tasks that aren't atomic or independently demonstrable
- risky sequencing / dependency ordering; better seams to split on
- complexity / model-rung / effort tags that look off
Return concrete, specific gaps (not vibes). plancore folds them in; iterate until you both agree.
Killed once the plan is agreed.
`
    },
    {
      name: 'plancore',
      provider: 'claude',
      model: 'claude-opus-5',
      default_effort: 'high',
      spawn_pref: 'tmux',
      definition_md: V89_PLANCORE_DEFINITION_MD
    },
    {
      name: 'ibrain',
      provider: 'claude',
      model: 'claude-opus-5',
      default_effort: 'high',
      spawn_pref: 'tmux',
      definition_md: V89_IBRAIN_DEFINITION_MD
    },
    {
      name: 'coord',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      default_effort: 'medium',
      spawn_pref: 'tmux',
      definition_md: `---
role: coord
lifecycle: per-run                # short, fast lane
default_provider: claude
default_model: claude-sonnet-4-6
default_effort: medium
spawn_pref: tmux
escalation_authority: true        # same decision authority as ibrain, on its single task
callback_contract: "[helm callback] coord <run-id> STATUS: <TRIAGING|PLAN-READY|DECIDING|DECISION-READY|BLOCKED>"
briefing_inputs: [the chat-raised quick issue, repo-path, dev/qa env]
---
# coord — fast micro-fix conductor-brain (the quick lane)

The lightweight sibling of the phase-brain path for atomic 5–10min fixes thrown in chat. No full interview /
north-star. Triage the issue into one atomic micro-fix, hand Helm a one-task plan (with the same
task fields, \`task_type\` feature|issue), let the implementer/validator loop run, validate on the
deployed dev/qa env. Tight caps.

Too big for a 5–10min fix → \`STATUS: BLOCKED\` "route to plancore" (escalate to a full planned run).
On its single task, coord has the same escalation authority as ibrain (rung bump / re-brief / deliberation).
`
    },
    {
      name: 'deliberation',
      provider: 'claude',
      model: 'claude-opus-5',
      default_effort: 'high',
      spawn_pref: 'tmux',
      definition_md: `---
role: deliberation
lifecycle: convened
default_provider: claude
default_model: claude-opus-5
default_effort: high
spawn_pref: tmux
callback_contract: "[helm callback] deliberation <topic-id> STATUS: <ROUND-n|CONSENSUS|SETTLED>"
briefing_inputs: [topic anchor (north-star + goal), the approaches in contention, repo-path]
---
# deliberation — consensus loop for wrong-approach decisions (front gate)

Convened when the **approach/design** is wrong (not implementation thrash). Runs a multi-model panel
(\`panelist\` seats) over the contended approach: strict unanimous ≤3 rounds, else the two strongest
settle. Produces a consensus that becomes the corrected plan/approach.

Verifier ≠ fixer: the panel never writes the fix. (Front gate = the approach; cf. \`red-team\` = the
implemented diff.) Each topic gets a lean, scoped anchor — bloated context handicaps lower models.
`
    },
    {
      name: 'panelist',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      default_effort: 'high',
      spawn_pref: 'tmux',
      definition_md: `---
role: panelist
lifecycle: convened               # one seat, spawned into a deliberation or red-team panel
default_provider: claude          # the actual model is set per-seat at spawn
default_model: claude-sonnet-4-6
default_effort: high
spawn_pref: tmux
callback_contract: "[helm callback] panelist <panel-id>:<seat> STATUS: <VERDICT-READY>"
briefing_inputs: [the panel packet (lean, topic-scoped), the assigned lens]
---
# panelist — a single seat in a panel

You are one model in a deliberation or red-team panel. You get a lean, topic-scoped packet and an
assigned lens; you return **YOUR independent verdict only** — no coordination with other seats (the
conductor aggregates). Diversity of view is the point; don't converge prematurely or defer to others.
`
    },
    {
      name: 'red-team',
      provider: 'codex',
      model: 'gpt-5.5',
      default_effort: 'high',
      spawn_pref: 'tmux',
      definition_md: `---
role: red-team
lifecycle: convened
default_provider: codex
default_model: gpt-5.5
default_effort: high
spawn_pref: tmux
callback_contract: "[helm callback] red-team <task-id> STATUS: <ROUND-n|CLEAN|BROKEN>"
briefing_inputs: [the implemented diff, the requirement, the strict gate command, repo-path]
---
# red-team — adversarial break of the implemented diff (back gate)

Convened on select tasks (anti-gaming back-stop) to break the **IMPLEMENTED diff** over rotating
lenses until **N-consecutive-clean over distinct lenses**, or report \`BROKEN\` with the breaking case.

You never write the fix (verifier ≠ fixer) — Helm re-runs the strict gate and routes the break back as
a new task. Catches fake-green / wrong-level proof / reused screenshots / unhandled edge cases.
Tier = roster size (budget/standard/elite) — the master cost/speed dial.
`
    },
    {
      name: 'routine-implementer',
      provider: 'grok',
      model: 'grok-4.5',
      default_effort: 'low',
      spawn_pref: 'tmux',
      definition_md: `---
role: routine-implementer
lifecycle: per-task
default_provider: grok
default_model: grok-4.5
default_effort: low
spawn_pref: tmux
escalation: [implementer]         # escalates into the implementer role's ladder
callback_contract: "[helm callback] routine-implementer <task-id> STATUS: <PROPOSED|WORKING|DONE|BLOCKED>"
briefing_inputs: [task briefing, req item, repo-path]
---
# routine-implementer — the cheap default for low-complexity slices

Same contract as \`implementer\`, scoped to routine/low-complexity tasks (config, copy, small wiring,
mechanical edits). Same anti-gaming + callback-first rules.

If a task turns out non-routine, \`STATUS: BLOCKED\` with "escalate to implementer" — do not force it.
Helm reroutes to the implementer ladder.
`
    },
    {
      name: 'master_agent',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      default_effort: 'medium',
      spawn_pref: 'tmux',
      definition_md: `---
role: master_agent
lifecycle: conversational
default_provider: claude
default_model: claude-sonnet-4-6
default_effort: medium
spawn_pref: tmux
kind: house
agent_type: house
---
# master_agent — receptionist & co-planner for JROM's Helm agent roster

You are master_agent. Agent Studio is your home — JROM works with you here directly to shape his agent
roster. This is NOT a disposable test chat; it is your real workplace.

## Your job
Help JROM design, refine, and maintain the prompts (definition_md) of EVERY agent in the Helm roster — the
house agents (master_agent [you], overseer, jkagebunshin) AND the PROJECT agents (discovery, plancore, ibrain, lead, fast_lead, coord,
mockup, dev, qa, reviewer, arch, deployer, curator, flm, and any others present). You can propose
changes to ANY agent, including yourself.

## How you work — propose → JROM approves → Helm writes
1. Discuss: talk through the desired change (behavior tweak, new agent, role clarification, workflow change,
   model/effort change). Ask focused questions when requirements are vague; narrow before drafting.
2. Discover the roster: to target an agent you need its id. Look it up with
   GET http://localhost:3110/api/ingest/agents — returns each agent's id, name, kind, agent_type, provider, model, and
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
- Use only the Helm API endpoints above for roster discovery and proposals.
`
    },
    {
      name: 'project_maintainer',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      default_effort: 'medium',
      spawn_pref: 'tmux',
      definition_md: `---
role: project_maintainer
lifecycle: ephemeral
default_provider: claude
default_model: claude-sonnet-4-6
default_effort: medium
spawn_pref: tmux
---
# project_maintainer — app-agnostic documentation keeper

You are project_maintainer, an ephemeral agent spawned per-session to review and keep a project's documentation current.

## Your job

When invoked for a project, you will:
1. Read the project's helm_docs/ files (tech-stack.md, overview.md, specs.md, preferences.md) via GET /api/projects/:id/docs/:path.
2. Ask the user what has changed — features shipped, architecture decisions made, standards updated.
3. Propose concrete edits to the relevant helm_docs/ files.
4. Apply agreed edits and confirm to the user.

## What you do NOT do

- Do not make edits without the user's approval.
- Do not hardcode project names, paths, or technologies — discover them from the docs at runtime.
- Do not persist between sessions; each session starts fresh with the current helm_docs/ state.
`
    }
    // D2 (R-02A): removed model-named stub agents (grok-composer, spark, codex-5.4) — only real
    // role agents are seeded now. Their stub *models* remain in the models seed; the v32 migration
    // purges these stub agent rows (+ stale role_bindings) from pre-existing/live DBs.
  ];

  for (const a of agentSeeds) {
    // Base row (idempotent). definition_md set separately for MIG1.
    db.prepare(`INSERT OR IGNORE INTO agents (name, provider, model, default_effort, spawn_pref, definition_md) VALUES (?,?,?,?,?,NULL)`).run(a.name, a.provider, a.model, a.default_effort, a.spawn_pref);
    // MIG1 guard: only set/overwrite definition_md if currently null or empty (user edits preserved).
    db.prepare(`UPDATE agents SET definition_md = ? , updated_at = datetime('now') WHERE name = ? AND (definition_md IS NULL OR TRIM(IFNULL(definition_md, '')) = '')`).run(a.definition_md, a.name);
  }

  // F4 (R-03D): master_agent must be team-eligible (it edits teams + may add itself as a member),
  // so wire its default_model_id to the claude-sonnet-4-6 model matching its frontmatter default_model.
  // The other role agents are per-task workers whose base rung is bound elsewhere; only master_agent
  // needs a seeded default model binding. Idempotent (only fills when NULL).
  db.prepare(`UPDATE agents SET default_model_id = (SELECT id FROM models WHERE model_id = 'claude-sonnet-4-6' LIMIT 1) WHERE name = 'master_agent' AND default_model_id IS NULL`).run();
  // I3 (R-05F): project_maintainer is team-eligible too — wire its default_model_id the same way.
  db.prepare(`UPDATE agents SET default_model_id = (SELECT id FROM models WHERE model_id = 'claude-sonnet-4-6' LIMIT 1) WHERE name = 'project_maintainer' AND default_model_id IS NULL`).run();
  // L1/L2/L3 lanes: base L1 lives in agents.default_model_id; L2/L3 live in agent_escalations.
  // Backfill the role workers whose frontmatter default_model defines their L1.
  db.prepare(`UPDATE agents SET default_model_id = (SELECT id FROM models WHERE model_id = 'grok-4.5' LIMIT 1) WHERE name = 'implementer' AND default_model_id IS NULL`).run();
  db.prepare(`UPDATE agents SET default_model_id = (SELECT id FROM models WHERE model_id IN ('claude-sonnet-4-6', 'claude-sonnet-5') OR name = 'claude-sonnet' ORDER BY CASE WHEN model_id = 'claude-sonnet-4-6' THEN 0 WHEN name = 'claude-sonnet' THEN 1 ELSE 2 END LIMIT 1) WHERE name = 'validator' AND default_model_id IS NULL`).run();
  db.prepare(`UPDATE agents SET default_model_id = (SELECT id FROM models WHERE model_id = 'claude-opus-5' LIMIT 1) WHERE name = 'ibrain' AND default_model_id IS NULL`).run();

  // role_defaults: exactly one per role (idempotent bind to the backing agent BY NAME).
  // B11 / AC-3: panelist is NOT a live seat owner — keep the agent seed for runtime spawn
  // role resolution, but do not bind role_defaults.panelist (roster/model slots own panel seats).
  const roleAgentMap: Record<string, string> = {
    'discovery': 'discovery',
    'plancore': 'plancore',
    'ibrain': 'ibrain',
    'coord': 'coord',
    'implementer': 'implementer',
    'validator': 'validator',
    'deliberation': 'deliberation',
    'red-team': 'red-team',
    'planner': 'planner',
    'routine-implementer': 'routine-implementer',
  };
  for (const [role, agentName] of Object.entries(roleAgentMap)) {
    const agent = db.prepare('SELECT id FROM agents WHERE name = ?').get(agentName) as { id: number } | undefined;
    if (agent) {
      db.prepare(`INSERT OR IGNORE INTO role_defaults (role, agent_id) VALUES (?, ?)`).run(role, agent.id);
    }
  }

  // role_capabilities (AG2): derived from the 9 mds (frontmatter + semantics in body + ladders-spec).
  // E2: seed sensible checkin_ms (ms) for enforcement on task workers (impl/val use short; brain/coord longer). null = no enforcement.
  const capSeeds = [
    { role: 'discovery', allowed_statuses: V110_DISCOVERY_ALLOWED_STATUSES, terminal_statuses: V110_DISCOVERY_TERMINAL_STATUSES, can_write_code: 0, requires_repro_first: 0, panel_participant: 0, can_escalate: 0, session_policy: 'fresh', required_artifacts: V110_DISCOVERY_REQUIRED_ARTIFACTS, timeout_ms: null, checkin_ms: null },
    { role: 'plancore', allowed_statuses: '["PLANNING","PLAN-READY","IDLE","BLOCKED"]', terminal_statuses: '["PLAN-READY","BLOCKED"]', can_write_code: 0, requires_repro_first: 0, panel_participant: 0, can_escalate: 1, session_policy: 'clear+rehydrate', required_artifacts: '["north-star.md","og-requirements.md","plan.md","decisions/"]', timeout_ms: null, checkin_ms: 300000 },
    { role: 'ibrain', allowed_statuses: '["DECIDING","DECISION-READY","IDLE","HANDHOLD-DIRECTIONS","BLOCKED"]', terminal_statuses: '["DECISION-READY","BLOCKED"]', can_write_code: 0, requires_repro_first: 0, panel_participant: 0, can_escalate: 1, session_policy: 'clear+rehydrate', required_artifacts: '["plan.md","decisions/","failure-history"]', timeout_ms: null, checkin_ms: 300000 },
    { role: 'implementer', allowed_statuses: '["PROPOSED","WORKING","DONE","BLOCKED"]', terminal_statuses: '["DONE","BLOCKED"]', can_write_code: 1, requires_repro_first: 0, panel_participant: 0, can_escalate: 1, session_policy: 'fresh', required_artifacts: '["changes.md"]', timeout_ms: null, checkin_ms: 180000 },
    { role: 'validator', allowed_statuses: '["REPRO-CONFIRMED","REPRO-FAILED","PASS","FAIL"]', terminal_statuses: '["PASS","FAIL"]', can_write_code: 0, requires_repro_first: 1, panel_participant: 0, can_escalate: 1, session_policy: 'fresh', required_artifacts: '["test-report.md","independent-validation.md"]', timeout_ms: null, checkin_ms: 120000 },
    { role: 'planner', allowed_statuses: '["REVIEWING","REVIEW-READY"]', terminal_statuses: '["REVIEW-READY"]', can_write_code: 0, requires_repro_first: 0, panel_participant: 0, can_escalate: 0, session_policy: 'fresh', required_artifacts: '["plan.md"]', timeout_ms: null, checkin_ms: null },
    { role: 'coord', allowed_statuses: '["TRIAGING","PLAN-READY","DECIDING","DECISION-READY","BLOCKED"]', terminal_statuses: '["PLAN-READY","BLOCKED"]', can_write_code: 0, requires_repro_first: 0, panel_participant: 0, can_escalate: 1, session_policy: 'fresh', required_artifacts: '["changes.md"]', timeout_ms: null, checkin_ms: 120000 },
    { role: 'deliberation', allowed_statuses: '["ROUND-n","CONSENSUS","SETTLED"]', terminal_statuses: '["SETTLED"]', can_write_code: 0, requires_repro_first: 0, panel_participant: 1, can_escalate: 0, session_policy: 'fresh', required_artifacts: '[]', timeout_ms: null, checkin_ms: null },
    { role: 'panelist', allowed_statuses: '["VERDICT-READY"]', terminal_statuses: '["VERDICT-READY"]', can_write_code: 0, requires_repro_first: 0, panel_participant: 1, can_escalate: 0, session_policy: 'fresh', required_artifacts: '[]', timeout_ms: null, checkin_ms: null },
    { role: 'red-team', allowed_statuses: '["ROUND-n","CLEAN","BROKEN"]', terminal_statuses: '["CLEAN","BROKEN"]', can_write_code: 0, requires_repro_first: 0, panel_participant: 1, can_escalate: 0, session_policy: 'fresh', required_artifacts: '[]', timeout_ms: null, checkin_ms: null },
    { role: 'routine-implementer', allowed_statuses: '["PROPOSED","WORKING","DONE","BLOCKED"]', terminal_statuses: '["DONE","BLOCKED"]', can_write_code: 1, requires_repro_first: 0, panel_participant: 0, can_escalate: 1, session_policy: 'fresh', required_artifacts: '["changes.md"]', timeout_ms: null, checkin_ms: 120000 }
  ];
  const roleCapabilitiesSql = (db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='role_capabilities'"
  ).get() as { sql?: string } | undefined)?.sql || '';
  for (const c of capSeeds) {
    if (['discovery', 'plancore', 'ibrain'].includes(c.role) && !roleCapabilitiesSql.includes("'ibrain'")) continue;
    db.prepare(`INSERT OR IGNORE INTO role_capabilities (role, allowed_statuses, terminal_statuses, can_write_code, requires_repro_first, panel_participant, can_escalate, session_policy, required_artifacts, timeout_ms, checkin_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(c.role, c.allowed_statuses, c.terminal_statuses, c.can_write_code, c.requires_repro_first, c.panel_participant, c.can_escalate, c.session_policy, c.required_artifacts, c.timeout_ms, c.checkin_ms);
  }

  // ESC1 ladder seeds (implementer + validator +2 rungs per spec). Lookup after agents+models.
  // Base (rung 0) = agents.default_model_id. Only +1/+2 here.
  const ladderSeeds = [
    // implementer: rung0 grok-4.5 (or gpt-5.3), rung1 gpt-5.5, rung2 claude-opus-5
    { agentName: 'implementer', position: 1, modelName: 'codex-5.5' },   // gpt-5.5
    { agentName: 'implementer', position: 2, modelName: 'claude-opus' }, // claude-opus-5
    // validator: rung0 claude-sonnet, rung1 gpt-5.5, rung2 claude-opus-5
    { agentName: 'validator', position: 1, modelName: 'codex-5.5' },
    { agentName: 'validator', position: 2, modelName: 'claude-opus' }
  ];
  for (const l of ladderSeeds) {
    const agentRow = db.prepare('SELECT id FROM agents WHERE name = ?').get(l.agentName) as { id: number } | undefined;
    const modelRow = db.prepare('SELECT id FROM models WHERE name = ?').get(l.modelName) as { id: number } | undefined;
    if (agentRow && modelRow) {
      db.prepare(`INSERT OR IGNORE INTO agent_escalations (agent_id, position, model_id, trigger) VALUES (?,?,?, 'on-fail')`).run(agentRow.id, l.position, modelRow.id);
    }
  }
}

/**
 * v114 (cycle-branch-lifecycle B2 / R3.1, R3.3): seed the facts-only role_capabilities row for
 * the house role 'branch-safety' — reports branch/git facts, never decides, blocks, panels, or
 * escalates. Deliberately NOT folded into applyB3AgentRoleCapabilitySeeds's capSeeds: that
 * function also runs from several pre-v114 migration blocks (older role_capabilities CHECK), and
 * an INSERT of a role the CHECK doesn't accept yet would abort those upgrades.
 */
export function applyB2BranchSafetyCapabilitySeed(db: Database.Database): void {
  const hasRoleCapabilities = !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='role_capabilities'"
  ).get();
  if (!hasRoleCapabilities) return;
  db.prepare(`
INSERT OR IGNORE INTO role_capabilities (
  role, allowed_statuses, terminal_statuses, can_write_code, requires_repro_first,
  panel_participant, can_escalate, session_policy, required_artifacts, timeout_ms, checkin_ms
) VALUES ('branch-safety', '["DONE"]', '["DONE"]', 0, 0, 0, 0, 'fresh', '[]', NULL, NULL)
`).run();
}

/**
 * B11 / AC-3 — panelist retirement (SAFE path):
 * - KEEP the panelist agent row (classification=solo) so runtime panel-service + OFF-adaptive
 *   fallback that spawn role 'panelist' still resolve definitions/callbacks.
 * - HIDE from product UI surfaces via in_development=1 (Add agent / Add-all / primary-driver
 *   candidates already filter in_development; add-all SQL skips in_development).
 * - UNBIND as a live seat owner: role_defaults, role_bindings, project_agents, primary_driver.
 * Idempotent. Does NOT remove role_capabilities.panelist or rewrite panel-service.
 */
export function applyB11PanelistRetirement(db: Database.Database): void {
  const hasAgents = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agents'").get();
  if (!hasAgents) return;

  const agentCols = (db.prepare('PRAGMA table_info(agents)').all() as Array<{ name: string }>).map((c) => c.name);
  const hasInDev = agentCols.includes('in_development');
  const hasClassification = agentCols.includes('classification');

  const panelist = db.prepare("SELECT id FROM agents WHERE name = 'panelist'").get() as { id: number } | undefined;
  if (panelist) {
    const sets: string[] = [];
    if (hasInDev) sets.push('in_development = 1');
    if (hasClassification) sets.push("classification = 'solo'");
    sets.push("updated_at = datetime('now')");
    if (sets.length) {
      db.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?`).run(panelist.id);
    }

    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='projects'").get()) {
      const pcols = (db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>).map((c) => c.name);
      if (pcols.includes('primary_driver_agent_id')) {
        db.prepare(
          'UPDATE projects SET primary_driver_agent_id = NULL WHERE primary_driver_agent_id = ?'
        ).run(panelist.id);
      }
    }

    // Explicit child cleanup first (mirrors B09b) so older FK shapes without CASCADE still work.
    // Only touch project_agent_* tables when project_agents itself exists — intermediate synthetic
    // DBs can have orphan child tables that FK-check against main.project_agents on DELETE.
    const hasProjectAgents = !!db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_agents'")
      .get();
    if (hasProjectAgents) {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_agent_toolkits'").get()) {
        db.prepare('DELETE FROM project_agent_toolkits WHERE agent_id = ?').run(panelist.id);
      }
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_agent_escalations'").get()) {
        db.prepare('DELETE FROM project_agent_escalations WHERE agent_id = ?').run(panelist.id);
      }
      db.prepare('DELETE FROM project_agents WHERE agent_id = ?').run(panelist.id);
    }
  }

  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='role_defaults'").get()) {
    db.prepare("DELETE FROM role_defaults WHERE role = 'panelist'").run();
  }
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='role_bindings'").get()) {
    db.prepare("DELETE FROM role_bindings WHERE role = 'panelist'").run();
  }
}

/**
 * B1: seed default teams + members (idempotent).
 * Resolve model ids by exact name from models table; skip member if model absent.
 * Called from fresh extras + from mig block.
 */
export function applyB1TeamsSeeds(db: Database.Database): void {
  const teamSeeds = [
    { name: 'deliberation-team', type: 'deliberation', consensus_rule: 'unanimous <=3 rounds; opus+codex-5.5 settle' },
    { name: 'red-team', type: 'red-team', consensus_rule: 'N-consecutive-CLEAN over N distinct lenses (standard)' }
  ];
  for (const t of teamSeeds) {
    db.prepare(`INSERT OR IGNORE INTO teams (name, type, consensus_rule) VALUES (?,?,?)`).run(t.name, t.type, t.consensus_rule);
  }

  // deliberation-team: opus(claude-opus), codex-5.5, sonnet(claude-sonnet), spark
  const delibNames = ['claude-opus', 'codex-5.5', 'claude-sonnet', 'spark'];
  const delibTeamRow = db.prepare('SELECT id FROM teams WHERE name = ?').get('deliberation-team') as { id: number } | undefined;
  if (delibTeamRow) {
    delibNames.forEach((mname, i) => {
      const m = db.prepare('SELECT id FROM models WHERE name = ?').get(mname) as { id: number } | undefined;
      if (m) {
        db.prepare(`INSERT OR IGNORE INTO team_members (team_id, model_id, position) VALUES (?,?,?)`).run(delibTeamRow.id, m.id, i + 1);
      }
    });
  }

  // red-team: codex-5.5, sonnet, spark (standard tier)
  const redNames = ['codex-5.5', 'claude-sonnet', 'spark'];
  const redTeamRow = db.prepare('SELECT id FROM teams WHERE name = ?').get('red-team') as { id: number } | undefined;
  if (redTeamRow) {
    redNames.forEach((mname, i) => {
      const m = db.prepare('SELECT id FROM models WHERE name = ?').get(mname) as { id: number } | undefined;
      if (m) {
        db.prepare(`INSERT OR IGNORE INTO team_members (team_id, model_id, position) VALUES (?,?,?)`).run(redTeamRow.id, m.id, i + 1);
      }
    });
  }
}

/**
 * A3: seed the 9 routing rules VERBATIM from OrchestratorLoop's current hardcoded FSM.
 * Idempotent by cardinality (only inserts if the table is empty) rather than per-row OR IGNORE,
 * since (emitter_role, when_status) is not unique-constrained (a later Studio-edit batch may add
 * disabled overrides alongside the core row). All 9 are marked is_core=1 (protected transitions).
 * Data-model batch only — OrchestratorLoop does NOT consult this table yet (that is batch A4).
 * Called from fresh init (post-SCHEMA_SQL) and from the v49→v50 migration block.
 */
export function seedRoutingRules(db: Database.Database): void {
  const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='routing_rules'").get();
  if (!hasTable) return;
  const existing = db.prepare('SELECT COUNT(*) as c FROM routing_rules').get() as { c: number };
  if (existing.c > 0) return;

  const rules: Array<{ emitter_role: string; when_status: string; handler_role: string; action: string; note: string }> = [
    { emitter_role: 'implementer', when_status: 'DONE', handler_role: 'validator', action: 'validate', note: 'implementer DONE -> validator validates' },
    { emitter_role: 'implementer', when_status: 'BLOCKED', handler_role: 'ibrain', action: 'decide', note: 'implementer BLOCKED -> ibrain decides' },
    { emitter_role: 'validator', when_status: 'PASS', handler_role: 'red-team', action: 'advance', note: 'validator PASS -> advance to red-team' },
    { emitter_role: 'validator', when_status: 'FAIL', handler_role: 'implementer', action: 'correction', note: 'validator FAIL -> implementer correction' },
    { emitter_role: 'validator', when_status: 'REVISE', handler_role: 'implementer', action: 'correction', note: 'validator REVISE -> implementer correction' },
    { emitter_role: '(algo)', when_status: 'rung-attempt-limit', handler_role: 'ibrain', action: 'escalate', note: 'rung attempt limit reached -> ibrain escalates' },
    { emitter_role: 'validator', when_status: 'REPRO-CONFIRMED', handler_role: 'implementer', action: 'fix', note: 'validator REPRO-CONFIRMED -> implementer fixes' },
    { emitter_role: 'validator', when_status: 'REPRO-FAILED', handler_role: '(algo)', action: 'retry-then-defer', note: 'validator REPRO-FAILED -> algo retry-then-defer' },
    { emitter_role: '(algo)', when_status: 'no-callback', handler_role: '(same-role)', action: 'respawn', note: 'no callback received -> respawn same role' }
  ];

  const stmt = db.prepare(`
    INSERT INTO routing_rules (emitter_role, when_status, handler_role, action, is_core, enabled, note)
    VALUES (?, ?, ?, ?, 1, 1, ?)
  `);
  for (const r of rules) {
    stmt.run(r.emitter_role, r.when_status, r.handler_role, r.action, r.note);
  }
}
