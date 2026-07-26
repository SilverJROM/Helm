import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseService } from './db/database.js';
import { TeamService } from './services/team-service.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

describe('TeamService + resolver team precedence (B6a/B3)', () => {
  let dbs: DatabaseService;
  let tmp: string;
  let svc: TeamService;
  let assignment: any;

  beforeEach(() => {
    tmp = path.join(os.tmpdir(), `helm-test-teams-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    dbs = new DatabaseService(tmp);
    svc = new TeamService(dbs);
    // use dynamic import to avoid top level
  });

  afterEach(() => {
    try { if (dbs) dbs.close(); } catch {}
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
  });

  it('creates team, adds members (model validated)', async () => {
    const models = dbs.prepare('SELECT id FROM models LIMIT 1').all() as any[];
    if (!models.length) return; // if no models in temp, skip assert
    const mid = models[0].id;
    dbs.prepare('UPDATE models SET validation_status = ? WHERE id = ?').run('valid', mid);
    const t = svc.createTeam({ name: 'test-delib', type: 'deliberation' });
    expect(t.name).toBe('test-delib');
    const m = svc.addMember(t.id, { model_id: mid });
    expect(m.model_id).toBe(mid);
    const ms = svc.listMembers(t.id);
    expect(ms.length).toBe(1);
  });

  it('resolver returns project-team-binding for team role when set', async () => {
    // minimal: seed a team + binding via assignment
    const { AgentAssignmentService } = await import('./services/agent-assignment-service.js');
    const as = new AgentAssignmentService(dbs);
    const teams = svc.listTeams();
    if (!teams.length) return;
    const tid = teams[0].id;
    // use existing project or skip
    const proj = dbs.prepare('SELECT id FROM projects LIMIT 1').get() as any;
    if (!proj) return;
    as.setProjectTeamBinding(proj.id, 'deliberation', tid);
    const res = as.resolveProjectRole(proj.id, 'deliberation');
    expect(res).toBeTruthy();
    expect(res.source).toBe('project-team-binding');
    expect(res.roster).toBeDefined();
  });

  it('agent_escalations CRUD via assignment + precedence: project override > default', async () => {
    const { AgentAssignmentService } = await import('./services/agent-assignment-service.js');
    const as = new AgentAssignmentService(dbs);
    // use seeded data
    const impl = dbs.prepare("SELECT id FROM agents WHERE name='implementer' LIMIT 1").get() as any;
    const grokM = dbs.prepare("SELECT id,name FROM models WHERE name LIKE '%grok%' LIMIT 1").get() as any;
    const codexM = dbs.prepare("SELECT id,name FROM models WHERE name='codex-5.5' LIMIT 1").get() as any;
    if (!impl || !grokM || !codexM) return;
    const proj = dbs.prepare('SELECT id FROM projects LIMIT 1').get() as any;
    if (!proj) return;
    // ensure project agent registered + set role binding so uses 'binding' path
    dbs.prepare('INSERT OR IGNORE INTO project_agents (project_id, agent_id, model_id, use_dynamic) VALUES (?,?,?,0)').run(proj.id, impl.id, grokM.id);
    as.setProjectBinding(proj.id, 'implementer', impl.id);
    let res = as.resolveProjectRole(proj.id, 'implementer');
    expect(res.source).toBe('binding');
    // now override model via project_agents
    dbs.prepare('UPDATE project_agents SET model_id=? , use_dynamic=0 WHERE project_id=? AND agent_id=?').run(codexM.id, proj.id, impl.id);
    const paIn = dbs.prepare('SELECT m.name as ov FROM project_agents pa LEFT JOIN models m ON m.id=pa.model_id WHERE pa.project_id=? AND pa.agent_id=?').get(proj.id, impl.id) as any;
    expect(paIn && paIn.ov).toBe('codex-5.5');
    res = as.resolveProjectRole(proj.id, 'implementer');
    expect(res.agent.model).toBe('codex-5.5'); // now beats
    // escalation CRUD
    const escs = as.setAgentEscalations(impl.id, [{position:1, model_id: grokM.id}, {position:2, model_id: codexM.id}]);
    expect(escs.length >= 1).toBe(true);
    as.deleteAgentEscalation(impl.id, 1);
    expect(as.listAgentEscalations(impl.id).length <=1 ).toBe(true);
  });

  it('team role -> resolved roster + per-project roster override (via bound team)', async () => {
    const { AgentAssignmentService } = await import('./services/agent-assignment-service.js');
    const as = new AgentAssignmentService(dbs);
    // seed team + members + bind per proj
    let t = svc.listTeams().find((x:any)=>x.type==='deliberation');
    if (!t) t = svc.createTeam({name:'delib-t', type:'deliberation'});
    const ms = dbs.prepare('SELECT id FROM models LIMIT 2').all() as any[];
    if (ms.length>=2) {
      try { svc.addMember(t.id, {model_id: ms[0].id, position:1}); } catch{}
      try { svc.addMember(t.id, {model_id: ms[1].id, position:2}); } catch{}
    }
    const p = dbs.prepare('SELECT id FROM projects LIMIT 1').get() as any;
    if (p) {
      as.setProjectTeamBinding(p.id, 'deliberation', t.id);
      const res = as.resolveProjectRole(p.id, 'deliberation');
      expect(res.source).toBe('project-team-binding');
      expect(Array.isArray(res.roster)).toBe(true);
      if (res.roster.length>0) expect(res.roster[0].position).toBe(1);
    }
  });

  it('proving: project_agents model override beats default in resolveProjectRole (returns model_id)', async () => {
    const { AgentAssignmentService } = await import('./services/agent-assignment-service.js');
    const as = new AgentAssignmentService(dbs);
    const impl = dbs.prepare("SELECT id FROM agents WHERE name='implementer' LIMIT 1").get() as any;
    const codex = dbs.prepare("SELECT id,model_id FROM models WHERE name='codex-5.5' LIMIT 1").get() as any;
    const proj = dbs.prepare('SELECT id FROM projects LIMIT 1').get() as any;
    if (!impl || !codex || !proj) return;
    as.setProjectBinding(proj.id, 'implementer', impl.id);
    // set override
    dbs.prepare('INSERT OR IGNORE INTO project_agents (project_id, agent_id, model_id, use_dynamic) VALUES (?,?,?,0)').run(proj.id, impl.id, codex.id);
    const res = as.resolveProjectRole(proj.id, 'implementer');
    expect(res && res.agent).toBeTruthy();
    expect(res.agent.model).toBe(codex.model_id); // model_id not name
  });

  it('B9b: resolveProjectRole applies the canonical resolveProjectAgent effective settings', async () => {
    const { AgentAssignmentService } = await import('./services/agent-assignment-service.js');
    const as = new AgentAssignmentService(dbs);
    const grok = dbs.prepare("SELECT id FROM models WHERE model_id = 'grok-4.5' LIMIT 1").get() as any;
    const codex = dbs.prepare("SELECT id, model_id, provider FROM models WHERE model_id = 'gpt-5.5' LIMIT 1").get() as any;
    const backup = dbs.prepare("SELECT id FROM models WHERE model_id = 'claude-opus-4-8' LIMIT 1").get() as any;
    if (!grok || !codex || !backup) return;

    const project = dbs.prepare("INSERT INTO projects (name, directory) VALUES (?, ?) RETURNING id").get(`b9b-role-${Date.now()}`, '/tmp/b9b-role') as any;
    const pid = Number(project.id);
    const agent = dbs.prepare(`
      INSERT INTO agents (name, provider, model, default_effort, default_model_id, backup_model_id, spawn_pref, definition_md, in_development)
      VALUES (?, 'grok', 'grok-4.5', 'medium', ?, NULL, 'tmux', 'studio persona', 1)
      RETURNING id
    `).get(`b9b-agent-${Date.now()}-${Math.random().toString(36).slice(2)}`, grok.id) as any;

    as.setProjectBinding(pid, 'implementer', agent.id);
    dbs.prepare(`
      INSERT INTO project_agents (
        project_id, agent_id, model_id, backup_model_id, effort_override,
        spawn_pref_override, disabled_override, definition_md_override, use_dynamic
      )
      VALUES (?, ?, ?, ?, 'high', 'in-process', 0, 'project persona', 0)
    `).run(pid, agent.id, codex.id, backup.id);

    const effective = as.resolveProjectAgent(pid, agent.id);
    const role = as.resolveProjectRole(pid, 'implementer');

    expect(effective).toBeTruthy();
    expect(role && role.agent).toBeTruthy();
    expect(role.agent.model).toBe(effective!.model.model_id);
    expect(role.agent.provider).toBe(codex.provider);
    expect(role.agent.default_effort).toBe(effective!.effort);
    expect(role.agent.backup_model_id).toBe(effective!.backup_model_id);
    expect(role.agent.spawn_pref).toBe(effective!.spawn_pref);
    expect(role.agent.definition_md).toBe(effective!.definition_md);
    expect(role.agent.in_development).toBe(true);
    expect(role.effective_project_agent?.in_development).toBe(true);
  });

  it('proving: team binding resolves to FULL roster with model_id per seat', async () => {
    const { AgentAssignmentService } = await import('./services/agent-assignment-service.js');
    const as = new AgentAssignmentService(dbs);
    const teams = svc.listTeams();
    if (!teams.length) return;
    const t = teams.find((x:any)=>x.type==='deliberation') || teams[0];
    const proj = dbs.prepare('SELECT id FROM projects LIMIT 1').get() as any;
    if (!proj) return;
    as.setProjectTeamBinding(proj.id, 'deliberation', t.id);
    const res = as.resolveProjectRole(proj.id, 'deliberation');
    expect(res.source).toBe('project-team-binding');
    expect(Array.isArray(res.roster)).toBe(true);
    if (res.roster.length) {
      expect(res.roster[0].model).toBeTruthy(); // model_id
      expect(typeof res.roster[0].model).toBe('string');
    }
  });

  it('proving: escalation trigger whitelist rejects bad value', async () => {
    const { AgentAssignmentService } = await import('./services/agent-assignment-service.js');
    const as = new AgentAssignmentService(dbs);
    const impl = dbs.prepare("SELECT id FROM agents WHERE name='implementer' LIMIT 1").get() as any;
    const m = dbs.prepare("SELECT id FROM models LIMIT 1").get() as any;
    if (!impl || !m) return;
    let threw = false;
    try {
      as.setAgentEscalations(impl.id, [{position:1, model_id: m.id, trigger: 'bad-trigger'}]);
    } catch(e:any) {
      threw = /invalid escalation trigger/.test(String(e));
    }
    expect(threw).toBe(true);
  });
});

describe('F1: mixed team membership + protocol_note (R-03B/C)', () => {
  let dbs: DatabaseService;
  let tmp: string;
  let svc: TeamService;

  beforeEach(() => {
    tmp = path.join(os.tmpdir(), `helm-f1-teams-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    dbs = new DatabaseService(tmp);
    svc = new TeamService(dbs);
  });

  afterEach(() => {
    try { if (dbs) dbs.close(); } catch {}
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
  });

  it('F1-1: fresh DB has protocol_note on teams + member_type/agent_id on team_members + UNIQUE(team_id,position)', () => {
    const teamCols = (dbs.prepare("PRAGMA table_info(teams)").all() as any[]).map((c: any) => c.name);
    expect(teamCols).toContain('protocol_note');
    const memberCols = (dbs.prepare("PRAGMA table_info(team_members)").all() as any[]).map((c: any) => c.name);
    expect(memberCols).toContain('member_type');
    expect(memberCols).toContain('agent_id');
    // UNIQUE is now on (team_id, position) — insert 2 members with same model but different positions → both succeed
    const t = svc.createTeam({ name: 'test-schema', type: 'generic' });
    const ms = dbs.prepare('SELECT id FROM models LIMIT 1').all() as any[];
    if (!ms.length) return;
    const mid = ms[0].id;
    dbs.prepare('UPDATE models SET validation_status = ? WHERE id = ?').run('valid', mid);
    svc.addMember(t.id, { model_id: mid, position: 1 });
    svc.addMember(t.id, { model_id: mid, position: 2 }); // same model, different position — allowed now
    expect(svc.listMembers(t.id).length).toBe(2);
    // same position → rejected
    expect(() => svc.addMember(t.id, { model_id: mid, position: 1 })).toThrow('position already taken');
  });

  it('F1-2: addMember agent-type fills model_id from agent default_model_id', () => {
    const agent = dbs.prepare("SELECT id, default_model_id FROM agents WHERE name='implementer' LIMIT 1").get() as any;
    if (!agent || agent.default_model_id == null) return;
    dbs.prepare('UPDATE models SET validation_status = ? WHERE id = ?').run('valid', agent.default_model_id);
    const t = svc.createTeam({ name: 'test-agent-member', type: 'generic' });
    const m = svc.addMember(t.id, { member_type: 'agent', agent_id: agent.id });
    expect(m.member_type).toBe('agent');
    expect(m.agent_id).toBe(agent.id);
    expect(m.model_id).toBe(Number(agent.default_model_id));
    expect(m.position).toBe(0); // auto-assigned first position
  });

  it('F1-3: same agent_id allowed in multiple slots (multi-role); position is the unique key', () => {
    const agent = dbs.prepare("SELECT id, default_model_id FROM agents WHERE name='implementer' LIMIT 1").get() as any;
    if (!agent || agent.default_model_id == null) return;
    dbs.prepare('UPDATE models SET validation_status = ? WHERE id = ?').run('valid', agent.default_model_id);
    const t = svc.createTeam({ name: 'test-multislot', type: 'generic' });
    const m1 = svc.addMember(t.id, { member_type: 'agent', agent_id: agent.id, position: 1 });
    const m2 = svc.addMember(t.id, { member_type: 'agent', agent_id: agent.id, position: 2 });
    expect(m1.agent_id).toBe(agent.id);
    expect(m2.agent_id).toBe(agent.id);
    expect(m1.position).toBe(1);
    expect(m2.position).toBe(2);
    expect(svc.listMembers(t.id).length).toBe(2);
  });

  it('F1-4: protocol_note round-trips via createTeam + updateTeam + listTeams/getTeam', () => {
    const t = svc.createTeam({ name: 'test-note', type: 'generic', protocol_note: 'Use structured reasoning.' });
    expect(t.protocol_note).toBe('Use structured reasoning.');
    const fetched = svc.getTeam(t.id);
    expect(fetched!.protocol_note).toBe('Use structured reasoning.');
    const updated = svc.updateTeam(t.id, { protocol_note: 'Be concise.' });
    expect(updated.protocol_note).toBe('Be concise.');
    const cleared = svc.updateTeam(t.id, { protocol_note: null });
    expect(cleared.protocol_note).toBeNull();
    const listed = svc.listTeams().find(x => x.id === t.id);
    expect(listed!.protocol_note).toBeNull();
  });
});

describe('F3: vetted-only team membership enforcement (R-03F)', () => {
  let dbs: DatabaseService;
  let tmp: string;
  let svc: TeamService;

  beforeEach(() => {
    tmp = path.join(os.tmpdir(), `helm-f3-teams-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    dbs = new DatabaseService(tmp);
    svc = new TeamService(dbs);
  });

  afterEach(() => {
    try { if (dbs) dbs.close(); } catch {}
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
  });

  it('F3-1: addMember rejects agent with in_development=1', () => {
    const t = svc.createTeam({ name: 'f3-team', type: 'generic' });
    const agent = dbs.prepare("INSERT INTO agents (name, provider, model, in_development) VALUES (?, 'claude', 'stub', 1) RETURNING id").get('dev-agent-f3') as any;
    expect(() => svc.addMember(t.id, { member_type: 'agent', agent_id: agent.id }))
      .toThrow('agent is still in development');
  });

  it('F3-2: addMember rejects model-type member with non-valid model', () => {
    const t = svc.createTeam({ name: 'f3-team-model', type: 'generic' });
    const model = dbs.prepare("INSERT INTO models (name, provider, model_id, cli, slug, display_name, validation_status) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id")
      .get('unvalidated-f3', 'claude', 'gpt-unvalidated', 'claude', 'unvalidated-f3', 'unvalidated-f3', 'untested') as any;
    expect(() => svc.addMember(t.id, { member_type: 'model', model_id: model.id }))
      .toThrow('model is not validated');
  });

  it('F3-3: addMember rejects agent-type member whose default_model is not valid', () => {
    const t = svc.createTeam({ name: 'f3-team-agent-model', type: 'generic' });
    const invalidModel = dbs.prepare("INSERT INTO models (name, provider, model_id, cli, slug, display_name, validation_status) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id")
      .get('invalid-model-f3', 'claude', 'gpt-invalid', 'claude', 'invalid-model-f3', 'invalid-model-f3', 'invalid') as any;
    const agent = dbs.prepare("INSERT INTO agents (name, provider, model, in_development, default_model_id) VALUES (?, 'claude', 'stub', 0, ?) RETURNING id")
      .get('ready-agent-f3', invalidModel.id) as any;
    expect(() => svc.addMember(t.id, { member_type: 'agent', agent_id: agent.id }))
      .toThrow('agent model is not validated');
  });
});

describe('F4: agent-master team edit capability (R-03D; B09b: master_agent → agent-master)', () => {
  it('F4-1: agent-master seeded as ready and can updateTeam + addMember + removeMember', () => {
    const tmp = path.join(os.tmpdir(), `helm-f4-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const dbs = new DatabaseService(tmp);
    const svc = new TeamService(dbs);
    try {
      // B09b pruned legacy master_agent; canonical house receptionist is agent-master.
      const ma = dbs.prepare("SELECT id, in_development, default_model_id FROM agents WHERE name='agent-master' LIMIT 1").get() as any;
      expect(ma).toBeTruthy();
      expect(ma.in_development).toBe(0);
      expect(ma.default_model_id).not.toBeNull();
      // satisfy F3 vetted guard for addMember
      dbs.prepare('UPDATE models SET validation_status = ? WHERE id = ?').run('valid', ma.default_model_id);
      // agent-master can update team fields
      const t = svc.createTeam({ name: 'master-team', type: 'generic' });
      const updated = svc.updateTeam(t.id, { name: 'master-team-updated', protocol_note: 'Managed by agent-master.' });
      expect(updated.name).toBe('master-team-updated');
      expect(updated.protocol_note).toBe('Managed by agent-master.');
      // agent-master can add itself as an agent-type member
      const m = svc.addMember(t.id, { member_type: 'agent', agent_id: ma.id });
      expect(m.agent_id).toBe(ma.id);
      expect(m.member_type).toBe('agent');
      expect(svc.listMembers(t.id)).toHaveLength(1);
      // agent-master can remove a member
      svc.removeMember(t.id, m.id);
      expect(svc.listMembers(t.id)).toHaveLength(0);
    } finally {
      try { dbs.close(); } catch {}
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
    }
  });
});
