import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

// A13 (R1.29 reconvene half — D6 per-task half; A9's whole-plan scope half is untouched) live proof
// on :3110 / cards2-ibrain.db via playwright.cap.config.ts only. After the whole-plan PLAN-READY+CLEAN
// gate passes and the plan ingests (A9's mechanism, unchanged), a per-task ESCALATE verdict from
// either seat now convenes the pair for THAT task only — a fresh, task-scoped mini review seat is
// spawned (visible as a 3rd worker_runtimes seat, mirroring how A10's panelSize=3 showed a 3rd seat)
// and a durable run_events row records the trigger for audit. The all-ACCEPT/zero-convene baseline is
// already proven live by A8's own spec (exactly 2 seats when no TASK-VERDICT lines are ever emitted);
// this spec proves the NEW, A13-specific half: a seeded ESCALATE visibly convening within budget.

const BASE = process.env.HELM_BASE_URL || 'http://127.0.0.1:3110';
const CRED = process.env.HELM_OWNER_CRED || 'cards2-harness-563f750bebc23bba';
const DB_PATH = process.env.HELM_DB_PATH_LIVE || '/home/agjrom/websites/Helm/data/cards2-ibrain.db';
const RUN_TS = Date.now();
const PROJECT_NAME = `a13-validation-${RUN_TS}`;
const PROJECT_DIR = `/home/agjrom/websites/a13-validation-${RUN_TS}`;
const OWNER_MARKER = '.a13-live-owned';
const BATCH_ID = `a13-live-${RUN_TS}`;
const HELM_RUN_ROOT = process.env.HELM_RUN_ROOT_OVERRIDE || '/home/agjrom/websites/Helm/data/runs';
const EVIDENCE_DIR = path.join(process.cwd(), 'validation', 'A13');
const PLAN_DIR_EVIDENCE = path.join(process.cwd(), 'plan', 'helm-ux-remediation', 'validation', 'A13');

const VALID_NS = '# North star\n\nA13 reconvene proof: plan a small utility feature (throwaway).\n';
const VALID_OGREQ = '# Requirements\n\n- **R1.29** — a per-task ESCALATE conflict convenes the pair.\n';
const VALID_PLAN_MD =
  '# Plan\n\n```json\n[{"id":"T1","batch":"A13","title":"A13 reconvene proof task","req_refs":["R1.29"],"assignee":"grok-4.5","validator_lane":"L2","effort":"low","type":"feature"}]\n```\n';

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

function readReconveneEvent(runId: number): any {
  const db = new Database(DB_PATH, { readonly: true });
  const row = db.prepare(
    `SELECT run_id, batch_id, event_type, payload_json FROM run_events WHERE run_id = ? AND event_type = 'A13_TASK_RECONVENE'`
  ).get(String(runId));
  db.close();
  return row;
}

