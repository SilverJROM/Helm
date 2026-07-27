import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

// A4 (R4.18) live proof on :3110 / cards2-ibrain.db via playwright.cap.config.ts only.
// Surfaces step-level run_events trail (type + timestamp) — not full transcripts.
// Throwaway project only; scoped teardown (A1/A3 lessons — unique owned path, marker proof).

const BASE = process.env.HELM_BASE_URL || 'http://127.0.0.1:3110';
const CRED = process.env.HELM_OWNER_CRED || 'cards2-harness-563f750bebc23bba';
const DB_PATH = process.env.HELM_DB_PATH_LIVE || '/home/agjrom/websites/Helm/data/cards2-ibrain.db';
const RUN_TS = Date.now();
const PROJECT_NAME = `a4-validation-${RUN_TS}`;
const PROJECT_DIR = `/home/agjrom/websites/a4-validation-${RUN_TS}`;
const OWNER_MARKER = '.a4-live-owned';
const BATCH_ID = `a4-live-${RUN_TS}`;

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

test.describe('A4 live: step-level event trail on :3110', () => {
  let token: string;
  let projectId: number;
  let cycleId: number;
  let runId: number | null = null;

  test.beforeAll(async () => {
    if (fs.existsSync(PROJECT_DIR)) {
      throw new Error(
        `A4 live refuse: PROJECT_DIR already exists (${PROJECT_DIR}). ` +
          `Refusing to reuse or delete a path this test did not create.`
      );
    }
    fs.mkdirSync(PROJECT_DIR, { recursive: false });
    fs.writeFileSync(
      path.join(PROJECT_DIR, OWNER_MARKER),
      `owned-by e2e/A4.live.spec.ts ${PROJECT_NAME}\n`,
      'utf8'
    );
    // Intentionally NO plan.md — trail must not depend on it.
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
      body: JSON.stringify({ name: `A4 events ${Date.now()}` }),
    });
    const cycleData = await cycleResp.json();
    if (!cycleResp.ok) throw new Error(`cycle create failed: ${JSON.stringify(cycleData)}`);
    cycleId = cycleData.cycle.id;

    // Seed a completed cycle-linked run + ordered run_events via live DB (surfacing proof).
    // Uses cards2-ibrain.db only — never helm.db.
    const db = new Database(DB_PATH);
    try {
      const info = db
        .prepare(
          `INSERT INTO runs (project_id, cycle_id, batch_id, north_star_ref, status, phase)
           VALUES (?, ?, ?, NULL, 'complete', 'complete')`
        )
        .run(projectId, cycleId, BATCH_ID);
      runId = Number(info.lastInsertRowid);
      // Unique far-future timestamps per live run so our 3 events sort last even when
      // runs.id is recycled and append-only orphans remain from prior A1/A4 seeds.
      // Use year 2999 + RUN_TS seconds so we beat any prior 2099 seed leftovers.
      const ins = db.prepare(
        `INSERT INTO run_events (run_id, batch_id, event_type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?)`
      );
      const pad = (n: number) => String(n).padStart(2, '0');
      const stamp = (secOffset: number) => {
        const sec = Math.floor(RUN_TS / 1000) + secOffset;
        const h = Math.floor(sec / 3600) % 24;
        const m = Math.floor(sec / 60) % 60;
        const s = sec % 60;
        const day = (Math.floor(sec / 86400) % 28) + 1;
        return `2999-06-${pad(day)} ${pad(h)}:${pad(m)}:${pad(s)}`;
      };
      ins.run(String(runId), BATCH_ID, 'REGISTERED', JSON.stringify({ role: 'system', reason: 'a4-live-seed' }), stamp(1));
      ins.run(
        String(runId),
        BATCH_ID,
        'CALLBACK_WAIT_RESULT',
        JSON.stringify({ role: 'plancore', outcome: 'callback', provider: 'grok' }),
        stamp(2)
      );
      ins.run(String(runId), BATCH_ID, 'TERMINAL', JSON.stringify({ outcome: 'complete', reason: 'a4-live' }), stamp(3));
    } finally {
      db.close();
    }
  });

  test.afterAll(async () => {
    try {
      const db = new Database(DB_PATH);
      if (runId != null) {
        // run_events is append-only with DELETE trigger — drop via direct only if needed.
        // Triggers block DELETE; leave orphan events for this throwaway run_id (harmless)
        // OR use a transaction that disables triggers — SQLite can't easily. Leave events.
        db.prepare('DELETE FROM worker_runtimes WHERE run_id = ?').run(runId);
        db.prepare('DELETE FROM helm_sessions WHERE run_id = ?').run(runId);
        // runs can be deleted; events may remain orphaned — acceptable for throwaway evidence run.
        try {
          db.prepare('DELETE FROM runs WHERE id = ?').run(runId);
        } catch { /* FK / triggers may block; best-effort */ }
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
      const markerPath = path.join(PROJECT_DIR, OWNER_MARKER);
      if (
        PROJECT_DIR.includes(`a4-validation-${RUN_TS}`) &&
        fs.existsSync(markerPath) &&
        fs.readFileSync(markerPath, 'utf8').includes(PROJECT_NAME)
      ) {
        fs.rmSync(PROJECT_DIR, { recursive: true, force: false });
      }
    } catch { /* leave orphan unique dir rather than widen blast radius */ }
  });

  test('completed run event trail API + Planning UI on :3110', async ({ page }) => {
    test.setTimeout(120000);

    // Confirm live target (cap config baseURL must be :3110 — also assert health).
    const health = await fetch(`${BASE}/health`);
    expect(health.ok).toBe(true);
    expect(BASE).toMatch(/127\.0\.0\.1:3110|localhost:3110/);

    // API: ordered type + timestamp, plan.md absent.
    expect(fs.existsSync(path.join(PROJECT_DIR, 'plan.md'))).toBe(false);
    const evResp = await fetch(`${BASE}/api/cycles/${cycleId}/events`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(evResp.ok, `events status ${evResp.status}`).toBe(true);
    const evBody = await evResp.json();
    expect(evBody.hasRun).toBe(true);
    expect(evBody.runId).toBe(runId);
    expect(Array.isArray(evBody.events)).toBe(true);
    expect(evBody.events.length).toBeGreaterThanOrEqual(3);
    // Scope to this throwaway batch — recycled run ids may still carry orphan append-only events.
    const mine = evBody.events.filter((e: any) => e.batchId === BATCH_ID);
    expect(mine.map((e: any) => e.type)).toEqual(['REGISTERED', 'CALLBACK_WAIT_RESULT', 'TERMINAL']);
    // Full trail remains time-ordered (created_at ASC, id ASC).
    for (let i = 1; i < evBody.events.length; i++) {
      const a = evBody.events[i - 1];
      const b = evBody.events[i];
      const cmp = String(a.createdAt).localeCompare(String(b.createdAt));
      if (cmp === 0) expect(a.id).toBeLessThan(b.id);
      else expect(cmp).toBeLessThan(0);
    }
    for (const e of mine) {
      expect(e.type).toBeTruthy();
      expect(e.createdAt).toBeTruthy();
      // Not a full transcript
      expect(String(e.summary || '').length).toBeLessThan(300);
    }

    // Confirm overview API lists this cycle (active status) before UI drive.
    const ovApi = await fetch(`${BASE}/api/cycles/overview`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(ovApi.ok).toBe(true);
    const ovBody = await ovApi.json();
    const ovHit = [...(ovBody.active || []), ...(ovBody.pending || [])].find(
      (r: any) => r.project_id === projectId || r.id === cycleId
    );
    expect(ovHit, `overview API missing project ${projectId} cycle ${cycleId}`).toBeTruthy();

    // UI: Overview → cycle card → Planning → Event trail.
    // Note: completed bucket uses ov-hist-row-*, not ov-card-*; stay on active/pending.
    await page.goto(`${BASE}/`);
    await page.locator('input[placeholder="owner credential"]').fill(CRED);
    await page.click('button:has-text("Login")');
    await page.getByTestId('nav-project-setup').waitFor({ state: 'visible', timeout: 15000 });

    await page.goto(`${BASE}/#07-command-center-overview`);
    await expect(page.getByTestId('ov-board')).toBeVisible({ timeout: 15000 });
    const activeTab = page.getByTestId('ov-tab-active');
    if (await activeTab.count()) await activeTab.click();

    let cardVisible = false;
    const uiDeadline = Date.now() + 30000;
    while (Date.now() < uiDeadline) {
      if (await activeTab.count()) await activeTab.click();
      const card = page.getByTestId(`ov-card-${projectId}`);
      if (await card.count() && await card.isVisible()) {
        cardVisible = true;
        await card.click();
        break;
      }
      const pendingTab = page.getByTestId('ov-tab-pending');
      if (await pendingTab.count()) {
        await pendingTab.click();
        const pCard = page.getByTestId(`ov-card-${projectId}`);
        if (await pCard.count() && await pCard.isVisible()) {
          cardVisible = true;
          await pCard.click();
          break;
        }
      }
      // Name fallback on active bucket (card title).
      if (await activeTab.count()) await activeTab.click();
      const byName = page.getByTestId('ov-card-name').filter({ hasText: PROJECT_NAME });
      if (await byName.count()) {
        await byName.first().click();
        cardVisible = true;
        break;
      }
      await page.reload();
      await page.goto(`${BASE}/#07-command-center-overview`);
      await expect(page.getByTestId('ov-board')).toBeVisible({ timeout: 10000 });
      await new Promise((r) => setTimeout(r, 1500));
    }
    expect(cardVisible, `ov-card-${projectId} not found on overview active/pending`).toBe(true);
    await expect(page.getByTestId('content-cmd-workspace')).toBeVisible({ timeout: 15000 });
    await page.getByTestId('ws-tab-planning').click();
    await expect(page.getByTestId('ws-plan-event-trail-block')).toBeVisible({ timeout: 15000 });

    const trail = page.getByTestId('ws-plan-event-trail');
    await expect(trail).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId('ws-plan-event-1')).toBeVisible();
    await expect(page.getByTestId('ws-plan-event-ts-1')).not.toBeEmpty();
    // Our late-timestamp seed must appear as the last three steps (type labels in the list).
    await expect(trail).toContainText('REGISTERED');
    await expect(trail).toContainText('CALLBACK_WAIT_RESULT');
    await expect(trail).toContainText('TERMINAL');
    const lastThreeTypes = await page.locator('[data-testid^="ws-plan-event-type-"]').evaluateAll((els) =>
      els.slice(-3).map((el) => (el.textContent || '').trim())
    );
    expect(lastThreeTypes).toEqual(['REGISTERED', 'CALLBACK_WAIT_RESULT', 'TERMINAL']);

    fs.mkdirSync('validation/A4', { recursive: true });
    fs.mkdirSync('plan/helm-ux-remediation/validation/A4', { recursive: true });
    await page.screenshot({ path: 'validation/A4/A4-event-trail-completed-run.png', fullPage: true });
    fs.copyFileSync(
      'validation/A4/A4-event-trail-completed-run.png',
      'plan/helm-ux-remediation/validation/A4/A4-event-trail-completed-run.png'
    );
    const aria = await page.locator('[data-testid="ws-plan-event-trail-block"]').ariaSnapshot();
    fs.writeFileSync('validation/A4/A4-event-trail-aria-snapshot.yaml', aria, 'utf8');
    fs.writeFileSync(
      'plan/helm-ux-remediation/validation/A4/A4-event-trail-aria-snapshot.yaml',
      aria,
      'utf8'
    );
  });
});
