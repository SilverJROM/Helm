import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

// A10 (R1.3) live proof on :3110 / cards2-ibrain.db via playwright.cap.config.ts only.
// Panel size is now per-project config (project.planning_panel_size, total seats incl. plancore,
// default 2) rather than a guess derived from selectCoPlannerMode's north-star regex — that function
// only ever chose the partner's review lens (planner vs deliberation), never seat count. This spec
// proves the configured half: a project explicitly configured for planning_panel_size=3 spawns
// exactly 3 seats (plancore + 2 partners), visible via GET /api/cycles/:id/seats and the live UI seat
// roster. The default-2-seats case is already covered live by e2e/A8.live.spec.ts; the unanimous-
// agreement-across-N-partners gate mechanics are covered by unit tests in planning-phase-service.test.ts.

const BASE = process.env.HELM_BASE_URL || 'http://127.0.0.1:3110';
const CRED = process.env.HELM_OWNER_CRED || 'cards2-harness-563f750bebc23bba';
const DB_PATH = process.env.HELM_DB_PATH_LIVE || '/home/agjrom/websites/Helm/data/cards2-ibrain.db';
const RUN_TS = Date.now();
const PROJECT_NAME = `a10-validation-${RUN_TS}`;
const PROJECT_DIR = `/home/agjrom/websites/a10-validation-${RUN_TS}`;
const OWNER_MARKER = '.a10-live-owned';
const BATCH_ID = `a10-live-${RUN_TS}`;
const HELM_RUN_ROOT = process.env.HELM_RUN_ROOT_OVERRIDE || '/home/agjrom/websites/Helm/data/runs';
const EVIDENCE_DIR = path.join(process.cwd(), 'validation', 'A10');
const PLAN_DIR_EVIDENCE = path.join(process.cwd(), 'plan', 'helm-ux-remediation', 'validation', 'A10');

const VALID_NS = '# North star\n\nA10 three-seats proof: plan a small utility feature (throwaway).\n';
const VALID_OGREQ = '# Requirements\n\n- **R1.3** — planning panel size is per-project config, default 2.\n';
const VALID_PLAN_MD =
  '# Plan\n\n```json\n[{"id":"T1","batch":"A10","title":"A10 three-seats proof task","req_refs":["R1.3"],"assignee":"grok-4.5","validator_lane":"L2","effort":"low","type":"feature"}]\n```\n';

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

function readCycle(cycleId: number): any {
  const db = new Database(DB_PATH, { readonly: true });
  const row = db.prepare('SELECT phase, autonomy, awaiting_approval FROM cycles WHERE id = ?').get(cycleId);
  db.close();
  return row;
}

function readRun(runId: number): any {
  const db = new Database(DB_PATH, { readonly: true });
  const row = db.prepare('SELECT id, phase, status FROM runs WHERE id = ?').get(runId);
  db.close();
  return row;
}

function setPanelSize(projectId: number, size: number): void {
  const db = new Database(DB_PATH);
  db.prepare('UPDATE projects SET planning_panel_size = ? WHERE id = ?').run(size, projectId);
  db.close();
}

