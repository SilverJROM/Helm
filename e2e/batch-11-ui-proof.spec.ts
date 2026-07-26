import { test, expect } from '@playwright/test';
import path from 'node:path';

const CRED = process.env.HELM_OWNER_CRED || 'JROM-OWNER-SECRET-2026';
const BASE = process.env.HELM_BASE_URL || 'http://127.0.0.1:3110';
const SHOT_DIR = path.join(process.cwd(), 'plan/WK_0624/projects-section-run-2026-06-24/batch-11/screenshots');
const FALLBACK_AID = 20;

/** B4: escalations section only on tiered drawers — pick tiered agent by classification chip. */
async function resolveTieredAid(page: import('@playwright/test').Page): Promise<number> {
  const tieredChip = page.locator('[data-testid^="project-agent-classification-"][data-class="tiered"]').first();
  if (await tieredChip.isVisible().catch(() => false)) {
    const testId = await tieredChip.getAttribute('data-testid');
    const m = testId?.match(/project-agent-classification-(\d+)/);
    if (m) return Number(m[1]);
  }
  return FALLBACK_AID;
}

test('batch-11 toolkits+escalations drawer UI-PROOF', async ({ page }) => {
  test.setTimeout(180000);
  await page.goto(BASE + '/');
  await page.locator('input[placeholder="owner credential"]').fill(CRED);
  await page.click('button:has-text("Login")');
  await expect(page.getByTestId('nav-project-setup')).toBeVisible({ timeout: 15000 });

  await page.getByTestId('nav-project-setup').click();
  await page.getByTestId('tab-projects').click();
  await page.getByTestId('project-row-1').click();
  await page.getByTestId('project-subtab-agents').click();

  const AID = await resolveTieredAid(page);
  await expect(page.getByTestId(`project-agent-row-${AID}`)).toBeVisible({ timeout: 10000 });

  await page.getByTestId(`project-agent-row-${AID}`).click();
  await expect(page.getByTestId(`project-agent-override-drawer-${AID}`)).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId(`project-agent-toolkits-section-${AID}`)).toBeVisible();
  // Solo hides L2+; this proof requires tiered ladder.
  await expect(page.getByTestId(`project-agent-override-drawer-${AID}`)).toHaveAttribute('data-classification', 'tiered');
  await expect(page.getByTestId(`project-agent-escalations-section-${AID}`)).toBeVisible();
  await page.screenshot({ path: path.join(SHOT_DIR, '01-inherited-toolkits-escalations.png'), fullPage: false });

  // Reset toolkits/escalations to inherit first (clean baseline)
  const tkToggle = page.getByTestId(`project-agent-toolkits-override-toggle-${AID}`);
  if (await tkToggle.isChecked()) {
    await page.getByTestId(`project-agent-toolkits-reset-${AID}`).click();
    await page.waitForTimeout(500);
  }
  const escToggle = page.getByTestId(`project-agent-escalations-override-toggle-${AID}`);
  if (await escToggle.isChecked()) {
    await page.getByTestId(`project-agent-escalations-reset-${AID}`).click();
    await page.waitForTimeout(500);
  }
  await expect(tkToggle).not.toBeChecked();
  await page.screenshot({ path: path.join(SHOT_DIR, '02-inherited-greyed.png'), fullPage: false });

  // Toolkits override: enable + attach first available toolkit
  await tkToggle.check();
  await page.waitForTimeout(500);
  const attachSel = page.getByTestId(`project-agent-toolkit-attach-select-${AID}`);
  const attachOpts = await attachSel.locator('option').evaluateAll((opts) =>
    opts.map((o) => ({ value: (o as HTMLOptionElement).value, text: o.textContent || '' })).filter((o) => o.value)
  );
  if (attachOpts.length > 0) {
    await attachSel.selectOption(attachOpts[0].value);
    await page.getByTestId(`project-agent-toolkit-attach-btn-${AID}`).click();
    await page.waitForTimeout(500);
  }
  await expect(tkToggle).toBeChecked();
  await page.screenshot({ path: path.join(SHOT_DIR, '03-toolkits-override.png'), fullPage: false });

  // Escalations override: enable + set rung 1 model
  await escToggle.check();
  await page.waitForTimeout(500);
  const escModel = page.getByTestId(`project-agent-escalation-model-1-${AID}`);
  const escOpts = await escModel.locator('option').evaluateAll((opts) =>
    opts
      .map((o) => ({ value: (o as HTMLOptionElement).value, disabled: (o as HTMLOptionElement).disabled }))
      .filter((o) => o.value && !o.disabled)
  );
  expect(escOpts.length).toBeGreaterThan(0);
  await escModel.selectOption(escOpts[0].value);
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SHOT_DIR, '04-escalations-override.png'), fullPage: false });

  // Persist after reload
  await page.reload();
  await page.getByTestId('nav-project-setup').click();
  await page.getByTestId('tab-projects').click();
  await page.getByTestId('project-row-1').click();
  await page.getByTestId('project-subtab-agents').click();
  await page.getByTestId(`project-agent-row-${AID}`).click();
  await expect(page.getByTestId(`project-agent-toolkits-override-toggle-${AID}`)).toBeChecked({ timeout: 10000 });
  await expect(page.getByTestId(`project-agent-escalations-override-toggle-${AID}`)).toBeChecked();
  await page.screenshot({ path: path.join(SHOT_DIR, '05-persist-after-reload.png'), fullPage: false });

  // Reset to inherit
  await page.getByTestId(`project-agent-toolkits-reset-${AID}`).click();
  await page.waitForTimeout(500);
  await page.getByTestId(`project-agent-escalations-reset-${AID}`).click();
  await page.waitForTimeout(500);
  await expect(page.getByTestId(`project-agent-toolkits-override-toggle-${AID}`)).not.toBeChecked();
  await expect(page.getByTestId(`project-agent-escalations-override-toggle-${AID}`)).not.toBeChecked();
  await page.screenshot({ path: path.join(SHOT_DIR, '06-reset-inherit.png'), fullPage: false });
});