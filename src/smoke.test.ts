import { describe, it, expect } from 'vitest';
import { loadConfig } from './config/config.js';
import { DatabaseService } from './db/database.js';
import { SCHEMA_VERSION } from './db/schema.js';
import fs from 'node:fs';
import path from 'node:path';

describe('Helm P1-1 scaffold', () => {
  it('config returns correct defaults (3110/127.0.0.1/data/helm.db)', () => {
    // T1 sets HELM_DB_PATH globally for tests; to verify the DEFAULT, temporarily clear it.
    const oldDbPath = process.env.HELM_DB_PATH;
    delete process.env.HELM_DB_PATH;
    try {
      const cfg = loadConfig();
      expect(cfg.port).toBe(3110);
      expect(cfg.host).toBe('127.0.0.1');
      expect(cfg.dbPath).toBe('data/helm.db');
    } finally {
      if (oldDbPath !== undefined) {
        process.env.HELM_DB_PATH = oldDbPath;
      } else {
        delete process.env.HELM_DB_PATH;
      }
    }
  });

  it('db opens WAL, creates schema_version table, seeds version 1', () => {
    const tmpDb = path.join(process.cwd(), 'data', `helm-smoke-${Date.now()}.db`);
    try {
      const svc = new DatabaseService(tmpDb);
      const row = svc.raw
        .prepare("SELECT version FROM schema_version LIMIT 1")
        .get() as { version: number } | undefined;
      expect(row).toBeDefined();
      // P1-2 bumped to current SCHEMA_VERSION (additive migration); P1-1 scaffold logic unaffected
      expect(row!.version).toBe(SCHEMA_VERSION);
      svc.close();
    } finally {
      if (fs.existsSync(tmpDb)) fs.unlinkSync(tmpDb);
    }
  });
});
