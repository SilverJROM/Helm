import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

// B1 (R2.8/R2.12) live proof on :3110 / cards2-ibrain.db via playwright.cap.config.ts only.
// A cycle-linked run (start-planning) resolves canonicalArtifactRoot from the cycle folder (SEAM-2);
// deleting the run's ephemeral scratch dir (simulating a reboot — os.tmpdir()/HELM_RUN_ROOT is not
// meant to be relied on across the OWNED SCRATCH, only the cycle folder is durable) must NOT take the
// Planning doc cards down with it, because they are sourced from the cycle folder directly. Throwaway
// project + unique dir + owner marker (A1/A3 lessons); scoped teardown.

const BASE = process.env.HELM_BASE_URL || 'http://127.0.0.1:3110';
const CRED = process.env.HELM_OWNER_CRED || 'cards2-harness-563f750bebc23bba';
const DB_PATH = process.env.HELM_DB_PATH_LIVE || '/home/agjrom/websites/Helm/data/cards2-ibrain.db';
const RUN_TS = Date.now();
const PROJECT_NAME = `b1-validation-${RUN_TS}`;
const PROJECT_DIR = `/home/agjrom/websites/b1-validation-${RUN_TS}`;
const OWNER_MARKER = '.b1-live-owned';
const BATCH_ID = `b1-live-${RUN_TS}`;

// B1 (R2.12/F6): production run root — see ecosystem.config.cjs / run-paths.ts.
const HELM_RUN_ROOT = process.env.HELM_RUN_ROOT_OVERRIDE || '/home/agjrom/websites/Helm/data/runs';

const OGREQ_CONTENT = `# OG Requirements\n\nB1 SEAM-2 live proof — this content must survive the run's scratch dir being deleted (reboot simulation). RUN_TS=${RUN_TS}\n`;
const PLAN_CONTENT = '# Plan\n\n```json\n[{"id":"T1","batch":"B00","title":"vocabulary","req_refs":["R14.46"],"assignee":"terra","validator_lane":"L2","effort":"low","type":"feature"}]\n```\n';

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

