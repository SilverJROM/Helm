import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';

// B4 attempt=2 — close B4-RT-HIGH-1..4 on :3110 / cards2-ibrain.db via playwright.cap.config.ts.
// HIGH-1: ≥1 tmux-alive running worker_runtime; API capture content rendered in pane payload.
// HIGH-2: data-live-pane-count separate from data-pane-count; fail if only historical satisfies count.
// HIGH-3: foreign cycle real runtimeId → 404; evil session query on live runtime ignored.
// HIGH-4: scroll up on live pane body; after poll, scrollTop preserved.

const BASE = process.env.HELM_BASE_URL || 'http://127.0.0.1:3110';
const CRED = process.env.HELM_OWNER_CRED || 'cards2-harness-563f750bebc23bba';
const DB_PATH = process.env.HELM_DB_PATH_LIVE || '/home/agjrom/websites/Helm/data/cards2-ibrain.db';
const RUN_TS = Date.now();
const PROJECT_NAME = `b4-validation-${RUN_TS}`;
const PROJECT_DIR = `/home/agjrom/websites/b4-validation-${RUN_TS}`;
const OWNER_MARKER = '.b4-live-owned';
const BATCH_ID = `b4-live-${RUN_TS}`;
const LIVE_SESSION = `helm-b4-live-${RUN_TS}`;
const LIVE_MARKER = `B4_LIVE_MARKER_${RUN_TS}`;
const EVIDENCE_DIR = path.join(process.cwd(), 'validation', 'B4');
const PLAN_DIR_EVIDENCE = path.join(process.cwd(), 'plan', 'helm-ux-remediation', 'validation', 'B4');

const VALID_PLAN_MD =
  '# Plan\n\n```json\n[{"id":"T1","batch":"B4","title":"B4 planning panes proof","req_refs":["R5.19"],"assignee":"grok-4.5","validator_lane":"L2","effort":"low","type":"feature"},{"id":"T2","batch":"B4","title":"B4 second task row","req_refs":["R5.21"],"assignee":"grok-4.5","validator_lane":"L2","effort":"low","type":"feature"}]\n```\n';
const VALID_OGREQ = '# Requirements\n\n- **R5.19** — Planning shows live co-planner panes.\n';
const VALID_NS = '# North star\n\nB4 attempt=2 live panes proof.\n';

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

function tmux(args: string[]) {
  execFileSync('tmux', args, { stdio: 'pipe' });
}

/** Create a real tmux session with multi-line payload (scrollable) containing LIVE_MARKER. */
function createLiveTmuxSession(): void {
  try {
    tmux(['kill-session', '-t', LIVE_SESSION]);
  } catch {
    /* none */
  }
  tmux(['new-session', '-d', '-s', LIVE_SESSION]);
  tmux(['set-option', '-t', LIVE_SESSION, '@helm_child', '1']);
  // Fill pane with many lines so body is scrollable, then the unique marker.
  const lines = [
    '#!/bin/sh',
    'echo "B4 live pane seed"',
    ...Array.from({ length: 40 }, (_, i) => `echo "line ${i} filler for scroll"`),
    `echo "${LIVE_MARKER}"`,
    `printf '%s\\n' "${LIVE_MARKER}"`,
  ].join('\n');
  // Use cat via shell so capturePane sees the marker text in history.
  const script = `for i in $(seq 1 45); do echo "b4-scroll-line-$i"; done; echo "${LIVE_MARKER}"; echo "done ${LIVE_MARKER}"`;
  tmux(['send-keys', '-t', `${LIVE_SESSION}:0.0`, script, 'Enter']);
  // Give bash a beat to print
  execFileSync('sleep', ['0.4']);
}

function killLiveTmuxSession(): void {
  try {
    tmux(['kill-session', '-t', LIVE_SESSION]);
  } catch {
    /* best-effort */
  }
}

