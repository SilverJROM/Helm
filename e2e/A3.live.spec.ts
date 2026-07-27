import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

// A3 (R4.17 / SEAM-1) live proof on :3110 / cards2-ibrain.db via playwright.cap.config.ts only.
// Cycle-linked planning seats appear on GET /api/cycles/:id/seats (live + historical) and as a
// compact Planning seat list. Throwaway project only; scoped teardown (A1-RT-CRIT-1 lesson).
//
// A3-RT-CRIT: PROJECT_DIR is unique per run (matches PROJECT_NAME timestamp). Never use a shared
// fixed path like …/a3-validation — afterAll rmSync would delete real data if that path were reused.
// Teardown only removes the exact directory this test created (marker file ownership proof).

const BASE = process.env.HELM_BASE_URL || 'http://127.0.0.1:3110';
const CRED = process.env.HELM_OWNER_CRED || 'cards2-harness-563f750bebc23bba';
const DB_PATH = process.env.HELM_DB_PATH_LIVE || '/home/agjrom/websites/Helm/data/cards2-ibrain.db';
const RUN_TS = Date.now();
const PROJECT_NAME = `a3-validation-${RUN_TS}`;
const PROJECT_DIR = `/home/agjrom/websites/a3-validation-${RUN_TS}`;
const OWNER_MARKER = '.a3-live-owned';
const BATCH_ID = `a3-live-${RUN_TS}`;

const HELM_TMPDIR = process.env.HELM_TMPDIR_OVERRIDE || '/tmp/helm-harness';
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

