import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

// A1 (R4.16) live proof: a real planning run, on the live pm2 helm-harness process (:3110,
// cards2-ibrain.db), records BOTH the plancore and partner seats as worker_runtimes rows with
// role+model, and the existing Command Center Multi-Terminal viewer (reused, not new UI code)
// renders them. Uses a dedicated throwaway project so no real project (cards2/imgedt/memory_mcp)
// history is touched (JROM decision 2026-07-26). Stops the run and deletes its own rows afterward.
//
// Cycle-linkage (worker_runtimes.run_id resolving via runs.cycle_id) is proven by the DB-level
// vitest test in planning-phase-service.test.ts; this live spec proves the same recording
// mechanism fires for real spawns against the real pm2 process and is visible in its UI, via the
// simpler, already-shipped "Autonomous/skip-interview path" (POST /api/projects/:id/runs with a
// pre-seeded plan.json) rather than fighting a real discovery-LLM interview round.

const BASE = process.env.HELM_BASE_URL || 'http://127.0.0.1:3110';
const CRED = process.env.HELM_OWNER_CRED || 'cards2-harness-563f750bebc23bba';
const DB_PATH = process.env.HELM_DB_PATH_LIVE || '/home/agjrom/websites/Helm/data/cards2-ibrain.db';
const PROJECT_DIR = '/home/agjrom/websites/a1-validation';
const PROJECT_NAME = `a1-validation-${Date.now()}`;
const BATCH_ID = `a1-live-${Date.now()}`;

// resolveRunDir (run-paths.ts): <HELM_RUN_ROOT or os.tmpdir()>/helm-run-<projectId>-<batchId>.
// B1 (R2.12/F6): ecosystem.config.cjs now sets HELM_RUN_ROOT=/home/agjrom/websites/Helm/data/runs
// (ABSOLUTE, durable), which run-paths.ts's runRoot() prefers over os.tmpdir() unconditionally once
// the pm2 process picks it up — override via HELM_RUN_ROOT_OVERRIDE if a deployment differs.
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

