import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from '../db/database.js';
import { AgentAssignmentService } from './agent-assignment-service.js';
import type { DecisionActor } from './decision-authority.js';

const OWNER: DecisionActor = { kind: 'owner', role: 'owner' };
// NAME-LAYER rename (2026-07-16): the strategy front-end agent is named 'discovery' (fka 'north').
const REPAIR_AGENT_NAMES = ['discovery', 'implementer'] as const;

export type CanonicalAgentSeedRepair = {
  name: (typeof REPAIR_AGENT_NAMES)[number];
  id: number;
  definitionLength: number;
};

/**
 * Builds a throwaway fresh database so the current schema seed pipeline remains
 * the sole source for the canonical agent bodies. No seed markdown is copied here.
 */
function readCanonicalDefinitions(): Map<string, string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-canonical-agent-seeds-'));
  const sourcePath = path.join(dir, 'seed-source.db');
  try {
    const sourceDb = new DatabaseService(sourcePath);
    const sourceAgents = new AgentAssignmentService(sourceDb);
    const definitions = new Map<string, string>();
    for (const name of REPAIR_AGENT_NAMES) {
      const agent = sourceAgents.listAgents().find((candidate) => candidate.name === name);
      if (!agent?.definition_md) throw new Error(`canonical seed missing definition_md for ${name}`);
      definitions.set(name, agent.definition_md);
    }
    sourceDb.close();
    return definitions;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * One-time repair path for clobbered canonical definitions. The target is only
 * mutated through AgentAssignmentService's Studio + owner authorization gate.
 */
export function repairCanonicalAgentDefinitions(targetDbPath: string): CanonicalAgentSeedRepair[] {
  const canonicalDefinitions = readCanonicalDefinitions();
  const targetIsLive = path.resolve(targetDbPath) === path.resolve(process.cwd(), 'data/helm.db');
  const previousLiveOptIn = process.env.HELM_ALLOW_LIVE_DB;
  if (targetIsLive) process.env.HELM_ALLOW_LIVE_DB = '1';

  try {
    const targetDb = new DatabaseService(targetDbPath);
    const targetAgents = new AgentAssignmentService(targetDb);
    const repaired = REPAIR_AGENT_NAMES.map((name) => {
      const existing = targetAgents.listAgents().find((candidate) => candidate.name === name);
      const definitionMd = canonicalDefinitions.get(name);
      if (!existing || !definitionMd) throw new Error(`cannot repair missing canonical agent ${name}`);
      const updated = targetAgents.updateAgent(
        existing.id,
        { definition_md: definitionMd },
        { surface: 'studio', actor: OWNER }
      );
      return { name, id: updated.id, definitionLength: updated.definition_md!.length };
    });
    targetDb.close();
    return repaired;
  } finally {
    if (targetIsLive) {
      if (previousLiveOptIn === undefined) delete process.env.HELM_ALLOW_LIVE_DB;
      else process.env.HELM_ALLOW_LIVE_DB = previousLiveOptIn;
    }
  }
}
