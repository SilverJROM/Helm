import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

// A6 (R3.14) live proof on :3110 / cards2-ibrain.db via playwright.cap.config.ts only.
// pause_after_planning actually gates: a gate-mode cycle parks at planning-done (awaiting_approval,
// implementation queue never dispatches) and only proceeds once JROM clicks Approve. Throwaway
// project; scoped teardown.

const BASE = process.env.HELM_BASE_URL || 'http://127.0.0.1:3110';
const CRED = process.env.HELM_OWNER_CRED || 'cards2-harness-563f750bebc23bba';
const DB_PATH = process.env.HELM_DB_PATH_LIVE || '/home/agjrom/websites/Helm/data/cards2-ibrain.db';
const RUN_TS = Date.now();
const PROJECT_NAME = `a6-validation-${RUN_TS}`;
const PROJECT_DIR = `/home/agjrom/websites/a6-validation-${RUN_TS}`;
const OWNER_MARKER = '.a6-live-owned';
const BATCH_ID = `a6-live-${RUN_TS}`;
const HELM_RUN_ROOT = process.env.HELM_RUN_ROOT_OVERRIDE || '/home/agjrom/websites/Helm/data/runs';
const EVIDENCE_DIR = path.join(process.cwd(), 'validation', 'A6');
const PLAN_DIR_EVIDENCE = path.join(process.cwd(), 'plan', 'helm-ux-remediation', 'validation', 'A6');

// assignee must be a real model_id (validatePlanStartingRungs rejects UNKNOWN_MODEL e.g. "terra").
const VALID_PLAN_MD =
  '# Plan\n\n```json\n[{"id":"T1","batch":"A6","title":"A6 gate proof task","req_refs":["R3.14"],"assignee":"grok-4.5","validator_lane":"L2","effort":"low","type":"feature"}]\n```\n';
const VALID_OGREQ = '# Requirements\n\n- **R3.14** — pause_after_planning actually gates the implementation queue.\n';

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

