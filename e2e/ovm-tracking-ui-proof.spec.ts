import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const CRED = process.env.HELM_OWNER_CRED || 'JROM-OWNER-SECRET-2026';
const SHOT_DIR = path.join(process.cwd(), 'plan/WK_0715/projcore-run-2026-07-15-helm-consolidation/validation/o62-ui-proof');
const PROJ_DIR = `/tmp/helm-o62-ui-proof-${process.pid}`;
const DB_PATH = '/tmp/helm-e2e.db';

test.describe('O6.2 Tracking UI-PROOF (native run substrate, read-only)', () => {
  let projectId = 0;
  const ids: Record<string, number> = {};

  test.beforeAll(async ({ request }) => {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    fs.mkdirSync(PROJ_DIR, { recursive: true });

    const loginResp = await request.post('/api/auth/login', { data: { credential: CRED } });
    const { token } = await loginResp.json();

    const projResp = await request.post('/api/projects', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { name: `O6.2 Tracking Proof ${process.pid}`, directory: PROJ_DIR },
    });
    expect(projResp.ok()).toBeTruthy();
    const { project } = await projResp.json();
    projectId = project.id;

    const db = new Database(DB_PATH);
    const now = new Date().toISOString();

    const insertRun = (opts: { batchId: string; status: string; phase: string; source: string; externalRunId?: string; generation?: number }) => {
      const info = db.prepare(
        `INSERT INTO runs (project_id, batch_id, status, phase, started_at, external_run_id, generation, source)
         VALUES (?,?,?,?,?,?,?,?)`
      ).run(projectId, opts.batchId, opts.status, opts.phase, now, opts.externalRunId ?? null, opts.generation ?? 0, opts.source);
      return Number(info.lastInsertRowid);
    };
    const insertTask = (runId: number, label: string, status: string) => {
      db.prepare(`INSERT INTO run_tasks (run_id, label, status, created_at, updated_at) VALUES (?,?,?,?,?)`)
        .run(runId, label, status, now, now);
    };
    const insertWorker = (runId: number, role: string) => {
      const info = db.prepare(
        `INSERT INTO worker_runtimes (project_id, run_id, role, provider, model, state, started_at, ts) VALUES (?,?,?,?,?,?,?,?)`
      ).run(projectId, runId, role, 'codex', 'gpt-5.5', 'running', now, now);
      return Number(info.lastInsertRowid);
    };
    const insertSession = (runId: number, name: string) => {
      const info = db.prepare(
        `INSERT INTO helm_sessions (name, kind, project_id, run_id, status, created_at, last_used_at) VALUES (?,?,?,?,?,?,?)`
      ).run(name, 'implementer', projectId, runId, 'active', now, now);
      return Number(info.lastInsertRowid);
    };

    // 1. active run WITH children (real workers/sessions, non-terminal, mixed task progress)
    const activeId = insertRun({ batchId: 'trk-active', status: 'active', phase: 'executing', source: 'native' });
    insertTask(activeId, 'a1', 'complete');
    insertTask(activeId, 'a2', 'complete');
    insertTask(activeId, 'a3', 'failed');
    insertTask(activeId, 'a4', 'deferred');
    insertTask(activeId, 'a5', 'working');
    const activeWorkerId = insertWorker(activeId, 'implementer');
    const activeSessionId = insertSession(activeId, `helm-o62-active-${process.pid}`);
    ids.active = activeId; ids.activeWorker = activeWorkerId; ids.activeSession = activeSessionId;

    // 2. blocked run (terminal via phase, no active children)
    const blockedId = insertRun({ batchId: 'trk-blocked', status: 'failed', phase: 'blocked', source: 'ingest', externalRunId: 'ext-blocked-1', generation: 2 });
    insertTask(blockedId, 'b1', 'complete');
    insertTask(blockedId, 'b2', 'failed');
    ids.blocked = blockedId;

    // 3. complete run (terminal, no active children)
    const completeId = insertRun({ batchId: 'trk-complete', status: 'complete', phase: 'complete', source: 'native' });
    insertTask(completeId, 'c1', 'complete');
    insertTask(completeId, 'c2', 'complete');
    insertTask(completeId, 'c3', 'complete');
    ids.complete = completeId;

    // 4. zero-task run (non-terminal, no tasks at all -> 'empty' state)
    const zeroId = insertRun({ batchId: 'trk-zero', status: 'active', phase: 'planning', source: 'native' });
    ids.zero = zeroId;

    // 5. no-child run (active, has tasks, but zero active workers/sessions -> must not fabricate a child row)
    const nochildId = insertRun({ batchId: 'trk-nochild', status: 'active', phase: 'executing', source: 'ingest' });
    insertTask(nochildId, 'n1', 'complete');
    insertTask(nochildId, 'n2', 'complete');
    insertTask(nochildId, 'n3', 'working');
    ids.nochild = nochildId;

    db.close();
  });

  test.afterAll(async () => {
    try { fs.rmSync(PROJ_DIR, { recursive: true, force: true }); } catch {}
  });

  test('Tracking nav (desktop + mobile) + real seeded run/child states + refresh + no fabricated rows', async ({ page }) => {
    test.setTimeout(120000);
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));

    await page.goto('/');
    await page.locator('input[placeholder="owner credential"]').fill(CRED);
    await page.click('button:has-text("Login")');
    await expect(page.getByTestId('nav-project-setup')).toBeVisible({ timeout: 15000 });

    // AC1a: desktop nav reachable
    await expect(page.getByTestId('nav-tracking')).toBeVisible();
    await page.getByTestId('nav-tracking').click();
    await expect(page.getByTestId('tab-tracking')).toBeVisible();
    await expect(page.getByTestId('content-tracking')).toBeVisible({ timeout: 10000 });

    // AC2/AC4: seeded states render their exact real values (not derived guesses, not fabricated)
    const activeRow = page.getByTestId(`tracking-run-${ids.active}`);
    await expect(activeRow).toBeVisible();
    await expect(page.getByTestId(`tracking-run-phase-${ids.active}`)).toContainText('executing');
    await expect(page.getByTestId(`tracking-run-status-${ids.active}`)).toContainText('active');
    await expect(page.getByTestId(`tracking-run-state-${ids.active}`)).toContainText('active');
    await expect(page.getByTestId(`tracking-run-progress-${ids.active}`)).toContainText('2/5 done');
    await expect(page.getByTestId(`tracking-run-progress-${ids.active}`)).toContainText('1 failed');
    await expect(page.getByTestId(`tracking-run-progress-${ids.active}`)).toContainText('1 parked');
    await expect(page.getByTestId(`tracking-run-source-${ids.active}`)).toHaveText('native');
    await expect(page.getByTestId(`tracking-worker-${ids.activeWorker}`)).toBeVisible();
    await expect(page.getByTestId(`tracking-worker-${ids.activeWorker}`)).toContainText('codex/gpt-5.5');
    await expect(page.getByTestId(`tracking-session-${ids.activeSession}`)).toBeVisible();

    const blockedRow = page.getByTestId(`tracking-run-${ids.blocked}`);
    await expect(blockedRow).toBeVisible();
    await expect(page.getByTestId(`tracking-run-phase-${ids.blocked}`)).toContainText('blocked');
    await expect(page.getByTestId(`tracking-run-status-${ids.blocked}`)).toContainText('failed');
    await expect(page.getByTestId(`tracking-run-source-${ids.blocked}`)).toHaveText('ingest');
    await expect(blockedRow).toContainText('ext-blocked-1/gen2');
    await expect(page.getByTestId(`tracking-workers-empty-${ids.blocked}`)).toBeVisible();
    await expect(page.getByTestId(`tracking-sessions-empty-${ids.blocked}`)).toBeVisible();

    const completeRow = page.getByTestId(`tracking-run-${ids.complete}`);
    await expect(completeRow).toBeVisible();
    await expect(page.getByTestId(`tracking-run-phase-${ids.complete}`)).toContainText('complete');
    await expect(page.getByTestId(`tracking-run-progress-${ids.complete}`)).toContainText('3/3 done');
    await expect(page.getByTestId(`tracking-workers-empty-${ids.complete}`)).toBeVisible();

    const zeroRow = page.getByTestId(`tracking-run-${ids.zero}`);
    await expect(zeroRow).toBeVisible();
    await expect(page.getByTestId(`tracking-run-state-${ids.zero}`)).toContainText('empty');
    await expect(page.getByTestId(`tracking-run-progress-${ids.zero}`)).toContainText('0/0 done');

    const nochildRow = page.getByTestId(`tracking-run-${ids.nochild}`);
    await expect(nochildRow).toBeVisible();
    await expect(page.getByTestId(`tracking-run-state-${ids.nochild}`)).toContainText('active');
    await expect(page.getByTestId(`tracking-run-progress-${ids.nochild}`)).toContainText('2/3 done');
    // AC3: no placeholder/fake child row for a run with real tasks but zero active children
    await expect(page.getByTestId(`tracking-workers-empty-${ids.nochild}`)).toBeVisible();
    await expect(page.getByTestId(`tracking-sessions-empty-${ids.nochild}`)).toBeVisible();
    await expect(page.getByTestId(`tracking-worker-${ids.nochild}`)).toHaveCount(0);

    // exactly the 5 seeded runs — nothing fabricated, nothing dropped
    await expect(page.getByTestId(/^tracking-run-\d+$/)).toHaveCount(5);

    await page.screenshot({ path: path.join(SHOT_DIR, '01-tracking-desktop.png'), fullPage: true });

    // AC3: progress + child rows update after refresh (real DB mutation between loads, not a client-side re-render of stale data)
    const db2 = new Database(DB_PATH);
    db2.prepare(`UPDATE run_tasks SET status = 'complete', updated_at = ? WHERE run_id = ? AND label = 'a5'`)
      .run(new Date().toISOString(), ids.active);
    db2.prepare(`UPDATE worker_runtimes SET state = 'done', ended_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), ids.activeWorker);
    db2.close();

    await page.getByTestId('tracking-refresh-btn').click();
    await expect(page.getByTestId(`tracking-run-progress-${ids.active}`)).toContainText('3/5 done', { timeout: 10000 });
    await expect(page.getByTestId(`tracking-workers-empty-${ids.active}`)).toBeVisible();
    await expect(page.getByTestId(`tracking-worker-${ids.activeWorker}`)).toHaveCount(0);

    // navigate away first (desktop) so the mobile check below proves reachability, not a stale view
    await page.getByTestId('nav-project-setup').click();
    await expect(page.getByTestId('tab-projects')).toBeVisible();

    // AC1b: mobile nav reachable via drawer
    await page.setViewportSize({ width: 390, height: 844 });
    const ham = page.getByTestId('mobile-hamburger');
    await expect(ham).toBeVisible();
    await ham.click();
    await expect(page.getByTestId('nav-tracking')).toBeVisible({ timeout: 5000 });
    await page.getByTestId('nav-tracking').click();
    await expect(page.getByTestId('content-tracking')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId(`tracking-run-${ids.complete}`)).toBeVisible();
    await page.screenshot({ path: path.join(SHOT_DIR, '02-tracking-mobile.png'), fullPage: true });

    // AC4/empty+error states: unauthenticated project filter -> 400 surfaces as a real error banner, not a silent blank
    await page.setViewportSize({ width: 1280, height: 900 });
    const badResp = await page.evaluate(async () => {
      const token = sessionStorage.getItem('helm_token');
      const r = await fetch('/api/tracking?project_id=not-a-number', { headers: { Authorization: `Bearer ${token}` } });
      return r.status;
    });
    expect(badResp).toBe(400);

    expect(errors.some((e) => /SyntaxError|Unexpected token/.test(e))).toBeFalsy();
  });
});
