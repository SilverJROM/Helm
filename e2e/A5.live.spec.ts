import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

// A5 (R3.13) live proof on :3110 / cards2-ibrain.db via playwright.cap.config.ts only.
// Production finishPlanning at planning-done advances cycle.phase planning → implementation
// without a human PATCH of the row. Throwaway project; scoped teardown.

const BASE = process.env.HELM_BASE_URL || 'http://127.0.0.1:3110';
const CRED = process.env.HELM_OWNER_CRED || 'cards2-harness-563f750bebc23bba';
const DB_PATH = process.env.HELM_DB_PATH_LIVE || '/home/agjrom/websites/Helm/data/cards2-ibrain.db';
const RUN_TS = Date.now();
const PROJECT_NAME = `a5-validation-${RUN_TS}`;
const PROJECT_DIR = `/home/agjrom/websites/a5-validation-${RUN_TS}`;
const OWNER_MARKER = '.a5-live-owned';
const BATCH_ID = `a5-live-${RUN_TS}`;
const HELM_RUN_ROOT = process.env.HELM_RUN_ROOT_OVERRIDE || '/home/agjrom/websites/Helm/data/runs';
const EVIDENCE_DIR = path.join(process.cwd(), 'validation', 'A5');
const PLAN_DIR_EVIDENCE = path.join(process.cwd(), 'plan', 'helm-ux-remediation', 'validation', 'A5');

// assignee must be a real model_id (validatePlanStartingRungs rejects UNKNOWN_MODEL e.g. "terra").
const VALID_PLAN_MD =
  '# Plan\n\n```json\n[{"id":"T1","batch":"A5","title":"A5 finishPlanning proof task","req_refs":["R3.13"],"assignee":"grok-4.5","validator_lane":"L2","effort":"low","type":"feature"}]\n```\n';
const VALID_OGREQ = '# Requirements\n\n- **R3.13** — finishPlanning called from production at planning-done.\n';

