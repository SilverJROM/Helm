import { test, expect } from '@playwright/test';
import path from 'node:path';

const CRED = process.env.HELM_OWNER_CRED || 'JROM-OWNER-SECRET-2026';
const BASE = process.env.HELM_BASE_URL || 'http://127.0.0.1:3110';
const SHOT_DIR = path.join(process.cwd(), 'plan/WK_0624/projects-section-run-2026-06-24/rt1fix3/screenshots');
const AID = 20;

async function openSoloAgents(page: import('@playwright/test').Page) {
  await page.getByTestId('nav-project-setup').click();
  await page.getByTestId('tab-projects').click();
  await page.getByTestId('project-row-1').click();
  await page.getByTestId('project-subtab-agents').click();
  await expect(page.getByTestId(`project-agent-row-${AID}`)).toBeVisible({ timeout: 10000 });
}

test('rt1fix3 has-overrides row indicator', async ({ page }) => {
  test.setTimeout(90000);
  await page.goto(BASE + '/');
  await page.locator('input[placeholder="owner credential"]').fill(CRED);
  await page.click('button:has-text("Login")');
  await expect(page.getByTestId('nav-project-setup')).toBeVisible({ timeout: 15000 });

  await openSoloAgents(page);
  const dot = page.getByTestId(`project-agent-has-overrides-${AID}`);

  // Baseline: clear all overrides if present
  await page.getByTestId(`project-agent-row-${AID}`).click();
  await expect(page.getByTestId(`project-agent-override-drawer-${AID}`)).toBeVisible();
  for (const resetId of [
    'project-agent-model-reset',
    'project-agent-backup-reset',
    'project-agent-effort-reset',
    'project-agent-spawn-reset',
    'project-agent-readiness-reset',
    'project-agent-toolkits-reset',
    'project-agent-escalations-reset',
    'project-agent-persona-reset',
  ]) {
    const btn = page.getByTestId(`${resetId}-${AID}`);
    if (await btn.isVisible().catch(() => false)) {
      await btn.click();
      await page.waitForTimeout(400);
    }
  }
  const tkToggle = page.getByTestId(`project-agent-toolkits-override-toggle-${AID}`);
  if (await tkToggle.isChecked().catch(() => false)) {
    await page.getByTestId(`project-agent-toolkits-reset-${AID}`).click();
    await page.waitForTimeout(400);
  }
  const escToggle = page.getByTestId(`project-agent-escalations-override-toggle-${AID}`);
  if (await escToggle.isChecked().catch(() => false)) {
    await page.getByTestId(`project-agent-escalations-reset-${AID}`).click();
    await page.waitForTimeout(400);
  }
  await page.keyboard.press('Escape');
  await expect(dot).not.toBeVisible();
  await page.screenshot({ path: path.join(SHOT_DIR, '01-no-override-dot.png'), fullPage: false });

  await page.getByTestId(`project-agent-row-${AID}`).click();
  await page.getByTestId(`project-agent-effort-select-${AID}`).selectOption('high');
  await page.waitForTimeout(500);
  await page.keyboard.press('Escape');
  await expect(dot).toBeVisible();
  await expect(dot).toHaveAttribute('title', 'has project overrides');
  await page.screenshot({ path: path.join(SHOT_DIR, '02-override-dot-visible.png'), fullPage: false });

  await page.reload();
  await openSoloAgents(page);
  await expect(dot).toBeVisible();
  await page.screenshot({ path: path.join(SHOT_DIR, '03-persist-after-reload.png'), fullPage: false });

  await page.getByTestId(`project-agent-row-${AID}`).click();
  await page.getByTestId(`project-agent-effort-reset-${AID}`).click();
  await page.waitForTimeout(500);
  await page.keyboard.press('Escape');
  await expect(dot).not.toBeVisible();
  await page.screenshot({ path: path.join(SHOT_DIR, '04-cleared-no-dot.png'), fullPage: false });
});