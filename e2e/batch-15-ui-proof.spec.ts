import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const CRED = process.env.HELM_OWNER_CRED || 'JROM-OWNER-SECRET-2026';
const SHOT_DIR = path.join(process.cwd(), 'plan/WK_0624/projects-section-run-2026-06-24/batch-15/screenshots');
const PROJ_DIR = `/tmp/helm-b15-ui-proof-${process.pid}`;
const DB_PATH = '/tmp/helm-e2e.db';

async function openTasksTab(page: import('@playwright/test').Page, projectId: number) {
  await page.getByTestId('nav-project-setup').click();
  await page.getByTestId('tab-projects').click();
  await page.getByTestId(`project-row-${projectId}`).click();
  await page.getByTestId('project-subtab-documents').click();
  await page.getByTestId('doc-subtab-tasks').click();
  await expect(page.getByTestId('tasks-tree')).toBeVisible({ timeout: 15000 });
}

test.describe('batch-15 tasks UI-PROOF (folder-grouped + status badges)', () => {
  let token = '';
  let projectId = 0;

  test.beforeAll(async ({ request }) => {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    fs.mkdirSync(PROJ_DIR, { recursive: true });
    fs.mkdirSync(path.join(PROJ_DIR, 'helm_tasks', 'b15-proof', 'task-alpha'), { recursive: true });
    fs.mkdirSync(path.join(PROJ_DIR, 'helm_tasks', 'b15-proof', 'task-beta'), { recursive: true });
    // safe(" foo ") → "_foo_" on disk (getTaskArtifactRoot replaces untrimmed string; spaces → _)
    fs.mkdirSync(path.join(PROJ_DIR, 'helm_tasks', 'b15-proof', '_foo_'), { recursive: true });
    fs.writeFileSync(path.join(PROJ_DIR, 'helm_tasks/b15-proof/task-alpha/changes.md'), '# Alpha task\n\nBatch-15 status badge proof.\n');
    fs.writeFileSync(path.join(PROJ_DIR, 'helm_tasks/b15-proof/task-beta/changes.md'), '# Beta task\n\nNo ingested TaskRow — no badge.\n');
    fs.writeFileSync(path.join(PROJ_DIR, 'helm_tasks/b15-proof/_foo_/changes.md'), '# Whitespace-key task\n\nDisk folder _foo_ matches slugTaskKey(" foo ").\n');

    const loginResp = await request.post('/api/auth/login', { data: { credential: CRED } });
    const { token: t } = await loginResp.json();
    token = t;
    const projResp = await request.post('/api/projects', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { name: 'B15 UI Proof', directory: PROJ_DIR },
    });
    expect(projResp.ok()).toBeTruthy();
    const { project } = await projResp.json();
    projectId = project.id;

    const now = new Date().toISOString();
    const db = new Database(DB_PATH);
    db.prepare(
      `INSERT INTO tasks (project_id, task_key, label, status, agent, position, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(projectId, 'task-alpha', 'Alpha task', 'working', 'implementer', 0, now, now);
    db.prepare(
      `INSERT INTO tasks (project_id, task_key, label, status, agent, position, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(projectId, 'orphan-gamma', 'Gamma orphan', 'pending', null, 1, now, now);
    db.prepare(
      `INSERT INTO tasks (project_id, task_key, label, status, agent, position, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(projectId, ' foo ', 'Whitespace-padded key', 'completed', null, 2, now, now);
    db.close();
  });

  test.afterAll(async () => {
    try { fs.rmSync(PROJ_DIR, { recursive: true, force: true }); } catch {}
  });

  test('folder-grouped tasks + status badge when matched + no badge when unmapped', async ({ page }) => {
    test.setTimeout(120000);

    await page.goto('/');
    await page.locator('input[placeholder="owner credential"]').fill(CRED);
    await page.click('button:has-text("Login")');
    await expect(page.getByTestId('nav-project-setup')).toBeVisible({ timeout: 15000 });

    await openTasksTab(page, projectId);

    await expect(page.getByTestId('tasks-group-b15-proof')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('task-unit-task-alpha')).toBeVisible();
    await expect(page.getByTestId('task-status-task-alpha')).toHaveText('working');
    await expect(page.getByTestId('task-unit-task-beta')).toBeVisible();
    await expect(page.getByTestId('task-status-task-beta')).toHaveCount(0);
    await expect(page.getByTestId('tasks-unmapped-note')).toContainText('1 projcore task');
    await expect(page.getByTestId('tasks-group-rollup-b15-proof')).toContainText('1 working');
    // slugTaskKey(" foo ") === "_foo_" === on-disk folder → status join must not silently miss
    await expect(page.getByTestId('task-unit-_foo_')).toBeVisible();
    await expect(page.getByTestId('task-status-_foo_')).toHaveText('completed');

    await page.screenshot({ path: path.join(SHOT_DIR, '01-folder-grouped-status.png'), fullPage: false });
  });
});