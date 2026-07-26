import { test, expect, type Locator, type Page } from '@playwright/test';
import path from 'node:path';
import Database from 'better-sqlite3';
import { BASE, CRED, DB_PATH } from './helpers/projects-cap.js';

const SHOT_DIR = path.join(process.cwd(), 'plan/WK_0624/projects-section-run-2026-06-24/rt2fix2/screenshots');
const LONG_NAME = `RT2FIX2-LONG-${'abcdefghij'.repeat(9)}`;
const LONG_DIR = `/home/agjrom/websites/cards/${'very-long-directory-segment/'.repeat(12)}cards`;

async function assertEllipsis(locator: Locator) {
  const styles = await locator.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { textOverflow: cs.textOverflow, overflow: cs.overflow };
  });
  expect(styles.textOverflow).toBe('ellipsis');
  expect(['hidden', 'clip']).toContain(styles.overflow);
}

async function assertNoHorizontalOverflow(locator: Locator) {
  const ok = await locator.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
  expect(ok).toBe(true);
}

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

test('rt2fix2 long-name truncation + narrow viewport no overflow', async ({ page }) => {
  test.setTimeout(120000);
  page.on('dialog', (d) => d.accept());

  let throwawayId: number | null = null;

  try {
    await login(page);
    await openProjects(page);

    await page.getByTestId('add-project-btn').click();
    await page.getByTestId('new-proj-name').fill(LONG_NAME);
    await page.getByTestId('new-proj-dir').fill(LONG_DIR);
    await page.getByTestId('save-project-btn').click();

    const throwawayRow = page.locator('[data-testid^="project-row-"]').filter({ hasText: 'RT2FIX2-LONG-' });
    await expect(throwawayRow).toBeVisible({ timeout: 15000 });
    const testId = await throwawayRow.getAttribute('data-testid');
    throwawayId = Number(testId?.replace('project-row-', ''));

    const sidebarName = throwawayRow.locator('.truncate-ellipsis').first();
    const sidebarDir = throwawayRow.locator('.truncate-ellipsis').nth(1);
    await assertEllipsis(sidebarName);
    await assertEllipsis(sidebarDir);
    await expect(sidebarName).toHaveAttribute('title', LONG_NAME);
    await expect(sidebarDir).toHaveAttribute('title', LONG_DIR);

    const rowHeight = await throwawayRow.evaluate((el) => el.getBoundingClientRect().height);
    expect(rowHeight).toBeLessThan(80);

    const deleteBtn = throwawayRow.getByRole('button', { name: 'Delete project' });
    const rowBox = await throwawayRow.boundingBox();
    const deleteBox = await deleteBtn.boundingBox();
    expect(rowBox && deleteBox).toBeTruthy();
    if (rowBox && deleteBox) {
      expect(deleteBox.x + deleteBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 2);
    }

    await throwawayRow.click();
    await page.getByTestId('project-subtab-detail').click();

    const detailName = page.getByTestId('project-detail-name').locator('.truncate-ellipsis');
    const detailDir = page.getByTestId('project-detail-dir');
    await assertEllipsis(detailName);
    await assertEllipsis(detailDir);
    await expect(detailName).toHaveAttribute('title', LONG_NAME);
    await expect(detailDir).toHaveAttribute('title', LONG_DIR);
    const detailCard = page.locator('.card').filter({ has: page.getByTestId('project-detail-name') });
    const cardBox = await detailCard.boundingBox();
    const nameBox = await detailName.boundingBox();
    const dirBox = await detailDir.boundingBox();
    expect(cardBox && nameBox && dirBox).toBeTruthy();
    if (cardBox && nameBox && dirBox) {
      expect(nameBox.x + nameBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 2);
      expect(dirBox.x + dirBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 2);
    }

    await page.screenshot({ path: path.join(SHOT_DIR, '01-long-name-ellipsis.png'), fullPage: false });

    for (const width of [680, 420]) {
      await page.setViewportSize({ width, height: 800 });
      await assertNoHorizontalOverflow(page.getByTestId('project-content-pane'));
      await assertNoHorizontalOverflow(page.getByTestId('project-sub-tabs'));
      await expect(page.getByTestId('project-subtab-detail')).toBeVisible();
      await expect(page.getByTestId('project-subtab-agents')).toBeVisible();
      await expect(page.getByTestId('project-subtab-documents')).toBeVisible();
    }

    await page.screenshot({ path: path.join(SHOT_DIR, '02-narrow-viewport-420.png'), fullPage: false });

    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByTestId('project-row-1')).toBeVisible();
  } finally {
    if (throwawayId && throwawayId !== 1) {
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