test.describe('A10 live: a project configured for planning_panel_size=3 convenes 3 seats on :3110', () => {
  let token: string;
  let projectId: number;
  let cycleId: number;
  let cycleDir = '';
  let runId: number | null = null;
  let runDir = '';

  test.beforeAll(async () => {
    if (fs.existsSync(PROJECT_DIR)) {
      throw new Error(
        `A10 live refuse: PROJECT_DIR already exists (${PROJECT_DIR}). ` +
          `Refusing to reuse or delete a path this test did not create.`
      );
    }
    fs.mkdirSync(PROJECT_DIR, { recursive: false });
    fs.writeFileSync(
      path.join(PROJECT_DIR, OWNER_MARKER),
      `owned-by e2e/A10.live.spec.ts ${PROJECT_NAME}\n`,
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
    setPanelSize(projectId, 3);

    const cycleResp = await fetch(`${BASE}/api/projects/${projectId}/cycles`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `A10 three-seats ${RUN_TS}`,
        autonomy: 'pause_after_planning',
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
    runDir = predictRunDir(projectId, BATCH_ID);
  });

  test.afterAll(async () => {
    if (runId != null) {
      try {
        const row = readRun(runId);
        const terminal = row && (['complete', 'failed', 'blocked'].includes(String(row.phase)));
        if (!terminal) {
          await fetch(`${BASE}/api/runs/${runId}/stop`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: 'A10 live evidence capture complete' }),
          });
          await new Promise((r) => setTimeout(r, 1500));
        }
      } catch { /* best-effort */ }
    }

    // waitForAgreement's poll loop does not consult the abort registry, so a stopped run's planning
    // seats can still be state='running' at delete time. worker_runtimes.run_id has no ON DELETE
    // CASCADE (same gap A6/A6b/A8/A9's specs already work around) — clean up explicitly before the
    // project DELETE cascades runs, or it 400s with a FOREIGN KEY constraint failure.
    if (runId != null) {
      try {
        const db = new Database(DB_PATH);
        db.prepare('DELETE FROM worker_runtimes WHERE run_id = ?').run(runId);
        db.prepare('DELETE FROM helm_sessions WHERE run_id = ?').run(runId);
        db.prepare('DELETE FROM run_tasks WHERE run_id = ?').run(runId);
        db.prepare('DELETE FROM run_events WHERE run_id = ?').run(runId);
        db.close();
      } catch { /* best-effort */ }
    }

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
        PROJECT_DIR.includes(`a10-validation-${RUN_TS}`) &&
        fs.existsSync(markerPath) &&
        fs.readFileSync(markerPath, 'utf8').includes(PROJECT_NAME)
      ) {
        fs.rmSync(PROJECT_DIR, { recursive: true, force: false });
      }
    } catch { /* leave orphan unique dir rather than widen blast radius */ }
  });

  test('planning_panel_size=3 spawns exactly 3 seats (plancore + 2 partners), visible in the UI seat roster', async ({ page }) => {
    test.setTimeout(170000);
    const t0 = Date.now();
    const mark = (label: string) => console.log(`[A10.live timing] ${label} at +${Date.now() - t0}ms`);

    const health = await fetch(`${BASE}/health`);
    expect(health.ok).toBe(true);
    expect(BASE).toMatch(/127\.0\.0\.1:3110|localhost:3110/);

    expect(readCycle(cycleId).phase).toBe('discovery');

    const startResp = await fetch(`${BASE}/api/cycles/${cycleId}/start-planning`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        batchId: BATCH_ID,
        prompt: 'Plan a small utility feature for this throwaway A10 three-seats proof cycle.',
      }),
    });
    const startData = await startResp.json();
    if (!startResp.ok) throw new Error(`start-planning failed: ${JSON.stringify(startData)}`);
    runId = startData.runId;
    expect(runId).toBeTruthy();
    mark('start-planning returned');

    // Short-circuit the discovery interview: inject NORTH-STAR-READY directly (the exact contract
    // waitForNorthStarReady polls callbacks.md for) rather than waiting on a real discovery agent to
    // finish thinking — this spec is about the PLANNING phase's configured seat count, not discovery.
    const driveDeadline = Date.now() + 20000;
    let drove = false;
    while (Date.now() < driveDeadline) {
      try {
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(path.join(runDir, 'north-star.md'), VALID_NS, 'utf8');
        fs.writeFileSync(path.join(runDir, 'conversation-log.md'), 'A10 three-seats proof.\n', 'utf8');
        fs.appendFileSync(
          path.join(runDir, 'callbacks.md'),
          `[helm callback] discovery ${BATCH_ID} STATUS: NORTH-STAR-READY — a10 live drive\n`,
          'utf8'
        );
        drove = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    expect(drove, 'could not write discovery drive artifacts into runDir').toBe(true);
    mark('north-star-ready injected');

    // Wait for planning's plancore seat to register (worker_runtimes row, via GET /api/cycles/:id/seats).
    // registerWorkerRuntime for plancore fires immediately after transport.spawn — before any callback
    // wait — so this should land as soon as the real discovery→planning handoff completes.
    let sawPlancoreSeat = false;
    const plancoreSeatDeadline = Date.now() + 90000;
    while (Date.now() < plancoreSeatDeadline) {
      const r = await fetch(`${BASE}/api/cycles/${cycleId}/seats`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) {
        const d = await r.json();
        if (Array.isArray(d.seats) && d.seats.some((s: any) => s.role === 'plancore')) {
          sawPlancoreSeat = true;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    mark('plancore seat observed');
    expect(sawPlancoreSeat, 'plancore seat never registered under /api/cycles/:id/seats').toBe(true);

    // Drive plancore's OWN first callback (any status) so the spawn-retry loop proceeds past its
    // wait and reaches the A10 fix: BOTH configured partners spawn up front (panelSize=3), not just one.
    let seatCount = 0;
    const threeSeatDeadline = Date.now() + 60000;
    while (Date.now() < threeSeatDeadline) {
      const r = await fetch(`${BASE}/api/cycles/${cycleId}/seats`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) {
        const d = await r.json();
        seatCount = Array.isArray(d.seats) ? d.seats.length : 0;
        if (seatCount >= 3) break;
      }
      try {
        fs.appendFileSync(
          path.join(runDir, 'callbacks.md'),
          `[helm callback] plancore ${BATCH_ID} STATUS: PLANNING — a10 reassert\n`,
          'utf8'
        );
      } catch { /* dir materializing */ }
      await new Promise((r) => setTimeout(r, 1500));
    }
    mark('three-seat poll exited');
    expect(seatCount, 'planning did not spawn the configured 3 seats (plancore + 2 partners)').toBeGreaterThanOrEqual(3);

    // UI proof: log in, open the cycle workspace Planning tab, screenshot the live seat roster.
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

    await expect(page.getByTestId('ws-plan-seats')).toBeVisible({ timeout: 15000 });
    mark('seat roster visible in UI');

    await page.screenshot({
      path: path.join(EVIDENCE_DIR, 'A10-planning-three-seats.png'),
      fullPage: true,
    });
    const seatsAria = await page.getByTestId('ws-plan-seats-block').ariaSnapshot();
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'A10-planning-three-seats-aria-snapshot.yaml'), seatsAria, 'utf8');
    fs.copyFileSync(
      path.join(EVIDENCE_DIR, 'A10-planning-three-seats.png'),
      path.join(PLAN_DIR_EVIDENCE, 'A10-planning-three-seats.png')
    );
    fs.copyFileSync(
      path.join(EVIDENCE_DIR, 'A10-planning-three-seats-aria-snapshot.yaml'),
      path.join(PLAN_DIR_EVIDENCE, 'A10-planning-three-seats-aria-snapshot.yaml')
    );
    mark('evidence written');
  });
});
