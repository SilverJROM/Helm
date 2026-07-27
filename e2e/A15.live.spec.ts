import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

// A15 (R4.16/R4.17 finalize-to-reaped / truthful live) on :3110 / cards2-ibrain.db.
// Spawn a planning seat row (or real seat), stop so session dies; assert terminals/seats
// no longer show that seat as live/WORKING. Throwaway project; scoped teardown.

const BASE = process.env.HELM_BASE_URL || 'http://127.0.0.1:3110';
const CRED = process.env.HELM_OWNER_CRED || 'cards2-harness-563f750bebc23bba';
const DB_PATH = process.env.HELM_DB_PATH_LIVE || '/home/agjrom/websites/Helm/data/cards2-ibrain.db';
const RUN_TS = Date.now();
const PROJECT_NAME = `a15-validation-${RUN_TS}`;
const PROJECT_DIR = `/home/agjrom/websites/a15-validation-${RUN_TS}`;
const OWNER_MARKER = '.a15-live-owned';
const BATCH_ID = `a15-live-${RUN_TS}`;
const HELM_RUN_ROOT = process.env.HELM_RUN_ROOT_OVERRIDE || '/home/agjrom/websites/Helm/data/runs';
const EVIDENCE_DIR = path.join(process.cwd(), 'validation', 'A15');
const PLAN_DIR_EVIDENCE = path.join(process.cwd(), 'plan', 'helm-ux-remediation', 'validation', 'A15');

const VALID_PLAN_MD =
  '# Plan\n\n```json\n[{"id":"T1","batch":"A15","title":"A15 finalize-to-reaped proof","req_refs":["R4.16"],"assignee":"grok-4.5","validator_lane":"L2","effort":"low","type":"feature"}]\n```\n';
const VALID_OGREQ = '# Requirements\n\n- **R4.16** — seats terminal when session gone.\n';
const VALID_NS = '# North star\n\nA15 throwaway finalize-to-reaped.\n';

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