function seedMix(opts: {
  projectId: number;
  cycleId: number;
  liveSession: string;
}): { runId: number; liveSeatId: number; histSeatId: number; seatIds: number[] } {
  const db = new Database(DB_PATH);
  try {
    const info = db
      .prepare(
        `INSERT INTO runs (project_id, cycle_id, batch_id, north_star_ref, status, phase)
         VALUES (?, ?, ?, NULL, 'active', 'planning')`
      )
      .run(opts.projectId, opts.cycleId, BATCH_ID);
    const runId = Number(info.lastInsertRowid);

    // Live seat: running + real tmux session (HIGH-1)
    const live = db
      .prepare(
        `INSERT INTO worker_runtimes (project_id, role, provider, model, session, correlation_id, state, spawned_by, run_id, started_at, ended_at)
         VALUES (?,?,?,?,?,?,'running','b4-live-seed',?, datetime('now'), NULL)`
      )
      .run(
        opts.projectId,
        'plancore',
        'claude',
        'opus',
        opts.liveSession,
        `${BATCH_ID}-plancore`,
        runId
      );
    const liveSeatId = Number(live.lastInsertRowid);

    // Historical seat: reaped (honest non-live; must not alone satisfy live contract)
    const hist = db
      .prepare(
        `INSERT INTO worker_runtimes (project_id, role, provider, model, session, correlation_id, state, spawned_by, run_id, started_at, ended_at)
         VALUES (?,?,?,?,?,?,'reaped','b4-live-seed',?, datetime('now'), datetime('now'))`
      )
      .run(
        opts.projectId,
        'deliberation',
        'xai',
        'sol',
        `helm-b4-hist-${RUN_TS}`,
        `${BATCH_ID}-partner`,
        runId
      );
    const histSeatId = Number(hist.lastInsertRowid);

    try {
      db.prepare(
        `INSERT INTO run_tasks (run_id, task_key, label, status, batch) VALUES (?, 'T1', 'B4 proof', 'pending', 'B4')`
      ).run(runId);
      db.prepare(
        `INSERT INTO run_tasks (run_id, task_key, label, status, batch) VALUES (?, 'T2', 'B4 row2', 'pending', 'B4')`
      ).run(runId);
    } catch {
      /* optional */
    }

    return { runId, liveSeatId, histSeatId, seatIds: [liveSeatId, histSeatId] };
  } finally {
    db.close();
  }
}

function appendHistoricalSeat(projectId: number, runId: number): number {
  const db = new Database(DB_PATH);
  try {
    const r = db
      .prepare(
        `INSERT INTO worker_runtimes (project_id, role, provider, model, session, correlation_id, state, spawned_by, run_id, started_at, ended_at)
         VALUES (?,?,?,?,?,?,'reaped','b4-live-seed',?, datetime('now'), datetime('now'))`
      )
      .run(
        projectId,
        'deliberation',
        'grok',
        'grok-4.5',
        `helm-b4-extra-${RUN_TS}`,
        `${BATCH_ID}-extra`,
        runId
      );
    return Number(r.lastInsertRowid);
  } finally {
    db.close();
  }
}

function seedForeignCycle(projectId: number): { cycleId: number; runtimeId: number; runId: number } {
  const db = new Database(DB_PATH);
  try {
    const c = db
      .prepare(
        `INSERT INTO cycles (project_id, name, folder_name, phase, autonomy, status, final_tests_enabled)
         VALUES (?, ?, ?, 'planning', 'autonomous_after_discovery', 'active', 0)`
      )
      .run(projectId, `B4 foreign ${RUN_TS}`, `b4-foreign_${String(RUN_TS).slice(-8)}`);
    const cycleId = Number(c.lastInsertRowid);
    const run = db
      .prepare(
        `INSERT INTO runs (project_id, cycle_id, batch_id, north_star_ref, status, phase)
         VALUES (?, ?, ?, NULL, 'active', 'planning')`
      )
      .run(projectId, cycleId, `${BATCH_ID}-foreign`);
    const runId = Number(run.lastInsertRowid);
    const wr = db
      .prepare(
        `INSERT INTO worker_runtimes (project_id, role, provider, model, session, correlation_id, state, spawned_by, run_id, started_at, ended_at)
         VALUES (?,?,?,?,?,?,'running','b4-live-seed',?, datetime('now'), NULL)`
      )
      .run(
        projectId,
        'plancore',
        'grok',
        'grok-4.5',
        `helm-b4-foreign-${RUN_TS}`,
        `${BATCH_ID}-foreign`,
        runId
      );
    return { cycleId, runtimeId: Number(wr.lastInsertRowid), runId };
  } finally {
    db.close();
  }
}

