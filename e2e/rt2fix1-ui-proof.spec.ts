import { test, expect } from '@playwright/test';
import path from 'node:path';

const CRED = process.env.HELM_OWNER_CRED || 'JROM-OWNER-SECRET-2026';
const BASE = process.env.HELM_BASE_URL || 'http://127.0.0.1:3110';
const SHOT_DIR = path.join(process.cwd(), 'plan/WK_0624/projects-section-run-2026-06-24/rt2fix1/screenshots');

test('rt2fix1 Projects section aria-labels + keyboard row activation', async ({ page }) => {
  test.setTimeout(90000);
  await page.goto(BASE + '/');
  await page.locator('input[placeholder="owner credential"]').fill(CRED);
  await page.click('button:has-text("Login")');
  await expect(page.getByTestId('nav-project-setup')).toBeVisible({ timeout: 15000 });

  await page.getByTestId('nav-project-setup').click();
  await page.getByTestId('tab-projects').click();

  await expect(page.getByTestId('project-page-size')).toHaveAttribute('aria-label', 'Items per page');
  await expect(page.getByTestId('project-tag-filter')).toHaveAttribute('aria-label', 'Filter by project tag');

  await page.getByTestId('add-project-btn').click();
  await expect(page.getByTestId('new-proj-name')).toHaveAttribute('aria-label', 'New project name');
  await expect(page.getByTestId('new-proj-dir')).toHaveAttribute('aria-label', 'New project directory path');

  await expect(page.getByTestId('project-row-1')).toHaveAttribute('role', 'button');
  await expect(page.getByTestId('project-row-1')).toHaveAttribute('tabindex', '0');
  await expect(page.getByTestId('project-row-1')).toHaveAttribute('aria-label', /Select project/);
  await expect(page.getByTestId('delete-project-1')).toHaveAttribute('aria-label', 'Delete project');

  await page.getByTestId('project-row-1').click();
  await page.getByTestId('project-subtab-detail').click();
  await page.getByTestId('edit-project-btn').click();

  const detailLabels: Array<[string, string]> = [
    ['edit-proj-name', 'Project name'],
    ['edit-proj-description', 'Project description'],
    ['edit-proj-dir', 'Project directory path'],
    ['edit-proj-dev-url', 'Development deploy URL'],
    ['edit-proj-qa-url', 'QA deploy URL'],
  ];
  for (const [id, label] of detailLabels) {
    await expect(page.getByTestId(id)).toHaveAttribute('aria-label', label);
  }

  await page.getByTestId('project-subtab-agents').click();
  // B3: unified agent list + Team roles strip (no Solo/Team subtabs)
  await expect(page.getByTestId('add-agent-select')).toHaveAttribute('aria-label', 'Select agent to add');
  await expect(page.locator('[data-testid^="project-agent-row-"]').first().getByRole('button', { name: 'Remove agent' })).toBeVisible();
  await expect(page.getByTestId('team-roles-strip')).toBeVisible();
  await expect(page.getByTestId('add-team-select')).toHaveAttribute('aria-label', 'Select team to bind');

  await page.getByTestId('project-subtab-documents').click();
  await page.getByTestId('doc-subtab-docs').click();
  await expect(page.getByTestId('doc-row-overview.md')).toHaveAttribute('role', 'button');
  await expect(page.getByTestId('doc-row-overview.md')).toHaveAttribute('aria-label', 'View document overview.md');

  await page.getByTestId('docs-new-btn').click();
  await expect(page.getByTestId('docs-new-folder')).toHaveAttribute('aria-label', 'New document folder');
  await expect(page.getByTestId('docs-new-name')).toHaveAttribute('aria-label', 'New document filename');
  await expect(page.getByTestId('docs-new-content')).toHaveAttribute('aria-label', 'New document content');
  await page.getByTestId('docs-new-cancel').click();

  await page.getByTestId('doc-row-overview.md').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('viewed-doc-pane')).toBeVisible({ timeout: 10000 });

  await page.getByTestId('docs-edit-btn').click();
  await expect(page.getByTestId('docs-edit-textarea')).toHaveAttribute('aria-label', 'Edit document content');
  await page.getByTestId('docs-edit-cancel').click();

  await page.screenshot({ path: path.join(SHOT_DIR, '01-aria-labels.png'), fullPage: false });
});