test.describe('A1 live: plancore + partner recorded as worker_runtimes, visible on :3110', () => {
  let token: string;
  let projectId: number;
  let cycleId: number;
  let runId: number | null = null;

  test.beforeAll(async () => {
    fs.mkdirSync(PROJECT_DIR, { recursive: true });
    token = await login();

    // No pre-clean sweep here (redteam A1-RT-CRIT-1): a name-pattern DELETE or a global
    // project_id-NOT-IN-projects orphan sweep against the LIVE cards2-ibrain.db has unbounded blast
    // radius — it can delete a real project that happens to share the name prefix, or any other
    // project's orphaned rows, neither of which this test created or has any business touching.
    // PROJECT_NAME already carries a millisecond timestamp, so a genuine collision is not expected;
    // if one ever occurs, fail fast below rather than mass-deleting to "self-heal". Cleanup of what
    // THIS run itself creates is scoped by project/run id in afterAll.
    const projResp = await fetch(`${BASE}/api/projects`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: PROJECT_NAME, directory: PROJECT_DIR }),
    });
    const projData = await projResp.json();
    if (!projResp.ok) throw new Error(`project create failed: ${JSON.stringify(projData)}`);
    projectId = projData.project.id;

    // B1 (N10): POST /api/projects/:id/runs now REQUIRES an explicit cycleId (refuses an unlinked
    // run) — this throwaway project's own throwaway cycle satisfies that without changing what A1
    // proves (worker_runtimes linkage was already asserted via runs.cycle_id resolution, unaffected).
    const cycleResp = await fetch(`${BASE}/api/projects/${projectId}/cycles`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `A1 live ${Date.now()}` }),
    });
    const cycleData = await cycleResp.json();
    if (!cycleResp.ok) throw new Error(`cycle create failed: ${JSON.stringify(cycleData)}`);
    cycleId = cycleData.cycle.id;

    // Pre-seed plan.json in the run's OWN tmp dir so `planPreexists` is true and startRunInner takes
    // the direct-to-planning branch (real plancore + partner spawns) immediately — no interview round.
    const runDir = predictRunDir(projectId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'plan.json'),
      JSON.stringify({ tasks: [{ task_key: 'A1V-1', atomic_work: 'throwaway task for A1 live evidence only' }] }, null, 2)
    );
  });

  test.afterAll(async () => {
    if (runId != null) {
      try {
        await fetch(`${BASE}/api/runs/${runId}/stop`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: 'A1 live evidence capture complete' }),
        });
      } catch { /* best-effort */ }
    }

    // worker_runtimes has no FK-cascade path at all (run_id REFERENCES runs(id), no ON DELETE
    // CASCADE), so it must be cleared manually before the project delete reaches runs. Everything
    // else goes through the app's OWN DELETE /api/projects/:id (projectService.deleteProject), which
    // correctly also clears role_bindings/project_master_models (no FK to projects, a pre-existing
    // gap unrelated to A1) — a hand-rolled raw-SQL delete of just runs+projects leaves those two
    // orphaned, and SQLite's rowid reuse then collides the next created project/run against them.
    try {
      const db = new Database(DB_PATH);
      if (runId != null) db.prepare('DELETE FROM worker_runtimes WHERE run_id = ?').run(runId);
      db.close();
    } catch { /* best-effort */ }

    if (projectId != null) {
      try {
        await fetch(`${BASE}/api/projects/${projectId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      } catch { /* best-effort teardown; a stray throwaway project is not a correctness issue */ }
    }

    try { fs.rmSync(PROJECT_DIR, { recursive: true, force: true }); } catch {}
  });

  test('both recorded seats (plancore + partner) show role+model on the live Terminals view', async ({ page }) => {
    test.setTimeout(150000);

    // Prompt carries selectCoPlannerMode's deliberation triggers (architecture/cross-module/
    // security/high-risk) so BOTH plancore and partner spawn (A1 needs both seats recorded).
    const startResp = await fetch(`${BASE}/api/projects/${projectId}/runs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        batchId: BATCH_ID,
        cycleId,
        prompt: 'Architecture note: A1 live evidence run — cross-module, high-risk security refactor ' +
          'requiring two independent reviewers to agree before any implementation proceeds (throwaway).',
      }),
    });
    const startData = await startResp.json();
    if (!startResp.ok) throw new Error(`run start failed: ${JSON.stringify(startData)}`);
    runId = startData.runId;
    expect(runId).toBeTruthy();

    // Poll the DB directly for both worker_runtimes rows — registerWorkerRuntime fires synchronously
    // right after each transport.spawn() resolves (tmux session created), well before any LLM output.
    const db = new Database(DB_PATH, { readonly: true });
    let rows: any[] = [];
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      rows = db.prepare(
        `SELECT id, role, provider, model, session, correlation_id, run_id, project_id
         FROM worker_runtimes WHERE project_id = ? AND run_id = ?`
      ).all(projectId, runId) as any[];
      if (rows.length >= 2) break;
      await new Promise((res) => setTimeout(res, 2000));
    }
    db.close();

    expect(rows.length, `expected 2 worker_runtimes rows, got ${JSON.stringify(rows)}`).toBe(2);
    for (const row of rows) {
      expect(row.run_id).toBe(runId);
      expect(row.project_id).toBe(projectId);
      expect(row.provider).toBeTruthy();
      expect(row.model).toBeTruthy();
    }
    expect(rows.some((r) => r.role === 'plancore')).toBe(true);
    expect(rows.some((r) => r.role === 'deliberation')).toBe(true);
    expect(rows.find((r) => r.role === 'plancore')?.correlation_id).toBe(BATCH_ID);
    expect(rows.find((r) => r.role === 'deliberation')?.correlation_id).toBe(`${BATCH_ID}-partner`);

    // UI: log in and load the EXISTING Command Center Multi-Terminal viewer (no new UI code for A1) —
    // reachable by hash route (`renderCommandCenter` keys off `location.hash` → currentSlug).
    await page.goto(`${BASE}/`);
    await page.locator('input[placeholder="owner credential"]').fill(CRED);
    await page.click('button:has-text("Login")');
    await page.getByTestId('nav-project-setup').waitFor({ state: 'visible', timeout: 15000 });

    await page.goto(`${BASE}/#10-command-center-terminals`);
    await expect(page.getByTestId('content-cmd-terminals')).toBeVisible({ timeout: 15000 });
    await page.getByTestId('cmt-project-select').selectOption(String(projectId));
    await page.getByTestId('cmt-refresh-btn').click();

    const plancoreRow = rows.find((r) => r.role === 'plancore')!;
    const partnerRow = rows.find((r) => r.role === 'deliberation')!;
    const plancoreLocator = page.getByTestId(`cmt-worker-row-${plancoreRow.id}`);
    const partnerLocator = page.getByTestId(`cmt-worker-row-${partnerRow.id}`);
    await expect(plancoreLocator).toBeVisible({ timeout: 20000 });
    await expect(partnerLocator).toBeVisible({ timeout: 20000 });
    await expect(plancoreLocator).toContainText(plancoreRow.role);
    await expect(plancoreLocator).toContainText(plancoreRow.model);
    await expect(partnerLocator).toContainText(partnerRow.role);
    await expect(partnerLocator).toContainText(partnerRow.model);

    fs.mkdirSync('validation/A1', { recursive: true });
    await page.screenshot({ path: 'validation/A1/A1-terminals-both-seats.png', fullPage: true });
    const ariaSnapshot = await page.locator('[data-testid="content-cmd-terminals"]').ariaSnapshot();
    fs.writeFileSync('validation/A1/A1-terminals-aria-snapshot.yaml', ariaSnapshot);
  });
});
