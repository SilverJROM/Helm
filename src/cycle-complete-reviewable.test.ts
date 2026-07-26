import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService } from './db/database.js';
import { ProjectService } from './services/project-service.js';
import { CycleService } from './services/cycle-service.js';
import { CycleDocsService } from './services/cycle-docs-service.js';

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b11t05-'));
  const dbPath = path.join(dir, 'test.db');
  return { dbPath, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

describe('B11-T05: completed cycle reviewable + orphan-guard (R-B2, R-G3)', () => {
  let cleanupDb: () => void;
  let dbs: DatabaseService;
  let projectService: ProjectService;
  let cycleService: CycleService;
  let cycleDocsService: CycleDocsService;
  let projDir: string;
  let projId: number;

  beforeEach(() => {
    process.env.HELM_DB_PATH = path.join(
      os.tmpdir(),
      `helm-b11t05-db-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
    const t = makeTempDb();
    cleanupDb = t.cleanup;
    dbs = new DatabaseService(t.dbPath);
    projectService = new ProjectService(dbs);
    cycleService = new CycleService(dbs, projectService);
    cycleDocsService = new CycleDocsService(cycleService);

    projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b11t05-proj-'));
    const proj = projectService.createProject({ name: 'B11T05-reviewable', directory: projDir });
    projId = proj.id;
  });

  afterEach(() => {
    dbs.close();
    cleanupDb();
    try { fs.rmSync(projDir, { recursive: true, force: true }); } catch {}
    try { if (process.env.HELM_DB_PATH) fs.unlinkSync(process.env.HELM_DB_PATH); } catch {}
  });

  it('active cycle getCycleDocDir still resolves to cycle/<folder> (no regression)', async () => {
    const created = await cycleService.createCycle(projId, 'Active Probe');
    const docDir = cycleService.getCycleDocDir(created.id);
    expect(docDir).toBe(path.join(projDir, 'cycle', created.folder_name));
    expect(docDir).not.toContain(path.join('cycle', 'completed'));
  });

  it('(a) completed cycle docs readable via readCycleDoc + listCycleArtifacts from completed/', async () => {
    const created = await cycleService.createCycle(projId, 'Reviewable Cycle');
    const activeDir = path.join(projDir, 'cycle', created.folder_name);
    const ogContent = '# Original Requirements\n\nCycle completed — must stay readable from History.';
    fs.writeFileSync(path.join(activeDir, 'og_req.md'), ogContent, 'utf8');

    const completed = await cycleService.completeCycle(created.id);
    expect(completed.status).toBe('completed');

    const docDir = cycleService.getCycleDocDir(created.id);
    expect(docDir).toBe(path.join(projDir, 'cycle', 'completed', created.folder_name));
    expect(fs.existsSync(docDir)).toBe(true);
    expect(fs.existsSync(activeDir)).toBe(false);

    const doc = await cycleDocsService.readCycleDoc(created.id, 'og_req.md');
    expect(doc.content).toBe(ogContent);
    expect(doc.filename).toBe('og_req.md');

    const listing = await cycleDocsService.listCycleArtifacts(created.id);
    expect(listing.docs.map((d) => d.name)).toContain('og_req.md');
  });

  it('(b) completeCycle guarded when active worker_runtime exists (no move, CONFLICT)', async () => {
    const created = await cycleService.createCycle(projId, 'Guarded Cycle');
    const activePath = path.join(projDir, 'cycle', created.folder_name);

    const runRow = dbs.prepare(
      `INSERT INTO runs (project_id, cycle_id, batch_id, north_star_ref, status)
       VALUES (?, ?, 'batch-B11T05-guard', 'north_star.md', 'active') RETURNING id`
    ).get(projId, created.id) as { id: number };

    dbs.prepare(
      `INSERT INTO worker_runtimes (project_id, role, provider, model, state, run_id, started_at)
       VALUES (?, 'implementer', 'grok', 'grok-4.5', 'running', ?, datetime('now'))`
    ).run(projId, runRow.id);

    let caught: any;
    try {
      await cycleService.completeCycle(created.id);
    } catch (e: any) {
      caught = e;
    }

    expect(caught).toBeTruthy();
    expect(caught.code).toBe('CONFLICT');
    expect(String(caught.message)).toMatch(/active agents|open handles/i);

    expect(fs.existsSync(activePath)).toBe(true);
    const row = dbs.prepare('SELECT status FROM cycles WHERE id = ?').get(created.id) as any;
    expect(row.status).toBe('active');
  });

  it('(c) normal completion moves folder, sets completed, docs remain readable', async () => {
    const created = await cycleService.createCycle(projId, 'Normal Complete');
    const activePath = path.join(projDir, 'cycle', created.folder_name);
    const completedPath = path.join(projDir, 'cycle', 'completed', created.folder_name);
    const planContent = '# Execution Plan\n\nBatch B11-T05 normal path.';
    fs.writeFileSync(path.join(activePath, 'execution_plan.md'), planContent, 'utf8');

    const result = await cycleService.completeCycle(created.id);

    expect(result.status).toBe('completed');
    expect(result.folder_path).toBe(completedPath);
    expect(fs.existsSync(activePath)).toBe(false);
    expect(fs.existsSync(completedPath)).toBe(true);

    const doc = await cycleDocsService.readCycleDoc(created.id, 'execution_plan.md');
    expect(doc.content).toBe(planContent);
  });
});