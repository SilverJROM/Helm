import { DatabaseService } from '../db/database.js';
import { AgentAssignmentService } from './agent-assignment-service.js';
import {
  assertOwnerDecisionAuthority,
  type DecisionActor,
} from './decision-authority.js';

export interface ProposalRow {
  id: number;
  agent_id: number;
  chat_session_id: string | null;
  proposed_definition_md: string;
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
  resolved_at: string | null;
}

function rowToProposal(r: any): ProposalRow {
  return {
    id: Number(r.id),
    agent_id: Number(r.agent_id),
    chat_session_id: r.chat_session_id ?? null,
    proposed_definition_md: String(r.proposed_definition_md),
    status: r.status as 'pending' | 'approved' | 'rejected',
    created_at: String(r.created_at),
    resolved_at: r.resolved_at ?? null
  };
}

export class AgentProposalService {
  constructor(
    private readonly db: DatabaseService,
    private readonly agentService: AgentAssignmentService
  ) {}

  createProposal(agentId: number, proposedMd: string, chatSessionId?: string | null): ProposalRow {
    const agent = this.db.prepare('SELECT id FROM agents WHERE id = ?').get(agentId);
    if (!agent) throw new Error('unknown agent');
    if (!proposedMd || !proposedMd.trim()) throw new Error('proposed_definition_md is required');
    const result = this.db.prepare(`
      INSERT INTO agent_proposals (agent_id, chat_session_id, proposed_definition_md)
      VALUES (?, ?, ?)
    `).run(agentId, chatSessionId ?? null, proposedMd);
    return rowToProposal(this.db.prepare('SELECT * FROM agent_proposals WHERE id = ?').get(result.lastInsertRowid));
  }

  listProposals(opts: { agent_id?: number; status?: string } = {}): ProposalRow[] {
    const where: string[] = [];
    const vals: any[] = [];
    if (opts.agent_id != null) { where.push('agent_id = ?'); vals.push(opts.agent_id); }
    if (opts.status) { where.push('status = ?'); vals.push(opts.status); }
    const sql = `SELECT * FROM agent_proposals${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`;
    return (this.db.prepare(sql).all(...vals) as any[]).map(rowToProposal);
  }

  /** B10b/R2.10 AS-A2: jkage L0 cannot approve proposals. */
  approveProposal(id: number, opts?: { actor?: DecisionActor | null }): ProposalRow {
    assertOwnerDecisionAuthority(opts?.actor);
    const proposal = this.db.prepare('SELECT * FROM agent_proposals WHERE id = ?').get(id) as any;
    if (!proposal) throw new Error('unknown proposal');
    if (proposal.status !== 'pending') throw new Error(`proposal already ${proposal.status}`);
    this.agentService.updateAgent(
      proposal.agent_id,
      { definition_md: proposal.proposed_definition_md },
      { surface: 'studio', actor: opts?.actor }
    );
    this.db.prepare(`UPDATE agent_proposals SET status='approved', resolved_at=datetime('now') WHERE id=?`).run(id);
    return rowToProposal(this.db.prepare('SELECT * FROM agent_proposals WHERE id = ?').get(id));
  }

  /** B10b/R2.10 AS-B1: jkage L0 cannot reject proposals (owner authority). */
  rejectProposal(id: number, opts?: { actor?: DecisionActor | null }): ProposalRow {
    assertOwnerDecisionAuthority(opts?.actor);
    const proposal = this.db.prepare('SELECT * FROM agent_proposals WHERE id = ?').get(id) as any;
    if (!proposal) throw new Error('unknown proposal');
    if (proposal.status !== 'pending') throw new Error(`proposal already ${proposal.status}`);
    this.db.prepare(`UPDATE agent_proposals SET status='rejected', resolved_at=datetime('now') WHERE id=?`).run(id);
    return rowToProposal(this.db.prepare('SELECT * FROM agent_proposals WHERE id = ?').get(id));
  }
}
