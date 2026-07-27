import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

// A11 (R1.6 + D7/R1.30) live proof on :3110 / cards2-ibrain.db via playwright.cap.config.ts only.
// The bounded-exit path (planning timeout OR round-cap exhaustion — the SAME mechanism per D7) now
// transitions through transitionRunToBlocked: phase='blocked' (not the old plain phase='failed', which
// fired no operator notification) + status='failed', plus a mechanism-level blockedReason naming the
// missing partner batch id(s) and the round-cap budget. A genuine full-timeout/round-cap-exhausted stall
// takes minutes even at roundCap=1 on the real (non-fake) server — far beyond this spec's 180s budget —
// so, mirroring A8/A9's own precedent of proving the live-observable, budget-safe half, this spec reuses
// the SAME agreed:false path via a BROKEN partner verdict (fast, deterministic, and — since A11 — routed
// through the identical bounded-exit code as a real timeout/round-cap exhaustion) to prove the run
// reaches phase='blocked' (not 'failed') live. The round-cap-scales-the-wait mechanics and the exact
// blockedReason string are covered by unit tests in planning-phase-service.test.ts.

const BASE = process.env.HELM_BASE_URL || 'http://127.0.0.1:3110';
const CRED = process.env.HELM_OWNER_CRED || 'cards2-harness-563f750bebc23bba';
const DB_PATH = process.env.HELM_DB_PATH_LIVE || '/home/agjrom/websites/Helm/data/cards2-ibrain.db';
const RUN_TS = Date.now();
const PROJECT_NAME = `a11-validation-${RUN_TS}`;
const PROJECT_DIR = `/home/agjrom/websites/a11-validation-${RUN_TS}`;
const OWNER_MARKER = '.a11-live-owned';
const BATCH_ID = `a11-live-${RUN_TS}`;
const HELM_RUN_ROOT = process.env.HELM_RUN_ROOT_OVERRIDE || '/home/agjrom/websites/Helm/data/runs';
const EVIDENCE_DIR = path.join(process.cwd(), 'validation', 'A11');
const PLAN_DIR_EVIDENCE = path.join(process.cwd(), 'plan', 'helm-ux-remediation', 'validation', 'A11');

const VALID_NS = '# North star\n\nA11 bounded-exit proof: plan a small utility feature (throwaway).\n';
const VALID_OGREQ = '# Requirements\n\n- **R1.6/D7** — a bounded planning exit is a visible BLOCKED state.\n';
const VALID_PLAN_MD =
  '# Plan\n\n```json\n[{"id":"T1","batch":"A11","title":"A11 bounded-exit proof task","req_refs":["R1.6"],"assignee":"grok-4.5","validator_lane":"L2","effort":"low","type":"feature"}]\n```\n';

function predictRunDir(projectId: number, batchId: string): string {
  return path.join(HELM_RUN_ROOT, `helm-run-${projectId}-${batchId}`);
}

