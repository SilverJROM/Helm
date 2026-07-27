/**
 * B9 GATE-ATOMIC — fork-capped vitest capstone (re-proof only; no product invention).
 * Q0 substrate for frozen ACs where unit/static/[DB] evidence can re-close without UI.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService } from './db/database.js';
import { ProjectService } from './services/project-service.js';
import { CycleService } from './services/cycle-service.js';
import { CycleChatFileService } from './services/cycle-chat-file-service.js';
import { ProjectDocsService } from './services/project-docs-service.js';
import {
  isNearBottom,
  captureStickIntent,
  applyStick,
} from './web/public/pane-bottom-stick.js';

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b9-cap-'));
  const dbPath = path.join(dir, 'test.db');
  return {
    dbPath,
    dir,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

function fakeEl(partial: { scrollTop: number; scrollHeight: number; clientHeight: number }) {
  return { ...partial };
}

describe('B9 GATE-ATOMIC capstone (static + pure + [DB] re-proof)', () => {
  // --- AC2 R1.2: no-co-planner fast path deleted (source contract) ---
  it('AC2: planning-phase-service documents A8 deletion of POCFIX9 partner-less PLAN-READY fast path', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/services/planning-phase-service.ts'),
      'utf8'
    );
    expect(src).toMatch(/A8 \(R1\.2\)/);
    expect(src).toMatch(/no longer fast-paths on PLAN-READY alone|POCFIX9 no-co-planner/);
    // Must still require partner agreement + PLAN-READY in wait path commentary / code
    expect(src).toMatch(/waitForAgreement/);
    // Must not reintroduce a solo planner early-return that skips partner (historical POCFIX9 shape)
    expect(src).not.toMatch(/if\s*\(\s*mode\s*===\s*['"]planner['"]\s*\)\s*return\s+sawPlanReady/);
  });

  // --- AC23 foundation R6.23: pure bottom-stick ---
  it('AC23 foundation: isNearBottom + stick intent preserve when scrolled up', () => {
    expect(
      isNearBottom(fakeEl({ scrollTop: 800, scrollHeight: 1000, clientHeight: 200 }))
    ).toBe(true);
    expect(
      isNearBottom(fakeEl({ scrollTop: 100, scrollHeight: 1000, clientHeight: 200 }))
    ).toBe(false);
    const el = fakeEl({ scrollTop: 50, scrollHeight: 1000, clientHeight: 200 });
    const intent = captureStickIntent(el);
    expect(intent.shouldStick).toBe(false);
    el.scrollHeight = 1200;
    expect(applyStick(el, intent)).toBe(false);
    expect(el.scrollTop).toBe(50);
    const atBottom = fakeEl({ scrollTop: 800, scrollHeight: 1000, clientHeight: 200 });
    const stick = captureStickIntent(atBottom);
    atBottom.scrollHeight = 1200;
    expect(applyStick(atBottom, stick)).toBe(true);
    expect(atBottom.scrollTop).toBe(1200);
  });

  // --- AC25/CSS: fixed 560/340 Discovery caps removed from index.html ---
  it('AC25: Discovery index.html no longer fixes height:560px / min-height:420px / live-stream 340', () => {
    const html = fs.readFileSync(path.join(process.cwd(), 'src/web/public/index.html'), 'utf8');
    expect(html).toMatch(/Removed fixed height:560px|B5.*560/);
    // Live product rule: .cc-disc-split must not reintroduce fixed 560/420
    const discSplit = html.match(/\.cc-disc-split\s*\{[^}]+\}/);
    expect(discSplit).toBeTruthy();
    expect(discSplit![0]).not.toMatch(/height:\s*560px/);
    expect(discSplit![0]).not.toMatch(/min-height:\s*420px/);
    expect(html).toMatch(/max-height:\s*none/);
  });

  // --- AC24: last-reply strip present in product ---
  it('AC24: last-reply strip CSS/testid contract present (B6)', () => {
    const html = fs.readFileSync(path.join(process.cwd(), 'src/web/public/index.html'), 'utf8');
    const app = fs.readFileSync(path.join(process.cwd(), 'src/web/public/app.js'), 'utf8');
    expect(html).toMatch(/cc-last-reply-strip/);
    expect(app).toMatch(/cc-last-reply-strip/);
    expect(app).toMatch(/cc-last-reply-expand|cc-last-reply-hide/);
    // Must not unconditional scrollTop=scrollHeight on the four former sites
    expect(app).not.toMatch(/el\.scrollTop\s*=\s*el\.scrollHeight/);
  });

  // --- AC31: A14 context-sensitive helm_pm resolution present (not naive replace) ---
  it('AC31: run-chat-merge resolves helm_pm via dispatch windows (A14), not naive string map', () => {
    const mergePath = path.join(process.cwd(), 'src/services/run-chat-merge.ts');
    expect(fs.existsSync(mergePath)).toBe(true);
    const merge = fs.readFileSync(mergePath, 'utf8');
    expect(merge).toMatch(/resolveHelmPmRole|BrainDispatchWindow|A14 \(D8\/R4\.31\)/);
    expect(merge).toMatch(/SHARED face for BOTH/);
    // Must not use a static helm_pm → plancore only map as the sole resolver
    expect(merge).not.toMatch(/helm_pm\s*:\s*['"]plancore['"]\s*[,}]/);
  });

  // --- AC27 backend: chat-file writer + [DB] path under project tmp ---
  describe('AC27 B7 writer [path]', () => {
    let cleanupDb: () => void;
    let projDir: string;
    let chatFileSvc: CycleChatFileService;
    let cycleId: number;
    let cycleFolder: string;

    beforeEach(async () => {
      const t = makeTempDb();
      cleanupDb = () => {
        t.cleanup();
        try {
          fs.rmSync(projDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      };
      const dbs = new DatabaseService(t.dbPath);
      const ps = new ProjectService(dbs);
      const cycleSvc = new CycleService(dbs, ps);
      chatFileSvc = new CycleChatFileService(cycleSvc);
      projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b9-proj-'));
      const proj = ps.createProject({ name: `b9-cap-${Date.now()}`, directory: projDir });
      const cycle = await cycleSvc.createCycle(proj.id, 'B9 cap cycle');
      cycleId = cycle.id;
      cycleFolder = cycle.folder_name;
    });

    afterEach(() => cleanupDb());

    it('writes text under project/tmp/<folder>/ and returns project-relative path', async () => {
      const r = await chatFileSvc.saveCycleChatFile(cycleId, 'capstone-note.txt', 'b9 capstone body');
      expect(r.path).toBe(`tmp/${cycleFolder}/capstone-note.txt`);
      const abs = path.join(projDir, r.path);
      expect(fs.existsSync(abs)).toBe(true);
      expect(fs.readFileSync(abs, 'utf8')).toBe('b9 capstone body');
      // Never under OS /tmp as the relative path shape
      expect(r.path.startsWith('tmp/')).toBe(true);
      expect(r.path.includes(os.tmpdir())).toBe(false);
    });

    it('rejects collision (exclusive create)', async () => {
      await chatFileSvc.saveCycleChatFile(cycleId, 'once.txt', 'first');
      await expect(chatFileSvc.saveCycleChatFile(cycleId, 'once.txt', 'second')).rejects.toMatchObject({
        code: 'CONFLICT',
      });
      expect(fs.readFileSync(path.join(projDir, 'tmp', cycleFolder, 'once.txt'), 'utf8')).toBe('first');
    });
  });

  // --- AC16 substrate: worker_runtimes can hold run+project linkage ---
  it('AC16 [DB]: worker_runtimes row can link project_id + run_id + role/model/session', () => {
    const t = makeTempDb();
    try {
      const dbs = new DatabaseService(t.dbPath);
      const ps = new ProjectService(dbs);
      const proj = ps.createProject({
        name: `b9-seats-${Date.now()}`,
        directory: fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b9-seats-')),
      });
      const run = dbs.raw
        .prepare(
          `INSERT INTO runs (project_id, cycle_id, batch_id, status, phase)
           VALUES (?, NULL, 'b9-cap', 'active', 'planning') RETURNING id`
        )
        .get(proj.id) as { id: number };
      const wr = dbs.raw
        .prepare(
          `INSERT INTO worker_runtimes (project_id, role, provider, model, session, correlation_id, state, spawned_by, run_id, started_at)
           VALUES (?,?,?,?,?,?,'running','b9-capstone',?, datetime('now')) RETURNING id, project_id, run_id, role, model, session`
        )
        .get(proj.id, 'plancore', 'xai', 'grok-4.5', 'helm-b9-fake', 'b9-cap-plancore', run.id) as any;
      expect(wr.project_id).toBe(proj.id);
      expect(wr.run_id).toBe(run.id);
      expect(wr.role).toBe('plancore');
      expect(wr.model).toBe('grok-4.5');
      expect(wr.session).toBe('helm-b9-fake');
    } finally {
      t.cleanup();
    }
  });

  // --- AC12/R2.12: HELM_RUN_ROOT set in ecosystem (not default os.tmpdir alone) ---
  it('AC12: ecosystem.config.cjs sets HELM_RUN_ROOT under project data/runs', () => {
    const eco = fs.readFileSync(path.join(process.cwd(), 'ecosystem.config.cjs'), 'utf8');
    expect(eco).toMatch(/HELM_RUN_ROOT/);
    expect(eco).toMatch(/data\/runs|Helm\/data\/runs/);
  });

  // --- AC8/AC27 scaffold: scaffoldProjectFolders ensures tmp/ in gitignore (B7; API POST projects calls this) ---
  it('AC8/AC27 scaffold: scaffoldProjectFolders ensures tmp/ in .gitignore', async () => {
    const t = makeTempDb();
    const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b9-gi-'));
    try {
      const dbs = new DatabaseService(t.dbPath);
      const ps = new ProjectService(dbs);
      const docs = new ProjectDocsService(ps);
      ps.createProject({ name: `b9-gi-${Date.now()}`, directory: projDir });
      await docs.scaffoldProjectFolders(projDir);
      const gi = path.join(projDir, '.gitignore');
      expect(fs.existsSync(gi)).toBe(true);
      const body = fs.readFileSync(gi, 'utf8');
      expect(body.split(/\r?\n/).some((l) => l.trim() === 'tmp/' || l.trim() === 'tmp')).toBe(true);
    } finally {
      t.cleanup();
      try {
        fs.rmSync(projDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });
});
