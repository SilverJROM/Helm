import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

// A6b (R3.14 post-approve half) live proof on :3110 / cards2-ibrain.db via playwright.cap.config.ts.
// Scope ONLY: after Approve on a pause_after_planning cycle in awaiting_approval, a fresh cyclePlan
// run starts and the implementation queue actually dispatches (run_tasks leave pending / attempts).
//
// Setup reliability (attempt=2): do NOT cold-spawn plancore (~80–120s first-callback, flaky under
// 180s wall). Land at awaiting_approval via production POST /api/cycles/:id/finish-planning
// (same CycleService.finishPlanning the orchestrator uses at planning-done). Park half is A6
// VERIFIED. A15 worker_runtimes finalize is out of scope.

const BASE = process.env.HELM_BASE_URL || 'http://127.0.0.1:3110';
const CRED = process.env.HELM_OWNER_CRED || 'cards2-harness-563f750bebc23bba';
const DB_PATH = process.env.HELM_DB_PATH_LIVE || '/home/agjrom/websites/Helm/data/cards2-ibrain.db';
const RUN_TS = Date.now();
const PROJECT_NAME = `a6b-validation-${RUN_TS}`;
const PROJECT_DIR = `/home/agjrom/websites/a6b-validation-${RUN_TS}`;
const OWNER_MARKER = '.a6b-live-owned';
const HELM_RUN_ROOT = process.env.HELM_RUN_ROOT_OVERRIDE || '/home/agjrom/websites/Helm/data/runs';
const EVIDENCE_DIR = path.join(process.cwd(), 'validation', 'A6b');
const PLAN_DIR_EVIDENCE = path.join(process.cwd(), 'plan', 'helm-ux-remediation', 'validation', 'A6b');

const VALID_PLAN_MD =
  '# Plan\n\n```json\n[{"id":"T1","batch":"A6b","title":"A6b post-approve dispatch proof","req_refs":["R3.14"],"assignee":"grok-4.5","validator_lane":"L2","effort":"low","type":"feature"}]\n```\n';
const VALID_OGREQ = '# Requirements\n\n- **R3.14** — approve unparks and implementation queue dispatches.\n';
const VALID_NS = '# North star\n\nA6b post-approve dispatch proof (throwaway).\n';

function predictRunDir(projectId: number, batchId: string): string {
  return path.join(HELM_RUN_ROOT, `helm-run-${projectId}-${batchId}`);
}

async function login(): Promise<string> {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential: CRED }),
  });
  const d = await r.json();
  if (!d.token) throw new Error(`login failed: ${JSON.stringify(d)}`);
  return d.token;
}

function ensureEvidenceDirs() {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.mkdirSync(PLAN_DIR_EVIDENCE, { recursive: true });
}

function readRun(runId: number): any {
  const db = new Database(DB_PATH, { readonly: true });
  const row = db.prepare('SELECT id, cycle_id, batch_id, phase, status FROM runs WHERE id = ?').get(runId);
  db.close();
  return row;
}

function readCycle(cycleId: number): any {
  const db = new Database(DB_PATH, { readonly: true });
  const row = db.prepare('SELECT phase, autonomy, awaiting_approval FROM cycles WHERE id = ?').get(cycleId);
  db.close();
  return row;
}