test.describe('A13 live: a per-task ESCALATE verdict convenes the pair for that task on :3110', () => {
  let token: string;
  let projectId: number;
  let cycleId: number;
  let cycleDir = '';
  let runId: number | null = null;
  let runDir = '';

  test.beforeAll(async () => {
    if (fs.existsSync(PROJECT_DIR)) {
      throw new Error(
        `A13 live refuse: PROJECT_DIR already exists (${PROJECT_DIR}). ` +
          `Refusing to reuse or delete a path this test did not create.`
      );
    }
    fs.mkdirSync(PROJECT_DIR, { recursive: false });
    fs.writeFileSync(
      path.join(PROJECT_DIR, OWNER_MARKER),
      `owned-by e2e/A13.live.spec.ts ${PROJECT_NAME}\n`,
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
        name: `A13 reconvene ${RUN_TS}`,
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
            body: JSON.stringify({ reason: 'A13 live evidence capture complete' }),
          });
          await new Promise((r) => setTimeout(r, 1500));
        }
      } catch { /* best-effort */ }
    }

    // worker_runtimes.run_id has no ON DELETE CASCADE (A6/A6b/A8/A9/A11 precedent) — clean up
    // explicitly before the project DELETE cascades runs, or it 400s with a FOREIGN KEY constraint
    // failure. run_events IS cascade-linked to runs (append-only, no FK issue) so no explicit delete
    // needed there.
    if (runId != null) {
      try {
        const db = new Database(DB_PATH);
        db.prepare('DELETE FROM worker_runtimes WHERE run_id = ?').run(runId);
        db.prepare('DELETE FROM helm_sessions WHERE run_id = ?').run(runId);
        db.prepare('DELETE FROM run_tasks WHERE run_id = ?').run(runId);
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
        PROJECT_DIR.includes(`a13-validation-${RUN_TS}`) &&
        fs.existsSync(markerPath) &&
        fs.readFileSync(markerPath, 'utf8').includes(PROJECT_NAME)
      ) {
        fs.rmSync(PROJECT_DIR, { recursive: true, force: false });
      }
    } catch { /* leave orphan unique dir rather than widen blast radius */ }
  });

  test('a seeded per-task ESCALATE convenes the pair: a 3rd reconvene seat spawns and a run_events row is recorded', async ({ page }) => {
    test.setTimeout(170000);
    const t0 = Date.now();
    const mark = (label: string) => console.log(`[A13.live timing] ${label} at +${Date.now() - t0}ms`);

    const health = await fetch(`${BASE}/health`);
    expect(health.ok).toBe(true);
    expect(BASE).toMatch(/127\.0\.0\.1:3110|localhost:3110/);

    expect(readCycle(cycleId).phase).toBe('discovery');

    const startResp = await fetch(`${BASE}/api/cycles/${cycleId}/start-planning`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        batchId: BATCH_ID,
        prompt: 'Plan a small utility feature for this throwaway A13 reconvene proof cycle.',
      }),
    });
    const startData = await startResp.json();
    if (!startResp.ok) throw new Error(`start-planning failed: ${JSON.stringify(startData)}`);
    runId = startData.runId;
    expect(runId).toBeTruthy();
    mark('start-planning returned');

    // Short-circuit the discovery interview (same contract as A8/A9/A10/A11's specs).
    const driveDeadline = Date.now() + 20000;
    let drove = false;
    while (Date.now() < driveDeadline) {
      try {
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(path.join(runDir, 'north-star.md'), VALID_NS, 'utf8');
        fs.writeFileSync(path.join(runDir, 'conversation-log.md'), 'A13 reconvene proof.\n', 'utf8');
        fs.appendFileSync(
          path.join(runDir, 'callbacks.md'),
          `[helm callback] discovery ${BATCH_ID} STATUS: NORTH-STAR-READY — a13 live drive\n`,
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

    // Drive the whole-plan gate to CLEAN (A9's mechanism, unchanged) PLUS a per-task ESCALATE for T1
    // from plancore, with the partner ACCEPTing it — the conflict A13 must convene on.
    let seatCount = 0;
    const threeSeatDeadline = Date.now() + 60000;
    while (Date.now() < threeSeatDeadline) {
      try {
        fs.appendFileSync(
          path.join(runDir, 'callbacks.md'),
          `[helm callback] plancore ${BATCH_ID} STATUS: TASK-VERDICT — T1: ESCALATE: needs owner decision\n` +
            `[helm callback] plancore ${BATCH_ID} STATUS: PLAN-READY — plan.json present\n` +
            `[helm callback] planner ${BATCH_ID}-partner STATUS: TASK-VERDICT — T1: ACCEPT\n` +
            `[helm callback] planner ${BATCH_ID}-partner STATUS: VERDICT-READY — CLEAN: clean\n`,
          'utf8'
        );
      } catch { /* dir materializing */ }
      const r = await fetch(`${BASE}/api/cycles/${cycleId}/seats`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) {
        const d = await r.json();
        seatCount = Array.isArray(d.seats) ? d.seats.length : 0;
        if (seatCount >= 3) break;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    mark('three-seat (reconvene) poll exited');
    expect(seatCount, 'the ESCALATE conflict never spawned a 3rd (reconvene) seat').toBeGreaterThanOrEqual(3);

    // Run itself proceeded past the whole-plan gate (agreed, ingested) — the reconvene is an audit-only
    // addition on top of the already-passed gate, not a new blocking gate of its own.
    const runRow = readRun(runId!);
    expect(runRow.phase).not.toBe('failed');
    expect(runRow.phase).not.toBe('blocked');

    // DB proof: a run_events row records the convene, against this run + its cycle.
    let eventRow: any = null;
    const eventDeadline = Date.now() + 15000;
    while (Date.now() < eventDeadline) {
      eventRow = readReconveneEvent(runId!);
      if (eventRow) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(eventRow, 'no A13_TASK_RECONVENE run_events row found').toBeTruthy();
    const payload = JSON.parse(eventRow.payload_json);
    expect(payload.task_key).toBe('T1');
    expect(payload.trigger).toBe('ESCALATE');
    mark('convene event confirmed in DB');

    // UI proof: log in, open the cycle workspace Planning tab, screenshot the 3-seat roster.
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
      path: path.join(EVIDENCE_DIR, 'A13-reconvene-three-seats.png'),
      fullPage: true,
    });
    const seatsAria = await page.getByTestId('ws-plan-seats-block').ariaSnapshot();
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'A13-reconvene-three-seats-aria-snapshot.yaml'), seatsAria, 'utf8');
    fs.copyFileSync(
      path.join(EVIDENCE_DIR, 'A13-reconvene-three-seats.png'),
      path.join(PLAN_DIR_EVIDENCE, 'A13-reconvene-three-seats.png')
    );
    fs.copyFileSync(
      path.join(EVIDENCE_DIR, 'A13-reconvene-three-seats-aria-snapshot.yaml'),
      path.join(PLAN_DIR_EVIDENCE, 'A13-reconvene-three-seats-aria-snapshot.yaml')
    );
    mark('evidence written');
  });
});