function predictRunDir(projectId: number): string {
  return path.join(HELM_RUN_ROOT, `helm-run-${projectId}-${BATCH_ID}`);
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

test.describe('A5 live: finishPlanning advances board unaided on :3110', () => {
  let token: string;
  let projectId: number;
  let cycleId: number;
  let cycleDir = '';
  let runId: number | null = null;
  let runDir = '';

  test.beforeAll(async () => {
    if (fs.existsSync(PROJECT_DIR)) {
      throw new Error(
        `A5 live refuse: PROJECT_DIR already exists (${PROJECT_DIR}). ` +
          `Refusing to reuse or delete a path this test did not create.`
      );
    }
    fs.mkdirSync(PROJECT_DIR, { recursive: false });
    fs.writeFileSync(
      path.join(PROJECT_DIR, OWNER_MARKER),
      `owned-by e2e/A5.live.spec.ts ${PROJECT_NAME}\n`,
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
        name: `A5 finishPlanning ${RUN_TS}`,
        autonomy: 'autonomous_after_discovery',
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
    runDir = predictRunDir(projectId);
  });

  test.afterAll(async () => {
    // Stop only if still non-terminal — avoids re-poisoning the in-memory abort registry on a
    // recycled run id after a prior clean stop (rowid reuse + requestRunAbort).
    if (runId != null) {
      try {
        const db = new Database(DB_PATH, { readonly: true });
        const row = db.prepare('SELECT phase, status FROM runs WHERE id = ?').get(runId) as any;
        db.close();
        const terminal =
          row &&
          (['complete', 'failed', 'blocked'].includes(String(row.phase)) ||
            ['complete', 'failed', 'paused'].includes(String(row.status)));
        if (!terminal) {
          await fetch(`${BASE}/api/runs/${runId}/stop`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: 'A5 live evidence capture complete' }),
          });
          // Give the in-process orchestrator a beat to clearRunAbort after RunAbortedError.
          await new Promise((r) => setTimeout(r, 2000));
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
      if (runDir && runDir.includes(BATCH_ID)) fs.rmSync(runDir, { recursive: true, force: true });
    } catch { /* best-effort */ }

    try {
      const markerPath = path.join(PROJECT_DIR, OWNER_MARKER);
      if (
        PROJECT_DIR.includes(`a5-validation-${RUN_TS}`) &&
        fs.existsSync(markerPath) &&
        fs.readFileSync(markerPath, 'utf8').includes(PROJECT_NAME)
      ) {
        fs.rmSync(PROJECT_DIR, { recursive: true, force: false });
      }
    } catch { /* leave orphan unique dir rather than widen blast radius */ }
  });

  test('planning-done advances cycle phase to implementation without human phase patch; board shows it', async ({
    page,
  }) => {
    test.setTimeout(150000);

    const health = await fetch(`${BASE}/health`);
    expect(health.ok).toBe(true);
    expect(BASE).toMatch(/127\.0\.0\.1:3110|localhost:3110/);

    // Baseline: cycle starts discovery; start-planning flips to planning (production).
    {
      const db = new Database(DB_PATH, { readonly: true });
      const row = db.prepare('SELECT phase FROM cycles WHERE id = ?').get(cycleId) as any;
      db.close();
      expect(row.phase).toBe('discovery');
    }

    // Simple north-star language so selectCoPlannerMode prefers planner (single-seat) when possible;
    // we still emit partner REVIEW-READY so deliberation path also unblocks.
    const startResp = await fetch(`${BASE}/api/cycles/${cycleId}/start-planning`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        batchId: BATCH_ID,
        prompt: 'Plan one small hello endpoint feature for this throwaway A5 proof cycle.',
      }),
    });
    const startData = await startResp.json();
    if (!startResp.ok) throw new Error(`start-planning failed: ${JSON.stringify(startData)}`);
    runId = startData.runId;
    expect(runId).toBeTruthy();
    expect(startData.cycleId).toBe(cycleId);

    // start-planning must have flipped discovery → planning (not a human overview PATCH).
    {
      const db = new Database(DB_PATH, { readonly: true });
      const row = db.prepare('SELECT phase FROM cycles WHERE id = ?').get(cycleId) as any;
      db.close();
      expect(row.phase).toBe('planning');
    }

    // Simulate plancore authoring (canonical docs + PLAN-READY) so the live gate can pass without
    // waiting on a full LLM. Phase advance still goes through production finishPlanning only.
    const driveDeadline = Date.now() + 90000;
    let drove = false;
    while (Date.now() < driveDeadline) {
      try {
        fs.mkdirSync(runDir, { recursive: true });
        fs.mkdirSync(cycleDir, { recursive: true });
        fs.writeFileSync(path.join(cycleDir, 'og-requirements.md'), VALID_OGREQ, 'utf8');
        fs.writeFileSync(path.join(cycleDir, 'plan.md'), VALID_PLAN_MD, 'utf8');
        // Also mirror into runDir if materialize has not yet run (belt-and-braces for gate poll).
        fs.writeFileSync(path.join(runDir, 'og-requirements.md'), VALID_OGREQ, 'utf8');
        fs.writeFileSync(path.join(runDir, 'plan.md'), VALID_PLAN_MD, 'utf8');
        const cbPath = path.join(runDir, 'callbacks.md');
        const line =
          `[helm callback] plancore ${BATCH_ID} STATUS: PLANNING — a5 live drive\n` +
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

    // Poll until production finishPlanning advances the board (no PATCH /api/cycles/:id/phase).
    let phase = 'planning';
    const phaseDeadline = Date.now() + 90000;
    while (Date.now() < phaseDeadline) {
      const db = new Database(DB_PATH, { readonly: true });
      const row = db.prepare('SELECT phase, awaiting_approval FROM cycles WHERE id = ?').get(cycleId) as any;
      db.close();
      phase = String(row?.phase || '');
      if (phase === 'implementation') {
        expect(Number(row.awaiting_approval || 0)).toBe(0);
        break;
      }
      // Keep re-appending PLAN-READY in case the gate polled before the first write.
      try {
        fs.appendFileSync(
          path.join(runDir, 'callbacks.md'),
          `[helm callback] plancore ${BATCH_ID} STATUS: PLAN-READY — a5 reassert\n` +
            `[helm callback] planner ${BATCH_ID}-partner STATUS: REVIEW-READY\n`,
          'utf8'
        );
        fs.writeFileSync(path.join(cycleDir, 'plan.md'), VALID_PLAN_MD, 'utf8');
        fs.writeFileSync(path.join(cycleDir, 'og-requirements.md'), VALID_OGREQ, 'utf8');
      } catch { /* run may still be creating dirs */ }
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(phase, 'cycle.phase never reached implementation via production finishPlanning').toBe(
      'implementation'
    );

    // Stop before implementer burns tokens on the throwaway task.
    try {
      await fetch(`${BASE}/api/runs/${runId}/stop`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'A5 live: stop after board advanced' }),
      });
    } catch { /* best-effort */ }

    // UI: overview board shows implementation for this cycle without human phase edit.
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

    // Capture board evidence BEFORE opening the card (opening leaves the overview).
    const cardText = (await card.innerText()).toLowerCase();
    expect(
      cardText.includes('implementation') || cardText.includes('implement'),
      `overview card should show implementation; text=${cardText.slice(0, 400)}`
    ).toBe(true);

    await page.screenshot({
      path: path.join(EVIDENCE_DIR, 'A5-board-advanced-unaided.png'),
      fullPage: true,
    });
    const aria = await page.getByTestId('ov-board').ariaSnapshot();
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'A5-board-aria-snapshot.yaml'), aria, 'utf8');
    fs.copyFileSync(
      path.join(EVIDENCE_DIR, 'A5-board-advanced-unaided.png'),
      path.join(PLAN_DIR_EVIDENCE, 'A5-board-advanced-unaided.png')
    );
    fs.copyFileSync(
      path.join(EVIDENCE_DIR, 'A5-board-aria-snapshot.yaml'),
      path.join(PLAN_DIR_EVIDENCE, 'A5-board-aria-snapshot.yaml')
    );

    // Also open workspace to confirm phase strip.
    await card.click();
    await expect(page.getByTestId('content-cmd-workspace')).toBeVisible({ timeout: 15000 });
    const workspace = page.getByTestId('content-cmd-workspace');
    const bodyText = (await workspace.innerText()).toLowerCase();
    expect(
      bodyText.includes('implementation') || bodyText.includes('implement'),
      `workspace should show implementation phase; got snippet=${bodyText.slice(0, 400)}`
    ).toBe(true);
  });
});