test.describe('A6b live: post-approve implementation dispatch on :3110', () => {
  let token: string;
  let projectId: number;
  let cycleId: number;
  let cycleDir = '';
  let implRunId: number | null = null;
  let implRunDir = '';

  test.beforeAll(async () => {
    if (fs.existsSync(PROJECT_DIR)) {
      throw new Error(
        `A6b live refuse: PROJECT_DIR already exists (${PROJECT_DIR}). ` +
          `Refusing to reuse or delete a path this test did not create.`
      );
    }
    fs.mkdirSync(PROJECT_DIR, { recursive: false });
    fs.writeFileSync(
      path.join(PROJECT_DIR, OWNER_MARKER),
      `owned-by e2e/A6b.live.spec.ts ${PROJECT_NAME}\n`,
      'utf8'
    );
    ensureEvidenceDirs();
    token = await login();

    const projResp = await fetch(`${BASE}/api/projects`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: PROJECT_NAME,
        directory: PROJECT_DIR,
        autonomy_default: 'pause_after_planning',
      }),
    });
    const projData = await projResp.json();
    if (!projResp.ok) throw new Error(`project create failed: ${JSON.stringify(projData)}`);
    projectId = projData.project.id;

    const cycleResp = await fetch(`${BASE}/api/projects/${projectId}/cycles`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `A6b dispatch ${RUN_TS}`,
        autonomy: 'pause_after_planning',
      }),
    });
    const cycleData = await cycleResp.json();
    if (!cycleResp.ok) throw new Error(`cycle create failed: ${JSON.stringify(cycleData)}`);
    cycleId = cycleData.cycle.id;
    cycleDir = path.join(PROJECT_DIR, 'cycle', String(cycleData.cycle.folder_name));
    fs.mkdirSync(cycleDir, { recursive: true });
    // Author the plan the post-approve cyclePlan run will ingest (cycle folder is canonical root).
    fs.writeFileSync(path.join(cycleDir, 'og-requirements.md'), VALID_OGREQ, 'utf8');
    fs.writeFileSync(path.join(cycleDir, 'plan.md'), VALID_PLAN_MD, 'utf8');
    fs.writeFileSync(path.join(cycleDir, 'north-star.md'), VALID_NS, 'utf8');
  });

  test.afterAll(async () => {
    if (implRunId != null) {
      try {
        const row = readRun(implRunId);
        const terminal =
          row &&
          (['complete', 'failed', 'blocked'].includes(String(row.phase)) ||
            ['complete', 'failed', 'paused'].includes(String(row.status)));
        if (!terminal) {
          await fetch(`${BASE}/api/runs/${implRunId}/stop`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: 'A6b live evidence capture complete' }),
          });
          await new Promise((r) => setTimeout(r, 2000));
        }
      } catch { /* best-effort */ }
    }

    try {
      const db = new Database(DB_PATH);
      if (implRunId != null) {
        db.prepare('DELETE FROM worker_runtimes WHERE run_id = ?').run(implRunId);
        db.prepare('DELETE FROM helm_sessions WHERE run_id = ?').run(implRunId);
        db.prepare('DELETE FROM run_tasks WHERE run_id = ?').run(implRunId);
        db.prepare('DELETE FROM run_events WHERE run_id = ?').run(implRunId);
      }
      if (projectId != null) {
        try {
          db.prepare('DELETE FROM master_runtimes WHERE project_id = ?').run(projectId);
        } catch { /* optional */ }
      }
      db.close();
    } catch { /* best-effort */ }

    if (projectId != null) {
      try {
        await fetch(`${BASE}/api/projects/${projectId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch { /* best-effort */ }
    }

    try {
      if (implRunDir && implRunDir.includes(`helm-run-${projectId}-`)) {
        fs.rmSync(implRunDir, { recursive: true, force: true });
      }
    } catch { /* best-effort */ }

    try {
      const markerPath = path.join(PROJECT_DIR, OWNER_MARKER);
      if (
        PROJECT_DIR.includes(`a6b-validation-${RUN_TS}`) &&
        fs.existsSync(markerPath) &&
        fs.readFileSync(markerPath, 'utf8').includes(PROJECT_NAME)
      ) {
        fs.rmSync(PROJECT_DIR, { recursive: true, force: false });
      }
    } catch { /* leave orphan unique dir rather than widen blast radius */ }
  });

  test('approve starts cyclePlan and implementation queue dispatches', async ({ page }) => {
    // Outer contract: timeout 180s. Setup is now seconds (no plancore); rest is approve+dispatch.
    test.setTimeout(170000);
    const t0 = Date.now();
    const mark = (label: string) => console.log(`[A6b.live timing] ${label} at +${Date.now() - t0}ms`);

    const health = await fetch(`${BASE}/health`);
    expect(health.ok).toBe(true);
    expect(BASE).toMatch(/127\.0\.0\.1:3110|localhost:3110/);

    expect(readCycle(cycleId).phase).toBe('discovery');
    expect(readCycle(cycleId).autonomy).toBe('pause_after_planning');

    // --- Setup: land at awaiting_approval without plancore cold-spawn ---
    const phaseResp = await fetch(`${BASE}/api/cycles/${cycleId}/phase`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ phase: 'planning' }),
    });
    const phaseData = await phaseResp.json();
    if (!phaseResp.ok) throw new Error(`phase→planning failed: ${JSON.stringify(phaseData)}`);
    expect(readCycle(cycleId).phase).toBe('planning');

    // Ensure plan is on disk right before finish-planning (cyclePlan after approve reads it).
    fs.mkdirSync(cycleDir, { recursive: true });
    fs.writeFileSync(path.join(cycleDir, 'plan.md'), VALID_PLAN_MD, 'utf8');
    fs.writeFileSync(path.join(cycleDir, 'og-requirements.md'), VALID_OGREQ, 'utf8');
    fs.writeFileSync(path.join(cycleDir, 'north-star.md'), VALID_NS, 'utf8');

    const finResp = await fetch(`${BASE}/api/cycles/${cycleId}/finish-planning`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const finData = await finResp.json();
    if (!finResp.ok) throw new Error(`finish-planning failed: ${JSON.stringify(finData)}`);
    mark('finish-planning returned');

    const gated = readCycle(cycleId);
    expect(gated.phase).toBe('planning');
    expect(Number(gated.awaiting_approval)).toBe(1);
    mark('awaiting_approval=1 (park banner eligible)');

    // --- UI: Approve (the user-visible unpark) ---
    await page.goto(`${BASE}/`);
    await page.locator('input[placeholder="owner credential"]').fill(CRED);
    await page.click('button:has-text("Login")');
    await page.getByTestId('nav-project-setup').waitFor({ state: 'visible', timeout: 15000 });

    await page.goto(`${BASE}/#07-command-center-overview`);
    await expect(page.getByTestId('ov-board')).toBeVisible({ timeout: 15000 });

    let card = page.getByTestId(`ov-card-${projectId}`);
    let cardVisible = false;
    const uiDeadline = Date.now() + 20000;
    while (Date.now() < uiDeadline) {
      for (const tab of ['ov-tab-active', 'ov-tab-pending', 'ov-tab-completed'] as const) {
        const t = page.getByTestId(tab);
        if (await t.count()) await t.click();
        card = page.getByTestId(`ov-card-${projectId}`);
        if ((await card.count()) && (await card.isVisible())) {
          cardVisible = true;
          break;
        }
      }
      if (cardVisible) break;
      await page.reload();
      await page.goto(`${BASE}/#07-command-center-overview`);
      await expect(page.getByTestId('ov-board')).toBeVisible({ timeout: 10000 });
      await new Promise((r) => setTimeout(r, 1500));
    }
    expect(cardVisible, `ov-card-${projectId} not found`).toBe(true);
    await card.click();
    await expect(page.getByTestId('content-cmd-workspace')).toBeVisible({ timeout: 15000 });
    const planTab = page.getByTestId('ws-tab-planning');
    if (await planTab.count()) await planTab.click();
    await expect(page.getByTestId('ws-plan-approve-banner')).toBeVisible({ timeout: 15000 });
    const bannerText = (await page.getByTestId('ws-plan-approve-banner').innerText()).toLowerCase();
    expect(bannerText).toContain('awaiting your approval');
    mark('park banner visible');

    mark('approve click');
    await page.getByTestId('ws-plan-approve-btn').click();
    await expect(page.getByTestId('ws-plan-approve-banner')).toBeHidden({ timeout: 15000 });
    mark('banner hidden after approve');

    expect(readCycle(cycleId).phase).toBe('implementation');
    expect(Number(readCycle(cycleId).awaiting_approval)).toBe(0);

    // Fresh cyclePlan run started by approve (no prior planning run on this path).
    let newRunRow: any = null;
    const newRunDeadline = Date.now() + 20000;
    while (Date.now() < newRunDeadline) {
      const db = new Database(DB_PATH, { readonly: true });
      newRunRow = db
        .prepare('SELECT id, batch_id, phase, status FROM runs WHERE cycle_id = ? ORDER BY id DESC LIMIT 1')
        .get(cycleId);
      db.close();
      if (newRunRow) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    mark('fresh cyclePlan run discovered');
    expect(newRunRow, 'approve did not start a fresh implementation run').toBeTruthy();
    implRunId = Number(newRunRow.id);
    implRunDir = predictRunDir(projectId, String(newRunRow.batch_id));

    // Inject implementer/validator callbacks; re-append in proceed loop for POCFIX22 offset fence.
    const implDriveDeadline = Date.now() + 15000;
    let implDrove = false;
    while (Date.now() < implDriveDeadline) {
      try {
        fs.mkdirSync(implRunDir, { recursive: true });
        fs.appendFileSync(
          path.join(implRunDir, 'callbacks.md'),
          `[helm callback] implementer ${newRunRow.batch_id} STATUS: DONE — a6b wired\n` +
            `[helm callback] validator ${newRunRow.batch_id} STATUS: PASS — verified\n` +
            `[helm callback] panelist ${newRunRow.batch_id} STATUS: VERDICT-READY — CLEAN: all gates pass (seat red-a6b:0)\n` +
            `[helm callback] panelist ${newRunRow.batch_id} STATUS: VERDICT-READY — CLEAN: regressions hold (seat red-a6b:1)\n`,
          'utf8'
        );
        implDrove = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    expect(implDrove, 'could not write impl drive artifacts').toBe(true);

    // PROCEEDING: queue dispatched (status left pending and/or attempts exist).
    let proceeded = false;
    let loggedIngested = false;
    const proceedDeadline = Date.now() + 55000;
    while (Date.now() < proceedDeadline) {
      const db = new Database(DB_PATH, { readonly: true });
      const tasks = db.prepare('SELECT status FROM run_tasks WHERE run_id = ?').all(implRunId) as any[];
      const attempts = db
        .prepare(
          'SELECT COUNT(*) AS c FROM task_attempts ta JOIN run_tasks rt ON ta.task_id = rt.id WHERE rt.run_id = ?'
        )
        .get(implRunId) as any;
      db.close();
      if (!loggedIngested && tasks.length > 0) {
        loggedIngested = true;
        mark('cyclePlan run_tasks ingested');
      }
      if (tasks.length > 0 && (tasks.some((t) => t.status !== 'pending') || Number(attempts.c) > 0)) {
        proceeded = true;
        break;
      }
      try {
        fs.appendFileSync(
          path.join(implRunDir, 'callbacks.md'),
          `[helm callback] implementer ${newRunRow.batch_id} STATUS: DONE — a6b reassert\n`,
          'utf8'
        );
      } catch { /* dir materializing */ }
      await new Promise((r) => setTimeout(r, 1500));
    }
    mark('proceed poll exited');
    expect(proceeded, 'implementation queue never dispatched after approve (A6b)').toBe(true);

    // UI proceeding evidence.
    const implTab = page.getByTestId('ws-tab-implementation');
    await implTab.click();
    await expect(page.getByTestId('ws-impl-metrics')).toBeVisible({ timeout: 15000 });

    await page.screenshot({
      path: path.join(EVIDENCE_DIR, 'A6b-implementation-proceeding.png'),
      fullPage: true,
    });
    const proceedingAria = await page.getByTestId('content-cmd-workspace').ariaSnapshot();
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'A6b-implementation-proceeding-aria-snapshot.yaml'), proceedingAria, 'utf8');
    fs.copyFileSync(
      path.join(EVIDENCE_DIR, 'A6b-implementation-proceeding.png'),
      path.join(PLAN_DIR_EVIDENCE, 'A6b-implementation-proceeding.png')
    );
    fs.copyFileSync(
      path.join(EVIDENCE_DIR, 'A6b-implementation-proceeding-aria-snapshot.yaml'),
      path.join(PLAN_DIR_EVIDENCE, 'A6b-implementation-proceeding-aria-snapshot.yaml')
    );
    mark('proceeding evidence written');
  });
});
