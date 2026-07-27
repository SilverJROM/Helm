import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

// B4 (R1.1 / R5.19 / R5.20 / R5.21) live proof on :3110 / cards2-ibrain.db via playwright.cap.config.ts.
// Planning tab renders one shared B3 pane per SEAM-1 seat (keyed by worker_runtimes.id).
// Pane count follows seats (2 default, 3 when three rows recorded). Docs + task table remain.
// Throwaway project; scoped teardown. Seeds seats (A3/A4 class) to fit 180s without cold-spawn.

const BASE = process.env.HELM_BASE_URL || 'http://127.0.0.1:3110';
const CRED = process.env.HELM_OWNER_CRED || 'cards2-harness-563f750bebc23bba';
const DB_PATH = process.env.HELM_DB_PATH_LIVE || '/home/agjrom/websites/Helm/data/cards2-ibrain.db';
const RUN_TS = Date.now();
const PROJECT_NAME = `b4-validation-${RUN_TS}`;
const PROJECT_DIR = `/home/agjrom/websites/b4-validation-${RUN_TS}`;
const OWNER_MARKER = '.b4-live-owned';
const BATCH_ID = `b4-live-${RUN_TS}`;
const EVIDENCE_DIR = path.join(process.cwd(), 'validation', 'B4');
const PLAN_DIR_EVIDENCE = path.join(process.cwd(), 'plan', 'helm-ux-remediation', 'validation', 'B4');

const VALID_PLAN_MD =
  '# Plan\n\n```json\n[{"id":"T1","batch":"B4","title":"B4 planning panes proof","req_refs":["R5.19"],"assignee":"grok-4.5","validator_lane":"L2","effort":"low","type":"feature"},{"id":"T2","batch":"B4","title":"B4 second task row","req_refs":["R5.21"],"assignee":"grok-4.5","validator_lane":"L2","effort":"low","type":"feature"}]\n```\n';
const VALID_OGREQ = '# Requirements\n\n- **R5.19** — Planning shows live co-planner panes.\n- **R5.21** — docs + task table remain.\n';
const VALID_NS = '# North star\n\nB4 throwaway: SEAM-1 planning panes.\n';

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

function seedSeats(
  projectId: number,
  cycleId: number,
  seats: Array<{ role: string; model: string; provider: string; live: boolean }>
): { runId: number; seatIds: number[] } {
  const db = new Database(DB_PATH);
  try {
    const info = db
      .prepare(
        `INSERT INTO runs (project_id, cycle_id, batch_id, north_star_ref, status, phase)
         VALUES (?, ?, ?, NULL, 'active', 'planning')`
      )
      .run(projectId, cycleId, BATCH_ID);
    const runId = Number(info.lastInsertRowid);
    const seatIds: number[] = [];
    const ins = db.prepare(
      `INSERT INTO worker_runtimes (project_id, role, provider, model, session, correlation_id, state, spawned_by, run_id, started_at, ended_at)
       VALUES (?,?,?,?,?,?,?,?,?, datetime('now'), ?)`
    );
    for (let i = 0; i < seats.length; i++) {
      const s = seats[i];
      const state = s.live ? 'running' : 'reaped';
      const session = s.live ? `helm-b4-${RUN_TS}-${i}` : `helm-b4-hist-${RUN_TS}-${i}`;
      const ended = s.live ? null : new Date().toISOString().slice(0, 19).replace('T', ' ');
      const r = ins.run(
        projectId,
        s.role,
        s.provider,
        s.model,
        session,
        `${BATCH_ID}-${s.role}`,
        state,
        'b4-live-seed',
        runId,
        ended
      );
      seatIds.push(Number(r.lastInsertRowid));
    }
    // Optional run_tasks so plan table can show DB rows if cycle run-state loads them
    try {
      db.prepare(
        `INSERT INTO run_tasks (run_id, task_key, label, status, batch)
         VALUES (?, 'T1', 'B4 planning panes proof', 'pending', 'B4')`
      ).run(runId);
      db.prepare(
        `INSERT INTO run_tasks (run_id, task_key, label, status, batch)
         VALUES (?, 'T2', 'B4 second task row', 'pending', 'B4')`
      ).run(runId);
    } catch {
      /* schema may differ slightly — panes proof does not require tasks */
    }
    return { runId, seatIds };
  } finally {
    db.close();
  }
}

function clearSeats(runId: number) {
  const db = new Database(DB_PATH);
  try {
    db.prepare('DELETE FROM worker_runtimes WHERE run_id = ?').run(runId);
    db.prepare('DELETE FROM run_tasks WHERE run_id = ?').run(runId);
    db.prepare('DELETE FROM runs WHERE id = ?').run(runId);
  } finally {
    db.close();
  }
}

