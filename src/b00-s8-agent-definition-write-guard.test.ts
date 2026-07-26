/** B00.s8 — agent-definition writes are Studio-scoped and test DBs are never live. */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from './db/database.js';
import { AgentAssignmentService } from './services/agent-assignment-service.js';
import type { DecisionActor } from './services/decision-authority.js';
import {
  LIVE_HELM_DB_PATH,
  requireIsolatedDefinitionTestDb,
} from './test-utils/database-isolation.js';

const OWNER: DecisionActor = { kind: 'owner', role: 'owner' };

function tempDbPath(): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b00-s8-'));
  const dbPath = path.join(dir, 'helm-test.db');
  requireIsolatedDefinitionTestDb(dbPath);
  return {
    dbPath,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

describe('B00.s8 agent-definition write guard', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  function setup() {
    const temp = tempDbPath();
    cleanups.push(temp.cleanup);
    process.env.HELM_DB_PATH = temp.dbPath;
    const db = new DatabaseService(temp.dbPath);
    const agents = new AgentAssignmentService(db);
    const agent = agents.createAgent(
      {
        name: `b00-s8-${Math.random().toString(36).slice(2, 8)}`,
        provider: 'claude',
        model: 'claude-sonnet-4-6',
        definition_md: '# original',
      },
      { surface: 'studio', actor: OWNER }
    );
    return { db, agents, agent };
  }

  it('allows an owner-authorized Studio definition update on a temporary DB', () => {
    const { db, agents, agent } = setup();
    const updated = agents.updateAgent(
      agent.id,
      { definition_md: '# Studio-owned update' },
      { surface: 'studio', actor: OWNER }
    );
    expect(updated.definition_md).toBe('# Studio-owned update');
    db.close();
  });

  it('rejects project and unscoped definition mutations without changing identity', () => {
    const { db, agents, agent } = setup();
    expect(() => agents.updateAgent(
      agent.id,
      { definition_md: '# project attempt' },
      { surface: 'project', actor: OWNER }
    )).toThrow(/Studio-authorized surface/i);
    expect(() => agents.updateAgent(agent.id, { definition_md: '# unscoped attempt' }))
      .toThrow(/Studio-authorized surface/i);
    expect(agents.getAgent(agent.id)?.definition_md).toBe('# original');
    db.close();
  });

  it('rejects the live DB path before a definition mutation test can open it', () => {
    expect(() => requireIsolatedDefinitionTestDb(LIVE_HELM_DB_PATH))
      .toThrow(/must not use live data\/helm\.db/i);
  });

  it('DatabaseService rejects a Vitest live DB open without explicit opt-in', () => {
    const priorVitest = process.env.VITEST;
    const priorLiveOptIn = process.env.HELM_ALLOW_LIVE_DB;
    process.env.VITEST = 'true';
    delete process.env.HELM_ALLOW_LIVE_DB;
    try {
      expect(() => new DatabaseService(LIVE_HELM_DB_PATH))
        .toThrow(/Vitest must not open write-capable live data\/helm\.db/i);
    } finally {
      if (priorVitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = priorVitest;
      if (priorLiveOptIn === undefined) delete process.env.HELM_ALLOW_LIVE_DB;
      else process.env.HELM_ALLOW_LIVE_DB = priorLiveOptIn;
    }
  });
});
