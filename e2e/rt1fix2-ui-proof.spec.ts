import { test, expect } from '@playwright/test';
import path from 'node:path';

const CRED = process.env.HELM_OWNER_CRED || 'JROM-OWNER-SECRET-2026';
const BASE = process.env.HELM_BASE_URL || 'http://127.0.0.1:3110';
const SHOT_DIR = path.join(process.cwd(), 'plan/WK_0624/projects-section-run-2026-06-24/rt1fix2/screenshots');
const AID = 20;

test('rt1fix2 Escape closes override drawer', async ({ page }) => {
  test.setTimeout(60000);
  await page.goto(BASE + '/');
  await page.locator('input[placeholder="owner credential"]').fill(CRED);
  await page.click('button:has-text("Login")');
  await expect(page.getByTestId('nav-project-setup')).toBeVisible({ timeout: 15000 });

  await page.getByTestId('nav-project-setup').click();
  await page.getByTestId('tab-projects').click();
  await page.getByTestId('project-row-1').click();
  await page.getByTestId('project-subtab-agents').click();
  await page.getByTestId(`project-agent-row-${AID}`).click();
  await expect(page.getByTestId(`project-agent-override-drawer-${AID}`)).toBeVisible({ timeout: 10000 });
  await page.screenshot({ path: path.join(SHOT_DIR, '01-drawer-open.png'), fullPage: false });

  await page.keyboard.press('Escape');
  await expect(page.getByTestId(`project-agent-override-drawer-${AID}`)).not.toBeVisible();
  await expect(page.getByTestId(`project-agent-expand-caret-${AID}`)).toHaveAttribute('data-expanded', 'false');
  await page.screenshot({ path: path.join(SHOT_DIR, '02-escape-closed.png'), fullPage: false });
});