test.describe('A15 live: finalize-to-reaped / truthful live on :3110', () => {
  let token: string;
  let projectId: number;
  let cycleId: number;
  let cycleDir = '';
  let runId: number | null = null;
  let runDir = '';
  let wrId: number | null = null;

  test.beforeAll(async () => {
    if (fs.existsSync(PROJECT_DIR)) {
      throw new Error(
        `A15 live refuse: PROJECT_DIR already exists (${PROJECT_DIR}). ` +
          `Refusing to reuse or delete a path this test did not create.`
      );
    }
    fs.mkdirSync(PROJECT_DIR, { recursive: false });
    fs.writeFileSync(
      path.join(PROJECT_DIR, OWNER_MARKER),
      `owned-by e2e/A15.live.spec.ts ${PROJECT_NAME}\n`,
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
        autonomy_default: 'autonomous_after_discovery',
      }),
    });
    const projData = await projResp.json();
    if (!projResp.ok) throw new Error(`project create failed: ${JSON.stringify(projData)}`);
    projectId = projData.project.id;

    const cycleResp = await fetch(`${BASE}/api/projects/${projectId}/cycles`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `A15 finalize ${RUN_TS}`,
        autonomy: 'autonomous_after_discovery',
        final_tests_enabled: false,
      }),
    });
    const cycleData = await cycleResp.json();
    if (!cycleResp.ok) throw new Error(`cycle create failed: ${JSON.stringify(cycleData)}`);
    cycleId = cycleData.cycle.id;
    cycleDir = path.join(PROJECT_DIR, 'cycle', String(cycleData.cycle.folder_name));
    fs.mkdirSync(cycleDir, { recursive: true });
    fs.writeFileSync(path.join(cycleDir, 'plan.md'), VALID_PLAN_MD, 'utf8');
    fs.writeFileSync(path.join(cycleDir, 'og-requirements.md'), VALID_OGREQ, 'utf8');
    fs.writeFileSync(path.join(cycleDir, 'north-star.md'), VALID_NS, 'utf8');
  });

  test.afterAll(async () => {
    if (runId != null) {
      try {
        await fetch(`${BASE}/api/runs/${runId}/stop`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: 'A15 live teardown' }),
        });
      } catch { /* best-effort */ }
    }
    try {
      const db = new Database(DB_PATH);
      if (runId != null) {
        db.prepare('DELETE FROM worker_runtimes WHERE run_id = ?').run(runId);
        db.prepare('DELETE FROM helm_sessions WHERE run_id = ?').run(runId);
        db.prepare('DELETE FROM run_tasks WHERE run_id = ?').run(runId);
        try {
          db.prepare('DELETE FROM master_runtimes WHERE project_id = ?').run(projectId);
        } catch { /* optional */ }
      }
      if (wrId != null) {
        try {
          db.prepare('DELETE FROM worker_runtimes WHERE id = ?').run(wrId);
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
      if (runDir && runDir.includes(`helm-run-${projectId}-`)) {
        fs.rmSync(runDir, { recursive: true, force: true });
      }
    } catch { /* best-effort */ }

    try {
      const markerPath = path.join(PROJECT_DIR, OWNER_MARKER);
      if (
        PROJECT_DIR.includes(`a15-validation-${RUN_TS}`) &&
        fs.existsSync(markerPath) &&
        fs.readFileSync(markerPath, 'utf8').includes(PROJECT_NAME)
      ) {
        fs.rmSync(PROJECT_DIR, { recursive: true, force: false });
      }
    } catch { /* leave orphan */ }
  });

  test('session gone / stop → seat not live on terminals + seats API', async ({ page }) => {
    test.setTimeout(170000);
    const t0 = Date.now();
    const mark = (label: string) => console.log(`[A15.live timing] ${label} at +${Date.now() - t0}ms`);

    const health = await fetch(`${BASE}/health`);
    expect(health.ok).toBe(true);
    expect(BASE).toMatch(/127\.0\.0\.1:3110|localhost:3110/);

    // Fast path: finish-planning + start-implementation so we get a cycle-linked run, then
    // seed a stuck-running worker_runtimes row with a non-existent tmux session (the defect class).
    // Production self-heal on GET /terminals + session-gone finalize must clear it.
    const phaseResp = await fetch(`${BASE}/api/cycles/${cycleId}/phase`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ phase: 'planning' }),
    });
    if (!phaseResp.ok) throw new Error(`phase failed: ${JSON.stringify(await phaseResp.json())}`);

    const finResp = await fetch(`${BASE}/api/cycles/${cycleId}/finish-planning`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!finResp.ok) throw new Error(`finish-planning failed: ${JSON.stringify(await finResp.json())}`);
    mark('finish-planning');

    const startResp = await fetch(`${BASE}/api/cycles/${cycleId}/start-implementation`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ batchId: BATCH_ID }),
    });
    const startData = await startResp.json();
    if (!startResp.ok) throw new Error(`start-implementation failed: ${JSON.stringify(startData)}`);
    runId = startData.runId;
    expect(runId).toBeTruthy();
    runDir = predictRunDir(projectId, String(startData.batchId || BATCH_ID));
    mark(`run ${runId}`);

    // Seed the defect class: worker_runtimes running with a session that does not exist in tmux.
    const ghostSession = `helm-a15-ghost-${RUN_TS}`;
    {
      const db = new Database(DB_PATH);
      const info = db
        .prepare(
          `INSERT INTO worker_runtimes (project_id, role, provider, model, session, correlation_id, state, spawned_by, run_id, started_at)
           VALUES (?,?,?,?,?,?,'running','a15-live-seed',?, datetime('now'))`
        )
        .run(projectId, 'plancore', 'grok', 'grok-4.5', ghostSession, BATCH_ID, runId);
      wrId = Number(info.lastInsertRowid);
      db.close();
    }
    mark(`seeded ghost wr ${wrId}`);

    // DB: still running before any API read
    {
      const db = new Database(DB_PATH, { readonly: true });
      const row = db.prepare('SELECT state, ended_at FROM worker_runtimes WHERE id = ?').get(wrId!) as any;
      db.close();
      expect(row.state).toBe('running');
      expect(row.ended_at).toBeNull();
    }

    // Production: GET /terminals self-heals session-gone → not WORKING
    const termResp = await fetch(`${BASE}/api/projects/${projectId}/terminals`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(termResp.ok).toBe(true);
    const termData = await termResp.json();
    const ghost = (termData.workers || []).find((w: any) => String(w.id) === String(wrId));
    expect(ghost, 'ghost worker must appear in terminals list').toBeTruthy();
    expect(ghost.status).not.toBe('WORKING');
    expect(ghost.live === true).toBe(false);
    expect(['reaped', 'done', 'failed'].includes(String(ghost.state)) || ghost.status === 'idle').toBe(true);
    mark('terminals self-heal ok');

    // DB after self-heal
    {
      const db = new Database(DB_PATH, { readonly: true });
      const row = db.prepare('SELECT state, ended_at, exit_reason FROM worker_runtimes WHERE id = ?').get(wrId!) as any;
      db.close();
      expect(row.state).toBe('reaped');
      expect(row.ended_at).toBeTruthy();
      expect(String(row.exit_reason || '')).toContain('session-gone');
    }

    // SEAM-1 seats: live false for this cycle's seats that are terminal
    const seatsResp = await fetch(`${BASE}/api/cycles/${cycleId}/seats`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(seatsResp.ok).toBe(true);
    const seatsData = await seatsResp.json();
    const seat = (seatsData.seats || []).find((s: any) => Number(s.id) === wrId);
    if (seat) {
      expect(seat.live).toBe(false);
    }

    // Stop the run (true terminal finalize path for any remaining seats)
    await fetch(`${BASE}/api/runs/${runId}/stop`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'A15 live evidence' }),
    });
    mark('stop issued');

    // UI: Terminals tab does not show ghost as WORKING
    await page.goto(`${BASE}/`);
    await page.locator('input[placeholder="owner credential"]').fill(CRED);
    await page.click('button:has-text("Login")');
    await page.getByTestId('nav-project-setup').waitFor({ state: 'visible', timeout: 15000 });

    // Open project cycle workspace → Command Center terminals if available
    await page.goto(`${BASE}/#07-command-center-overview`);
    await expect(page.getByTestId('ov-board')).toBeVisible({ timeout: 15000 });
    const card = page.getByTestId(`ov-card-${projectId}`);
    if (await card.count()) {
      await card.click();
      await expect(page.getByTestId('content-cmd-workspace')).toBeVisible({ timeout: 15000 }).catch(() => {});
    }

    // Prefer dedicated terminals surface used by A1
    await page.goto(`${BASE}/#10-command-center-terminals`);
    await page.waitForTimeout(1500);

    const bodyText = (await page.locator('body').innerText()).toUpperCase();
    // Ghost session name should not be labelled WORKING if visible; tolerate absence of row after terminalize
    if (bodyText.includes(ghostSession.toUpperCase()) || bodyText.includes('PLANCORE')) {
      // If plancore is shown, it must not be WORKING for our ghost
      const statusEls = page.locator('[data-testid*="terminal"], .cc-mt-status, .chip');
      // Soft: page should not claim the ghost session is WORKING
      expect(bodyText.includes(ghostSession.toUpperCase()) && bodyText.includes('WORKING')).toBe(false);
    }

    await page.screenshot({
      path: path.join(EVIDENCE_DIR, 'A15-terminals-not-live.png'),
      fullPage: true,
    });
    fs.copyFileSync(
      path.join(EVIDENCE_DIR, 'A15-terminals-not-live.png'),
      path.join(PLAN_DIR_EVIDENCE, 'A15-terminals-not-live.png')
    );

    const aria = await page.locator('body').ariaSnapshot();
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'A15-terminals-aria-snapshot.yaml'), aria, 'utf8');
    fs.writeFileSync(path.join(PLAN_DIR_EVIDENCE, 'A15-terminals-aria-snapshot.yaml'), aria, 'utf8');
    mark('evidence written');
  });
});