test.describe('A3 live: SEAM-1 cycle seats + Planning compact list on :3110', () => {
  let token: string;
  let projectId: number;
  let cycleId: number;
  let runId: number | null = null;

  test.beforeAll(async () => {
    // Fail-fast if the unique dir already exists — never clobber / mass-delete foreign content.
    if (fs.existsSync(PROJECT_DIR)) {
      throw new Error(
        `A3 live refuse: PROJECT_DIR already exists (${PROJECT_DIR}). ` +
          `Refusing to reuse or delete a path this test did not create.`
      );
    }
    fs.mkdirSync(PROJECT_DIR, { recursive: false });
    fs.writeFileSync(
      path.join(PROJECT_DIR, OWNER_MARKER),
      `owned-by e2e/A3.live.spec.ts ${PROJECT_NAME}\n`,
      'utf8'
    );
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
      body: JSON.stringify({ name: `A3 seats ${Date.now()}` }),
    });
    const cycleData = await cycleResp.json();
    if (!cycleResp.ok) throw new Error(`cycle create failed: ${JSON.stringify(cycleData)}`);
    cycleId = cycleData.cycle.id;

    // Skip-interview seam: plan.json in predicted run dir (same as A1/A2).
    const runDir = predictRunDir(projectId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'plan.json'),
      JSON.stringify({ tasks: [{ task_key: 'A3V-1', atomic_work: 'throwaway task for A3 live evidence only' }] }, null, 2)
    );
  });

  test.afterAll(async () => {
    if (runId != null) {
      try {
        await fetch(`${BASE}/api/runs/${runId}/stop`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: 'A3 live evidence capture complete' }),
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
        await fetch(`${BASE}/api/projects/${projectId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch { /* best-effort */ }
    }

    // Only rm the exact unique dir this test created, and only with ownership marker present.
    // Never touch a shared fixed path (e.g. …/a3-validation without timestamp).
    try {
      const markerPath = path.join(PROJECT_DIR, OWNER_MARKER);
      if (
        PROJECT_DIR.includes(`a3-validation-${RUN_TS}`) &&
        fs.existsSync(markerPath) &&
        fs.readFileSync(markerPath, 'utf8').includes(PROJECT_NAME)
      ) {
        fs.rmSync(PROJECT_DIR, { recursive: true, force: false });
      }
    } catch { /* best-effort; leave orphan unique dir rather than widen blast radius */ }
  });

  test('cycle seats API returns live+historical; Planning seat list shows both', async ({ page }) => {
    test.setTimeout(150000);

    // Cycle-linked start so runs.cycle_id is set (required for SEAM-1 join).
    const startResp = await fetch(`${BASE}/api/cycles/${cycleId}/start-planning`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        batchId: BATCH_ID,
        prompt: 'Architecture note: A3 live evidence run — cross-module, high-risk security refactor ' +
          'requiring two independent reviewers to agree before any implementation proceeds (throwaway).',
      }),
    });
    const startData = await startResp.json();
    if (!startResp.ok) throw new Error(`start-planning failed: ${JSON.stringify(startData)}`);
    runId = startData.runId;
    expect(runId).toBeTruthy();
    expect(startData.cycleId).toBe(cycleId);

    // Poll SEAM-1 seats endpoint until both planning seats appear.
    let seats: any[] = [];
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const r = await fetch(`${BASE}/api/cycles/${cycleId}/seats`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(r.ok, `seats status ${r.status}`).toBe(true);
      const body = await r.json();
      seats = body.seats || [];
      if (seats.length >= 2) break;
      await new Promise((res) => setTimeout(res, 2000));
    }
    expect(seats.length, `expected >=2 seats, got ${JSON.stringify(seats)}`).toBeGreaterThanOrEqual(2);
    for (const s of seats) {
      expect(s.cycleId).toBe(cycleId);
      expect(s.runId).toBe(runId);
      expect(typeof s.id).toBe('number');
      expect(s.role).toBeTruthy();
      expect(s.model).toBeTruthy();
    }

    // Force one historical (reaped) so the list shows live + historical chips together.
    const historicalId = seats[seats.length - 1].id;
    const liveCandidateId = seats[0].id;
    const db = new Database(DB_PATH);
    db.prepare(
      `UPDATE worker_runtimes SET state='reaped', ended_at=datetime('now') WHERE id=?`
    ).run(historicalId);
    db.close();

    const r2 = await fetch(`${BASE}/api/cycles/${cycleId}/seats`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body2 = await r2.json();
    seats = body2.seats || [];
    const hist = seats.find((s: any) => s.id === historicalId);
    expect(hist, 'reaped seat must still be returned').toBeTruthy();
    expect(hist.live).toBe(false);
    expect(hist.state).toBe('reaped');

    // Path-safety: foreign runtime id rejected; session query never accepted as target.
    const foreignCap = await fetch(
      `${BASE}/api/cycles/${cycleId}/seats/999999999?session=evil-attacker-session`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    expect(foreignCap.status).toBe(404);

    const ownCap = await fetch(
      `${BASE}/api/cycles/${cycleId}/seats/${liveCandidateId}?session=evil-attacker-session&sessionName=evil`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    expect(ownCap.ok).toBe(true);
    const capBody = await ownCap.json();
    expect(capBody.session).not.toBe('evil-attacker-session');
    expect(capBody.session).not.toBe('evil');

    // UI: Command Center Overview (slug 07-command-center-overview) → cycle card → Planning tab.
    await page.goto(`${BASE}/`);
    await page.locator('input[placeholder="owner credential"]').fill(CRED);
    await page.click('button:has-text("Login")');
    await page.getByTestId('nav-project-setup').waitFor({ state: 'visible', timeout: 15000 });

    await page.goto(`${BASE}/#07-command-center-overview`);
    await expect(page.getByTestId('ov-board')).toBeVisible({ timeout: 15000 });
    // Prefer Active bucket (start-planning flips phase→planning; status active).
    const activeTab = page.getByTestId('ov-tab-active');
    if (await activeTab.count()) await activeTab.click();
    // Poll refresh: overview loads on slug entry; card may appear after cycle is active.
    let cardVisible = false;
    const uiDeadline = Date.now() + 25000;
    while (Date.now() < uiDeadline) {
      const card = page.getByTestId(`ov-card-${projectId}`);
      if (await card.count() && await card.isVisible()) {
        cardVisible = true;
        await card.click();
        break;
      }
      // Also try pending bucket if not yet promoted.
      const pendingTab = page.getByTestId('ov-tab-pending');
      if (await pendingTab.count()) {
        await pendingTab.click();
        const pCard = page.getByTestId(`ov-card-${projectId}`);
        if (await pCard.count() && await pCard.isVisible()) {
          cardVisible = true;
          await pCard.click();
          break;
        }
        await activeTab.click();
      }
      await page.reload();
      await page.goto(`${BASE}/#07-command-center-overview`);
      await expect(page.getByTestId('ov-board')).toBeVisible({ timeout: 10000 });
      await new Promise((r) => setTimeout(r, 1500));
    }
    expect(cardVisible, `ov-card-${projectId} not found on overview active/pending`).toBe(true);
    await expect(page.getByTestId('content-cmd-workspace')).toBeVisible({ timeout: 15000 });
    await page.getByTestId('ws-tab-planning').click();
    await expect(page.getByTestId('ws-plan-seats-block')).toBeVisible({ timeout: 15000 });

    // Wait for seats poll to fill the list.
    const seatsList = page.getByTestId('ws-plan-seats');
    await expect(seatsList).toBeVisible({ timeout: 20000 });

    const histRow = page.getByTestId(`ws-plan-seat-${historicalId}`);
    await expect(histRow).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId(`ws-plan-seat-historical-${historicalId}`)).toBeVisible();

    // At least one other seat row present (live or historical depending on tmux).
    const other = seats.find((s: any) => s.id !== historicalId);
    if (other) {
      await expect(page.getByTestId(`ws-plan-seat-${other.id}`)).toBeVisible();
      if (other.live) {
        await expect(page.getByTestId(`ws-plan-seat-live-${other.id}`)).toBeVisible();
      }
    }

    fs.mkdirSync('validation/A3', { recursive: true });
    fs.mkdirSync('plan/helm-ux-remediation/validation/A3', { recursive: true });
    await page.screenshot({ path: 'validation/A3/A3-planning-seats-live-historical.png', fullPage: true });
    const ariaSnapshot = await page.getByTestId('ws-plan-seats-block').ariaSnapshot();
    fs.writeFileSync('validation/A3/A3-planning-seats-aria-snapshot.yaml', ariaSnapshot);
    fs.copyFileSync(
      'validation/A3/A3-planning-seats-live-historical.png',
      'plan/helm-ux-remediation/validation/A3/A3-planning-seats-live-historical.png'
    );
    fs.copyFileSync(
      'validation/A3/A3-planning-seats-aria-snapshot.yaml',
      'plan/helm-ux-remediation/validation/A3/A3-planning-seats-aria-snapshot.yaml'
    );
  });
});
