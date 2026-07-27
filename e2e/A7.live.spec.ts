import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

// A7 (R3.15) live proof on :3110 / cards2-ibrain.db via playwright.cap.config.ts only.
// On true run terminal the cycle board advances to phase=complete (never stuck at planning).
// Fast path: finish-planning (autonomous → implementation) + start-implementation + stop
// (stop is a true terminal; unit suite covers full success complete). Throwaway project.

const BASE = process.env.HELM_BASE_URL || 'http://127.0.0.1:3110';
const CRED = process.env.HELM_OWNER_CRED || 'cards2-harness-563f750bebc23bba';
const DB_PATH = process.env.HELM_DB_PATH_LIVE || '/home/agjrom/websites/Helm/data/cards2-ibrain.db';
const RUN_TS = Date.now();
const PROJECT_NAME = `a7-validation-${RUN_TS}`;
const PROJECT_DIR = `/home/agjrom/websites/a7-validation-${RUN_TS}`;
const OWNER_MARKER = '.a7-live-owned';
const BATCH_ID = `a7-live-${RUN_TS}`;
const HELM_RUN_ROOT = process.env.HELM_RUN_ROOT_OVERRIDE || '/home/agjrom/websites/Helm/data/runs';
const EVIDENCE_DIR = path.join(process.cwd(), 'validation', 'A7');
const PLAN_DIR_EVIDENCE = path.join(process.cwd(), 'plan', 'helm-ux-remediation', 'validation', 'A7');

const VALID_PLAN_MD =
  '# Plan\n\n```json\n[{"id":"T1","batch":"A7","title":"A7 terminal phase proof task","req_refs":["R3.15"],"assignee":"grok-4.5","validator_lane":"L2","effort":"low","type":"feature"}]\n```\n';
const VALID_OGREQ = '# Requirements\n\n- **R3.15** — on run completion cycle reaches terminal phase automatically.\n';
const VALID_NS = '# North star\n\nA7 throwaway: terminal cycle phase on run end.\n';

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
  const row = db.prepare('SELECT phase, autonomy, awaiting_approval, status FROM cycles WHERE id = ?').get(cycleId);
  db.close();
  return row;
}

function readRun(runId: number): any {
  const db = new Database(DB_PATH, { readonly: true });
  const row = db.prepare('SELECT id, cycle_id, batch_id, phase, status FROM runs WHERE id = ?').get(runId);
  db.close();
  return row;
}

