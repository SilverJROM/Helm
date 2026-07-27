import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

// B2 (R2.9/R2.10/R2.11) live proof on :3110 / cards2-ibrain.db via playwright.cap.config.ts only.
// 19 status-bearing run_tasks (memory_mcp shape) on BOTH Planning + Implementation while plan.md
// is unavailable (renamed restorable backup). Document card for plan.md is independent of task rows.
// Throwaway project + unique dir + owner marker (A1/A3 lessons); scoped teardown.

const BASE = process.env.HELM_BASE_URL || 'http://127.0.0.1:3110';
const CRED = process.env.HELM_OWNER_CRED || 'cards2-harness-563f750bebc23bba';
const DB_PATH = process.env.HELM_DB_PATH_LIVE || '/home/agjrom/websites/Helm/data/cards2-ibrain.db';
const RUN_TS = Date.now();
const PROJECT_NAME = `b2-validation-${RUN_TS}`;
const PROJECT_DIR = `/home/agjrom/websites/b2-validation-${RUN_TS}`;
const OWNER_MARKER = '.b2-live-owned';
const BATCH_ID = `b2-live-${RUN_TS}`;
const EVIDENCE_DIR = path.join(process.cwd(), 'validation', 'B2');
const PLAN_DIR_EVIDENCE = path.join(process.cwd(), 'plan', 'helm-ux-remediation', 'validation', 'B2');

const PLAN_CONTENT = `# Plan\n\n\`\`\`json\n${JSON.stringify(
  Array.from({ length: 19 }, (_, i) => ({
    id: `T${String(i + 1).padStart(2, '0')}`,
    batch: 'B2',
    title: `memory_mcp-shaped task ${i + 1}`,
    req_refs: ['R2.11'],
    assignee: 'terra',
    validator_lane: 'L2',
    effort: 'low',
    type: 'feature',
  }))
)}\n\`\`\`\n`;

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