test.describe('B1 live: cycle-linked run survives scratch removal — Planning doc cards on :3110', () => {
  let token: string;
  let projectId: number;
  let cycleId: number;
  let cycleDir: string;
  let runId: number | null = null;
  let runDir: string;

  test.beforeAll(async () => {
    if (fs.existsSync(PROJECT_DIR)) {
      throw new Error(`B1 live refuse: PROJECT_DIR already exists (${PROJECT_DIR}). Refusing to reuse or delete a path this test did not create.`);
    }
    fs.mkdirSync(PROJECT_DIR, { recursive: false });
    fs.writeFileSync(path.join(PROJECT_DIR, OWNER_MARKER), `owned-by e2e/B1.live.spec.ts ${PROJECT_NAME}\n`, 'utf8');
    token = await login();

    const projResp = await fetch(`${BASE}/api/projects`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: PROJECT_NAME, directory: PROJECT_DIR }),
    });
    const projData = await projResp.json();
    if (!projResp.ok) throw new Error(`project create failed: ${JSON.stringify(projData)}`);
    projectId = projData.project.id;

    const cycleResp = await fetch(`${BASE}/api/projects/${projectId}/cycles`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `B1 SEAM-2 ${RUN_TS}` }),
    });
    const cycleData = await cycleResp.json();
    if (!cycleResp.ok) throw new Error(`cycle create failed: ${JSON.stringify(cycleData)}`);
    cycleId = cycleData.cycle.id;
    cycleDir = path.join(PROJECT_DIR, 'cycle', String(cycleData.cycle.folder_name));
    fs.mkdirSync(cycleDir, { recursive: true });
    // Authored DIRECTLY on disk (not through the docs API) — proves the doc cards read the cycle
    // folder itself, independent of any API write-path side effect (e.g. plan.md auto-start).
    fs.writeFileSync(path.join(cycleDir, 'og-requirements.md'), OGREQ_CONTENT, 'utf8');
    fs.writeFileSync(path.join(cycleDir, 'plan.md'), PLAN_CONTENT, 'utf8');

    // Pre-seed plan.json + callbacks.md in the run's OWN scratch dir so planPreexists is true and
    // startRunInner short-circuits past the interview/live-planning-negotiation round (A1's proven
    // technique) — this test only needs the run to START (far enough for the B1 SEAM-2 resolution to
    // fire), not to complete an implementation.
    runDir = path.join(HELM_RUN_ROOT, `helm-run-${projectId}-${BATCH_ID}`);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'plan.json'), JSON.stringify({ tasks: [{ task_key: 'B1V-1', atomic_work: 'throwaway task for B1 live evidence only' }] }, null, 2), 'utf8');
  });

  test.afterAll(async () => {
    if (runId != null) {
      try {
        await fetch(`${BASE}/api/runs/${runId}/stop`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: 'B1 live evidence capture complete' }),
        });
      } catch { /* best-effort */ }
    }
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
        await fetch(`${BASE}/api/projects/${projectId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      } catch { /* best-effort */ }
    }

    try { fs.rmSync(runDir, { recursive: true, force: true }); } catch {}
    try {
      const markerPath = path.join(PROJECT_DIR, OWNER_MARKER);
      if (PROJECT_DIR.includes(`b1-validation-${RUN_TS}`) && fs.existsSync(markerPath) && fs.readFileSync(markerPath, 'utf8').includes(PROJECT_NAME)) {
        fs.rmSync(PROJECT_DIR, { recursive: true, force: false });
      }
    } catch { /* leave orphan unique dir rather than widen blast radius */ }
  });

  test('cycle-linked start-planning materializes into scratch; deleting scratch does not take the Planning doc cards down', async ({ page }) => {
    test.setTimeout(120000);

    const health = await fetch(`${BASE}/health`);
    expect(health.ok).toBe(true);
    expect(BASE).toMatch(/127\.0\.0\.1:3110|localhost:3110/);

    const startResp = await fetch(`${BASE}/api/cycles/${cycleId}/start-planning`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ batchId: BATCH_ID, prompt: 'B1 live evidence: cycle-linked planning run (throwaway)' }),
    });
    const startData = await startResp.json();
    if (!startResp.ok) throw new Error(`start-planning failed: ${JSON.stringify(startData)}`);
    runId = startData.runId;
    expect(runId).toBeTruthy();
    expect(startData.cycleId).toBe(cycleId);

    // SEAM-2: poll the run's own scratch dir for the materialized cycle docs (proves
    // canonicalArtifactRoot resolved to the cycle folder for this NON-cyclePlan cycle-linked run,
    // independent of cyclePlan) before we delete it out from under the run.
    const deadline = Date.now() + 60000;
    let materialized = false;
    while (Date.now() < deadline) {
      try {
        const ogreq = fs.readFileSync(path.join(runDir, 'og-requirements.md'), 'utf8');
        if (ogreq === OGREQ_CONTENT) { materialized = true; break; }
      } catch { /* not yet written */ }
      await new Promise((res) => setTimeout(res, 1500));
    }
    expect(materialized, 'SEAM-2: cycle og-requirements.md was never materialized into the run scratch dir').toBe(true);

    // Stop the run now — this evidence needs no implementer dispatch, and the fake task's implementer
    // should never actually run against a throwaway project.
    try {
      await fetch(`${BASE}/api/runs/${runId}/stop`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'B1 live evidence: stop before scratch removal' }),
      });
    } catch { /* best-effort */ }

    // Simulate a reboot: the ephemeral scratch dir is gone.
    fs.rmSync(runDir, { recursive: true, force: true });
    expect(fs.existsSync(runDir)).toBe(false);

    // UI: log in, open Overview, find this project's card, open Planning — doc cards must still show
    // the CYCLE-authored content (sourced from the cycle folder, never the deleted scratch dir).
    await page.goto(`${BASE}/`);
    await page.locator('input[placeholder="owner credential"]').fill(CRED);
    await page.click('button:has-text("Login")');
    await page.getByTestId('nav-project-setup').waitFor({ state: 'visible', timeout: 15000 });

    await page.goto(`${BASE}/#07-command-center-overview`);
    await expect(page.getByTestId('ov-board')).toBeVisible({ timeout: 15000 });

    let cardVisible = false;
    const uiDeadline = Date.now() + 30000;
    while (Date.now() < uiDeadline) {
      const activeTab = page.getByTestId('ov-tab-active');
      if (await activeTab.count()) await activeTab.click();
      const card = page.getByTestId(`ov-card-${projectId}`);
      if (await card.count() && await card.isVisible()) { cardVisible = true; await card.click(); break; }
      const pendingTab = page.getByTestId('ov-tab-pending');
      if (await pendingTab.count()) {
        await pendingTab.click();
        const pCard = page.getByTestId(`ov-card-${projectId}`);
        if (await pCard.count() && await pCard.isVisible()) { cardVisible = true; await pCard.click(); break; }
      }
      await page.reload();
      await page.goto(`${BASE}/#07-command-center-overview`);
      await expect(page.getByTestId('ov-board')).toBeVisible({ timeout: 10000 });
      await new Promise((r) => setTimeout(r, 1500));
    }
    expect(cardVisible, `ov-card-${projectId} not found on overview active/pending`).toBe(true);
    await expect(page.getByTestId('content-cmd-workspace')).toBeVisible({ timeout: 15000 });
    await page.getByTestId('ws-tab-planning').click();

    await expect(page.getByTestId('ws-plan-card-ogreq')).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId('ws-plan-view-ogreq')).toContainText('survive the run\'s scratch dir being deleted');
    await expect(page.getByTestId('ws-plan-card-execplan')).toBeVisible();
    await expect(page.getByTestId('ws-plan-badge-execplan')).toContainText('schema valid');

    fs.mkdirSync('validation/B1', { recursive: true });
    fs.mkdirSync('plan/helm-ux-remediation/validation/B1', { recursive: true });
    await page.screenshot({ path: 'validation/B1/B1-planning-docs-survive-scratch-removal.png', fullPage: true });
    fs.copyFileSync('validation/B1/B1-planning-docs-survive-scratch-removal.png', 'plan/helm-ux-remediation/validation/B1/B1-planning-docs-survive-scratch-removal.png');
    const aria = await page.locator('[data-testid="ws-plan-docs"]').ariaSnapshot();
    fs.writeFileSync('validation/B1/B1-docs-aria-snapshot.yaml', aria, 'utf8');
    fs.writeFileSync('plan/helm-ux-remediation/validation/B1/B1-docs-aria-snapshot.yaml', aria, 'utf8');
  });
});