test.describe('A7 live: terminal cycle phase on run completion on :3110', () => {
  let token: string;
  let projectId: number;
  let cycleId: number;
  let cycleDir = '';
  let runId: number | null = null;
  let runDir = '';

  test.beforeAll(async () => {
    if (fs.existsSync(PROJECT_DIR)) {
      throw new Error(
        `A7 live refuse: PROJECT_DIR already exists (${PROJECT_DIR}). ` +
          `Refusing to reuse or delete a path this test did not create.`
      );
    }
    fs.mkdirSync(PROJECT_DIR, { recursive: false });
    fs.writeFileSync(
      path.join(PROJECT_DIR, OWNER_MARKER),
      `owned-by e2e/A7.live.spec.ts ${PROJECT_NAME}\n`,
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
        name: `A7 terminal ${RUN_TS}`,
        autonomy: 'autonomous_after_discovery',
        final_tests_enabled: false,
      }),
    });
    const cycleData = await cycleResp.json();
    if (!cycleResp.ok) throw new Error(`cycle create failed: ${JSON.stringify(cycleData)}`);
    cycleId = cycleData.cycle.id;
    cycleDir = path.join(PROJECT_DIR, 'cycle', String(cycleData.cycle.folder_name));
    fs.mkdirSync(cycleDir, { recursive: true });
    fs.writeFileSync(path.join(cycleDir, 'og-requirements.md'), VALID_OGREQ, 'utf8');
    fs.writeFileSync(path.join(cycleDir, 'plan.md'), VALID_PLAN_MD, 'utf8');
    fs.writeFileSync(path.join(cycleDir, 'north-star.md'), VALID_NS, 'utf8');
  });

  test.afterAll(async () => {
    if (runId != null) {
      try {
        const row = readRun(runId);
        const terminal =
          row &&
          (['complete', 'failed', 'blocked'].includes(String(row.phase)) ||
            ['complete', 'failed', 'paused'].includes(String(row.status)));
        if (!terminal) {
          await fetch(`${BASE}/api/runs/${runId}/stop`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: 'A7 live teardown' }),
          });
          await new Promise((r) => setTimeout(r, 1500));
        }
      } catch { /* best-effort */ }
    }

    try {
      const db = new Database(DB_PATH);
      if (runId != null) {
        db.prepare('DELETE FROM worker_runtimes WHERE run_id = ?').run(runId);
        db.prepare('DELETE FROM helm_sessions WHERE run_id = ?').run(runId);
        db.prepare('DELETE FROM run_tasks WHERE run_id = ?').run(runId);
        db.prepare('DELETE FROM run_events WHERE run_id = ?').run(runId);
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
        PROJECT_DIR.includes(`a7-validation-${RUN_TS}`) &&
        fs.existsSync(markerPath) &&
        fs.readFileSync(markerPath, 'utf8').includes(PROJECT_NAME)
      ) {
        fs.rmSync(PROJECT_DIR, { recursive: true, force: false });
      }
    } catch { /* leave orphan unique dir rather than widen blast radius */ }
  });

  test('finished run advances cycle board to COMPLETE (not planning)', async ({ page }) => {
    // Outer contract: timeout 180s wrapper. Keep test budget under that.
    test.setTimeout(170000);
    const t0 = Date.now();
    const mark = (label: string) => console.log(`[A7.live timing] ${label} at +${Date.now() - t0}ms`);

    const health = await fetch(`${BASE}/health`);
    expect(health.ok).toBe(true);
    expect(BASE).toMatch(/127\.0\.0\.1:3110|localhost:3110/);

    expect(readCycle(cycleId).phase).toBe('discovery');

    // Land at implementation without plancore cold-spawn (A6b pattern) so we fit 180s.
    const phaseResp = await fetch(`${BASE}/api/cycles/${cycleId}/phase`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ phase: 'planning' }),
    });
    if (!phaseResp.ok) throw new Error(`phase→planning failed: ${JSON.stringify(await phaseResp.json())}`);
    expect(readCycle(cycleId).phase).toBe('planning');

    fs.writeFileSync(path.join(cycleDir, 'plan.md'), VALID_PLAN_MD, 'utf8');
    fs.writeFileSync(path.join(cycleDir, 'og-requirements.md'), VALID_OGREQ, 'utf8');
    fs.writeFileSync(path.join(cycleDir, 'north-star.md'), VALID_NS, 'utf8');

    const finResp = await fetch(`${BASE}/api/cycles/${cycleId}/finish-planning`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!finResp.ok) throw new Error(`finish-planning failed: ${JSON.stringify(await finResp.json())}`);
    mark('finish-planning');
    // Autonomous: finishPlanning advances to implementation
    expect(readCycle(cycleId).phase).toBe('implementation');

    // Start implementation-only run (cyclePlan) — real production path that will terminalize.
    const startResp = await fetch(`${BASE}/api/cycles/${cycleId}/start-implementation`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ batchId: BATCH_ID }),
    });
    const startData = await startResp.json();
    if (!startResp.ok) throw new Error(`start-implementation failed: ${JSON.stringify(startData)}`);
    runId = startData.runId ?? startData.run?.id ?? null;
    if (runId == null) {
      // Poll for cycle-linked run if response shape differs
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline && runId == null) {
        const db = new Database(DB_PATH, { readonly: true });
        const row = db
          .prepare('SELECT id, batch_id FROM runs WHERE cycle_id = ? ORDER BY id DESC LIMIT 1')
          .get(cycleId) as any;
        db.close();
        if (row) {
          runId = Number(row.id);
          runDir = predictRunDir(projectId, String(row.batch_id));
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    } else {
      const r = readRun(runId);
      runDir = predictRunDir(projectId, String(r?.batch_id || BATCH_ID));
    }
    expect(runId, 'no implementation run started').toBeTruthy();
    mark(`run ${runId} started`);

    // Still non-terminal board while run is live
    {
      const mid = readCycle(cycleId);
      expect(mid.phase).not.toBe('complete');
    }

    // True terminal via stop (production stopRun → terminalizeCycleAtRunEnd).
    // Full success complete is covered by unit (a); live proves production wire + board chip.
    const stopResp = await fetch(`${BASE}/api/runs/${runId}/stop`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'A7 live: force true terminal to prove board advance' }),
    });
    if (!stopResp.ok) {
      const body = await stopResp.json().catch(() => ({}));
      throw new Error(`stop failed: ${JSON.stringify(body)}`);
    }
    mark('stop issued');

    let phase = '';
    const phaseDeadline = Date.now() + 20000;
    while (Date.now() < phaseDeadline) {
      const c = readCycle(cycleId);
      phase = String(c?.phase || '');
      if (phase === 'complete') break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(phase, 'cycle.phase never reached complete after true run terminal').toBe('complete');
    expect(phase).not.toBe('planning');

    const runAfter = readRun(runId!);
    expect(['complete', 'failed', 'blocked']).toContain(String(runAfter.phase));
    mark('DB terminal asserted');

    // UI: overview board shows COMPLETE for this cycle (not PLANNING).
    await page.goto(`${BASE}/`);
    await page.locator('input[placeholder="owner credential"]').fill(CRED);
    await page.click('button:has-text("Login")');
    await page.getByTestId('nav-project-setup').waitFor({ state: 'visible', timeout: 15000 });

    await page.goto(`${BASE}/#07-command-center-overview`);
    await expect(page.getByTestId('ov-board')).toBeVisible({ timeout: 15000 });

    let card = page.getByTestId(`ov-card-${projectId}`);
    let cardVisible = false;
    const uiDeadline = Date.now() + 25000;
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
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(cardVisible, `ov-card-${projectId} not found on overview`).toBe(true);

    const cardText = (await card.innerText()).toUpperCase();
    expect(cardText, 'board still shows PLANNING for finished run').not.toContain('PLANNING');
    // Prefer COMPLETE chip; tolerate COMPLETE in card body
    expect(cardText.includes('COMPLETE') || cardText.includes('COMPLETED')).toBe(true);

    await card.screenshot({ path: path.join(EVIDENCE_DIR, 'A7-board-terminal-complete.png') });
    fs.copyFileSync(
      path.join(EVIDENCE_DIR, 'A7-board-terminal-complete.png'),
      path.join(PLAN_DIR_EVIDENCE, 'A7-board-terminal-complete.png')
    );

    const aria = await card.ariaSnapshot();
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'A7-board-aria-snapshot.yaml'), aria, 'utf8');
    fs.writeFileSync(path.join(PLAN_DIR_EVIDENCE, 'A7-board-aria-snapshot.yaml'), aria, 'utf8');
    mark('evidence written');
  });
});
