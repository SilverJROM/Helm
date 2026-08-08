import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { DatabaseService } from './db/database.js';
import { ModelService } from './services/model-service.js';
import { AgentAssignmentService, RoleCapabilityService } from './services/agent-assignment-service.js';
import { MasterModelService } from './services/master-model-service.js';
import { createRequireOwner } from './auth/auth-middleware.js';
import {
  SCHEMA_VERSION,
  B04_CANONICAL_MODEL_SEEDS,
  B04_CANONICAL_SLUGS,
  buildLaunchAllowlistedModelIds,
} from './db/schema.js';
import { PROVIDERS } from './config/providers.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b1-model-'));
  const dbPath = path.join(dir, 'test.db');
  return {
    dbPath,
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  };
}

/**
 * FIX-Q13-COUNTS: assert listModels properties from seed sources — never a snapshot length.
 * Every B04 canonical seed present exactly once by slug; list names unique;
 * B04 rows have unique model_ids among themselves; static-provider rows launch-allowlisted.
 * (Legacy B3 name rows may share model_id with B04 slug rows — dual identity is intentional.)
 */
function assertListModelsProperties(list: Array<{ slug?: string | null; model_id: string; provider: string; name: string }>) {
  expect(B04_CANONICAL_MODEL_SEEDS.length).toBe(B04_CANONICAL_SLUGS.length);
  expect(list.length).toBeGreaterThan(0);

  const allowed = buildLaunchAllowlistedModelIds();
  const names = list.map((m) => m.name);
  expect(new Set(names).size).toBe(names.length);

  const b04SlugSet = new Set(B04_CANONICAL_SLUGS as readonly string[]);
  const b04Rows = list.filter((m) => m.slug && b04SlugSet.has(m.slug));
  const b04ModelIds = b04Rows.map((m) => m.model_id);
  expect(new Set(b04ModelIds).size).toBe(b04ModelIds.length);

  for (const seed of B04_CANONICAL_MODEL_SEEDS) {
    const hits = list.filter((m) => m.slug === seed.slug);
    expect(hits, `B04 seed slug ${seed.slug} must appear exactly once`).toHaveLength(1);
    expect(hits[0].model_id).toBe(seed.model_id);
    expect(hits[0].provider).toBe(seed.provider);
  }

  for (const m of list) {
    const p = (PROVIDERS as Record<string, { dynamicModels?: boolean }>)[m.provider];
    if (p?.dynamicModels) continue;
    expect(
      allowed.has(m.model_id),
      `listed model_id ${m.model_id} (${m.provider}) must be launch-allowlisted`
    ).toBe(true);
  }
}