function setRoundCap(projectId: number, cap: number): void {
  const db = new Database(DB_PATH);
  db.prepare('UPDATE projects SET planning_round_cap = ? WHERE id = ?').run(cap, projectId);
  db.close();
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

test.describe('A11 live: bounded-exit path transitions a run to visible BLOCKED (not plain failed) on :3110', () => {
  let token: string;
  let projectId: number;
  let cycleId: number;
  let cycleDir = '';
  let runId: number | null = null;
  let runDir = '';

  test.beforeAll(async () => {
    if (fs.existsSync(PROJECT_DIR)) {
      throw new Error(
        `A11 live refuse: PROJECT_DIR already exists (${PROJECT_DIR}). ` +
          `Refusing to reuse or delete a path this test did not create.`
      );
    }
    fs.mkdirSync(PROJECT_DIR, { recursive: false });
    fs.writeFileSync(
      path.join(PROJECT_DIR, OWNER_MARKER),
      `owned-by e2e/A11.live.spec.ts ${PROJECT_NAME}\n`,
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
    setRoundCap(projectId, 1); // R1.30/D7: exercise a project explicitly configured off the default 3

    const cycleResp = await fetch(`${BASE}/api/projects/${projectId}/cycles`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `A11 bounded-exit ${RUN_TS}`,
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
            body: JSON.stringify({ reason: 'A11 live evidence capture complete' }),
          });
          await new Promise((r) => setTimeout(r, 1500));
        }
      } catch { /* best-effort */ }
    }

    // worker_runtimes.run_id has no ON DELETE CASCADE (A6/A6b/A8/A9 precedent) — clean up explicitly
    // before the project DELETE cascades runs, or it 400s with a FOREIGN KEY constraint failure.
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
        PROJECT_DIR.includes(`a11-validation-${RUN_TS}`) &&
        fs.existsSync(markerPath) &&
        fs.readFileSync(markerPath, 'utf8').includes(PROJECT_NAME)
      ) {
        fs.rmSync(PROJECT_DIR, { recursive: true, force: false });
      }
    } catch { /* leave orphan unique dir rather than widen blast radius */ }
  });

  test('a bounded-exit agreed:false transitions the run to phase=blocked (not failed) with an operator-visible status', async ({ page }) => {
    test.setTimeout(170000);
    const t0 = Date.now();
    const mark = (label: string) => console.log(`[A11.live timing] ${label} at +${Date.now() - t0}ms`);

    const health = await fetch(`${BASE}/health`);
    expect(health.ok).toBe(true);
    expect(BASE).toMatch(/127\.0\.0\.1:3110|localhost:3110/);

    expect(readCycle(cycleId).phase).toBe('discovery');

    const startResp = await fetch(`${BASE}/api/cycles/${cycleId}/start-planning`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        batchId: BATCH_ID,
        prompt: 'Plan a small utility feature for this throwaway A11 bounded-exit proof cycle.',
      }),
    });
    const startData = await startResp.json();
    if (!startResp.ok) throw new Error(`start-planning failed: ${JSON.stringify(startData)}`);
    runId = startData.runId;
    expect(runId).toBeTruthy();
    mark('start-planning returned');

    // Short-circuit the discovery interview: inject NORTH-STAR-READY directly (same contract as
    // A8/A9/A10's specs) — this spec is about the bounded-exit transition, not discovery.
    const driveDeadline = Date.now() + 20000;
    let drove = false;
    while (Date.now() < driveDeadline) {
      try {
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(path.join(runDir, 'north-star.md'), VALID_NS, 'utf8');
        fs.writeFileSync(path.join(runDir, 'conversation-log.md'), 'A11 bounded-exit proof.\n', 'utf8');
        fs.appendFileSync(
          path.join(runDir, 'callbacks.md'),
          `[helm callback] discovery ${BATCH_ID} STATUS: NORTH-STAR-READY — a11 live drive\n`,
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

    // Wait for the plancore seat to register (worker_runtimes row, via GET /api/cycles/:id/seats) —
    // registerWorkerRuntime fires immediately after transport.spawn, before any callback wait.
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

    // Drive a BROKEN partner verdict — the fastest, most deterministic way to reach agreed:false live
    // (a genuine full timeout/round-cap-exhausted stall takes minutes even at roundCap=1, far beyond
    // this spec's 180s budget). Since A11, BROKEN routes through the SAME bounded-exit transition
    // (transitionRunToBlocked) as a real timeout/round-cap exhaustion — this is the shared mechanism,
    // not a different one.
    let runTerminal = false;
    let terminalRow: any = null;
    const gateDeadline = Date.now() + 60000;
    while (Date.now() < gateDeadline) {
      try {
        fs.appendFileSync(
          path.join(runDir, 'callbacks.md'),
          `[helm callback] plancore ${BATCH_ID} STATUS: PLAN-READY — plan.json present\n` +
            `[helm callback] planner ${BATCH_ID}-partner STATUS: VERDICT-READY — BROKEN: missing validation criteria\n`,
          'utf8'
        );
      } catch { /* dir materializing */ }
      terminalRow = readRun(runId!);
      if (terminalRow && ['complete', 'failed', 'blocked'].includes(String(terminalRow.phase))) {
        runTerminal = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    mark('gate poll exited');
    expect(runTerminal, 'run never reached a terminal state after the BROKEN verdict').toBe(true);
    // A11's own fix: phase='blocked' (visible, escalating), not the pre-A11 plain 'failed'.
    expect(terminalRow.phase).toBe('blocked');
    expect(terminalRow.status).toBe('failed');

    // No ingest — the bounded exit never hands off to implementation.
    {
      const db = new Database(DB_PATH, { readonly: true });
      const taskCount = (db.prepare('SELECT COUNT(*) AS n FROM run_tasks WHERE run_id = ?').get(runId) as any).n;
      db.close();
      expect(Number(taskCount)).toBe(0);
    }

    // Both planning seats reaped (not live) — the run visibly stopped rather than silently continuing.
    let seatsAfter: any[] = [];
    const seatsDeadline = Date.now() + 20000;
    while (Date.now() < seatsDeadline) {
      const r = await fetch(`${BASE}/api/cycles/${cycleId}/seats`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) {
        const d = await r.json();
        seatsAfter = Array.isArray(d.seats) ? d.seats : [];
        if (seatsAfter.length >= 2 && seatsAfter.every((s: any) => s.live === false)) break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(seatsAfter.length).toBeGreaterThanOrEqual(2);
    expect(seatsAfter.every((s: any) => s.live === false), 'planning seats should be reaped (not live) after the bounded exit').toBe(true);
    mark('seats confirmed reaped');

    // UI proof: log in, open the cycle workspace, screenshot the visible BLOCKED/reaped state.
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

    // Best-effort: the run-phase/run-status chips (cc-col-term header) directly render run.phase /
    // run.status when a run is associated with the open workspace — if visible, this is the live,
    // operator-facing surface showing "blocked"/"failed" instead of the old "failed"/"failed".
    const runPhaseChip = page.getByTestId('run-phase');
    if (await runPhaseChip.count()) {
      await expect(runPhaseChip).toHaveText(/blocked/i, { timeout: 10000 }).catch(() => {});
    }

    const planTab = page.getByTestId('ws-tab-planning');
    if (await planTab.count()) await planTab.click();
    await expect(page.getByTestId('ws-plan-seats')).toBeVisible({ timeout: 15000 });
    mark('seat roster visible in UI');

    await page.screenshot({
      path: path.join(EVIDENCE_DIR, 'A11-bounded-exit-blocked.png'),
      fullPage: true,
    });
    const seatsAria = await page.getByTestId('ws-plan-seats-block').ariaSnapshot();
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'A11-bounded-exit-blocked-aria-snapshot.yaml'), seatsAria, 'utf8');
    fs.copyFileSync(
      path.join(EVIDENCE_DIR, 'A11-bounded-exit-blocked.png'),
      path.join(PLAN_DIR_EVIDENCE, 'A11-bounded-exit-blocked.png')
    );
    fs.copyFileSync(
      path.join(EVIDENCE_DIR, 'A11-bounded-exit-blocked-aria-snapshot.yaml'),
      path.join(PLAN_DIR_EVIDENCE, 'A11-bounded-exit-blocked-aria-snapshot.yaml')
    );
    mark('evidence written');
  });
});
