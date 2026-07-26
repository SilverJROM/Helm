import { test, expect } from '@playwright/test';
import path from 'node:path';

const CRED = process.env.HELM_OWNER_CRED || 'JROM-OWNER-SECRET-2026';
const BASE = process.env.HELM_BASE_URL || 'http://127.0.0.1:3110';
const SHOT_DIR = path.join(process.cwd(), 'plan/WK_0624/projects-section-run-2026-06-24/batch-10/screenshots');

test('batch-10 override drawer UI-PROOF', async ({ page }) => {
  test.setTimeout(120000);
  await page.goto(BASE + '/');
  await page.locator('input[placeholder="owner credential"]').fill(CRED);
  await page.click('button:has-text("Login")');
  await expect(page.getByTestId('nav-project-setup')).toBeVisible({ timeout: 15000 });

  await page.getByTestId('nav-project-setup').click();
  await page.getByTestId('tab-projects').click();
  await page.getByTestId('project-row-1').click();
  await page.getByTestId('project-subtab-agents').click();
  await expect(page.getByTestId('project-agent-row-20')).toBeVisible({ timeout: 10000 });

  await page.screenshot({ path: path.join(SHOT_DIR, '01-solo-table-slim.png'), fullPage: false });

  await page.getByTestId('project-agent-row-20').click();
  await expect(page.getByTestId('project-agent-override-drawer-20')).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId('pa-inherited-hint').first()).toBeVisible();
  // B4: solo drawer uses ≥2-col grid (pa-drawer-grid); tiered uses ladder (no solo grid).
  const drawerCls = await page.getByTestId('project-agent-override-drawer-20').getAttribute('data-classification');
  if (drawerCls === 'solo' || drawerCls === 'team') {
    const grid = page.getByTestId('pa-drawer-grid-20');
    await expect(grid).toBeVisible();
    const cols = await grid.evaluate((el) => getComputedStyle(el).gridTemplateColumns);
    expect(cols.split(/\s+/).filter(Boolean).length).toBeGreaterThanOrEqual(2);
    await expect(page.getByTestId('project-agent-escalations-section-20')).toHaveCount(0);
  } else if (drawerCls === 'tiered') {
    await expect(page.getByTestId('pa-drawer-ladder-20')).toBeVisible();
    await expect(page.getByTestId('project-agent-escalations-section-20')).toBeVisible();
  }
  await page.screenshot({ path: path.join(SHOT_DIR, '02-drawer-inherited.png'), fullPage: false });

  await page.getByTestId('project-agent-effort-select-20').selectOption('high');
  await page.waitForTimeout(400);
  await expect(page.getByTestId('project-agent-resolved-model-20')).toBeVisible();
  await page.screenshot({ path: path.join(SHOT_DIR, '03-effort-override.png'), fullPage: false });

  await page.getByTestId('project-agent-spawn-select-20').selectOption('in-process');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOT_DIR, '04-spawn-override.png'), fullPage: false });

  await page.reload();
  await page.getByTestId('nav-project-setup').click();
  await page.getByTestId('tab-projects').click();
  await page.getByTestId('project-row-1').click();
  await page.getByTestId('project-subtab-agents').click();
  await page.getByTestId('project-agent-row-20').click();
  await expect(page.getByTestId('project-agent-effort-select-20')).toHaveValue('high');
  await expect(page.getByTestId('project-agent-spawn-select-20')).toHaveValue('in-process');
  await page.screenshot({ path: path.join(SHOT_DIR, '05-persist-after-reload.png'), fullPage: false });

  await page.getByTestId('project-agent-effort-reset-20').click();
  await page.waitForTimeout(400);
  await page.getByTestId('project-agent-spawn-reset-20').click();
  await page.waitForTimeout(400);
  await expect(page.getByTestId('project-agent-effort-select-20')).toHaveValue('');
  await expect(page.getByTestId('project-agent-spawn-select-20')).toHaveValue('');
  await page.screenshot({ path: path.join(SHOT_DIR, '06-reset-inherit.png'), fullPage: false });
});