import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from './db/database.js';
import { AgentAssignmentService } from './services/agent-assignment-service.js';
import { repairCanonicalAgentDefinitions } from './services/canonical-agent-seed-repair.js';
import type { DecisionActor } from './services/decision-authority.js';

const OWNER: DecisionActor = { kind: 'owner', role: 'owner' };

describe('B00.s9 canonical agent seed repair', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('restores discovery and implementer from fresh canonical seeds through the Studio service path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b00-s9-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const targetPath = path.join(dir, 'repair-target.db');
    const db = new DatabaseService(targetPath);
    const agents = new AgentAssignmentService(db);
    for (const name of ['discovery', 'implementer']) {
      const agent = agents.listAgents().find((candidate) => candidate.name === name)!;
      agents.updateAgent(agent.id, { definition_md: `# clobbered ${name}` }, { surface: 'studio', actor: OWNER });
    }
    db.close();

    const repaired = repairCanonicalAgentDefinitions(targetPath);
    expect(repaired.map((item) => item.name)).toEqual(['discovery', 'implementer']);

    const verifiedDb = new DatabaseService(targetPath);
    const verifiedAgents = new AgentAssignmentService(verifiedDb);
    const discovery = verifiedAgents.listAgents().find((agent) => agent.name === 'discovery')!;
    const implementer = verifiedAgents.listAgents().find((agent) => agent.name === 'implementer')!;
    expect(discovery.definition_md).toContain('# discovery — strategy front-end');
    expect(implementer.definition_md).toContain('First tool call in every reply: the callback STATUS line');
    expect(implementer.definition_md).not.toContain('clobbered');
    verifiedDb.close();
  });
});
