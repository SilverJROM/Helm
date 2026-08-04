// S05 / AC2+AC3: pre-spawn owner refuse + six create paths pass explicit authority.
// Synthetic / static proofs only. HELM_SESSION_JANITOR stays 0. No live tmux.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SessionRegistryService } from './services/session-registry-service.js';
import { DatabaseService } from './db/database.js';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname));

function readSrc(...parts: string[]): string {
  return fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
}

describe('S05 six create paths pass owner explicitly (AC3)', () => {
  it('workers: worker-service createSession passes owner helm', () => {
    const src = readSrc('services', 'worker-service.ts');
    expect(src).toMatch(/createSession\([^)]*owner:\s*'helm'/);
  });

  it('brains/transport: real-transport createSession passes owner helm', () => {
    const src = readSrc('services', 'real-transport.ts');
    expect(src).toMatch(/createSession\([\s\S]*?owner:\s*'helm'/);
  });

  it('preflight: master-runtime probeSeatBinaries passes owner helm', () => {
    const src = readSrc('services', 'master-runtime-service.ts');
    // probe path uses helm-preflight- + owner helm
    expect(src).toMatch(/helm-preflight-/);
    expect(src).toMatch(/createSession\(probeSession[\s\S]*?owner:\s*'helm'/);
  });

  it('brains/master: launchMaster createSession passes owner helm', () => {
    const src = readSrc('services', 'master-runtime-service.ts');
    // second createSession site (launch) also helm
    const matches = [...src.matchAll(/createSession\([^;]+owner:\s*'(helm|human)'/g)];
    expect(matches.length).toBeGreaterThanOrEqual(2);
    expect(matches.every((m) => m[1] === 'helm')).toBe(true);
  });

  it('probes: model-validation createSession passes owner helm', () => {
    const src = readSrc('services', 'model-validation-service.ts');
    expect(src).toMatch(/createSession\([^;]*owner:\s*'helm'/);
  });

  it('discovery/chat: chat-session-service createSession passes owner human', () => {
    const src = readSrc('services', 'chat-session-service.ts');
    expect(src).toMatch(/createSession\([^;]*owner:\s*'human'/);
  });
});

describe('S05 defensive register refuse (AC2 belt)', () => {
  it('register without owner throws and writes no row', () => {
    const dbPath = path.join(os.tmpdir(), `helm-s05-reg-${Date.now()}.db`);
    const db = new DatabaseService(dbPath);
    try {
      const reg = new SessionRegistryService(db);
      expect(() => reg.register('helm-x', {} as any)).toThrow(/owner required/);
      expect(reg.get('helm-x')).toBeFalsy();
      reg.register('helm-x', { owner: 'helm' });
      expect(reg.get('helm-x')!.owner).toBe('helm');
    } finally {
      try { db.close(); } catch {}
      for (const s of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(dbPath + s); } catch {}
      }
    }
  });
});

describe('S05 safety guardrails', () => {
  it('HELM_SESSION_JANITOR remains 0 in deployed config', () => {
    const eco = fs.readFileSync(path.join(process.cwd(), 'ecosystem.config.cjs'), 'utf8');
    expect(eco).toMatch(/HELM_SESSION_JANITOR:\s*["']0["']/);
    const envPath = path.join(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
      expect(fs.readFileSync(envPath, 'utf8')).toMatch(/HELM_SESSION_JANITOR=0/);
    }
  });
});
