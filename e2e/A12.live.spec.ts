import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

// A12 (R1.7) live: generated plancore brief states D6 whole-plan + D7 config cap; no TEMP markers.
// On :3110 / cards2-ibrain.db via playwright.cap.config.ts. Throwaway project; scoped teardown.

const BASE = process.env.HELM_BASE_URL || 'http://127.0.0.1:3110';
const CRED = process.env.HELM_OWNER_CRED || 'cards2-harness-563f750bebc23bba';
const DB_PATH = process.env.HELM_DB_PATH_LIVE || '/home/agjrom/websites/Helm/data/cards2-ibrain.db';
const RUN_TS = Date.now();
const PROJECT_NAME = `a12-validation-${RUN_TS}`;
const PROJECT_DIR = `/home/agjrom/websites/a12-validation-${RUN_TS}`;
const OWNER_MARKER = '.a12-live-owned';
const BATCH_ID = `a12-live-${RUN_TS}`;
const HELM_RUN_ROOT = process.env.HELM_RUN_ROOT_OVERRIDE || '/home/agjrom/websites/Helm/data/runs';
const EVIDENCE_DIR = path.join(process.cwd(), 'validation', 'A12');
const PLAN_DIR_EVIDENCE = path.join(process.cwd(), 'plan', 'helm-ux-remediation', 'validation', 'A12');

const VALID_PLAN_MD =
  '# Plan\n\n```json\n[{"id":"T1","batch":"A12","title":"A12 brief split-brain proof","req_refs":["R1.7"],"assignee":"grok-4.5","validator_lane":"L2","effort":"low","type":"feature"}]\n```\n';
const VALID_OGREQ = '# Requirements\n\n- **R1.7** — plancore brief and engine agree.\n';
const VALID_NS = '# North star\n\nA12 throwaway: brief/engine split-brain closed.\n';

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

