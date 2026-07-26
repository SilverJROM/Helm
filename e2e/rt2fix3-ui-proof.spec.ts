import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import Database from 'better-sqlite3';
import { BASE, CRED, DB_PATH, CARDS_ID } from './helpers/projects-cap.js';

const SHOT_DIR = path.join(process.cwd(), 'plan/WK_0624/projects-section-run-2026-06-24/rt2fix3/screenshots');

async function login(page: Page) {
  await page.goto(`${BASE}/`);
  await page.locator('input[placeholder="owner credential"]').fill(CRED);
  await page.click('button:has-text("Login")');
  await expect(page.getByTestId('nav-project-setup')).toBeVisible({ timeout: 15000 });
}

async function openProjects(page: Page) {
  await page.getByTestId('nav-project-setup').click();
  await page.getByTestId('tab-projects').click();
}

test('rt2fix3 project-op error + active-doc highlight + P2 polish DOM', async ({ page }) => {
  test.setTimeout(120000);
  page.on('dialog', (d) => d.accept());

  await login(page);

  // Loading state: delay projects list fetch
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() === 'GET') {
      await new Promise((r) => setTimeout(r, 400));
      await route.continue();
    } else {
      await route.continue();
    }
  });

  await openProjects(page);
  await expect(page.getByTestId('projects-loading')).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId('project-row-1')).toBeVisible({ timeout: 15000 });

  // P2 polish: maxLength attrs on new-project inputs
  await page.getByTestId('add-project-btn').click();
  await expect(page.getByTestId('new-proj-name')).toHaveAttribute('maxLength', '120');
  await expect(page.getByTestId('new-proj-dir')).toHaveAttribute('maxLength', '300');

  // Failed create: duplicate name shows visible red error
  await page.getByTestId('new-proj-name').fill('cards');
  await page.getByTestId('new-proj-dir').fill('/tmp/rt2fix3-dup-probe');
  await page.getByTestId('save-project-btn').click();
  const err = page.getByTestId('project-op-err');
  await expect(err).toBeVisible({ timeout: 10000 });
  await expect(err).toHaveCSS('color', 'rgb(248, 81, 73)');
  await expect(err).not.toBeEmpty();
  await page.screenshot({ path: path.join(SHOT_DIR, '01-project-op-err.png'), fullPage: false });

  // Cancel add form; open cards detail for polish asserts
  await page.getByTestId('add-project-btn').click(); // close form
  await page.getByTestId(`project-row-${CARDS_ID}`).click();
  await page.getByTestId('project-subtab-detail').click();

  await expect(page.getByTestId('project-detail-status')).toHaveAttribute('title', 'No active projcore run');
  await expect(page.getByTestId('project-detail-tech-stack-caption')).toHaveText(
    /Auto-read from helm_docs\/tech-stack\.md/
  );

  await page.getByTestId('edit-project-btn').click();
  await expect(page.getByTestId('edit-proj-description')).toHaveAttribute(
    'placeholder',
    "Describe this project's purpose and goals"
  );
  await page.getByTestId('save-edit-project-btn').locator('..').locator('button:has-text("Cancel")').click();

  await page.getByTestId('project-subtab-agents').click();
  await expect(page.getByTestId('set-default-btn')).toHaveAttribute(
    'title',
    'Reset all agent model overrides to their Studio defaults'
  );

  // Active-doc highlight: exactly one row active, moves on second open
  await page.getByTestId('project-subtab-documents').click();
  await page.getByTestId('doc-subtab-docs').click();

  const overviewRow = page.locator('[data-testid^="doc-row-"]').filter({ hasText: 'overview.md' }).first();
  const techStackRow = page.locator('[data-testid^="doc-row-"]').filter({ hasText: 'tech-stack.md' }).first();
  await expect(overviewRow).toBeVisible({ timeout: 15000 });
  await expect(techStackRow).toBeVisible();

  await overviewRow.click();
  await expect(page.getByTestId('viewed-doc-pane')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('[data-active-doc="true"]')).toHaveCount(1);
  await expect(overviewRow).toHaveAttribute('data-active-doc', 'true');
  await page.screenshot({ path: path.join(SHOT_DIR, '02-active-doc-overview.png'), fullPage: false });

  await techStackRow.click();
  await expect(page.getByTestId('viewed-doc-pane')).toBeVisible();
  await expect(page.locator('[data-active-doc="true"]')).toHaveCount(1);
  await expect(techStackRow).toHaveAttribute('data-active-doc', 'true');
  await expect(overviewRow).toHaveAttribute('data-active-doc', 'false');
  await page.screenshot({ path: path.join(SHOT_DIR, '03-active-doc-tech-stack.png'), fullPage: false });

  // Valid create still succeeds (throwaway, scrubbed in finally)
  let throwawayId: number | null = null;
  try {
    await page.getByTestId('add-project-btn').click();
    const uniq = `RT2FIX3-OK-${Date.now()}`;
    await page.getByTestId('new-proj-name').fill(uniq);
    await page.getByTestId('new-proj-dir').fill(`/tmp/${uniq}`);
    await page.getByTestId('save-project-btn').click();
    const row = page.locator('[data-testid^="project-row-"]').filter({ hasText: uniq });
    await expect(row).toBeVisible({ timeout: 15000 });
    const testId = await row.getAttribute('data-testid');
    throwawayId = Number(testId?.replace('project-row-', ''));
    await expect(page.getByTestId('project-op-err')).toHaveCount(0);
  } finally {
    if (throwawayId && throwawayId !== CARDS_ID) {
      await openProjects(page);
      await page.getByTestId(`delete-project-${throwawayId}`).click();
      await expect(page.getByTestId(`project-row-${throwawayId}`)).toHaveCount(0, { timeout: 15000 });
    }

    const db = new Database(DB_PATH, { readonly: true });
    const ids = db.prepare('SELECT id, name FROM projects ORDER BY id').all() as Array<{ id: number; name: string }>;
    db.close();
    expect(ids).toEqual([{ id: 1, name: 'cards' }]);
  }
});