test.describe('B4 live: Planning SEAM-1 panes on :3110', () => {
  let token: string;
  let projectId: number;
  let cycleId: number;
  let cycleDir = '';
  let runId: number | null = null;
  let seatIds: number[] = [];

  test.beforeAll(async () => {
    if (fs.existsSync(PROJECT_DIR)) {
      throw new Error(
        `B4 live refuse: PROJECT_DIR already exists (${PROJECT_DIR}). ` +
          `Refusing to reuse or delete a path this test did not create.`
      );
    }
    fs.mkdirSync(PROJECT_DIR, { recursive: false });
    fs.writeFileSync(
      path.join(PROJECT_DIR, OWNER_MARKER),
      `owned-by e2e/B4.live.spec.ts ${PROJECT_NAME}\n`,
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
      body: JSON.stringify({ name: `B4 panes ${RUN_TS}` }),
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
        clearSeats(runId);
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
      const markerPath = path.join(PROJECT_DIR, OWNER_MARKER);
      if (
        PROJECT_DIR.includes(`b4-validation-${RUN_TS}`) &&
        fs.existsSync(markerPath) &&
        fs.readFileSync(markerPath, 'utf8').includes(PROJECT_NAME)
      ) {
        fs.rmSync(PROJECT_DIR, { recursive: true, force: false });
      }
    } catch { /* leave orphan */ }
  });

  async function openPlanning(page: import('@playwright/test').Page) {
    await page.goto(`${BASE}/`);
    // Skip login if session cookie already authenticated (reload / second phase).
    const cred = page.locator('input[placeholder="owner credential"]');
    if (await cred.count()) {
      try {
        await cred.fill(CRED, { timeout: 5000 });
        await page.click('button:has-text("Login")');
      } catch { /* already past login */ }
    }
    await page.getByTestId('nav-project-setup').waitFor({ state: 'visible', timeout: 20000 });
    await page.goto(`${BASE}/#07-command-center-overview`);
    await expect(page.getByTestId('ov-board')).toBeVisible({ timeout: 15000 });
    const card = page.getByTestId(`ov-card-${projectId}`);
    await expect(card).toBeVisible({ timeout: 15000 });
    await card.click();
    await expect(page.getByTestId('content-cmd-workspace')).toBeVisible({ timeout: 15000 });
    const planTab = page.getByTestId('ws-tab-planning');
    if (await planTab.count()) await planTab.click();
    // Ensure watch-live open (default true post-B4)
    const toggle = page.getByTestId('ws-plan-watch-live-toggle');
    if (await toggle.count()) {
      const t = await toggle.innerText();
      if (/watch live/i.test(t)) await toggle.click();
    }
  }

  function appendSeat(opts: {
    projectId: number;
    runId: number;
    role: string;
    model: string;
    provider: string;
  }): number {
    const db = new Database(DB_PATH);
    try {
      const r = db
        .prepare(
          `INSERT INTO worker_runtimes (project_id, role, provider, model, session, correlation_id, state, spawned_by, run_id, started_at, ended_at)
           VALUES (?,?,?,?,?,?,'reaped','b4-live-seed',?, datetime('now'), datetime('now'))`
        )
        .run(
          opts.projectId,
          opts.role,
          opts.provider,
          opts.model,
          `helm-b4-extra-${RUN_TS}`,
          `${BATCH_ID}-extra`,
          opts.runId
        );
      return Number(r.lastInsertRowid);
    } finally {
      db.close();
    }
  }

  test('2 panes then 3 panes; docs + task table present; path-safe seats API', async ({ page }) => {
    test.setTimeout(170000);
    const t0 = Date.now();
    const mark = (label: string) => console.log(`[B4.live timing] ${label} at +${Date.now() - t0}ms`);

    const health = await fetch(`${BASE}/health`);
    expect(health.ok).toBe(true);
    expect(BASE).toMatch(/127\.0\.0\.1:3110|localhost:3110/);

    // --- Seed 2 seats (default panel size / R1.1 half): plancore + partner-shaped roles ---
    // Models: prefer cross-family labels when available; harness may record grok — count is the hard contract.
    const seeded2 = seedSeats(projectId, cycleId, [
      { role: 'plancore', model: 'opus', provider: 'claude', live: false },
      { role: 'deliberation', model: 'sol', provider: 'xai', live: false },
    ]);
    runId = seeded2.runId;
    seatIds = seeded2.seatIds;
    mark(`seeded 2 seats run=${runId} ids=${seatIds.join(',')}`);

    // API: seats list length 2 + run/cycle linkage
    const seatsResp = await fetch(`${BASE}/api/cycles/${cycleId}/seats`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(seatsResp.ok).toBe(true);
    const seatsData = await seatsResp.json();
    expect(seatsData.seats.length).toBe(2);
    expect(seatsData.seats.every((s: any) => Number(s.cycleId) === cycleId)).toBe(true);
    expect(seatsData.seats.every((s: any) => Number(s.runId) === runId)).toBe(true);

    // Path-safety: foreign runtime id must not capture under this cycle
    const foreign = await fetch(`${BASE}/api/cycles/${cycleId}/seats/999999999`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(foreign.status).toBe(404);
    const evil = await fetch(
      `${BASE}/api/cycles/${cycleId}/seats/${seatIds[0]}?session=evil-attacker&sessionName=evil-attacker`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    expect(evil.ok).toBe(true);
    const evilBody = await evil.json();
    expect(String(evilBody.session || '')).not.toBe('evil-attacker');

    await openPlanning(page);
    mark('planning open (2 panes)');

    await expect(page.getByTestId('ws-plan-panes')).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('ws-plan-panes')).toHaveAttribute('data-pane-count', '2');
    for (const id of seatIds) {
      await expect(page.getByTestId(`ws-plan-pane-${id}`)).toBeVisible();
      await expect(page.getByTestId(`ws-plan-pane-historical-${id}`)).toBeVisible();
    }
    // R5.21: docs + task surface remain
    await expect(page.getByTestId('ws-plan-docs')).toBeVisible();
    const tableOrEmpty = page.getByTestId('ws-plan-table').or(page.getByTestId('ws-plan-table-empty'));
    await expect(tableOrEmpty.first()).toBeVisible({ timeout: 10000 });

    await page.screenshot({
      path: path.join(EVIDENCE_DIR, 'B4-planning-two-panes.png'),
      fullPage: true,
    });
    fs.copyFileSync(
      path.join(EVIDENCE_DIR, 'B4-planning-two-panes.png'),
      path.join(PLAN_DIR_EVIDENCE, 'B4-planning-two-panes.png')
    );
    const aria2 = await page.locator('body').ariaSnapshot();
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'B4-two-panes-aria-snapshot.yaml'), aria2, 'utf8');
    fs.writeFileSync(path.join(PLAN_DIR_EVIDENCE, 'B4-two-panes-aria-snapshot.yaml'), aria2, 'utf8');
    mark('2-pane evidence');

    // --- Expand to 3 seats (A10 panel size 3 shape): append third seat on same run ---
    const thirdId = appendSeat({
      projectId,
      runId: runId!,
      role: 'deliberation',
      model: 'grok-4.5',
      provider: 'grok',
    });
    seatIds = [...seatIds, thirdId];
    mark(`appended 3rd seat id=${thirdId}`);

    // Stay on Planning tab — seats poll every ~4s will pick up the third worker_runtimes row.
    await expect
      .poll(
        async () => {
          const r = await fetch(`${BASE}/api/cycles/${cycleId}/seats`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          const d = await r.json();
          return (d.seats || []).length;
        },
        { timeout: 15000 }
      )
      .toBe(3);

    // UI poll lags seats fetch by up to ~4s
    await expect
      .poll(async () => page.getByTestId('ws-plan-panes').getAttribute('data-pane-count'), {
        timeout: 25000,
      })
      .toBe('3');
    for (const id of seatIds) {
      await expect(page.getByTestId(`ws-plan-pane-${id}`)).toBeVisible({ timeout: 10000 });
    }
    await expect(page.getByTestId('ws-plan-docs')).toBeVisible();

    await page.screenshot({
      path: path.join(EVIDENCE_DIR, 'B4-planning-three-panes.png'),
      fullPage: true,
    });
    fs.copyFileSync(
      path.join(EVIDENCE_DIR, 'B4-planning-three-panes.png'),
      path.join(PLAN_DIR_EVIDENCE, 'B4-planning-three-panes.png')
    );
    const aria3 = await page.locator('body').ariaSnapshot();
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'B4-three-panes-aria-snapshot.yaml'), aria3, 'utf8');
    fs.writeFileSync(path.join(PLAN_DIR_EVIDENCE, 'B4-three-panes-aria-snapshot.yaml'), aria3, 'utf8');
    mark('3-pane evidence done');
  });
});