describe('B1 ModelService (S1) + B2 agent bindings + delete ref-guard + v10 mig (S2)', () => {
  let dbPath: string;
  let cleanup: () => void;
  let ms: ModelService;
  let dbs: DatabaseService;

  beforeEach(() => {
    const t = makeTempDb();
    dbPath = t.dbPath;
    cleanup = t.cleanup;
    dbs = new DatabaseService(dbPath); // triggers schema + v9 mig or fresh
    ms = new ModelService(dbs);
  });

  afterEach(() => {
    cleanup();
  });

  it('fresh DB (or mig) yields SCHEMA_VERSION + B3 models + B04 canonical registry (structured approval + flags rendered)', () => {
    const ver = (dbs.raw.prepare("SELECT version FROM schema_version").get() as any).version;
    expect(ver).toBe(SCHEMA_VERSION);

    const list = ms.listModels();
    // FIX-Q13-COUNTS: property assert from B04 seeds — never snapshot length (was 26 pre-Q-13).
    assertListModelsProperties(list);

    const opus = list.find(m => m.name === 'claude-opus');
    expect(opus).toBeTruthy();
    expect(opus!.provider).toBe('claude');
    expect(opus!.model_id).toBe('claude-opus-5');
    expect(opus!.bypass).toBe(1);
    expect(opus!.permission_mode).toBe('bypassPermissions');

    const spark = list.find(m => m.name === 'spark');
    expect(spark).toBeTruthy();
    expect(spark!.effort).toBe('dynamic');
    expect(spark!.flags).toContain('dangerously');
    expect(spark!.bypass).toBe(1);
    expect(spark!.slug).toBe('spark');

    const sonnet = list.find(m => m.name === 'claude-sonnet');
    expect(sonnet!.effort).toBe('dynamic');
    expect(sonnet!.approval_policy).toBe('auto');

    // new B3 models present with structured
    const fable = list.find(m => m.name === 'claude-fable');
    expect(fable).toBeTruthy();
    expect(fable!.model_id).toBe('claude-fable-5');
    expect(fable!.bypass).toBe(0);

    const codex51mini = list.find(m => m.name === 'codex-5.1-mini');
    expect(codex51mini).toBeTruthy();
    expect(codex51mini!.bypass).toBe(0);

    // B04 R1.4 sample slugs (full set covered by assertListModelsProperties)
    expect(list.find(m => m.slug === 'opus5')?.model_id).toBe('claude-opus-5');
    expect(list.find(m => m.slug === 'codex54min')?.model_id).toBe('gpt-5.4-mini');
  });

  it('migration is idempotent (run-twice on same DB: no dupe seeds, list stable)', () => {
    const firstList = ms.listModels();
    assertListModelsProperties(firstList);

    // re-open (simulates re-run of mig on existing v9 DB)
    const dbs2 = new DatabaseService(dbPath);
    const ms2 = new ModelService(dbs2);
    const secondList = ms2.listModels();
    // Idempotent: same properties + stable name set (self-equality, not a literal length).
    assertListModelsProperties(secondList);
    expect(secondList.map((m) => m.name).sort()).toEqual(firstList.map((m) => m.name).sort());
    expect(secondList.length).toBe(firstList.length);

    const ver = (dbs2.raw.prepare("SELECT version FROM schema_version").get() as any).version;
    expect(ver).toBe(SCHEMA_VERSION);

    // names stable, no dups
    const names = secondList.map(m => m.name).sort();
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('claude-fable');
    expect(names).toContain('codex-5.1-mini');
    expect(names).toContain('claude-opus-4-7');
    expect(names).toContain('codex54min');
  });

  it('CRUD round-trips (create/get/list/update/delete); dynamic effort + flags preserved', () => {
    const created = ms.createModel({ cli: 'grok', name: 'b1-test-crud', provider: 'grok', model_id: 'grok-test', effort: 'dynamic', approval: 'bypass', flags: '--foo' });
    expect(created.id).toBeGreaterThan(0);
    expect(created.effort).toBe('dynamic');
    expect(created.flags).toBe('--foo');

    const got = ms.getModel(created.id);
    expect(got!.name).toBe('b1-test-crud');

    const listed = ms.listModels();
    expect(listed.some(m => m.name === 'b1-test-crud')).toBe(true);

    const updated = ms.updateModel(created.id, { effort: 'high', flags: null, model_id: 'grok-test-up' });
    expect(updated.effort).toBe('high');
    expect(updated.model_id).toBe('grok-test-up');
    expect(updated.flags).toBeNull();

    ms.deleteModel(created.id);
    expect(ms.getModel(created.id)).toBeNull();
  });

  it('createModel: invalid provider throws (routes will map to 400); duplicate name throws (routes will map to 409)', () => {
    expect(() => ms.createModel({ cli: 'foo', name: 'bad-prov', provider: 'foo', model_id: 'm' })).toThrow(/invalid provider/);

    ms.createModel({ cli: 'claude', name: 'dup-name', provider: 'claude', model_id: 'm1' });
    expect(() => ms.createModel({ cli: 'claude', name: 'dup-name', provider: 'claude', model_id: 'm2' })).toThrow(/model name must be unique/);
  });

  it('update unknown id throws; delete on missing is no-op (free in B1)', () => {
    expect(() => ms.updateModel(999999, { name: 'x' })).toThrow(/unknown model/);

    // free delete (no preflight in B1)
    ms.deleteModel(999999); // should not throw
    const list = ms.listModels();
    expect(list.length).toBeGreaterThanOrEqual(17); // B3 seeds untouched (free delete on missing)
  });

  it('B2 agent model-binding CRUD (default+backup+spawn_pref set/get, enum validate, model id validate)', () => {
    const as = new AgentAssignmentService(dbs);
    const m = ms.listModels().find(x => x.name === 'spark')!;
    const created = as.createAgent({ name: 'b2-bind-test', provider: 'codex', model: 'gpt-5.3-codex-spark', default_model_id: m.id, backup_model_id: null, spawn_pref: 'in-process' });
    expect(created.default_model_id).toBe(m.id);
    expect(created.spawn_pref).toBe('in-process');
    const got = as.getAgent(created.id);
    expect(got!.backup_model_id).toBeNull();
    const updated = as.updateAgent(created.id, { spawn_pref: 'tmux', backup_model_id: m.id });
    expect(updated.spawn_pref).toBe('tmux');
    expect(updated.backup_model_id).toBe(m.id);
    expect(() => as.createAgent({ name: 'b2-bad-spawn', provider: 'grok', model: 'grok-4.5', spawn_pref: 'foo' })).toThrow(/invalid spawn_pref/);
    expect(() => as.createAgent({ name: 'b2-bad-mid', provider: 'grok', model: 'grok-4.5', default_model_id: 999999 })).toThrow(/unknown model id/);
  });

  it('B2 ModelService.deleteModel ref-guard (409-mappable when in use by default/backup, ok when not)', () => {
    const as = new AgentAssignmentService(dbs);
    const m = ms.listModels().find(x => x.name === 'spark')!;
    const a = as.createAgent({ name: 'b2-ref-agent', provider: 'codex', model: 'gpt-5.3-codex-spark', default_model_id: m.id });
    expect(() => ms.deleteModel(m.id)).toThrow(/model in use by agents/);
    // backup ref too
    const m2 = ms.listModels().find(x => x.name === 'claude-sonnet')!;
    as.updateAgent(a.id, { backup_model_id: m2.id, default_model_id: null });
    expect(() => ms.deleteModel(m2.id)).toThrow(/in use/);
    // free after unref (also clean team_members + seeded-agent default_model_id refs + ladders/overrides)
    as.deleteAgent(a.id);
    dbs.raw.prepare('DELETE FROM team_members WHERE model_id = ?').run(m.id);
    dbs.raw.prepare('DELETE FROM team_members WHERE model_id = ?').run(m2.id);
    dbs.raw.prepare('DELETE FROM agent_escalations WHERE model_id = ?').run(m.id);
    dbs.raw.prepare('DELETE FROM agent_escalations WHERE model_id = ?').run(m2.id);
    dbs.raw.prepare('DELETE FROM project_agent_escalations WHERE model_id = ?').run(m.id);
    dbs.raw.prepare('DELETE FROM project_agent_escalations WHERE model_id = ?').run(m2.id);
    dbs.raw.prepare('UPDATE project_agents SET model_id = NULL WHERE model_id = ?').run(m.id);
    dbs.raw.prepare('UPDATE project_agents SET model_id = NULL WHERE model_id = ?').run(m2.id);
    dbs.raw.prepare('UPDATE project_agents SET backup_model_id = NULL WHERE backup_model_id = ?').run(m.id);
    dbs.raw.prepare('UPDATE project_agents SET backup_model_id = NULL WHERE backup_model_id = ?').run(m2.id);
    // Canonical roster + any leftover agents may still pin default/backup
    dbs.raw.prepare('UPDATE agents SET default_model_id = NULL WHERE default_model_id = ?').run(m.id);
    dbs.raw.prepare('UPDATE agents SET default_model_id = NULL WHERE default_model_id = ?').run(m2.id);
    dbs.raw.prepare('UPDATE agents SET backup_model_id = NULL WHERE backup_model_id = ?').run(m.id);
    dbs.raw.prepare('UPDATE agents SET backup_model_id = NULL WHERE backup_model_id = ?').run(m2.id);
    // role_tiers / team_tier_models / project_* (B12/B16) may also FK models
    for (const mid of [m.id, m2.id]) {
      try { dbs.raw.prepare('UPDATE role_tiers SET primary_model_id = NULL WHERE primary_model_id = ?').run(mid); } catch { /* ok */ }
      try { dbs.raw.prepare('UPDATE role_tiers SET backup_model_id = NULL WHERE backup_model_id = ?').run(mid); } catch { /* ok */ }
      try { dbs.raw.prepare('DELETE FROM team_tier_models WHERE model_id = ?').run(mid); } catch { /* ok */ }
      try { dbs.raw.prepare('UPDATE project_role_tiers SET primary_model_id = NULL WHERE primary_model_id = ?').run(mid); } catch { /* ok */ }
      try { dbs.raw.prepare('UPDATE project_role_tiers SET backup_model_id = NULL WHERE backup_model_id = ?').run(mid); } catch { /* ok */ }
      try { dbs.raw.prepare('DELETE FROM project_team_tier_models WHERE model_id = ?').run(mid); } catch { /* ok */ }
    }
    ms.deleteModel(m.id);
    ms.deleteModel(m2.id);
    expect(ms.getModel(m.id)).toBeNull();
  });

  it('v9→v10 migration safe on COPY of live db (preserves agents + names, backfills default_model_id for name matches grok-4.5/codex-5.5/claude-sonnet per gate 1, cols, version=10)', () => {
    const livePath = path.resolve(process.cwd(), 'data/helm.db');
    if (!fs.existsSync(livePath)) return; // env without live; gate will use test db too
    const t = makeTempDb();
    fs.copyFileSync(livePath, t.dbPath);
    const dbsCopy = new DatabaseService(t.dbPath);
    const ver = (dbsCopy.raw.prepare("SELECT version FROM schema_version").get() as any).version;
    expect(ver).toBe(SCHEMA_VERSION);
    const cols = dbsCopy.raw.prepare("PRAGMA table_info(agents)").all().map((c: any) => c.name);
    expect(cols).toContain('default_model_id');
    expect(cols).toContain('backup_model_id');
    expect(cols).toContain('spawn_pref');
    const ags = dbsCopy.raw.prepare("SELECT id,name,default_model_id,backup_model_id,spawn_pref FROM agents").all() as any[];
    expect(ags.length).toBeGreaterThanOrEqual(3);
    const gb = ags.find(x => x.name === 'grok-4.5');
    if (gb) expect(gb.default_model_id).toBeGreaterThan(0);
    const cs = ags.find(x => x.name === 'codex-5.5');
    if (cs) expect(cs.default_model_id).toBeGreaterThan(0);
    const son = ags.find(x => x.name === 'claude-sonnet');
    if (son) expect(son.default_model_id).toBeGreaterThan(0);
    t.cleanup();
  });

  it('D2 R-02A: v32 live migration PURGES model-named stub agents (grok-4.5/grok-composer/spark/codex-5.4) from COPY of live data/helm.db; stub MODELS retained; version toBe(SCHEMA_VERSION)', () => {
    const livePath = path.resolve(process.cwd(), 'data/helm.db');
    if (!fs.existsSync(livePath)) return; // env without live db; gate covered by fresh + synthetic migs
    // Snapshot live model names BEFORE migration — this env's live registry may not still carry
    // every historical stub model row (names drift). Only assert retention for names that exist live.
    const liveModelNames = new Set(
      (new Database(livePath, { readonly: true })
        .prepare('SELECT name FROM models')
        .all() as Array<{ name: string }>)
        .map((m) => m.name)
    );
    const t = makeTempDb();
    fs.copyFileSync(livePath, t.dbPath);
    const dbsCopy = new DatabaseService(t.dbPath);
    const ver = (dbsCopy.raw.prepare("SELECT version FROM schema_version").get() as any).version;
    expect(ver).toBe(SCHEMA_VERSION);
    const as = new AgentAssignmentService(dbsCopy);
    const names = as.listAgents().map((a: any) => a.name);
    // D2: the 4 model-named stub AGENTS are gone after migrating the live DB to v32.
    expect(names).not.toContain('grok-4.5');
    expect(names).not.toContain('grok-composer');
    expect(names).not.toContain('spark');
    expect(names).not.toContain('codex-5.4');
    // No role_binding dangles on a now-deleted agent (stale bindings were purged with the stubs).
    const dangling = dbsCopy.raw.prepare(
      "SELECT COUNT(*) AS c FROM role_bindings rb LEFT JOIN agents a ON a.id = rb.agent_id WHERE a.id IS NULL"
    ).get() as { c: number };
    expect(dangling.c).toBe(0);
    // The stub MODELS remain when present live (D2 removes agents only, not models).
    const modelNames = (dbsCopy.raw.prepare("SELECT name FROM models").all() as any[]).map((m: any) => m.name);
    for (const stubModel of ['grok-composer-2.5-fast', 'spark', 'codex-5.4'] as const) {
      if (liveModelNames.has(stubModel)) {
        expect(modelNames).toContain(stubModel);
      }
    }
    t.cleanup();
  });

  it('B3 AG1+AG2 (D2 R-02A): seeds the canonical role agents (definition_md = verbatim run-folder md content) + exactly 1 role_default per role + role_capabilities (typed, queryable); MIG1 never overwrites user-edited definition_md on re-seed/mig. Model-named stub agents (grok-4.5/grok-composer/spark/codex-5.4) NO LONGER seeded.', () => {
    const ver = (dbs.raw.prepare("SELECT version FROM schema_version").get() as any).version;
    expect(ver).toBe(SCHEMA_VERSION);

    const as = new AgentAssignmentService(dbs);
    const cs = new RoleCapabilityService(dbs);

    const agents = as.listAgents();
    // B09b (R2.11) + v89 + S15 + B3: canonical set including ibrain + housekeeper + branch-safety.
    expect(agents.length).toBe(12);
    const agentNames = agents.map(a => a.name).sort();
    // NAME-LAYER rename: north→discovery, projcore→plancore (agents.name only; roles unchanged).
    expect(agentNames).toEqual([
      'agent-master',
      'branch-safety',
      'discovery',
      'housekeeper',
      'ibrain',
      'implementer',
      'jkage',
      'overseer',
      'panelist',
      'plancore',
      'planner',
      'validator',
    ]);
    // D2 R-02A gate: model-named stub agents are no longer seeded.
    expect(agentNames).not.toContain('grok-4.5');
    expect(agentNames).not.toContain('grok-composer');
    expect(agentNames).not.toContain('spark');
    expect(agentNames).not.toContain('codex-5.4');
    // B09b: legacy / non-canonical names gone
    expect(agentNames).not.toContain('master_agent');
    expect(agentNames).not.toContain('jkagebunshin');
    expect(agentNames).not.toContain('coord');

    // definition_md present and contains signature content (verbatim from agents/*.md)
    const impl = agents.find(a => a.name === 'implementer')!;
    expect(impl.definition_md).toContain('# implementer — the builder');
    expect(impl.definition_md).toContain('First tool call in every reply: the callback STATUS line');
    // v89 splits the old dual-hat prompt into planning-only plancore and decision-only ibrain.
    const proj = agents.find(a => a.name === 'plancore')!;
    expect(proj.definition_md).toContain('clear-and-rehydrate');
    expect(proj.definition_md).not.toContain('escalation_authority: true');
    const ibrain = agents.find(a => a.name === 'ibrain')!;
    expect(ibrain.definition_md).toContain('escalation_authority: true');

    // B11 / AC-3: panelist retired as live seat owner — still a seeded agent (hidden), but not role_defaults
    const roleNames = ['discovery', 'ibrain', 'implementer', 'plancore', 'planner', 'validator'].sort();
    const roleDefs = as.listRoleDefaults();
    // B3: branch-safety house role is bound to its canonical agent (in addition to the 6 project seats).
    expect(roleDefs.length).toBe(7);
    const defRoles = roleDefs.map(r => r.role).sort();
    expect(defRoles).toEqual([...roleNames, 'branch-safety'].sort());
    expect(defRoles).not.toContain('panelist');

    // Final v90 role defaults resolve directly to their backing agents.
    const roleToAgentName: Record<string, string> = {};
    for (const r of roleNames) {
      const resolved = as.resolveProjectRole(999999, r); // no project binding -> falls to default
      expect(resolved).toBeTruthy();
      expect(resolved!.agent.name).toBe(roleToAgentName[r] ?? r);
    }

    // role caps (AG2) contain the final role keys + B2 branch-safety facts-only row.
    const caps = cs.listRoleCapabilities();
    expect(caps.length).toBe(12);
    const implCap = cs.getRoleCapability('implementer')!;
    expect(implCap.can_write_code).toBe(true);
    expect(implCap.can_escalate).toBe(true);
    expect(implCap.session_policy).toBe('fresh');
    expect(implCap.allowed_statuses).toContain('DONE');
    const projCap = cs.getRoleCapability('plancore')!;
    expect(projCap.session_policy).toBe('clear+rehydrate');
    expect(projCap.can_escalate).toBe(true);
    const valCap = cs.getRoleCapability('validator')!;
    expect(valCap.requires_repro_first).toBe(true);
    expect(valCap.can_write_code).toBe(false);

    // MIG1: user-edit def_md, re-open (sim mig), preserved
    const edited = '### USER-EDITED DEFINITION_MD — DO NOT OVERWRITE PER MIG1';
    as.updateAgent(impl.id, { definition_md: edited }, { surface: 'studio' });
    const dbs2 = new DatabaseService(dbPath);
    const as2 = new AgentAssignmentService(dbs2);
    const after = as2.getAgent(impl.id)!;
    expect(after.definition_md).toBe(edited);
    // other agents untouched
    const valAfter = as2.getAgent(agents.find(a => a.name==='validator')!.id)!;
    expect(valAfter.definition_md).toContain('# validator — the judge');
  });

  it('B3 MDL3+MDL4: providers registry expanded (createAgent validates every seeded model); refreshProviderModels succeeds (grok best-effort + codex/claude maintained); structured fields on models', () => {
    const as = new AgentAssignmentService(dbs);
    // newly added models from full seed + providers expansion must pass createAgent (MDL3 same-slice)
    expect(() => as.createAgent({ name: 'b3-reg-test-fable', provider: 'claude', model: 'claude-fable-5' })).not.toThrow();
    expect(() => as.createAgent({ name: 'b3-reg-test-c51mini', provider: 'codex', model: 'gpt-5.1-codex-mini' })).not.toThrow();
    expect(() => as.createAgent({ name: 'b3-reg-test-opus47', provider: 'claude', model: 'claude-opus-4-7' })).not.toThrow();

    // refresh (MDL4) non-fatal
    ms.refreshProviderModels('grok');
    ms.refreshProviderModels('codex');
    ms.refreshProviderModels('claude');

    // structured visible
    const m = ms.listModels().find(x => x.name === 'codex-5.1-max')!;
    expect(m.bypass).toBe(1);
    expect(m.approval_policy).toBe('never');
  });

  it('B3 MDL5: deleteModel blocked when model referenced by agent_escalations (or agents/project overrides); free after unref', () => {
    const as = new AgentAssignmentService(dbs);
    // a laddered model (from ESC1 seed): claude-opus (used by implementer/validator rung2)
    const laddered = ms.listModels().find(x => x.name === 'claude-opus')!;
    expect(() => ms.deleteModel(laddered.id)).toThrow(/model in use by/);
    // unref by removing the escalation rows + team_members (B1 seeds) (test only)
    dbs.raw.prepare('DELETE FROM agent_escalations WHERE model_id = ?').run(laddered.id);
    dbs.raw.prepare('DELETE FROM team_members WHERE model_id = ?').run(laddered.id);
    dbs.raw.prepare("UPDATE agents SET default_model_id = NULL WHERE name = 'ibrain'").run();
    // now free (no other refs in this test DB)
    ms.deleteModel(laddered.id);
    expect(ms.getModel(laddered.id)).toBeNull();
  });

  it('B9a deleteModel blocked when model is referenced by project backup override or project escalation override', () => {
    const as = new AgentAssignmentService(dbs);
    const guarded = ms.createModel({ cli: 'codex', name: `b9a-guarded-${Date.now()}`, provider: 'codex', model_id: `b9a-guarded-${Date.now()}`, effort: 'low' });
    const agent = as.createAgent({ name: `b9a-agent-${Date.now()}`, provider: 'codex', model: 'gpt-5.3-codex-spark' });
    dbs.raw.prepare("INSERT INTO projects (name, directory) VALUES (?,?)").run(`b9a-model-guard-${Date.now()}`, '/tmp/b9a-model-guard');
    const project = dbs.raw.prepare("SELECT id FROM projects WHERE directory = ?").get('/tmp/b9a-model-guard') as any;
    dbs.raw.prepare("INSERT INTO project_agents (project_id, agent_id, backup_model_id) VALUES (?,?,?)").run(project.id, agent.id, guarded.id);

    expect(() => ms.deleteModel(guarded.id)).toThrow(/project_agents/);

    dbs.raw.prepare('UPDATE project_agents SET backup_model_id = NULL WHERE project_id = ? AND agent_id = ?').run(project.id, agent.id);
    dbs.raw.prepare("INSERT INTO project_agent_escalations (project_id, agent_id, position, model_id, trigger) VALUES (?,?,?,?,?)").run(project.id, agent.id, 1, guarded.id, 'on-fail');
    expect(() => ms.deleteModel(guarded.id)).toThrow(/project_agent_escalations/);

    dbs.raw.prepare('DELETE FROM project_agent_escalations WHERE project_id = ? AND agent_id = ?').run(project.id, agent.id);
    ms.deleteModel(guarded.id);
    expect(ms.getModel(guarded.id)).toBeNull();
  });

  it('B1 R-01B1: fresh DB exposes validation_status via getModel/listModels/createModel (mapper path); defaults untested', () => {
    const ver = (dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version;
    expect(ver).toBe(SCHEMA_VERSION);

    const cols = dbs.raw.prepare('PRAGMA table_info(models)').all().map((c: any) => c.name);
    expect(cols).toContain('validation_status');
    expect(cols).toContain('validated_at');
    expect(cols).toContain('validation_detail');

    const seeded = ms.getModel(ms.listModels().find(m => m.name === 'spark')!.id)!;
    expect(seeded.validation_status).toBe('untested');
    expect(seeded.validated_at).toBeNull();
    expect(seeded.validation_detail).toBeNull();

    const created = ms.createModel({ cli: 'grok', name: 'b1-val-flag', provider: 'grok', model_id: 'grok-val-test' });
    expect(created.validation_status).toBe('untested');
    expect(created.validated_at).toBeNull();
    expect(created.validation_detail).toBeNull();

    const got = ms.getModel(created.id)!;
    expect(got.validation_status).toBe('untested');

    const listed = ms.listModels().find(m => m.id === created.id)!;
    expect(listed.validation_status).toBe('untested');
  });

  it('B1 R-01B1: v29→v30 migration on synthetic fixture adds cols + version=30; existing rows default untested', () => {
    const prePath = path.join(os.tmpdir(), `helm-pre-v29-${Date.now()}.db`);
    const pre = new Database(prePath);
    pre.exec(`
CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
CREATE TABLE models (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('claude','codex','grok')),
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
    pre.prepare('INSERT INTO schema_version (version) VALUES (29)').run();
    pre.prepare(`INSERT INTO models (name, provider, model_id) VALUES ('pre-v29-model', 'grok', 'grok-pre-v29')`).run();
    pre.close();

    const migDbs = new DatabaseService(prePath);
    const migMs = new ModelService(migDbs);
    const ver = (migDbs.raw.prepare('SELECT version FROM schema_version').get() as any).version;
    expect(ver).toBe(SCHEMA_VERSION);

    const cols = migDbs.raw.prepare('PRAGMA table_info(models)').all().map((c: any) => c.name);
    expect(cols).toContain('validation_status');
    expect(cols).toContain('validated_at');
    expect(cols).toContain('validation_detail');

    const row = migMs.getModel(migMs.listModels().find(m => m.name === 'pre-v29-model')!.id)!;
    expect(row.validation_status).toBe('untested');
    expect(row.validated_at).toBeNull();
    expect(row.validation_detail).toBeNull();

    migDbs.close();
    try { fs.unlinkSync(prePath); } catch {}
  });

  it('B1 R-01B1: GET /api/models/:id returns validation_status via rowToModel mapper', async () => {
    const created = ms.createModel({ cli: 'codex', name: 'b1-api-mapper', provider: 'codex', model_id: 'gpt-api-test' });
    const app = Fastify({ logger: false });
    const requireOwner = createRequireOwner();
    const simAuth = async (req: any) => { req.user = { role: 'owner' }; };
    app.get('/api/models/:id', { preHandler: [simAuth, requireOwner] }, async (req: any, reply: any) => {
      const id = Number(req.params.id);
      const m = ms.getModel(id);
      if (!m) return reply.code(404).send({ error: 'unknown model' });
      return { model: m };
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: `/api/models/${created.id}`,
      remoteAddress: '127.0.0.1'
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.model.validation_status).toBe('untested');
    expect(body.model.validated_at).toBeNull();
    expect(body.model.validation_detail).toBeNull();

    await app.close();
  });

  it('B1 R-01B1: v29→v30 migration on COPY of live data/helm.db preserves models + defaults untested (when live db present)', () => {
    const livePath = path.resolve(process.cwd(), 'data/helm.db');
    if (!fs.existsSync(livePath)) return;
    const t = makeTempDb();
    fs.copyFileSync(livePath, t.dbPath);
    const dbsCopy = new DatabaseService(t.dbPath);
    const msCopy = new ModelService(dbsCopy);
    const ver = (dbsCopy.raw.prepare('SELECT version FROM schema_version').get() as any).version;
    expect(ver).toBe(SCHEMA_VERSION);
    const cols = dbsCopy.raw.prepare('PRAGMA table_info(models)').all().map((c: any) => c.name);
    expect(cols).toContain('validation_status');
    const any = msCopy.listModels()[0];
    // v30 adds validation_status with a default of 'untested' for rows lacking it; existing rows keep
    // their real status. Assert the column holds a valid enum value (migration didn't corrupt it) rather
    // than hardcoding 'untested' — the live DB's first model may already be validated (env-robust).
    expect(['untested', 'valid', 'invalid']).toContain(any.validation_status);
    dbsCopy.close();
    t.cleanup();
  });
});

describe('v90 provider role vocabulary', () => {
  it('removes the compatibility role and keeps all three split roles represented', () => {
    const roles = Object.entries(PROVIDERS).flatMap(([provider, definition]) =>
      definition.models.flatMap((model) => model.eligibleRoles.map((role) => ({ provider, model: model.model, role })))
    );
    expect(roles.some((row) => String(row.role) === 'projcore')).toBe(false);
    for (const role of ['discovery', 'plancore', 'ibrain']) {
      expect(roles.some((row) => row.role === role), role).toBe(true);
    }
  });
});

// D1 R-02E: in_development flag on agents (per brief pattern using dbs + AgentAssignmentService)
describe('D1 R-02E: in_development flag on agents', () => {
  it('createAgent sets in_development=false by default', () => {
    const t = makeTempDb();
    const dbs = new DatabaseService(t.dbPath);
    const as = new AgentAssignmentService(dbs);
    const agent = as.createAgent({ name: 'd1-test-agent', provider: 'grok', model: 'grok-4.5' });
    expect(agent.in_development).toBe(false);
    t.cleanup();
  });

  it('updateAgent toggles in_development', () => {
    const t = makeTempDb();
    const dbs = new DatabaseService(t.dbPath);
    const as = new AgentAssignmentService(dbs);
    const agent = as.createAgent({ name: 'd1-toggle-agent', provider: 'grok', model: 'grok-4.5' });
    expect(agent.in_development).toBe(false);
    const toggled = as.updateAgent(agent.id, { in_development: true });
    expect(toggled.in_development).toBe(true);
    const reset = as.updateAgent(toggled.id, { in_development: false });
    expect(reset.in_development).toBe(false);
    t.cleanup();
  });
});

// D2 R-02A: model-named stub agents removed (schema v32). Purge the 4 stub agents
// (grok-4.5, grok-composer, spark, codex-5.4) + their stale role_bindings; real role agents
// and role_defaults intact. Stub MODELS are retained (D2 touches agents only).
describe('D2 R-02A: model-named stub agents removed (schema v32)', () => {
  // Seed the 4 stub agents + stale role_bindings into a fresh v32 DB, then DOWNGRADE schema_version
  // and re-open to drive the real migration runner from `fromVersion` → v32. Returns the stub ids.
  function seedStubsThenDowngrade(rawDb: Database.Database, fromVersion: number): number[] {
    const stubs = [
      { name: 'grok-4.5', provider: 'grok', model: 'grok-4.5' },
      { name: 'grok-composer', provider: 'grok', model: 'grok-composer-2.5-fast' },
      { name: 'spark', provider: 'codex', model: 'gpt-5.3-codex-spark' },
      { name: 'codex-5.4', provider: 'codex', model: 'gpt-5.4' }
    ];
    const ids: number[] = [];
    for (const s of stubs) {
      const r = rawDb.prepare('INSERT OR IGNORE INTO agents (name, provider, model) VALUES (?,?,?)').run(s.name, s.provider, s.model);
      const id = Number(r.lastInsertRowid) || (rawDb.prepare('SELECT id FROM agents WHERE name = ?').get(s.name) as { id: number }).id;
      ids.push(id);
    }
    // stale role_bindings mirroring the live data (project_id=1): implementer/plancore/red-team→grok-4.5,
    // validator→codex-5.4, red-team→grok-composer, red-team→spark.
    const [gbId, gcId, sparkId, cxId] = ids;
    const binds: Array<[string, number]> = [
      ['implementer', gbId], ['plancore', gbId], ['red-team', gbId],
      ['validator', cxId], ['red-team', gcId], ['red-team', sparkId]
    ];
    for (const [role, agentId] of binds) {
      rawDb.prepare('INSERT INTO role_bindings (project_id, role, agent_id) VALUES (1, ?, ?)').run(role, agentId);
    }
    rawDb.prepare('DELETE FROM schema_version').run();
    rawDb.prepare('INSERT INTO schema_version (version) VALUES (?)').run(fromVersion);
    return ids;
  }

  it('Test 1: fresh DB seeds NO model-named stub agents', () => {
    const t = makeTempDb();
    const dbs = new DatabaseService(t.dbPath); // fresh → v32
    const stubs = dbs.raw.prepare(
      "SELECT name FROM agents WHERE name IN ('grok-4.5','grok-composer','spark','codex-5.4')"
    ).all();
    expect(stubs).toHaveLength(0);
    // B09b + v89 + S15 + B3: fresh DB includes ibrain + housekeeper + branch-safety (12 canonical).
    expect(dbs.raw.prepare('SELECT COUNT(*) AS c FROM agents').get()).toEqual({ c: 12 });
    t.cleanup();
  });

  it('Test 2: v31→v32 migration removes the 4 stubs + their role_bindings; real agents intact', () => {
    const t = makeTempDb();
    const seedDbs = new DatabaseService(t.dbPath); // fresh (all tables, B09b canonical roster)
    const realAgentsBefore = (seedDbs.raw.prepare('SELECT name FROM agents').all() as any[]).map(a => a.name).sort();
    expect(realAgentsBefore).toHaveLength(12);
    const stubIds = seedStubsThenDowngrade(seedDbs.raw, 31);
    seedDbs.close();

    // re-open → migration runner drives 31 → SCHEMA_VERSION (v32 purge + later B09a/B09b)
    const migDbs = new DatabaseService(t.dbPath);
    expect((migDbs.raw.prepare('SELECT version FROM schema_version').get() as any).version).toBe(SCHEMA_VERSION);

    const stubCount = migDbs.raw.prepare(
      "SELECT COUNT(*) AS c FROM agents WHERE name IN ('grok-4.5','grok-composer','spark','codex-5.4')"
    ).get() as { c: number };
    expect(stubCount.c).toBe(0);
    const bindCount = migDbs.raw.prepare(
      `SELECT COUNT(*) AS c FROM role_bindings WHERE agent_id IN (${stubIds.join(',')})`
    ).get() as { c: number };
    expect(bindCount.c).toBe(0);
    // B09b + B11: role_defaults only for surviving same-named agents; panelist unbound (AC-3)
    // B11 unbound panelist; B3 adds branch-safety → 6 project seats + branch-safety = 7
    expect((migDbs.raw.prepare('SELECT COUNT(*) AS c FROM role_defaults').get() as { c: number }).c).toBe(7);
    // canonical roster stable
    const realAfter = (migDbs.raw.prepare('SELECT name FROM agents').all() as any[]).map(a => a.name).sort();
    expect(realAfter).toEqual(realAgentsBefore);
    migDbs.close();
    t.cleanup();
  });

  it('Test 3 (REDTEAM): v21→v32 migration does NOT resurrect stubs — the v22 re-seed runs BEFORE the v32 purge, so the purge must win', () => {
    const t = makeTempDb();
    const seedDbs = new DatabaseService(t.dbPath); // fresh v32 shape
    const stubIds = seedStubsThenDowngrade(seedDbs.raw, 21); // v21 → v22 re-seed block WILL fire
    seedDbs.close();

    const migDbs = new DatabaseService(t.dbPath);
    expect((migDbs.raw.prepare('SELECT version FROM schema_version').get() as any).version).toBe(SCHEMA_VERSION);
    // Even though the v22 block re-seeds these stub agents for <22 DBs, the end-of-runner v32 purge removes them.
    const stubCount = migDbs.raw.prepare(
      "SELECT COUNT(*) AS c FROM agents WHERE name IN ('grok-4.5','grok-composer','spark','codex-5.4')"
    ).get() as { c: number };
    expect(stubCount.c).toBe(0);
    const bindCount = migDbs.raw.prepare(
      `SELECT COUNT(*) AS c FROM role_bindings WHERE agent_id IN (${stubIds.join(',')})`
    ).get() as { c: number };
    expect(bindCount.c).toBe(0);
    migDbs.close();
    t.cleanup();
  });
});

// E2 (R-02F): house receptionist seeded (B09b: agent-master is canonical; master_agent pruned).
describe('E2: master_agent seed + v34 migration', () => {
  it('fresh DB has agent-master (canonical house receptionist) with non-null definition_md; master_agent pruned', () => {
    const t = makeTempDb();
    const dbs = new DatabaseService(t.dbPath);
    const ma = dbs.raw.prepare("SELECT * FROM agents WHERE name='agent-master'").get() as any;
    expect(ma).toBeTruthy();
    expect(ma.provider).toBe('claude');
    expect(ma.model).toBe('claude-sonnet-4-6');
    expect(ma.default_effort).toBe('medium');
    expect(ma.in_development).toBe(0);
    expect(ma.definition_md).toBeTruthy();
    expect(ma.definition_md).toMatch(/agent-master|receptionist/i);
    expect(dbs.raw.prepare("SELECT 1 FROM agents WHERE name='master_agent'").get()).toBeFalsy();
    t.cleanup();
  });

  it('v33→v34 migration path still lands agent-master after full upgrade (B09b prunes master_agent)', () => {
    const t = makeTempDb();
    try {
      // Open fresh DB, remove house receptionist, downgrade to v33
      const db1 = new DatabaseService(t.dbPath);
      db1.raw.prepare("DELETE FROM agents WHERE name IN ('master_agent','agent-master')").run();
      db1.raw.prepare("UPDATE schema_version SET version=33").run();
      db1.close();
      // Re-open → v34 inserts master_agent; B09a seeds agent-master; B09b prunes master_agent
      const db2 = new DatabaseService(t.dbPath);
      const ver = (db2.raw.prepare("SELECT version FROM schema_version").get() as any).version;
      expect(ver).toBe(SCHEMA_VERSION);
      const am = db2.raw.prepare("SELECT * FROM agents WHERE name='agent-master'").get() as any;
      expect(am).toBeTruthy();
      expect(am.provider).toBe('claude');
      expect(am.in_development).toBe(0);
      expect(am.definition_md).toBeTruthy();
      expect(db2.raw.prepare("SELECT 1 FROM agents WHERE name='master_agent'").get()).toBeFalsy();
      db2.close();
    } finally {
      t.cleanup();
    }
  });
});

// B2 (R-03/R-04): agent_type column + HELM stub seeds + service exposure
// B09b: legacy names master_agent/jkagebunshin pruned; canonical house = agent-master/jkage/overseer
describe('B2: agent_type + HELM stubs (R-03/R-04)', () => {
  it('fresh DB has agent_type column and canonical house agents with definition_md', () => {
    const t = makeTempDb();
    const dbs = new DatabaseService(t.dbPath);
    const as = new AgentAssignmentService(dbs);

    const cols = dbs.raw.prepare('PRAGMA table_info(agents)').all().map((c: any) => c.name);
    expect(cols).toContain('agent_type');

    const jkage = as.getAgent((dbs.raw.prepare("SELECT id FROM agents WHERE name='jkage'").get() as any).id)!;
    const overseer = as.getAgent((dbs.raw.prepare("SELECT id FROM agents WHERE name='overseer'").get() as any).id)!;
    const master = as.listAgents().find(a => a.name === 'agent-master')!;
    const impl = as.listAgents().find(a => a.name === 'implementer')!;

    expect(jkage.agent_type).toBe('house');
    expect(jkage.kind).toBe('house');
    expect(overseer.agent_type).toBe('house');
    expect(master.agent_type).toBe('house');
    expect(impl.agent_type).toBe('project');
    expect(impl.kind).toBe('project');
    expect(jkage.definition_md).toMatch(/jkage|L0/i);
    expect(overseer.definition_md).toContain('overseer');
    expect(jkage.definition_md!.length).toBeGreaterThan(0);
    expect(overseer.definition_md!.length).toBeGreaterThan(0);
    t.cleanup();
  });

  it('v17 synthetic DB migrates through v18 applyFreshDbExtras to SCHEMA_VERSION 38 with HELM agent_type', () => {
    const prePath = path.join(os.tmpdir(), `helm-pre-v17-b2-${Date.now()}.db`);
    try { fs.unlinkSync(prePath); } catch {}
    const pre = new Database(prePath);
    pre.exec(`
CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
CREATE TABLE agents (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('claude', 'codex', 'grok')),
  model TEXT NOT NULL,
  default_effort TEXT NOT NULL DEFAULT 'medium',
  definition_md TEXT,
  default_model_id INTEGER REFERENCES models(id),
  backup_model_id INTEGER REFERENCES models(id),
  spawn_pref TEXT NOT NULL DEFAULT 'tmux',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE models (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('claude','codex','grok')),
  model_id TEXT NOT NULL,
  effort TEXT NOT NULL DEFAULT 'medium',
  approval TEXT NOT NULL DEFAULT 'auto',
  flags TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO schema_version (version) VALUES (17);
INSERT INTO agents (name, provider, model) VALUES ('legacy-pre-v18', 'grok', 'grok-4.5');
`);
    pre.close();

    const dbs = new DatabaseService(prePath);
    const as = new AgentAssignmentService(dbs);
    const ver = (dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version;
    expect(ver).toBe(SCHEMA_VERSION);

    const cols = dbs.raw.prepare('PRAGMA table_info(agents)').all().map((c: any) => c.name);
    expect(cols).toContain('agent_type');

    const jkage = as.listAgents().find(a => a.name === 'jkage')!;
    const overseer = as.listAgents().find(a => a.name === 'overseer')!;
    const master = as.listAgents().find(a => a.name === 'agent-master')!;
    expect(jkage.agent_type).toBe('house');
    expect(jkage.kind).toBe('house');
    expect(overseer.agent_type).toBe('house');
    expect(master.agent_type).toBe('house');

    // B09b prunes non-canonical legacy-pre-v18
    expect(as.listAgents().find(a => a.name === 'legacy-pre-v18')).toBeFalsy();

    dbs.close();
    try { fs.unlinkSync(prePath); } catch {}
  });

  it('v21 synthetic DB (pre-v22) upgrades to SCHEMA_VERSION 38 without agent_type column error; HELM stubs seeded', () => {
    const prePath = path.join(os.tmpdir(), `helm-pre-v21-b2-${Date.now()}.db`);
    try { fs.unlinkSync(prePath); } catch {}
    const pre = new Database(prePath);
    pre.exec(`
CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
CREATE TABLE agents (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('claude', 'codex', 'grok')),
  model TEXT NOT NULL,
  default_effort TEXT NOT NULL DEFAULT 'medium',
  definition_md TEXT,
  default_model_id INTEGER REFERENCES models(id),
  backup_model_id INTEGER REFERENCES models(id),
  spawn_pref TEXT NOT NULL DEFAULT 'tmux',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE models (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('claude','codex','grok')),
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
CREATE TABLE role_defaults (
  role TEXT PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO schema_version (version) VALUES (21);
INSERT INTO agents (name, provider, model) VALUES ('legacy-pre-v22', 'grok', 'grok-4.5');
INSERT INTO models (name, provider, model_id) VALUES ('grok-4.5', 'grok', 'grok-4.5');
`);
    pre.close();

    expect(() => new DatabaseService(prePath)).not.toThrow();
    const dbs = new DatabaseService(prePath);
    const as = new AgentAssignmentService(dbs);
    expect((dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version).toBe(SCHEMA_VERSION);

    const jkage = as.listAgents().find(a => a.name === 'jkage')!;
    const overseer = as.listAgents().find(a => a.name === 'overseer')!;
    const master = as.listAgents().find(a => a.name === 'agent-master')!;
    expect(jkage.agent_type).toBe('house');
    expect(overseer.agent_type).toBe('house');
    expect(master.agent_type).toBe('house');

    dbs.close();
    try { fs.unlinkSync(prePath); } catch {}
  });

  it('v37→v38 migration adds agent_type + house agents idempotently on reopen', () => {
    const t = makeTempDb();
    try {
      const db1 = new DatabaseService(t.dbPath);
      db1.raw.prepare("DELETE FROM agents WHERE name IN ('jkage','jkagebunshin','overseer','agent-master','master_agent')").run();
      db1.raw.prepare('UPDATE schema_version SET version=37').run();
      db1.close();

      const db2 = new DatabaseService(t.dbPath);
      const as = new AgentAssignmentService(db2);
      const ver = (db2.raw.prepare('SELECT version FROM schema_version').get() as any).version;
      expect(ver).toBe(SCHEMA_VERSION);

      const cols = db2.raw.prepare('PRAGMA table_info(agents)').all().map((c: any) => c.name);
      expect(cols).toContain('agent_type');

      const jkage = as.listAgents().find(a => a.name === 'jkage')!;
      const overseer = as.listAgents().find(a => a.name === 'overseer')!;
      const master = as.listAgents().find(a => a.name === 'agent-master')!;
      expect(jkage.agent_type).toBe('house');
      expect(overseer.agent_type).toBe('house');
      expect(master.agent_type).toBe('house');
      expect(jkage.definition_md).toMatch(/jkage|L0/i);
      expect(overseer.definition_md).toContain('overseer');

      // idempotent reopen: second open must not duplicate house agents
      db2.close();
      const db3 = new DatabaseService(t.dbPath);
      const as3 = new AgentAssignmentService(db3);
      expect(as3.listAgents().filter(a => a.name === 'jkage')).toHaveLength(1);
      expect(as3.listAgents().filter(a => a.name === 'overseer')).toHaveLength(1);
      expect(as3.listAgents().filter(a => a.name === 'agent-master')).toHaveLength(1);
      db3.close();
    } finally {
      t.cleanup();
    }
  });

  it('MIG1: v38 re-seed does not overwrite user-edited definition_md', () => {
    const t = makeTempDb();
    try {
      const db1 = new DatabaseService(t.dbPath);
      const customMd = '# user-edited overseer profile — keep me';
      db1.raw.prepare("UPDATE agents SET definition_md = ? WHERE name = 'overseer'").run(customMd);
      db1.raw.prepare('UPDATE schema_version SET version=37').run();
      db1.close();

      const db2 = new DatabaseService(t.dbPath);
      const as = new AgentAssignmentService(db2);
      const overseer = as.getAgent((db2.raw.prepare("SELECT id FROM agents WHERE name='overseer'").get() as any).id)!;
      expect(overseer.definition_md).toBe(customMd);
      expect(overseer.agent_type).toBe('house');
      expect(overseer.kind).toBe('house');
      db2.close();
    } finally {
      t.cleanup();
    }
  });

  it('createAgent defaults kind=project; create/update validate project|house (helm alias → house)', () => {
    const t = makeTempDb();
    const dbs = new DatabaseService(t.dbPath);
    const as = new AgentAssignmentService(dbs);

    const created = as.createAgent({ name: 'b2-test-agent', provider: 'claude', model: 'claude-sonnet-4-6' });
    expect(created.agent_type).toBe('project');
    expect(created.kind).toBe('project');

    const house = as.createAgent({ name: 'b2-house-agent', provider: 'claude', model: 'claude-sonnet-4-6', kind: 'house' });
    expect(house.agent_type).toBe('house');
    expect(house.kind).toBe('house');

    // Legacy helm alias maps to house
    const viaHelm = as.createAgent({ name: 'b2-helm-alias', provider: 'claude', model: 'claude-sonnet-4-6', agent_type: 'helm' });
    expect(viaHelm.kind).toBe('house');

    const updated = as.updateAgent(created.id, { kind: 'house' });
    expect(updated.agent_type).toBe('house');
    expect(updated.kind).toBe('house');

    expect(() => as.createAgent({ name: 'b2-bad', provider: 'claude', model: 'claude-sonnet-4-6', kind: 'other' as any }))
      .toThrow(/invalid kind/);
    expect(() => as.updateAgent(created.id, { agent_type: 'bogus' }))
      .toThrow(/invalid kind/);

    const impl = as.listAgents().find(a => a.name === 'implementer')!;
    expect(as.getAgent(impl.id)!.agent_type).toBe('project');
    expect(as.getAgent(impl.id)!.kind).toBe('project');

    const defs = as.listRoleDefaults();
    const implDef = defs.find(d => d.role === 'implementer')!;
    expect(implDef.agent.agent_type).toBe('project');
    expect(implDef.agent.kind).toBe('project');

    // project binding JOIN must surface kind
    dbs.raw.prepare('INSERT INTO projects (name, directory) VALUES (?,?)').run('b2-proj', '/tmp/b2-proj');
    const pid = (dbs.raw.prepare("SELECT id FROM projects WHERE name='b2-proj'").get() as any).id;
    as.setProjectBinding(pid, 'implementer', impl.id);
    const binding = as.getProjectBinding(pid, 'implementer')!;
    expect(binding.agent.agent_type).toBe('project');
    expect(binding.agent.kind).toBe('project');

    t.cleanup();
  });
});

// B1 (kloo/D1): registry entry + 4 allow-lists + CHECK migration (agents/models widen to include
// 'kloo' + models.route column, v50→v51). See plan/WK_0628/kloo-agentstudio-run-2026-06-30/decisions.md §A+§B.
describe('B1 (kloo): provider allow-lists + v51 CHECK-widen migration', () => {
  it('fresh DB reaches current SCHEMA_VERSION; models.route column present', () => {
    const t = makeTempDb();
    const dbs = new DatabaseService(t.dbPath);
    expect((dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version).toBe(SCHEMA_VERSION);
    // kloo route column landed at v51; subsequent batches bump SCHEMA_VERSION (B03a=61, B04=62…).
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(51);
    const cols = dbs.raw.prepare('PRAGMA table_info(models)').all().map((c: any) => c.name);
    expect(cols).toContain('route');
    t.cleanup();
  });

  it('ModelService.requireProvider (via createModel) accepts kloo + persists route', () => {
    const t = makeTempDb();
    const dbs = new DatabaseService(t.dbPath);
    const ms = new ModelService(dbs);
    const created = ms.createModel({ cli: 'kloo', name: 'b1-kloo-model', provider: 'kloo', model_id: 'deepseek-v4-flash' });
    expect(created.provider).toBe('kloo');
    // route isn't part of the ModelService create/update surface yet (B2/B3 add the API); verify it's
    // settable directly at the DB layer (the column the migration added) and readable back.
    dbs.raw.prepare('UPDATE models SET route = ? WHERE id = ?').run('openrouter', created.id);
    const row = dbs.raw.prepare('SELECT route FROM models WHERE id = ?').get(created.id) as any;
    expect(row.route).toBe('openrouter');
    ms.deleteModel(created.id);
    t.cleanup();
  });

  it('AgentAssignmentService.requireProvider (via createAgent validation path) accepts kloo as a valid provider literal', () => {
    // createAgent additionally validates `model` against the (empty, dynamic) PROVIDERS['kloo'].models
    // list, which always rejects until B2 discovery lands — so we assert the allow-list itself via the
    // exported AgentProvider-shaped rejection message (invalid provider vs unknown model are distinct
    // errors; kloo must fail with "unknown model", never "invalid provider").
    const t = makeTempDb();
    const dbs = new DatabaseService(t.dbPath);
    const as = new AgentAssignmentService(dbs);
    expect(() => as.createAgent({ name: 'b1-kloo-agent', provider: 'kloo', model: 'whatever' }))
      .toThrow(/unknown model for provider kloo/);
    expect(() => as.createAgent({ name: 'b1-bad-agent', provider: 'not-a-provider', model: 'whatever' }))
      .toThrow(/invalid provider/);
    t.cleanup();
  });

  it('MasterModelService.setChain explicitly rejects kloo as a project master', () => {
    const t = makeTempDb();
    const dbs = new DatabaseService(t.dbPath);
    dbs.raw.prepare('INSERT INTO projects (name, directory) VALUES (?,?)').run('b1-kloo-master-proj', '/tmp/b1-kloo-master');
    const pid = (dbs.raw.prepare("SELECT id FROM projects WHERE name = ?").get('b1-kloo-master-proj') as any).id;
    const mms = new MasterModelService(dbs);
    expect(() => mms.setChain(pid, [{ provider: 'kloo', model: 'deepseek-v4-flash' }]))
      .toThrow(/kloo is not supported as a project master/);
    t.cleanup();
  });

  it('ModelValidationService.validate on a kloo model does REAL discovery-based validation (present→valid) via injected stub, no CLI spawn, does not block', async () => {
    const t = makeTempDb();
    const dbs = new DatabaseService(t.dbPath);
    const ms = new ModelService(dbs);
    const created = ms.createModel({ cli: 'kloo', name: 'b1-kloo-validate', provider: 'kloo', model_id: 'deepseek/deepseek-v4-flash', route: 'openrouter' });
    const { ModelValidationService } = await import('./services/model-validation-service.js');
    // Inject a stub discovery so this is deterministic and network-free.
    const stubDisc = { validate: async () => ({ ok: true }) };
    const mvs = new ModelValidationService(dbs, undefined, {}, undefined, stubDisc);
    const result = await mvs.validate(created.id);
    expect(result.status).toBe('valid');
    expect(result.detail).toMatch(/kloo: openrouter catalog has deepseek\/deepseek-v4-flash/);
    const row = ms.getModel(created.id)!;
    expect(row.validation_status).toBe('valid');
    expect(row.validation_detail).toMatch(/openrouter catalog has/);
    t.cleanup();
  });

  it('v50→v51 migration on COPY of live data/helm.db is non-destructive: version=51, agents/models/projects/routing_rules counts preserved, models.route present, kloo insert + cleanup round-trips, foreign_key_check clean, idempotent on reopen', () => {
    const livePath = path.resolve(process.cwd(), 'data/helm.db');
    if (!fs.existsSync(livePath)) return; // env without live db
    const t = makeTempDb();
    fs.copyFileSync(livePath, t.dbPath);

    const before = new Database(t.dbPath);
    const beforeCounts: Record<string, number> = {};
    for (const table of ['agents', 'models', 'projects', 'routing_rules']) {
      beforeCounts[table] = (before.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as any).c;
    }
    before.close();

    const dbsCopy = new DatabaseService(t.dbPath);
    expect((dbsCopy.raw.prepare('SELECT version FROM schema_version').get() as any).version).toBe(SCHEMA_VERSION);

    // projects/routing_rules must not lose rows. models may grow (B04 R1.4 upserts 10 canonical).
    // agents: B09a may add canonical names; B09b may prune non-canonical (net shrink allowed).
    for (const table of ['projects', 'routing_rules']) {
      const after = (dbsCopy.raw.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as any).c;
      expect(after).toBe(beforeCounts[table]);
    }
    const agentsAfter = (dbsCopy.raw.prepare(`SELECT COUNT(*) as c FROM agents`).get() as any).c;
    expect(agentsAfter).toBeGreaterThanOrEqual(9);
    const modelsAfter = (dbsCopy.raw.prepare(`SELECT COUNT(*) as c FROM models`).get() as any).c;
    // models may grow (B04) or shrink slightly (B25 fix1 orphan prune); floor R1.4.
    expect(modelsAfter).toBeGreaterThanOrEqual(10);
    expect(modelsAfter).toBeGreaterThanOrEqual(beforeCounts['models'] - 5);

    const cols = dbsCopy.raw.prepare('PRAGMA table_info(models)').all().map((c: any) => c.name);
    expect(cols).toContain('route');

    // kloo now accepted by the widened CHECK (include B03a NOT NULL cols when present)
    const inserted = cols.includes('cli')
      ? (dbsCopy.raw.prepare(
          `INSERT INTO models (name, provider, model_id, cli, slug, display_name, route) VALUES (?,?,?,?,?,?,?) RETURNING *`
        ).get('b1-live-copy-kloo-test', 'kloo', 'deepseek-v4-flash-b1test', 'kloo', 'b1-live-copy-kloo-test', 'B1 Live Kloo', 'openrouter') as any)
      : (dbsCopy.raw.prepare(
          `INSERT INTO models (name, provider, model_id, route) VALUES (?,?,?,?) RETURNING *`
        ).get('b1-live-copy-kloo-test', 'kloo', 'deepseek-v4-flash', 'openrouter') as any);
    expect(inserted.provider).toBe('kloo');
    expect(inserted.route).toBe('openrouter');
    dbsCopy.raw.prepare('DELETE FROM models WHERE id = ?').run(inserted.id);
    expect(dbsCopy.raw.prepare('SELECT COUNT(*) as c FROM models WHERE name = ?').get('b1-live-copy-kloo-test')).toEqual({ c: 0 });

    // a still-invalid provider is still rejected (CHECK not just widened to allow anything)
    expect(() => {
      if (cols.includes('cli')) {
        dbsCopy.raw.prepare(
          `INSERT INTO models (name, provider, model_id, cli, slug, display_name) VALUES (?,?,?,?,?,?)`
        ).run('b1-bad-provider', 'not-a-real-provider', 'x', 'claude', 'b1-bad-provider', 'Bad');
      } else {
        dbsCopy.raw.prepare(`INSERT INTO models (name, provider, model_id) VALUES (?,?,?)`).run('b1-bad-provider', 'not-a-real-provider', 'x');
      }
    }).toThrow();

    // Live data/helm.db may carry pre-existing orphans (e.g. dispatches→task_attempts).
    // Assert migration did not break FKs for tables this suite cares about (agents/models).
    const fkProblems = (dbsCopy.raw.prepare('PRAGMA foreign_key_check').all() as any[]).filter(
      (p: any) =>
        p.table === 'agents' ||
        p.table === 'models' ||
        p.parent === 'agents' ||
        p.parent === 'models'
    );
    expect(fkProblems).toHaveLength(0);

    dbsCopy.close();

    // idempotent reopen (models may grow via B04; agents B09a/B09b settle — stable after first open)
    const reopened = new DatabaseService(t.dbPath);
    expect((reopened.raw.prepare('SELECT version FROM schema_version').get() as any).version).toBe(SCHEMA_VERSION);
    for (const table of ['projects', 'routing_rules']) {
      const after = (reopened.raw.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as any).c;
      expect(after).toBe(beforeCounts[table]);
    }
    const agentsReopen = (reopened.raw.prepare(`SELECT COUNT(*) as c FROM agents`).get() as any).c;
    expect(agentsReopen).toBeGreaterThanOrEqual(9);
    // Reopen must not grow further vs post-migration (idempotent seeds)
    expect(agentsReopen).toBe(agentsAfter);
    const modelsReopen = (reopened.raw.prepare(`SELECT COUNT(*) as c FROM models`).get() as any).c;
    expect(modelsReopen).toBe(modelsAfter); // idempotent after first open (no further prune/grow)
    reopened.close();

    t.cleanup();
  });
});