test.describe('A12 live: brief/engine split-brain closed on :3110', () => {
  let token: string;
  let projectId: number;
  let cycleId: number;
  let cycleDir = '';
  let runId: number | null = null;
  let runDir = '';

  test.beforeAll(async () => {
    if (fs.existsSync(PROJECT_DIR)) {
      throw new Error(
        `A12 live refuse: PROJECT_DIR already exists (${PROJECT_DIR}). ` +
          `Refusing to reuse or delete a path this test did not create.`
      );
    }
    fs.mkdirSync(PROJECT_DIR, { recursive: false });
    fs.writeFileSync(
      path.join(PROJECT_DIR, OWNER_MARKER),
      `owned-by e2e/A12.live.spec.ts ${PROJECT_NAME}\n`,
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

    // Ensure planning_round_cap is the known config value (default 3; set explicitly for proof).
    try {
      const db = new Database(DB_PATH);
      db.prepare('UPDATE projects SET planning_round_cap = 3 WHERE id = ?').run(projectId);
      db.close();
    } catch { /* column may already be 3 */ }

    const cycleResp = await fetch(`${BASE}/api/projects/${projectId}/cycles`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `A12 brief ${RUN_TS}`,
        autonomy: 'autonomous_after_discovery',
        final_tests_enabled: false,
      }),
    });
    const cycleData = await cycleResp.json();
    if (!cycleResp.ok) throw new Error(`cycle create failed: ${JSON.stringify(cycleData)}`);
    cycleId = cycleData.cycle.id;
    cycleDir = path.join(PROJECT_DIR, 'cycle', String(cycleData.cycle.folder_name));
    fs.mkdirSync(cycleDir, { recursive: true });
    fs.writeFileSync(path.join(cycleDir, 'north-star.md'), VALID_NS, 'utf8');
    fs.writeFileSync(path.join(cycleDir, 'og-requirements.md'), VALID_OGREQ, 'utf8');
    fs.writeFileSync(path.join(cycleDir, 'plan.md'), VALID_PLAN_MD, 'utf8');
  });

  test.afterAll(async () => {
    if (runId != null) {
      try {
        await fetch(`${BASE}/api/runs/${runId}/stop`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: 'A12 live teardown' }),
        });
        await new Promise((r) => setTimeout(r, 1500));
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
        PROJECT_DIR.includes(`a12-validation-${RUN_TS}`) &&
        fs.existsSync(markerPath) &&
        fs.readFileSync(markerPath, 'utf8').includes(PROJECT_NAME)
      ) {
        fs.rmSync(PROJECT_DIR, { recursive: true, force: false });
      }
    } catch { /* leave orphan */ }
  });

  test('generated planning brief shows whole-plan + planning_round_cap; no TEMP', async ({ page }) => {
    test.setTimeout(170000);
    const t0 = Date.now();
    const mark = (label: string) => console.log(`[A12.live timing] ${label} at +${Date.now() - t0}ms`);

    const health = await fetch(`${BASE}/health`);
    expect(health.ok).toBe(true);
    expect(BASE).toMatch(/127\.0\.0\.1:3110|localhost:3110/);

    // start-planning writes prompts/plancore.brief.md via production generatePlanningBrief
    const startResp = await fetch(`${BASE}/api/cycles/${cycleId}/start-planning`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        batchId: BATCH_ID,
        prompt: 'A12 proof: plan a small hello feature from north-star (throwaway).',
      }),
    });
    const startData = await startResp.json();
    if (!startResp.ok) throw new Error(`start-planning failed: ${JSON.stringify(startData)}`);
    runId = startData.runId;
    expect(runId).toBeTruthy();
    runDir = predictRunDir(projectId, String(startData.batchId || BATCH_ID));
    mark(`run ${runId}`);

    // Poll for production brief on disk (written early in planning phase)
    let briefText = '';
    const briefPaths = [
      path.join(runDir, 'prompts', 'plancore.brief.md'),
      path.join(runDir, 'prompts', 'helm_pm.brief.md'),
      path.join(cycleDir, 'prompts', 'plancore.brief.md'),
    ];
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      for (const p of briefPaths) {
        try {
          if (fs.existsSync(p)) {
            briefText = fs.readFileSync(p, 'utf8');
            if (briefText.includes('planning_round_cap') || briefText.includes('whole-plan')) {
              mark(`brief found ${p}`);
              break;
            }
          }
        } catch { /* retry */ }
      }
      if (briefText.includes('planning_round_cap') || briefText.includes('whole-plan')) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(
      briefText.length > 0,
      `no plancore brief under ${runDir}/prompts within 90s`
    ).toBe(true);

    // R1.7 content assertions on production-generated brief
    expect(briefText).toMatch(/whole-plan/i);
    expect(briefText).toMatch(/planning_round_cap\s*[:=]\s*3|planning_round_cap=3/);
    expect(briefText).not.toMatch(/\bTEMP\b/);
    expect(briefText.toLowerCase()).not.toContain('pending-policy');
    expect(briefText).not.toContain('Iterate until agreement');
    expect(briefText).not.toContain('Convene partner');
    expect(briefText).toMatch(/helm-algo spawns|helm-algo/i);
    mark('brief content ok');

    // Persist brief snippet for validator
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'A12-plancore-brief-excerpt.md'), briefText.slice(0, 4000), 'utf8');
    fs.copyFileSync(
      path.join(EVIDENCE_DIR, 'A12-plancore-brief-excerpt.md'),
      path.join(PLAN_DIR_EVIDENCE, 'A12-plancore-brief-excerpt.md')
    );

    // Stop before long planning burn
    try {
      await fetch(`${BASE}/api/runs/${runId}/stop`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'A12 live: brief captured' }),
      });
    } catch { /* best-effort */ }

    // UI: Planning docs / cycle workspace shows the cycle (brief proof is file+API; UI shows planning surface)
    await page.goto(`${BASE}/`);
    await page.locator('input[placeholder="owner credential"]').fill(CRED);
    await page.click('button:has-text("Login")');
    await page.getByTestId('nav-project-setup').waitFor({ state: 'visible', timeout: 15000 });

    await page.goto(`${BASE}/#07-command-center-overview`);
    await expect(page.getByTestId('ov-board')).toBeVisible({ timeout: 15000 });
    const card = page.getByTestId(`ov-card-${projectId}`);
    if (await card.count()) {
      await card.click();
      await page.waitForTimeout(1000);
      const planTab = page.getByTestId('ws-tab-planning');
      if (await planTab.count()) await planTab.click();
    }

    await page.screenshot({
      path: path.join(EVIDENCE_DIR, 'A12-planning-brief-surface.png'),
      fullPage: true,
    });
    fs.copyFileSync(
      path.join(EVIDENCE_DIR, 'A12-planning-brief-surface.png'),
      path.join(PLAN_DIR_EVIDENCE, 'A12-planning-brief-surface.png')
    );

    const aria = await page.locator('body').ariaSnapshot();
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'A12-brief-aria-snapshot.yaml'), aria, 'utf8');
    fs.writeFileSync(path.join(PLAN_DIR_EVIDENCE, 'A12-brief-aria-snapshot.yaml'), aria, 'utf8');
    mark('evidence written');
  });
});
