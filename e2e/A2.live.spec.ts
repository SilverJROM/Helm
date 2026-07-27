import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

// A2 (R4.16) live proof: planning seats register into helm_sessions with non-NULL
// project_id + run_id at the TmuxService.createSession choke point, and the existing
// Tracking view attributes those sessions under their run. Dedicated throwaway project
// only (A1 pattern / JROM 2026-07-26); cards2-ibrain.db; never default :3111 config.

const BASE = process.env.HELM_BASE_URL || 'http://127.0.0.1:3110';
const CRED = process.env.HELM_OWNER_CRED || 'cards2-harness-563f750bebc23bba';
const DB_PATH = process.env.HELM_DB_PATH_LIVE || '/home/agjrom/websites/Helm/data/cards2-ibrain.db';
const PROJECT_DIR = '/home/agjrom/websites/a2-validation';
const PROJECT_NAME = `a2-validation-${Date.now()}`;
const BATCH_ID = `a2-live-${Date.now()}`;

// B1 (R2.12/F6): ecosystem.config.cjs now sets HELM_RUN_ROOT=/home/agjrom/websites/Helm/data/runs
// (ABSOLUTE, durable), which run-paths.ts's runRoot() prefers over os.tmpdir() unconditionally.
const HELM_TMPDIR = process.env.HELM_RUN_ROOT_OVERRIDE || '/home/agjrom/websites/Helm/data/runs';
function predictRunDir(projectId: number): string {
  return path.join(HELM_TMPDIR, `helm-run-${projectId}-${BATCH_ID}`);
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

test.describe('A2 live: helm_sessions project_id/run_id for planning seats on :3110', () => {
  let token: string;
  let projectId: number;
  let cycleId: number;
  let runId: number | null = null;

  test.beforeAll(async () => {
    fs.mkdirSync(PROJECT_DIR, { recursive: true });
    token = await login();

    // No pre-clean sweep (A1-RT-CRIT-1 lesson): never name-pattern DELETE on live DB.
    const projResp = await fetch(`${BASE}/api/projects`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: PROJECT_NAME, directory: PROJECT_DIR }),
    });
    const projData = await projResp.json();
    if (!projResp.ok) throw new Error(`project create failed: ${JSON.stringify(projData)}`);
    projectId = projData.project.id;

    // B1 (N10): POST /api/projects/:id/runs now REQUIRES an explicit cycleId.
    const cycleResp = await fetch(`${BASE}/api/projects/${projectId}/cycles`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `A2 live ${Date.now()}` }),
    });
    const cycleData = await cycleResp.json();
    if (!cycleResp.ok) throw new Error(`cycle create failed: ${JSON.stringify(cycleData)}`);
    cycleId = cycleData.cycle.id;

    const runDir = predictRunDir(projectId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'plan.json'),
      JSON.stringify({ tasks: [{ task_key: 'A2V-1', atomic_work: 'throwaway task for A2 live evidence only' }] }, null, 2)
    );
  });

  test.afterAll(async () => {
    if (runId != null) {
      try {
        await fetch(`${BASE}/api/runs/${runId}/stop`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: 'A2 live evidence capture complete' }),
        });
      } catch { /* best-effort */ }
    }

    // Scoped teardown only: this run's rows + app-owned project delete.
    try {
      const db = new Database(DB_PATH);
      if (runId != null) {
        db.prepare('DELETE FROM worker_runtimes WHERE run_id = ?').run(runId);
        db.prepare('DELETE FROM helm_sessions WHERE run_id = ?').run(runId);
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

    try { fs.rmSync(PROJECT_DIR, { recursive: true, force: true }); } catch {}
  });

  test('planning seats land in helm_sessions with both ids; Tracking attributes them under the run', async ({ page }) => {
    test.setTimeout(150000);

    const startResp = await fetch(`${BASE}/api/projects/${projectId}/runs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        batchId: BATCH_ID,
        cycleId,
        prompt: 'Architecture note: A2 live evidence run — cross-module, high-risk security refactor ' +
          'requiring two independent reviewers to agree before any implementation proceeds (throwaway).',
      }),
    });
    const startData = await startResp.json();
    if (!startResp.ok) throw new Error(`run start failed: ${JSON.stringify(startData)}`);
    runId = startData.runId;
    expect(runId).toBeTruthy();

    // Poll helm_sessions for planning seats linked to this run (createSession choke point).
    const db = new Database(DB_PATH, { readonly: true });
    let sessions: any[] = [];
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      sessions = db.prepare(
        `SELECT id, name, kind, project_id, run_id, status
         FROM helm_sessions
         WHERE project_id = ? AND run_id = ? AND status IN ('active','idle')
         ORDER BY id`
      ).all(projectId, runId) as any[];
      if (sessions.length >= 2) break;
      await new Promise((res) => setTimeout(res, 2000));
    }
    db.close();

    expect(
      sessions.length,
      `expected >=2 helm_sessions with project_id+run_id, got ${JSON.stringify(sessions)}`
    ).toBeGreaterThanOrEqual(2);
    for (const s of sessions) {
      expect(s.project_id).toBe(projectId);
      expect(s.run_id).toBe(runId);
      expect(s.name.startsWith('helm-')).toBe(true);
    }

    // UI: Tracking nests active_sessions under the run (run_id filter in TrackingReadService).
    await page.goto(`${BASE}/`);
    await page.locator('input[placeholder="owner credential"]').fill(CRED);
    await page.click('button:has-text("Login")');
    await page.getByTestId('nav-tracking').waitFor({ state: 'visible', timeout: 15000 });

    await page.goto(`${BASE}/#12-tracking`);
    await page.getByTestId('tracking-refresh-btn').click();
    const runCard = page.getByTestId(`tracking-run-${runId}`);
    await expect(runCard).toBeVisible({ timeout: 20000 });

    // At least one session row under this run (attribution to run/cycle substrate).
    const sessionRows = runCard.locator('[data-testid^="tracking-session-"]');
    await expect(sessionRows.first()).toBeVisible({ timeout: 15000 });
    const sessionCount = await sessionRows.count();
    expect(sessionCount).toBeGreaterThanOrEqual(1);

    // Session names from DB should appear in the Tracking card text.
    const cardText = await runCard.innerText();
    const nameHit = sessions.some((s) => cardText.includes(s.name));
    expect(nameHit, `Tracking card should name at least one linked session; text=${cardText.slice(0, 400)}`).toBe(true);

    fs.mkdirSync('validation/A2', { recursive: true });
    fs.mkdirSync('plan/helm-ux-remediation/validation/A2', { recursive: true });
    await page.screenshot({ path: 'validation/A2/A2-tracking-sessions-linked.png', fullPage: true });
    const ariaSnapshot = await runCard.ariaSnapshot();
    fs.writeFileSync('validation/A2/A2-tracking-aria-snapshot.yaml', ariaSnapshot);
    fs.copyFileSync('validation/A2/A2-tracking-sessions-linked.png', 'plan/helm-ux-remediation/validation/A2/A2-tracking-sessions-linked.png');
    fs.copyFileSync('validation/A2/A2-tracking-aria-snapshot.yaml', 'plan/helm-ux-remediation/validation/A2/A2-tracking-aria-snapshot.yaml');
  });
});