test.describe('B2 live: DB-backed task rows on Planning + Implementation — plan.md optional', () => {
  let token: string;
  let projectId: number;
  let cycleId: number;
  let cycleDir: string;
  let runId: number | null = null;
  let planPath = '';
  let planBak = '';

  test.beforeAll(async () => {
    if (fs.existsSync(PROJECT_DIR)) {
      throw new Error(
        `B2 live refuse: PROJECT_DIR already exists (${PROJECT_DIR}). Refusing to reuse or delete a path this test did not create.`
      );
    }
    fs.mkdirSync(PROJECT_DIR, { recursive: false });
    fs.writeFileSync(
      path.join(PROJECT_DIR, OWNER_MARKER),
      `owned-by e2e/B2.live.spec.ts ${PROJECT_NAME}\n`,
      'utf8'
    );
    ensureEvidenceDirs();
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
      body: JSON.stringify({ name: `B2 DB tasks ${RUN_TS}` }),
    });
    const cycleData = await cycleResp.json();
    if (!cycleResp.ok) throw new Error(`cycle create failed: ${JSON.stringify(cycleData)}`);
    cycleId = cycleData.cycle.id;
    cycleDir = path.join(PROJECT_DIR, 'cycle', String(cycleData.cycle.folder_name));
    fs.mkdirSync(cycleDir, { recursive: true });
    planPath = path.join(cycleDir, 'plan.md');
    fs.writeFileSync(planPath, PLAN_CONTENT, 'utf8');

    // Seed cycle-linked ACTIVE run + 19 run_tasks (so overview ov-card shows on active tab).
    const db = new Database(DB_PATH);
    try {
      const info = db
        .prepare(
          `INSERT INTO runs (project_id, cycle_id, batch_id, north_star_ref, status, phase)
           VALUES (?, ?, ?, NULL, 'active', 'implementation')`
        )
        .run(projectId, cycleId, BATCH_ID);
      runId = Number(info.lastInsertRowid);
      // Keep cycle phase non-terminal so overview places it on active/pending.
      try {
        db.prepare(`UPDATE cycles SET phase = 'implementation' WHERE id = ?`).run(cycleId);
      } catch { /* phase column may use different values; ignore */ }
      const statuses = ['pending', 'working', 'complete', 'failed', 'deferred'] as const;
      const ins = db.prepare(
        `INSERT INTO run_tasks (run_id, task_key, label, batch, status) VALUES (?, ?, ?, ?, ?)`
      );
      for (let i = 1; i <= 19; i++) {
        const key = `T${String(i).padStart(2, '0')}`;
        ins.run(runId, key, `memory_mcp-shaped task ${i}`, 'B2', statuses[(i - 1) % statuses.length]);
      }
    } finally {
      db.close();
    }
  });

  test.afterAll(async () => {
    try {
      if (planBak && fs.existsSync(planBak) && planPath && !fs.existsSync(planPath)) {
        fs.renameSync(planBak, planPath);
      }
    } catch { /* ignore */ }

    try {
      const db = new Database(DB_PATH);
      if (runId != null) {
        try { db.prepare('DELETE FROM run_tasks WHERE run_id = ?').run(runId); } catch { /* ignore */ }
        try { db.prepare('DELETE FROM runs WHERE id = ?').run(runId); } catch { /* ignore */ }
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
        PROJECT_DIR.includes(`b2-validation-${RUN_TS}`) &&
        fs.existsSync(markerPath) &&
        fs.readFileSync(markerPath, 'utf8').includes(PROJECT_NAME)
      ) {
        fs.rmSync(PROJECT_DIR, { recursive: true, force: false });
      }
    } catch { /* leave orphan unique dir rather than widen blast radius */ }
  });

  test('plan-present + plan-absent: 19 status-bearing rows on Planning and Implementation', async ({ page }) => {
    test.setTimeout(120000);

    const health = await fetch(`${BASE}/health`);
    expect(health.ok).toBe(true);
    expect(BASE).toMatch(/127\.0\.0\.1:3110|localhost:3110/);

    // API with plan present
    const rsPresent = await fetch(`${BASE}/api/cycles/${cycleId}/run-state`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(rsPresent.ok).toBe(true);
    const bodyPresent = await rsPresent.json();
    expect(bodyPresent.hasRun).toBe(true);
    expect(bodyPresent.tasks).toHaveLength(19);
    expect(bodyPresent.tasks.every((t: any) => t.status && t.label)).toBe(true);
    const idsPresent = bodyPresent.tasks.map((t: any) => t.id);
    expect(idsPresent).toEqual([...idsPresent].sort((a: number, b: number) => a - b));

    // UI: Overview → cycle card → Planning
    await page.goto(`${BASE}/`);
    await page.locator('input[placeholder="owner credential"]').fill(CRED);
    await page.click('button:has-text("Login")');
    await page.getByTestId('nav-project-setup').waitFor({ state: 'visible', timeout: 15000 });

    await page.goto(`${BASE}/#07-command-center-overview`);
    await expect(page.getByTestId('ov-board')).toBeVisible({ timeout: 15000 });

    let cardVisible = false;
    const uiDeadline = Date.now() + 30000;
    while (Date.now() < uiDeadline) {
      const activeTab = page.getByTestId('ov-tab-active');
      if (await activeTab.count()) await activeTab.click();
      const card = page.getByTestId(`ov-card-${projectId}`);
      if (await card.count() && (await card.isVisible())) {
        cardVisible = true;
        await card.click();
        break;
      }
      const pendingTab = page.getByTestId('ov-tab-pending');
      if (await pendingTab.count()) {
        await pendingTab.click();
        const pCard = page.getByTestId(`ov-card-${projectId}`);
        if (await pCard.count() && (await pCard.isVisible())) {
          cardVisible = true;
          await pCard.click();
          break;
        }
      }
      await page.waitForTimeout(500);
      await page.goto(`${BASE}/#07-command-center-overview`);
    }
    expect(cardVisible, `ov-card-${projectId} not found on overview active/pending`).toBe(true);

    await page.getByTestId('ws-tab-planning').click();
    await expect(page.getByTestId('ws-plan-table')).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('ws-plan-task-row')).toHaveCount(19, { timeout: 15000 });
    // Status-bearing
    for (let i = 0; i < 19; i++) {
      const st = await page.getByTestId('ws-plan-task-row').nth(i).getAttribute('data-task-status');
      expect(st).toBeTruthy();
    }
    // Plan document card still present when plan.md exists (R2.9)
    await expect(page.getByTestId('ws-plan-card-execplan')).toBeVisible({ timeout: 10000 });

    const shotPresent = path.join(EVIDENCE_DIR, 'B2-plan-present-19-rows.png');
    await page.screenshot({ path: shotPresent, fullPage: true });
    fs.copyFileSync(shotPresent, path.join(PLAN_DIR_EVIDENCE, 'B2-plan-present-19-rows.png'));

    // Rename plan.md away (restorable — never rm)
    planBak = path.join(cycleDir, `plan.md.bak-B2-live-${RUN_TS}`);
    fs.renameSync(planPath, planBak);
    expect(fs.existsSync(planPath)).toBe(false);
    expect(fs.existsSync(planBak)).toBe(true);

    // API still 19 with plan absent
    const rsAbsent = await fetch(`${BASE}/api/cycles/${cycleId}/run-state`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(rsAbsent.ok).toBe(true);
    const bodyAbsent = await rsAbsent.json();
    expect(bodyAbsent.hasRun).toBe(true);
    expect(bodyAbsent.tasks).toHaveLength(19);
    expect(bodyAbsent.tasks.every((t: any) => t.status)).toBe(true);

    // Stay in the open workspace (hash/reload can drop ws chrome). Task rows come from
    // run-state poll — not plan.md — so a tab re-click + short wait is enough proof.
    await page.getByTestId('ws-tab-planning').click();
    await page.waitForTimeout(1500);
    await expect(page.getByTestId('ws-plan-task-row')).toHaveCount(19, { timeout: 15000 });

    // Implementation tab — show all 19 while plan file is still absent
    await page.getByTestId('ws-tab-implementation').click();
    const showAll = page.getByTestId('impl-tasklist-toggle');
    await expect(showAll).toBeVisible({ timeout: 15000 });
    const txt = await showAll.textContent();
    if (txt && /Show all/i.test(txt)) await showAll.click();
    await expect(page.getByTestId('ws-impl-task-row')).toHaveCount(19, { timeout: 15000 });
    for (let i = 0; i < 5; i++) {
      const st = await page.getByTestId('ws-impl-task-row').nth(i).getAttribute('data-task-status');
      expect(st).toBeTruthy();
    }

    const shotAbsent = path.join(EVIDENCE_DIR, 'B2-DB-backed-19-rows-plan-absent.png');
    await page.screenshot({ path: shotAbsent, fullPage: true });
    fs.copyFileSync(shotAbsent, path.join(PLAN_DIR_EVIDENCE, 'B2-DB-backed-19-rows-plan-absent.png'));

    const ariaTarget = page.getByTestId('ws-impl-task-list');
    const aria = await ariaTarget.ariaSnapshot();
    const ariaPath = path.join(EVIDENCE_DIR, 'B2-tasks-aria-snapshot.yaml');
    fs.writeFileSync(ariaPath, aria, 'utf8');
    fs.copyFileSync(ariaPath, path.join(PLAN_DIR_EVIDENCE, 'B2-tasks-aria-snapshot.yaml'));

    // Restore plan.md
    fs.renameSync(planBak, planPath);
    planBak = '';
  });
});