test.describe('A6 live: pause_after_planning gates the implementation queue on :3110', () => {
  let token: string;
  let projectId: number;
  let cycleId: number;
  let cycleDir = '';
  let plannedRunId: number | null = null;
  let plannedRunDir = '';
  let implRunId: number | null = null;
  let implRunDir = '';

  test.beforeAll(async () => {
    if (fs.existsSync(PROJECT_DIR)) {
      throw new Error(
        `A6 live refuse: PROJECT_DIR already exists (${PROJECT_DIR}). ` +
          `Refusing to reuse or delete a path this test did not create.`
      );
    }
    fs.mkdirSync(PROJECT_DIR, { recursive: false });
    fs.writeFileSync(
      path.join(PROJECT_DIR, OWNER_MARKER),
      `owned-by e2e/A6.live.spec.ts ${PROJECT_NAME}\n`,
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
        name: `A6 gate ${RUN_TS}`,
        autonomy: 'pause_after_planning',
      }),
    });
    const cycleData = await cycleResp.json();
    if (!cycleResp.ok) throw new Error(`cycle create failed: ${JSON.stringify(cycleData)}`);
    cycleId = cycleData.cycle.id;
    cycleDir = path.join(PROJECT_DIR, 'cycle', String(cycleData.cycle.folder_name));
    fs.mkdirSync(cycleDir, { recursive: true });
    // Pre-seed cycle canonical docs so the real-path agreement gate can read them as soon as
    // PLAN-READY lands (B1: cycle folder is canonicalArtifactRoot for cycle-linked starts).
    fs.writeFileSync(path.join(cycleDir, 'og-requirements.md'), VALID_OGREQ, 'utf8');
    fs.writeFileSync(path.join(cycleDir, 'plan.md'), VALID_PLAN_MD, 'utf8');
    plannedRunDir = predictRunDir(projectId, BATCH_ID);
  });

  test.afterAll(async () => {
    // Stop only if still non-terminal — avoids re-poisoning the in-memory abort registry on a
    // recycled run id after a prior clean stop (rowid reuse + requestRunAbort).
    for (const rid of [plannedRunId, implRunId]) {
      if (rid == null) continue;
      try {
        const row = readRun(rid);
        const terminal =
          row &&
          (['complete', 'failed', 'blocked'].includes(String(row.phase)) ||
            ['complete', 'failed', 'paused'].includes(String(row.status)));
        if (!terminal) {
          await fetch(`${BASE}/api/runs/${rid}/stop`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: 'A6 live evidence capture complete' }),
          });
          await new Promise((r) => setTimeout(r, 2000));
        }
      } catch { /* best-effort */ }
    }

    try {
      const db = new Database(DB_PATH);
      for (const rid of [plannedRunId, implRunId]) {
        if (rid == null) continue;
        db.prepare('DELETE FROM worker_runtimes WHERE run_id = ?').run(rid);
        db.prepare('DELETE FROM helm_sessions WHERE run_id = ?').run(rid);
        db.prepare('DELETE FROM run_tasks WHERE run_id = ?').run(rid);
        db.prepare('DELETE FROM run_events WHERE run_id = ?').run(rid);
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

    for (const dir of [plannedRunDir, implRunDir]) {
      try {
        if (dir && dir.includes(`helm-run-${projectId}-`)) fs.rmSync(dir, { recursive: true, force: true });
      } catch { /* best-effort */ }
    }

    try {
      const markerPath = path.join(PROJECT_DIR, OWNER_MARKER);
      if (
        PROJECT_DIR.includes(`a6-validation-${RUN_TS}`) &&
        fs.existsSync(markerPath) &&
        fs.readFileSync(markerPath, 'utf8').includes(PROJECT_NAME)
      ) {
        fs.rmSync(PROJECT_DIR, { recursive: true, force: false });
      }
    } catch { /* leave orphan unique dir rather than widen blast radius */ }
  });

  test('gate parks the queue at planning-done; approve unparks it and implementation proceeds', async ({ page }) => {
    test.setTimeout(400000);

    const health = await fetch(`${BASE}/health`);
    expect(health.ok).toBe(true);
    expect(BASE).toMatch(/127\.0\.0\.1:3110|localhost:3110/);

    // Baseline: cycle starts discovery.
    expect(readCycle(cycleId).phase).toBe('discovery');

    const startResp = await fetch(`${BASE}/api/cycles/${cycleId}/start-planning`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        batchId: BATCH_ID,
        prompt: 'Plan one small hello endpoint feature for this throwaway A6 gate-proof cycle.',
      }),
    });
    const startData = await startResp.json();
    if (!startResp.ok) throw new Error(`start-planning failed: ${JSON.stringify(startData)}`);
    plannedRunId = startData.runId;
    expect(plannedRunId).toBeTruthy();

    expect(readCycle(cycleId).phase).toBe('planning');

    // Drive plancore to PLAN-READY (same recipe as A5) so finishPlanning fires without waiting on
    // a full LLM plan-authoring pass.
    const driveDeadline = Date.now() + 90000;
    let drove = false;
    while (Date.now() < driveDeadline) {
      try {
        fs.mkdirSync(plannedRunDir, { recursive: true });
        fs.mkdirSync(cycleDir, { recursive: true });
        fs.writeFileSync(path.join(cycleDir, 'og-requirements.md'), VALID_OGREQ, 'utf8');
        fs.writeFileSync(path.join(cycleDir, 'plan.md'), VALID_PLAN_MD, 'utf8');
        fs.writeFileSync(path.join(plannedRunDir, 'og-requirements.md'), VALID_OGREQ, 'utf8');
        fs.writeFileSync(path.join(plannedRunDir, 'plan.md'), VALID_PLAN_MD, 'utf8');
        const cbPath = path.join(plannedRunDir, 'callbacks.md');
        const line =
          `[helm callback] plancore ${BATCH_ID} STATUS: PLANNING — a6 live drive\n` +
          `[helm callback] plancore ${BATCH_ID} STATUS: PLAN-READY — plan agreed with planner; see plan.md\n` +
          `[helm callback] planner ${BATCH_ID}-partner STATUS: REVIEW-READY\n` +
          `[helm callback] helm_pm ${BATCH_ID} STATUS: PLAN-READY — plan agreed with planner; see plan.md\n`;
        fs.appendFileSync(cbPath, line, 'utf8');
        drove = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    expect(drove, 'could not write plancore drive artifacts into runDir/cycleDir').toBe(true);

    // Poll until the GATE fires: awaiting_approval=1, phase stays 'planning' (never auto-advances
    // to implementation the way an autonomous cycle would — that's the A5 contract, not this one).
    let awaitingApproval = false;
    const gateDeadline = Date.now() + 90000;
    while (Date.now() < gateDeadline) {
      const row = readCycle(cycleId);
      if (row && Number(row.awaiting_approval) === 1) {
        awaitingApproval = true;
        expect(row.phase).toBe('planning');
        break;
      }
      try {
        fs.appendFileSync(
          path.join(plannedRunDir, 'callbacks.md'),
          `[helm callback] plancore ${BATCH_ID} STATUS: PLAN-READY — a6 reassert\n` +
            `[helm callback] planner ${BATCH_ID}-partner STATUS: REVIEW-READY\n`,
          'utf8'
        );
        fs.writeFileSync(path.join(cycleDir, 'plan.md'), VALID_PLAN_MD, 'utf8');
        fs.writeFileSync(path.join(cycleDir, 'og-requirements.md'), VALID_OGREQ, 'utf8');
      } catch { /* run may still be creating dirs */ }
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(awaitingApproval, 'cycle.awaiting_approval never flipped via the pause_after_planning gate').toBe(true);

    // DB proof the QUEUE NEVER STARTED: the planning run itself is parked via the #52
    // operator-pause contract (phase='blocked', status='paused' — every other terminal-phase guard
    // in run-orchestrator-service.ts already protects 'blocked' from being clobbered by an
    // unrelated later write, unlike a bespoke phase string), and every ingested task is still
    // pending with zero attempts.
    let parkedRow: any = null;
    const parkDeadline = Date.now() + 20000;
    while (Date.now() < parkDeadline) {
      parkedRow = readRun(plannedRunId!);
      if (parkedRow && parkedRow.phase === 'blocked') break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(parkedRow?.phase, `run ${plannedRunId} never parked as blocked/paused`).toBe('blocked');
    expect(parkedRow?.status).toBe('paused');
    {
      const db = new Database(DB_PATH, { readonly: true });
      const tasks = db.prepare('SELECT status FROM run_tasks WHERE run_id = ?').all(plannedRunId) as any[];
      const attempts = db
        .prepare('SELECT COUNT(*) AS c FROM task_attempts ta JOIN run_tasks rt ON ta.task_id = rt.id WHERE rt.run_id = ?')
        .get(plannedRunId) as any;
      db.close();
      expect(tasks.length).toBeGreaterThan(0);
      for (const t of tasks) expect(t.status).toBe('pending');
      expect(Number(attempts.c)).toBe(0);
    }

    // UI: log in, open the cycle workspace — it lands on the Planning tab (cycle.phase is still
    // 'planning') and shows the "Awaiting your approval" banner. This is the PARKED evidence.
    await page.goto(`${BASE}/`);
    await page.locator('input[placeholder="owner credential"]').fill(CRED);
    await page.click('button:has-text("Login")');
    await page.getByTestId('nav-project-setup').waitFor({ state: 'visible', timeout: 15000 });

    await page.goto(`${BASE}/#07-command-center-overview`);
    await expect(page.getByTestId('ov-board')).toBeVisible({ timeout: 15000 });

    let card = page.getByTestId(`ov-card-${projectId}`);
    let cardVisible = false;
    const uiDeadline = Date.now() + 30000;
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
    expect(cardVisible, `ov-card-${projectId} not found on overview`).toBe(true);

    await card.click();
    await expect(page.getByTestId('content-cmd-workspace')).toBeVisible({ timeout: 15000 });
    const planTab = page.getByTestId('ws-tab-planning');
    if (await planTab.count()) await planTab.click();
    await expect(page.getByTestId('ws-plan-approve-banner')).toBeVisible({ timeout: 15000 });
    const bannerText = (await page.getByTestId('ws-plan-approve-banner').innerText()).toLowerCase();
    expect(bannerText).toContain('awaiting your approval');

    await page.screenshot({
      path: path.join(EVIDENCE_DIR, 'A6-gate-parked-awaiting-approval.png'),
      fullPage: true,
    });
    const parkedAria = await page.getByTestId('content-cmd-workspace').ariaSnapshot();
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'A6-gate-parked-aria-snapshot.yaml'), parkedAria, 'utf8');
    fs.copyFileSync(
      path.join(EVIDENCE_DIR, 'A6-gate-parked-awaiting-approval.png'),
      path.join(PLAN_DIR_EVIDENCE, 'A6-gate-parked-awaiting-approval.png')
    );
    fs.copyFileSync(
      path.join(EVIDENCE_DIR, 'A6-gate-parked-aria-snapshot.yaml'),
      path.join(PLAN_DIR_EVIDENCE, 'A6-gate-parked-aria-snapshot.yaml')
    );

    // Click Approve — this is the ONLY thing that should unpark the queue (R3.14).
    await page.getByTestId('ws-plan-approve-btn').click();
    await expect(page.getByTestId('ws-plan-approve-banner')).toBeHidden({ timeout: 20000 });

    expect(readCycle(cycleId).phase).toBe('implementation');
    expect(Number(readCycle(cycleId).awaiting_approval)).toBe(0);

    // Discover the fresh cyclePlan run approval started (a NEW run row, not the parked one).
    let newRunRow: any = null;
    const newRunDeadline = Date.now() + 20000;
    while (Date.now() < newRunDeadline) {
      const db = new Database(DB_PATH, { readonly: true });
      newRunRow = db
        .prepare('SELECT id, batch_id, phase, status FROM runs WHERE cycle_id = ? AND id != ? ORDER BY id DESC LIMIT 1')
        .get(cycleId, plannedRunId);
      db.close();
      if (newRunRow) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(newRunRow, 'approveCycle did not start a fresh implementation run').toBeTruthy();
    implRunId = Number(newRunRow.id);
    implRunDir = predictRunDir(projectId, String(newRunRow.batch_id));

    // Drive the implementer/validator/panelist callbacks (no plancore/partner — cyclePlan skips
    // interview + planning entirely and ingests plan.md straight into run_tasks) so the single
    // ingested task can proceed without waiting on a full real dispatch.
    const implDriveDeadline = Date.now() + 60000;
    let implDrove = false;
    while (Date.now() < implDriveDeadline) {
      try {
        fs.mkdirSync(implRunDir, { recursive: true });
        const cbPath = path.join(implRunDir, 'callbacks.md');
        const line =
          `[helm callback] implementer ${newRunRow.batch_id} STATUS: DONE — wired\n` +
          `[helm callback] validator ${newRunRow.batch_id} STATUS: PASS — verified\n` +
          `[helm callback] panelist ${newRunRow.batch_id} STATUS: VERDICT-READY — CLEAN: all gates pass (seat red-a6:0)\n` +
          `[helm callback] panelist ${newRunRow.batch_id} STATUS: VERDICT-READY — CLEAN: regressions hold (seat red-a6:1)\n`;
        fs.appendFileSync(cbPath, line, 'utf8');
        implDrove = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    expect(implDrove, 'could not write implementer/validator/panelist drive artifacts into implRunDir').toBe(true);

    // Poll for the PROCEEDING signal: the queue actually dispatched (run_tasks left 'pending', or a
    // real attempt was recorded) — the direct opposite of test one's "queue never starts" invariant.
    let proceeded = false;
    // Wide window: a real (non-fake) implementer spawn can take several minutes to boot under
    // contention (this box runs many concurrent agent tmux sessions) before recordAttempt flips
    // run_tasks to 'working' — a slow cold real CLI start, not a hang.
    const proceedDeadline = Date.now() + 300000;
    while (Date.now() < proceedDeadline) {
      const db = new Database(DB_PATH, { readonly: true });
      const tasks = db.prepare('SELECT status FROM run_tasks WHERE run_id = ?').all(implRunId) as any[];
      const attempts = db
        .prepare('SELECT COUNT(*) AS c FROM task_attempts ta JOIN run_tasks rt ON ta.task_id = rt.id WHERE rt.run_id = ?')
        .get(implRunId) as any;
      db.close();
      if (tasks.length > 0 && (tasks.some((t) => t.status !== 'pending') || Number(attempts.c) > 0)) {
        proceeded = true;
        break;
      }
      // Keep re-appending in case the loop polled callbacks.md before the first write landed.
      try {
        fs.appendFileSync(
          path.join(implRunDir, 'callbacks.md'),
          `[helm callback] implementer ${newRunRow.batch_id} STATUS: DONE — a6 reassert\n`,
          'utf8'
        );
      } catch { /* dir may still be materializing */ }
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(proceeded, 'implementation queue never dispatched after approveCycle').toBe(true);

    // Deliberately NOT calling /stop here: stopping while OrchestratorLoop.runTask is mid-flight
    // (implementer DONE -> validator PASS just landed from the injected callbacks) races its own
    // persistValidatorOutcome write against the abort — a pre-existing stop/in-flight-task race
    // unrelated to R3.14. The single injected task is tiny and finishes on its own in seconds;
    // afterAll's cleanup stops the run (if still non-terminal) only once this test is fully done.

    // UI: Implementation tab now shows real progress — the PROCEEDING evidence.
    const implTab = page.getByTestId('ws-tab-implementation');
    await implTab.click();
    // Both render together once dispatch starts (the "running" chip is additive, not exclusive,
    // with the metrics row) — assert on the always-present metrics row to avoid a Playwright
    // strict-mode violation from matching two visible elements at once.
    await expect(page.getByTestId('ws-impl-metrics')).toBeVisible({ timeout: 20000 });

    await page.screenshot({
      path: path.join(EVIDENCE_DIR, 'A6-implementation-proceeding.png'),
      fullPage: true,
    });
    const proceedingAria = await page.getByTestId('content-cmd-workspace').ariaSnapshot();
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'A6-implementation-proceeding-aria-snapshot.yaml'), proceedingAria, 'utf8');
    fs.copyFileSync(
      path.join(EVIDENCE_DIR, 'A6-implementation-proceeding.png'),
      path.join(PLAN_DIR_EVIDENCE, 'A6-implementation-proceeding.png')
    );
    fs.copyFileSync(
      path.join(EVIDENCE_DIR, 'A6-implementation-proceeding-aria-snapshot.yaml'),
      path.join(PLAN_DIR_EVIDENCE, 'A6-implementation-proceeding-aria-snapshot.yaml')
    );
  });
});
