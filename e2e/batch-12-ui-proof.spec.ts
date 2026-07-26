import { test, expect } from '@playwright/test';
import path from 'node:path';

const CRED = process.env.HELM_OWNER_CRED || 'JROM-OWNER-SECRET-2026';
const BASE = process.env.HELM_BASE_URL || 'http://127.0.0.1:3110';
const SHOT_DIR = path.join(process.cwd(), 'plan/WK_0624/projects-section-run-2026-06-24/batch-12/screenshots');
const AID = 20;
const PA_DEFINITION_MAX = 50000;
const MARKER = '# BATCH-12-UI-PROOF-PERSONA\nProject-specific persona override.';

async function openPersonaDrawer(page: import('@playwright/test').Page) {
  await page.getByTestId('nav-project-setup').click();
  await page.getByTestId('tab-projects').click();
  await page.getByTestId('project-row-1').click();
  await page.getByTestId('project-subtab-agents').click();
  await expect(page.getByTestId(`project-agent-row-${AID}`)).toBeVisible({ timeout: 10000 });
  await page.getByTestId(`project-agent-row-${AID}`).click();
  await expect(page.getByTestId(`project-agent-persona-section-${AID}`)).toBeVisible({ timeout: 10000 });
}

test('batch-12 persona drawer UI-PROOF', async ({ page }) => {
  test.setTimeout(120000);
  await page.goto(BASE + '/');
  await page.locator('input[placeholder="owner credential"]').fill(CRED);
  await page.click('button:has-text("Login")');
  await expect(page.getByTestId('nav-project-setup')).toBeVisible({ timeout: 15000 });

  await openPersonaDrawer(page);
  // Baseline: reset persona if overridden
  if (await page.getByTestId(`project-agent-persona-overridden-badge-${AID}`).isVisible().catch(() => false)) {
    await page.getByTestId(`project-agent-persona-reset-${AID}`).click();
    await page.waitForTimeout(500);
  }
  await expect(page.getByTestId(`project-agent-persona-inherited-hint-${AID}`)).toBeVisible();
  await page.screenshot({ path: path.join(SHOT_DIR, '01-inherited-persona.png'), fullPage: false });

  await page.getByTestId(`project-agent-persona-edit-${AID}`).click();
  await page.getByTestId(`project-agent-persona-textarea-${AID}`).fill(MARKER);
  await page.getByTestId(`project-agent-persona-save-${AID}`).click();
  await page.waitForTimeout(500);
  await expect(page.getByTestId(`project-agent-persona-overridden-badge-${AID}`)).toBeVisible();
  await expect(page.getByTestId(`project-agent-persona-inherited-${AID}`)).toHaveValue(MARKER);
  await page.screenshot({ path: path.join(SHOT_DIR, '02-persona-override.png'), fullPage: false });

  await page.reload();
  await openPersonaDrawer(page);
  await expect(page.getByTestId(`project-agent-persona-overridden-badge-${AID}`)).toBeVisible();
  await expect(page.getByTestId(`project-agent-persona-inherited-${AID}`)).toHaveValue(MARKER);
  await page.screenshot({ path: path.join(SHOT_DIR, '03-persist-after-reload.png'), fullPage: false });

  await page.getByTestId(`project-agent-persona-edit-${AID}`).click();
  const overCap = 'x'.repeat(PA_DEFINITION_MAX + 1);
  await page.getByTestId(`project-agent-persona-textarea-${AID}`).fill(overCap);
  await page.getByTestId(`project-agent-persona-save-${AID}`).click();
  await expect(page.getByTestId(`project-agent-persona-cap-err-${AID}`)).toBeVisible();
  await page.screenshot({ path: path.join(SHOT_DIR, '04-cap-blocked.png'), fullPage: false });

  await page.getByTestId(`project-agent-persona-cancel-${AID}`).click();
  await page.getByTestId(`project-agent-persona-reset-${AID}`).click();
  await page.waitForTimeout(500);
  await expect(page.getByTestId(`project-agent-persona-overridden-badge-${AID}`)).not.toBeVisible();
  await expect(page.getByTestId(`project-agent-persona-inherited-hint-${AID}`)).toBeVisible();
  const inheritedVal = await page.getByTestId(`project-agent-persona-inherited-${AID}`).inputValue();
  expect(inheritedVal).not.toBe(MARKER);
  await page.screenshot({ path: path.join(SHOT_DIR, '05-reset-inherit.png'), fullPage: false });
});