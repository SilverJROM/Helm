import { test, expect } from '@playwright/test';
import path from 'node:path';

const CRED = process.env.HELM_OWNER_CRED || 'JROM-OWNER-SECRET-2026';
const BASE = process.env.HELM_BASE_URL || 'http://127.0.0.1:3110';
const SHOT_DIR = path.join(process.cwd(), 'plan/WK_0624/projects-section-run-2026-06-24/rt1fix1/screenshots');
const AID = 20;

async function openSoloAgents(page: import('@playwright/test').Page) {
  await page.getByTestId('nav-project-setup').click();
  await page.getByTestId('tab-projects').click();
  await page.getByTestId('project-row-1').click();
  await page.getByTestId('project-subtab-agents').click();
  await expect(page.getByTestId(`project-agent-row-${AID}`)).toBeVisible({ timeout: 10000 });
}

test('rt1fix1 editor UX UI-PROOF (U1/U2/U3)', async ({ page }) => {
  test.setTimeout(90000);
  await page.goto(BASE + '/');
  await page.locator('input[placeholder="owner credential"]').fill(CRED);
  await page.click('button:has-text("Login")');
  await expect(page.getByTestId('nav-project-setup')).toBeVisible({ timeout: 15000 });

  await openSoloAgents(page);
  const caret = page.getByTestId(`project-agent-expand-caret-${AID}`);
  await expect(caret).toBeVisible();
  await expect(caret).toHaveAttribute('data-expanded', 'false');
  await page.screenshot({ path: path.join(SHOT_DIR, '01-caret-visible-at-rest.png'), fullPage: false });

  await page.getByTestId(`project-agent-row-${AID}`).click();
  await expect(page.getByTestId(`project-agent-override-drawer-${AID}`)).toBeVisible();
  await expect(caret).toHaveAttribute('data-expanded', 'true');
  await page.screenshot({ path: path.join(SHOT_DIR, '02-caret-rotated-expanded.png'), fullPage: false });

  await page.getByTestId(`project-agent-drawer-close-${AID}`).click();
  await expect(page.getByTestId(`project-agent-override-drawer-${AID}`)).not.toBeVisible();
  await expect(caret).toHaveAttribute('data-expanded', 'false');
  await page.screenshot({ path: path.join(SHOT_DIR, '03-close-collapses.png'), fullPage: false });

  await page.getByTestId(`project-agent-row-${AID}`).click();
  await expect(page.getByTestId(`project-agent-effort-select-${AID}`)).toBeVisible();
  await page.getByTestId(`project-agent-effort-select-${AID}`).selectOption('high');
  await expect(page.getByTestId('project-agent-save-flash')).toBeVisible({ timeout: 5000 });
  await page.screenshot({ path: path.join(SHOT_DIR, '04-saved-flash.png'), fullPage: false });

  await page.getByTestId(`project-agent-effort-reset-${AID}`).click();
  await expect(page.getByTestId('project-agent-save-flash')).toBeVisible({ timeout: 5000 });
});