function cleanupDb(projectId: number, runId: number | null, foreignRunId: number | null) {
  const db = new Database(DB_PATH);
  try {
    db.prepare("DELETE FROM worker_runtimes WHERE spawned_by = 'b4-live-seed'").run();
    if (runId != null) {
      db.prepare('DELETE FROM run_tasks WHERE run_id = ?').run(runId);
      db.prepare('DELETE FROM runs WHERE id = ?').run(runId);
    }
    if (foreignRunId != null) {
      db.prepare('DELETE FROM run_tasks WHERE run_id = ?').run(foreignRunId);
      db.prepare('DELETE FROM runs WHERE id = ?').run(foreignRunId);
    }
    db.prepare("DELETE FROM cycles WHERE project_id = ? AND name LIKE 'B4 foreign%'").run(projectId);
  } catch {
    /* best-effort */
  } finally {
    db.close();
  }
}

test.describe('B4 live attempt=2: live capture + path-safety + bottom-stick', () => {
  let token: string;
  let projectId: number;
  let cycleId: number;
  let cycleDir = '';
  let runId: number | null = null;
  let foreignRunId: number | null = null;
  let liveSeatId = 0;
  let histSeatId = 0;
  let seatIds: number[] = [];
  let foreignRuntimeId = 0;

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
      `owned-by e2e/B4.live.spec.ts attempt=2 ${PROJECT_NAME}\n`,
      'utf8'
    );
    ensureEvidenceDirs();
    createLiveTmuxSession();
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
    killLiveTmuxSession();
    try {
      cleanupDb(projectId, runId, foreignRunId);
    } catch {
      /* best-effort */
    }
    if (projectId != null) {
      try {
        await fetch(`${BASE}/api/projects/${projectId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch {
        /* best-effort */
      }
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
    } catch {
      /* leave orphan */
    }
  });

  async function openPlanning(page: import('@playwright/test').Page) {
    await page.goto(`${BASE}/`);
    const cred = page.locator('input[placeholder="owner credential"]');
    if (await cred.count()) {
      try {
        await cred.fill(CRED, { timeout: 5000 });
        await page.click('button:has-text("Login")');
      } catch {
        /* already past login */
      }
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
    const toggle = page.getByTestId('ws-plan-watch-live-toggle');
    if (await toggle.count()) {
      const t = await toggle.innerText();
      if (/watch live/i.test(t)) await toggle.click();
    }
  }

  test('live capture + live count + foreign path-safety + bottom-stick', async ({ page }) => {
    test.setTimeout(170000);
    const t0 = Date.now();
    const mark = (label: string) => console.log(`[B4.live a2 timing] ${label} at +${Date.now() - t0}ms`);

    const health = await fetch(`${BASE}/health`);
    expect(health.ok).toBe(true);
    expect(BASE).toMatch(/127\.0\.0\.1:3110|localhost:3110/);

    // --- HIGH-1: seed live + historical ---
    const seeded = seedMix({ projectId, cycleId, liveSession: LIVE_SESSION });
    runId = seeded.runId;
    liveSeatId = seeded.liveSeatId;
    histSeatId = seeded.histSeatId;
    seatIds = seeded.seatIds;
    mark(`seeded live=${liveSeatId} hist=${histSeatId} run=${runId}`);

    // API seats: live:true for running+tmux, false for reaped
    const seatsResp = await fetch(`${BASE}/api/cycles/${cycleId}/seats`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(seatsResp.ok).toBe(true);
    const seatsData = await seatsResp.json();
    expect(seatsData.seats.length).toBe(2);
    const liveApi = seatsData.seats.find((s: any) => Number(s.id) === liveSeatId);
    const histApi = seatsData.seats.find((s: any) => Number(s.id) === histSeatId);
    expect(liveApi, 'live seat missing from SEAM-1').toBeTruthy();
    expect(liveApi.live).toBe(true);
    expect(histApi.live).toBe(false);
    expect(Number(liveApi.runId)).toBe(runId);
    expect(Number(liveApi.cycleId)).toBe(cycleId);

    // Capture returns real pane content with marker
    const capResp = await fetch(`${BASE}/api/cycles/${cycleId}/seats/${liveSeatId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(capResp.ok).toBe(true);
    const capBody = await capResp.json();
    expect(String(capBody.session)).toBe(LIVE_SESSION);
    expect(String(capBody.content || ''), 'API capture missing LIVE_MARKER').toContain(LIVE_MARKER);
    mark('API live capture ok');

    // --- HIGH-3: foreign cycle real runtimeId → 404 ---
    const foreign = seedForeignCycle(projectId);
    foreignRunId = foreign.runId;
    foreignRuntimeId = foreign.runtimeId;
    const foreignCap = await fetch(`${BASE}/api/cycles/${cycleId}/seats/${foreignRuntimeId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(foreignCap.status).toBe(404);

    // Evil session query on LIVE runtime — must not redirect capture
    const evil = await fetch(
      `${BASE}/api/cycles/${cycleId}/seats/${liveSeatId}?session=evil-attacker&sessionName=evil-attacker`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    expect(evil.ok).toBe(true);
    const evilBody = await evil.json();
    expect(String(evilBody.session)).toBe(LIVE_SESSION);
    expect(String(evilBody.session)).not.toBe('evil-attacker');
    expect(String(evilBody.content || '')).toContain(LIVE_MARKER);
    mark('path-safety ok');

    await openPlanning(page);
    mark('planning open');

    // HIGH-2: total panes 2, live panes ≥1; fail if only historical
    await expect(page.getByTestId('ws-plan-panes')).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('ws-plan-panes')).toHaveAttribute('data-pane-count', '2');
    await expect(page.getByTestId('ws-plan-panes')).toHaveAttribute('data-live-pane-count', '1');

    await expect(page.getByTestId(`ws-plan-pane-live-${liveSeatId}`)).toBeVisible();
    await expect(page.getByTestId(`ws-plan-pane-historical-${histSeatId}`)).toBeVisible();

    // HIGH-1 UI: live payload must contain marker (not historical empty)
    await expect
      .poll(
        async () => {
          const el = page.getByTestId(`ws-plan-pane-payload-${liveSeatId}`);
          if (!(await el.count())) return '';
          return (await el.innerText()) || '';
        },
        { timeout: 20000 }
      )
      .toContain(LIVE_MARKER);

    // Historical must still show empty/historical, not live chip
    await expect(page.getByTestId(`ws-plan-pane-empty-${histSeatId}`)).toBeVisible();

    await expect(page.getByTestId('ws-plan-docs')).toBeVisible();
    mark('live UI payload ok');

    // --- HIGH-4: bottom-stick — scroll up, wait for poll, scrollTop preserved ---
    const body = page.getByTestId(`ws-plan-pane-body-${liveSeatId}`);
    await body.evaluate((el) => {
      el.scrollTop = 8;
    });
    const scrollBefore = await body.evaluate((el) => el.scrollTop);
    expect(scrollBefore).toBeLessThan(40);
    // Wait > one capture poll (~2s) so loadSeatPaneCapture runs
    await page.waitForTimeout(3500);
    const scrollAfter = await body.evaluate((el) => el.scrollTop);
    // Not forced to bottom (would be large if stuck)
    expect(scrollAfter, 'scrollTop jumped to bottom after poll (bottom-stick broken)').toBeLessThan(
      80
    );
    mark(`bottom-stick scroll before=${scrollBefore} after=${scrollAfter}`);

    await page.screenshot({
      path: path.join(EVIDENCE_DIR, 'B4-planning-live-panes.png'),
      fullPage: true,
    });
    fs.copyFileSync(
      path.join(EVIDENCE_DIR, 'B4-planning-live-panes.png'),
      path.join(PLAN_DIR_EVIDENCE, 'B4-planning-live-panes.png')
    );
    const ariaLive = await page.locator('body').ariaSnapshot();
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'B4-live-panes-aria-snapshot.yaml'), ariaLive, 'utf8');
    fs.writeFileSync(path.join(PLAN_DIR_EVIDENCE, 'B4-live-panes-aria-snapshot.yaml'), ariaLive, 'utf8');

    // --- Expand total to 3 with another historical (live count stays 1) ---
    const thirdId = appendHistoricalSeat(projectId, runId!);
    seatIds = [...seatIds, thirdId];
    mark(`appended hist third=${thirdId}`);

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

    await expect
      .poll(async () => page.getByTestId('ws-plan-panes').getAttribute('data-pane-count'), {
        timeout: 25000,
      })
      .toBe('3');
    await expect
      .poll(async () => page.getByTestId('ws-plan-panes').getAttribute('data-live-pane-count'), {
        timeout: 10000,
      })
      .toBe('1');
    // Still must have live payload — not only historical satisfying count
    await expect(page.getByTestId(`ws-plan-pane-payload-${liveSeatId}`)).toContainText(LIVE_MARKER, {
      timeout: 10000,
    });

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
    mark('done attempt=2');
  });
});
