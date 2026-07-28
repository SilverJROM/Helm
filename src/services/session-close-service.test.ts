// S14a — human session close API service tests.
// Synthetic DB + fake tmux only. HELM_SESSION_JANITOR stays 0. Never live kill-session.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService } from '../db/database.js';
import { SessionRegistryService } from './session-registry-service.js';
import {
  SessionCloseService,
  projectSessionListRow,
  sessionCloseHttpStatus,
  type SessionCloseTmux,
} from './session-close-service.js';

function makeTempDb(): { db: DatabaseService; cleanup: () => void } {
  const dbPath = path.join(os.tmpdir(), `helm-s14a-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = new DatabaseService(dbPath);
  return {
    db,
    cleanup: () => {
      try {
        db.close();
      } catch {}
      for (const suf of ['', '-wal', '-shm']) {
        try {
          fs.unlinkSync(dbPath + suf);
        } catch {}
      }
    },
  };
}

describe('S14a SessionCloseService (human manual close)', () => {
  let db: DatabaseService;
  let cleanup: () => void;
  let reg: SessionRegistryService;
  let terminated: string[];
  let tagMap: Map<string, boolean | 'throw'>;
  let tmux: SessionCloseTmux;
  let svc: SessionCloseService;

  function seed(
    name: string,
    opts: { owner?: string | null; status?: string; kind?: string } = {}
  ) {
    const owner = opts.owner === undefined ? 'human' : opts.owner;
    const status = opts.status ?? 'active';
    const kind = opts.kind ?? 'discovery';
    db.prepare(
      `INSERT INTO helm_sessions (name, kind, project_id, run_id, owner, status, created_at, last_used_at)
       VALUES (?, ?, 1, NULL, ?, ?, datetime('now'), datetime('now'))`
    ).run(name, kind, owner, status);
  }

  beforeEach(() => {
    process.env.HELM_SESSION_JANITOR = '0';
    const t = makeTempDb();
    db = t.db;
    cleanup = t.cleanup;
    reg = new SessionRegistryService(db);
    terminated = [];
    tagMap = new Map();
    tmux = {
      terminateSession: async (name: string) => {
        terminated.push(name);
      },
      sessionHasHelmChildTag: async (name: string) => {
        const v = tagMap.has(name) ? tagMap.get(name)! : true;
        if (v === 'throw') throw new Error('probe failed');
        return v === true;
      },
    };
    svc = new SessionCloseService(reg, tmux);
  });

  afterEach(() => cleanup());

  it('human success → exactly one fake terminate + registry reaped (human-close)', async () => {
    seed('helm-discovery-s14a-chat');
    const r = await svc.closeHumanSession('helm-discovery-s14a-chat');
    expect(r).toEqual({ ok: true, closed: 'helm-discovery-s14a-chat' });
    expect(terminated).toEqual(['helm-discovery-s14a-chat']);
    const row = reg.get('helm-discovery-s14a-chat')!;
    expect(row.status).toBe('reaped');
    expect(row.reason).toBe('human-close');
    expect(row.ended_at).toBeTruthy();
  });

  it('helm owner refuse → zero terminate', async () => {
    seed('helm-w-cards-1', { owner: 'helm', kind: 'worker' });
    const r = await svc.closeHumanSession('helm-w-cards-1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not_human');
    expect(terminated).toEqual([]);
    expect(reg.get('helm-w-cards-1')!.status).toBe('active');
  });

  it('legacy:unknown refuse → zero terminate', async () => {
    seed('helm-legacy-seat', { owner: 'legacy:unknown' });
    const r = await svc.closeHumanSession('helm-legacy-seat');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not_human');
    expect(terminated).toEqual([]);
  });

  it('null owner refuse → zero terminate', async () => {
    seed('helm-null-owner', { owner: null });
    const r = await svc.closeHumanSession('helm-null-owner');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not_human');
    expect(terminated).toEqual([]);
  });

  it('missing registry row refuse → zero terminate', async () => {
    const r = await svc.closeHumanSession('helm-discovery-ghost');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('missing');
    expect(terminated).toEqual([]);
  });

  it('tag-failed (false) refuse → zero terminate', async () => {
    seed('helm-discovery-untagged');
    tagMap.set('helm-discovery-untagged', false);
    const r = await svc.closeHumanSession('helm-discovery-untagged');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('tag_failed');
    expect(terminated).toEqual([]);
    expect(reg.get('helm-discovery-untagged')!.status).toBe('active');
  });

  it('tag-failed (probe throw) refuse → zero terminate', async () => {
    seed('helm-discovery-tagerr');
    tagMap.set('helm-discovery-tagerr', 'throw');
    const r = await svc.closeHumanSession('helm-discovery-tagerr');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('tag_failed');
    expect(terminated).toEqual([]);
  });

  it('non-helm- name refuse → zero terminate', async () => {
    // Row could exist theoretically; name gate fires first after charset check.
    seed('other-session-x', { owner: 'human' });
    const r = await svc.closeHumanSession('other-session-x');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('non_helm_name');
    expect(terminated).toEqual([]);
  });

  it('invalid name charset refuse → zero terminate', async () => {
    const r = await svc.closeHumanSession('helm-bad;name');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid_name');
    expect(terminated).toEqual([]);
  });

  it('duplicate close is idempotent (one terminate total)', async () => {
    seed('helm-chat-dup');
    const r1 = await svc.closeHumanSession('helm-chat-dup');
    expect(r1.ok).toBe(true);
    expect(terminated).toEqual(['helm-chat-dup']);
    const r2 = await svc.closeHumanSession('helm-chat-dup');
    expect(r2).toEqual({ ok: true, closed: 'helm-chat-dup', alreadyReaped: true });
    expect(terminated).toEqual(['helm-chat-dup']); // still exactly one
    expect(reg.get('helm-chat-dup')!.status).toBe('reaped');
  });

  it('projectSessionListRow includes owner + status', () => {
    seed('helm-discovery-list', { owner: 'human', status: 'active' });
    const row = reg.get('helm-discovery-list')!;
    const projected = projectSessionListRow(row);
    expect(projected).toMatchObject({
      name: 'helm-discovery-list',
      owner: 'human',
      status: 'active',
    });
    expect(projected).toHaveProperty('owner');
    expect(projected).toHaveProperty('status');
  });

  it('sessionCloseHttpStatus maps refuse reasons', () => {
    expect(sessionCloseHttpStatus('missing')).toBe(404);
    expect(sessionCloseHttpStatus('invalid_name')).toBe(400);
    expect(sessionCloseHttpStatus('non_helm_name')).toBe(400);
    expect(sessionCloseHttpStatus('not_human')).toBe(403);
    expect(sessionCloseHttpStatus('tag_failed')).toBe(403);
  });

  it('route source: GET includes owner; POST close uses auth + human close service', () => {
    const indexSrc = fs.readFileSync(path.join(__dirname, '../index.ts'), 'utf8');
    // GET /api/sessions projects via projectSessionListRow (includes owner + status)
    expect(indexSrc).toMatch(/app\.get\(\s*['"]\/api\/sessions['"]/);
    expect(indexSrc).toMatch(/projectSessionListRow/);
    // POST close route authenticated + owner + local-launch (terminate-capable)
    expect(indexSrc).toMatch(
      /app\.post\(\s*['"]\/api\/sessions\/:name\/close['"]\s*,\s*\{\s*preHandler:\s*\[\s*authMiddleware\s*,\s*requireOwnerPre\s*,\s*requireLocalLaunchPre/
    );
    expect(indexSrc).toMatch(/sessionCloseService\.closeHumanSession/);
    // auth required on both
    const getBlock = indexSrc.match(
      /app\.get\(\s*['"]\/api\/sessions['"][\s\S]{0,200}/
    )?.[0];
    expect(getBlock).toMatch(/authMiddleware/);
    expect(getBlock).toMatch(/requireOwnerPre/);
  });

  it('HELM_SESSION_JANITOR remains 0 in deployed config', () => {
    const eco = fs.readFileSync(path.join(__dirname, '../../ecosystem.config.cjs'), 'utf8');
    expect(eco).toMatch(/HELM_SESSION_JANITOR:\s*["']0["']/);
    const envPath = path.join(__dirname, '../../.env');
    if (fs.existsSync(envPath)) {
      expect(fs.readFileSync(envPath, 'utf8')).toMatch(/HELM_SESSION_JANITOR=0/);
    }
  });

  it('service source never shells live kill-session directly', () => {
    const src = fs.readFileSync(path.join(__dirname, 'session-close-service.ts'), 'utf8');
    expect(src).not.toMatch(/kill-session/);
    expect(src).not.toMatch(/execFile|spawn\(|child_process/);
  });
});
