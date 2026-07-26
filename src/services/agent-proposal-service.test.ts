import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseService } from '../db/database.js';
import { AgentProposalService } from './agent-proposal-service.js';
import { AgentAssignmentService } from './agent-assignment-service.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const STUDIO = { surface: 'studio' as const };

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-e1-'));
  return {
    dbPath: path.join(dir, 'test.db'),
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  };
}

describe('E1 AgentProposalService (KEY-E1): createProposal + list + approve + reject', () => {
  let dbs: DatabaseService;
  let svc: AgentProposalService;
  let agentSvc: AgentAssignmentService;
  let cleanup: () => void;
  let agentId: number;

  beforeEach(() => {
    const t = makeTempDb();
    cleanup = t.cleanup;
    dbs = new DatabaseService(t.dbPath);
    agentSvc = new AgentAssignmentService(dbs);
    svc = new AgentProposalService(dbs, agentSvc);
    const a = agentSvc.createAgent({ name: 'e1-agent', provider: 'claude', model: 'claude-sonnet-4-6', default_effort: 'medium', definition_md: '# Original' }, STUDIO);
    agentId = a.id;
  });

  afterEach(() => cleanup());

  it('createProposal stores pending proposal; listProposals finds it', () => {
    const p = svc.createProposal(agentId, '# Proposed\nNew def.', 'chat-abc');
    expect(p.status).toBe('pending');
    expect(p.agent_id).toBe(agentId);
    expect(p.proposed_definition_md).toBe('# Proposed\nNew def.');
    expect(p.chat_session_id).toBe('chat-abc');
    const list = svc.listProposals({ agent_id: agentId, status: 'pending' });
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(p.id);
  });

  it('approveProposal writes definition_md to agent and marks approved', () => {
    const p = svc.createProposal(agentId, '# Approved def');
    const approved = svc.approveProposal(p.id);
    expect(approved.status).toBe('approved');
    expect(approved.resolved_at).not.toBeNull();
    const agent = agentSvc.getAgent(agentId);
    expect(agent?.definition_md).toBe('# Approved def');
    expect(() => svc.approveProposal(p.id)).toThrow(/already approved/);
  });

  it('rejectProposal marks rejected; definition_md unchanged; double-reject throws', () => {
    const p = svc.createProposal(agentId, '# Bad idea');
    const rejected = svc.rejectProposal(p.id);
    expect(rejected.status).toBe('rejected');
    const agent = agentSvc.getAgent(agentId);
    expect(agent?.definition_md).toBe('# Original');
    expect(() => svc.rejectProposal(p.id)).toThrow(/already rejected/);
  });

  it('createProposal throws on unknown agent; listProposals returns [] when none', () => {
    expect(() => svc.createProposal(9999, 'bad')).toThrow(/unknown agent/);
    expect(svc.listProposals({ agent_id: agentId, status: 'pending' })).toEqual([]);
  });
});
