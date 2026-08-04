/**
 * S11 — pure reconcile decision (AC14/18/25/26, AC6/8 invariants).
 * Synthetic facts only. No live tmux. No DB writes. HELM_SESSION_JANITOR stays 0.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  decideSessionReconcile,
  type ReconcileAction,
  type ReconcileFacts,
  type ReconcileRow,
} from './session-reconcile-decision.js';

function row(partial: Partial<ReconcileRow> & Pick<ReconcileRow, 'owner' | 'status'>): ReconcileRow {
  return {
    run_id: partial.run_id === undefined ? 42 : partial.run_id,
    name: partial.name ?? 'helm-w-test-1',
    owner: partial.owner,
    status: partial.status,
  };
}

function facts(sessionExists: boolean | null): ReconcileFacts {
  return { sessionExists };
}

describe('S11 session-reconcile-decision pure helper (AC14/18/25/26)', () => {
  const cases: Array<{
    name: string;
    row: ReconcileRow;
    facts: ReconcileFacts;
    action: ReconcileAction;
    reason: string;
  }> = [
    // --- AC25: helm + assertion + live → REAP ---
    {
      name: 'helm + idle + live → REAP (AC25)',
      row: row({ owner: 'helm', status: 'idle', run_id: 7 }),
      facts: facts(true),
      action: 'REAP',
      reason: 'asserted_complete_live',
    },
    {
      name: 'helm + idle + live + null run_id → REAP (AC18: null run not required/blocked)',
      row: row({ owner: 'helm', status: 'idle', run_id: null }),
      facts: facts(true),
      action: 'REAP',
      reason: 'asserted_complete_live',
    },

    // --- AC14: gone → CONVERGE (before kill) ---
    {
      name: 'helm + idle + gone → CONVERGE (AC14, not REAP)',
      row: row({ owner: 'helm', status: 'idle', run_id: 7 }),
      facts: facts(false),
      action: 'CONVERGE',
      reason: 'session_gone',
    },
    {
      name: 'helm + active + gone → CONVERGE (A15 unasserted crash record)',
      row: row({ owner: 'helm', status: 'active', run_id: 7 }),
      facts: facts(false),
      action: 'CONVERGE',
      reason: 'session_gone',
    },
    {
      name: 'helm + active + gone + null run_id → CONVERGE (AC18)',
      row: row({ owner: 'helm', status: 'active', run_id: null }),
      facts: facts(false),
      action: 'CONVERGE',
      reason: 'session_gone',
    },

    // --- AC8/26: unasserted live → KEEP (idle age never REAP) ---
    {
      name: 'helm + active + live → KEEP unasserted',
      row: row({ owner: 'helm', status: 'active', run_id: 7 }),
      facts: facts(true),
      action: 'KEEP',
      reason: 'unasserted',
    },
    {
      name: 'helm + active + live + null run_id → KEEP (F3 deleted: null ≠ done)',
      row: row({ owner: 'helm', status: 'active', run_id: null }),
      facts: facts(true),
      action: 'KEEP',
      reason: 'unasserted',
    },
    {
      name: 'helm + null status + live → KEEP unasserted',
      row: row({ owner: 'helm', status: null }),
      facts: facts(true),
      action: 'KEEP',
      reason: 'unasserted',
    },

    // --- human / legacy / unknown owner always KEEP ---
    {
      name: 'human + idle + live → KEEP owner_not_helm',
      row: row({ owner: 'human', status: 'idle', run_id: null }),
      facts: facts(true),
      action: 'KEEP',
      reason: 'owner_not_helm',
    },
    {
      name: 'human + idle + gone → KEEP (manual close owns human; no auto converge)',
      row: row({ owner: 'human', status: 'idle', run_id: null }),
      facts: facts(false),
      action: 'KEEP',
      reason: 'owner_not_helm',
    },
    {
      name: 'legacy:unknown + idle + live → KEEP',
      row: row({ owner: 'legacy:unknown', status: 'idle', run_id: 1 }),
      facts: facts(true),
      action: 'KEEP',
      reason: 'owner_not_helm',
    },
    {
      name: 'legacy:unknown + active + gone → KEEP',
      row: row({ owner: 'legacy:unknown', status: 'active', run_id: null }),
      facts: facts(false),
      action: 'KEEP',
      reason: 'owner_not_helm',
    },
    {
      name: 'null owner + idle + live → KEEP',
      row: row({ owner: null, status: 'idle' }),
      facts: facts(true),
      action: 'KEEP',
      reason: 'owner_not_helm',
    },
    {
      name: 'undefined owner + idle + live → KEEP',
      row: { owner: undefined, status: 'idle', run_id: 42, name: 'helm-w-test-1' },
      facts: facts(true),
      action: 'KEEP',
      reason: 'owner_not_helm',
    },

    // --- session existence unknown → KEEP ---
    {
      name: 'helm + idle + sessionExists null → KEEP session_unknown',
      row: row({ owner: 'helm', status: 'idle' }),
      facts: facts(null),
      action: 'KEEP',
      reason: 'session_unknown',
    },
    {
      name: 'helm + active + sessionExists null → KEEP session_unknown',
      row: row({ owner: 'helm', status: 'active' }),
      facts: facts(null),
      action: 'KEEP',
      reason: 'session_unknown',
    },

    // --- already reaped ---
    {
      name: 'already reaped → KEEP',
      row: row({ owner: 'helm', status: 'reaped' }),
      facts: facts(true),
      action: 'KEEP',
      reason: 'already_reaped',
    },
    {
      name: 'already reaped + gone still KEEP (idempotent)',
      row: row({ owner: 'helm', status: 'reaped' }),
      facts: facts(false),
      action: 'KEEP',
      reason: 'already_reaped',
    },
  ];

  it.each(cases)('$name', (c) => {
    const d = decideSessionReconcile(c.row, c.facts);
    expect(d.action).toBe(c.action);
    expect(d.reason).toBe(c.reason);
  });

  it('AC18: run_id null vs set never changes action for matched cases', () => {
    const pairs: Array<{ base: ReconcileRow; facts: ReconcileFacts }> = [
      { base: row({ owner: 'helm', status: 'idle', run_id: 99 }), facts: facts(true) },
      { base: row({ owner: 'helm', status: 'active', run_id: 99 }), facts: facts(true) },
      { base: row({ owner: 'helm', status: 'idle', run_id: 99 }), facts: facts(false) },
      { base: row({ owner: 'helm', status: 'active', run_id: 99 }), facts: facts(false) },
      { base: row({ owner: 'human', status: 'idle', run_id: 99 }), facts: facts(true) },
      { base: row({ owner: 'helm', status: 'idle', run_id: 99 }), facts: facts(null) },
    ];
    for (const p of pairs) {
      const withRun = decideSessionReconcile({ ...p.base, run_id: 99 }, p.facts);
      const nullRun = decideSessionReconcile({ ...p.base, run_id: null }, p.facts);
      expect(nullRun).toEqual(withRun);
    }
  });

  it('idle age / large timestamps are not inputs — unasserted stays KEEP (AC26)', () => {
    // Function has no idleAge field; prove active+live is KEEP regardless of caller context.
    const d = decideSessionReconcile(
      row({ owner: 'helm', status: 'active', run_id: null }),
      facts(true)
    );
    expect(d.action).toBe('KEEP');
    expect(d.reason).toBe('unasserted');
    expect(d.action).not.toBe('REAP');
  });

  it('return union only REAP|CONVERGE|KEEP; action never invents other verbs', () => {
    for (const c of cases) {
      const d = decideSessionReconcile(c.row, c.facts);
      expect(['REAP', 'CONVERGE', 'KEEP']).toContain(d.action);
    }
  });

  it('source guard: no F3 run_id==null authority; no TTL/idle-age REAP path', () => {
    const srcPath = path.join(__dirname, 'session-reconcile-decision.ts');
    const src = fs.readFileSync(srcPath, 'utf8');

    // F3 patterns that would reintroduce null-run authority for REAP.
    expect(src).not.toMatch(/run_id\s*==\s*null/);
    expect(src).not.toMatch(/run_id\s*===\s*null/);
    expect(src).not.toMatch(/runId\s*==\s*null/);
    expect(src).not.toMatch(/runId\s*===\s*null/);
    // Must explicitly void / ignore run_id as non-authority.
    expect(src).toMatch(/void row\.run_id/);

    // No idle-age / grace-period decision surface (no wall-clock authority).
    expect(src).not.toMatch(/idleAge|idle_age|last_used_at|session_activity|HELM_SESSION_TTL|thresholdMs/i);

    // No I/O / kill side effects in the decision module.
    expect(src).not.toMatch(/terminateSession|markReaped|DatabaseService|\.prepare\(/);
    expect(src).not.toMatch(/from ['"].*tmux/);
  });

  it('HARD SAFETY: HELM_SESSION_JANITOR remains 0 in deploy config', () => {
    const root = path.resolve(__dirname, '../..');
    const env = fs.readFileSync(path.join(root, '.env'), 'utf8');
    const eco = fs.readFileSync(path.join(root, 'ecosystem.config.cjs'), 'utf8');
    expect(env).toMatch(/HELM_SESSION_JANITOR\s*=\s*0/);
    expect(eco).toMatch(/HELM_SESSION_JANITOR:\s*["']0["']/);
  });
});
