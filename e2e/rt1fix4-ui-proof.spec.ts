import { test, expect } from '@playwright/test';
import path from 'node:path';

const CRED = process.env.HELM_OWNER_CRED || 'JROM-OWNER-SECRET-2026';
const BASE = process.env.HELM_BASE_URL || 'http://127.0.0.1:3110';
const SHOT_DIR = path.join(process.cwd(), 'plan/WK_0624/projects-section-run-2026-06-24/rt1fix4/screenshots');
const AID = 20;

test('rt1fix4 override drawer aria-labels', async ({ page }) => {
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
  const drawerCls = await page.getByTestId(`project-agent-override-drawer-${AID}`).getAttribute('data-classification');

  const ariaChecks: Array<[string, string]> = [
    [`project-agent-model-select-${AID}`, 'Default model override'],
    [`project-agent-backup-select-${AID}`, 'Backup model override'],
    [`project-agent-effort-select-${AID}`, 'Effort tier override'],
    [`project-agent-spawn-select-${AID}`, 'Spawn preference override'],
    [`project-agent-readiness-select-${AID}`, 'Readiness override'],
    [`project-agent-toolkits-override-toggle-${AID}`, 'Override skills and toolkits on this project'],
    [`project-agent-persona-inherited-${AID}`, 'Persona preview'],
    [`project-agent-drawer-close-${AID}`, 'Close override editor'],
  ];
  // B4: L2+ ladder (and its toggle) only on tiered drawers.
  if (drawerCls === 'tiered') {
    ariaChecks.push([`project-agent-escalations-override-toggle-${AID}`, 'Override escalation ladder on this project']);
  }

  for (const [testId, label] of ariaChecks) {
    await expect(page.getByTestId(testId)).toHaveAttribute('aria-label', label);
  }

  await page.getByTestId(`project-agent-toolkits-override-toggle-${AID}`).check();
  await expect(page.getByTestId(`project-agent-toolkit-attach-select-${AID}`)).toHaveAttribute('aria-label', 'Attach toolkit override');

  if (drawerCls === 'tiered') {
    await page.getByTestId(`project-agent-escalations-override-toggle-${AID}`).check();
    // Labels use L2/L3 (position+1), not "Escalation rung N".
    await expect(page.getByTestId(`project-agent-escalation-model-1-${AID}`)).toHaveAttribute('aria-label', 'L2 escalation model override');
    await expect(page.getByTestId(`project-agent-escalation-trigger-1-${AID}`)).toHaveAttribute('aria-label', 'L2 escalation trigger override');
  } else if (drawerCls === 'solo') {
    await expect(page.getByTestId(`pa-drawer-grid-${AID}`)).toBeVisible();
    await expect(page.getByTestId(`project-agent-escalations-section-${AID}`)).toHaveCount(0);
  }

  await page.getByTestId(`project-agent-persona-edit-${AID}`).click();
  await expect(page.getByTestId(`project-agent-persona-textarea-${AID}`)).toHaveAttribute('aria-label', 'Persona override');

  await page.screenshot({ path: path.join(SHOT_DIR, '01-drawer-aria-labels.png'), fullPage: false });
});