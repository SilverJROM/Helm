/**
 * Phase A — Helm agent-port seed
 * Seeds distilled agent prompts + side-skill toolkits into data/helm.db.
 * Idempotent: safe to re-run. No engine logic changes.
 *
 * Run:  npx tsx seeds/agent-port-2026-06-19/seed.ts
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// ── paths ────────────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.resolve(__dirname, '../../data/helm.db');
const SEED_DIR = __dirname; // seeds/agent-port-2026-06-19/

function readMd(rel: string): string {
  return fs.readFileSync(path.join(SEED_DIR, rel), 'utf8');
}

// ── open DB ──────────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── (a) BACKUP FIRST ─────────────────────────────────────────────────────────
const BACKUP_PATH = path.join(SEED_DIR, 'backup-before-seed.json');
if (!fs.existsSync(BACKUP_PATH)) {
  const agents = db
    .prepare('SELECT id, name, definition_md FROM agents ORDER BY id')
    .all() as { id: number; name: string; definition_md: string | null }[];
  const agentToolkits = db
    .prepare('SELECT agent_id, toolkit_id FROM agent_toolkits ORDER BY agent_id, toolkit_id')
    .all() as { agent_id: number; toolkit_id: number }[];
  fs.writeFileSync(BACKUP_PATH, JSON.stringify({ agents, agent_toolkits: agentToolkits }, null, 2));
  console.log(`[backup] Written to ${BACKUP_PATH}`);
} else {
  console.log(`[backup] Already exists — skipping overwrite (preserving original backup)`);
}

// ── (b) UPSERT TOOLKITS by name ──────────────────────────────────────────────
interface ToolkitEntry {
  name: string;
  file: string; // relative to side-skills/ or teams/
  dir: 'side-skills' | 'teams';
}

const TOOLKITS: ToolkitEntry[] = [
  { name: 'evidence-quality-gate',    file: 'evidence-quality-gate.md',   dir: 'side-skills' },
  { name: 'projcore-brief-template',  file: 'projcore-brief-template.md', dir: 'side-skills' },
  { name: 'atomic-task-rule',         file: 'atomic-task-rule.md',        dir: 'side-skills' },
  { name: 'verifier-not-fixer',       file: 'verifier-not-fixer.md',      dir: 'side-skills' },
  { name: 'deliberation-protocol',    file: 'deliberation-protocol.md',   dir: 'side-skills' },
  { name: 'redteam-protocol',         file: 'redteam-protocol.md',        dir: 'side-skills' },
  { name: 'single-lens-verdict',      file: 'single-lens-verdict.md',     dir: 'side-skills' },
  { name: 'issue-repro-and-defer',    file: 'issue-repro-and-defer.md',   dir: 'side-skills' },
  { name: 'budget-and-escalation',    file: 'budget-and-escalation.md',   dir: 'side-skills' },
];

const upsertToolkit = db.prepare(`
  INSERT INTO toolkits (name, description, body_md)
  VALUES (@name, @description, @body_md)
  ON CONFLICT(name) DO UPDATE SET
    body_md    = excluded.body_md,
    updated_at = datetime('now')
`);

db.transaction(() => {
  for (const tk of TOOLKITS) {
    const body = readMd(`${tk.dir}/${tk.file}`);
    upsertToolkit.run({ name: tk.name, description: tk.name, body_md: body });
    console.log(`[toolkit] upsert: ${tk.name}`);
  }
})();

// ── (c) UPDATE definition_md for existing agents ──────────────────────────────
interface AgentDefEntry {
  name: string;   // agent name in DB
  file: string;   // relative path from SEED_DIR
}

const AGENT_DEFS: AgentDefEntry[] = [
  { name: 'projcore',            file: 'projcore.md' },
  { name: 'coord',               file: 'coord.md' },
  { name: 'implementer',         file: 'implementer.md' },
  { name: 'routine-implementer', file: 'routine-implementer.md' },
  { name: 'validator',           file: 'validator.md' },
  { name: 'planner',             file: 'planner.md' },
  { name: 'panelist',            file: 'panelist.md' },
  { name: 'deliberation',        file: 'teams/deliberation-team.md' },
  { name: 'red-team',            file: 'teams/red-team.md' },
];

const updateDef = db.prepare(`
  UPDATE agents SET definition_md = @definition_md, updated_at = datetime('now')
  WHERE name = @name
`);

db.transaction(() => {
  for (const ag of AGENT_DEFS) {
    const definition_md = readMd(ag.file);
    const info = updateDef.run({ definition_md, name: ag.name });
    if (info.changes === 0) {
      console.warn(`[agent-def] WARNING: agent '${ag.name}' not found in DB — skipped`);
    } else {
      console.log(`[agent-def] updated definition_md for '${ag.name}' (${definition_md.length} chars)`);
    }
  }
})();

// ── (d) CREATE-IF-MISSING: lead + reviewer ────────────────────────────────────

// Resolve model id by partial name match
function resolveModelId(likeName: string): number | null {
  const row = db
    .prepare(`SELECT id FROM models WHERE name LIKE ? ORDER BY id DESC LIMIT 1`)
    .get(`%${likeName}%`) as { id: number } | undefined;
  return row ? row.id : null;
}

const newAgents: Array<{
  name: string;
  provider: string;
  model: string;
  default_effort: string;
  spawn_pref: string;
  definition_md: string;
  default_model_like: string;
  backup_model_like: string | null;
}> = [
  {
    name: 'lead',
    provider: 'claude',
    model: 'claude-opus-4-8',
    default_effort: 'medium',
    spawn_pref: 'tmux',
    definition_md: readMd('lead.md'),
    default_model_like: 'claude-opus',
    backup_model_like: 'codex-5.5',
  },
  {
    name: 'reviewer',
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    default_effort: 'medium',
    spawn_pref: 'tmux',
    definition_md: readMd('reviewer.md'),
    default_model_like: 'claude-sonnet',
    backup_model_like: 'codex-5.5',
  },
];

const insertAgent = db.prepare(`
  INSERT INTO agents (name, provider, model, default_effort, spawn_pref, definition_md, default_model_id, backup_model_id)
  VALUES (@name, @provider, @model, @default_effort, @spawn_pref, @definition_md, @default_model_id, @backup_model_id)
`);

db.transaction(() => {
  for (const ag of newAgents) {
    const existing = db
      .prepare('SELECT id FROM agents WHERE name = ?')
      .get(ag.name) as { id: number } | undefined;
    if (existing) {
      console.log(`[new-agent] '${ag.name}' already exists (id=${existing.id}) — skipping insert`);
      continue;
    }
    const default_model_id = resolveModelId(ag.default_model_like);
    const backup_model_id = ag.backup_model_like ? resolveModelId(ag.backup_model_like) : null;
    insertAgent.run({
      name: ag.name,
      provider: ag.provider,
      model: ag.model,
      default_effort: ag.default_effort,
      spawn_pref: ag.spawn_pref,
      definition_md: ag.definition_md,
      default_model_id,
      backup_model_id,
    });
    console.log(
      `[new-agent] created '${ag.name}' default_model_id=${default_model_id} backup_model_id=${backup_model_id}`
    );
  }
})();

// ── (e) ATTACH toolkits ───────────────────────────────────────────────────────

interface ToolkitAttachment {
  agentName: string;
  toolkitNames: string[];
}

const ATTACHMENTS: ToolkitAttachment[] = [
  {
    agentName: 'projcore',
    toolkitNames: [
      'projcore-brief-template',
      'evidence-quality-gate',
      'atomic-task-rule',
      'verifier-not-fixer',
      'issue-repro-and-defer',
      'budget-and-escalation',
      'deliberation-protocol',
      'redteam-protocol',
    ],
  },
  {
    agentName: 'coord',
    toolkitNames: ['projcore-brief-template', 'evidence-quality-gate', 'verifier-not-fixer'],
  },
  {
    agentName: 'implementer',
    toolkitNames: ['budget-and-escalation'],
  },
  {
    agentName: 'routine-implementer',
    toolkitNames: ['budget-and-escalation'],
  },
  {
    agentName: 'validator',
    toolkitNames: [
      'verifier-not-fixer',
      'evidence-quality-gate',
      'issue-repro-and-defer',
      'budget-and-escalation',
    ],
  },
  {
    agentName: 'reviewer',
    toolkitNames: ['verifier-not-fixer', 'evidence-quality-gate'],
  },
  {
    agentName: 'panelist',
    toolkitNames: ['single-lens-verdict', 'verifier-not-fixer'],
  },
  {
    agentName: 'deliberation',
    toolkitNames: ['deliberation-protocol', 'single-lens-verdict', 'verifier-not-fixer'],
  },
  {
    agentName: 'red-team',
    toolkitNames: ['redteam-protocol', 'single-lens-verdict', 'verifier-not-fixer'],
  },
  // planner + lead: no toolkits this phase
];

const insertAttachment = db.prepare(`
  INSERT OR IGNORE INTO agent_toolkits (agent_id, toolkit_id, position)
  VALUES (@agent_id, @toolkit_id, @position)
`);

db.transaction(() => {
  for (const att of ATTACHMENTS) {
    const agRow = db
      .prepare('SELECT id FROM agents WHERE name = ?')
      .get(att.agentName) as { id: number } | undefined;
    if (!agRow) {
      console.warn(`[attach] WARNING: agent '${att.agentName}' not found — skipping`);
      continue;
    }

    att.toolkitNames.forEach((tkName, idx) => {
      const tkRow = db
        .prepare('SELECT id FROM toolkits WHERE name = ?')
        .get(tkName) as { id: number } | undefined;
      if (!tkRow) {
        console.warn(`[attach] WARNING: toolkit '${tkName}' not found — skipping`);
        return;
      }
      const info = insertAttachment.run({
        agent_id: agRow.id,
        toolkit_id: tkRow.id,
        position: idx,
      });
      if (info.changes > 0) {
        console.log(`[attach] ${att.agentName} ← ${tkName} (pos=${idx})`);
      } else {
        console.log(`[attach] ${att.agentName} ← ${tkName} (already linked, no-op)`);
      }
    });
  }
})();

console.log('\n[seed] Complete.');
db.close();
