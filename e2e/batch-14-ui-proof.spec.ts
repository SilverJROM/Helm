import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const CRED = process.env.HELM_OWNER_CRED || 'JROM-OWNER-SECRET-2026';
const SHOT_DIR = path.join(process.cwd(), 'plan/WK_0624/projects-section-run-2026-06-24/batch-14/screenshots');
const PROJ_DIR = `/tmp/helm-b14-ui-proof-${process.pid}`;
const EDIT_MARKER = 'BATCH14-EDIT-MARKER-PROOF';

async function openDocsTab(page: import('@playwright/test').Page, projectId: number) {
  await page.getByTestId('nav-project-setup').click();
  await page.getByTestId('tab-projects').click();
  await page.getByTestId(`project-row-${projectId}`).click();
  await page.getByTestId('project-subtab-documents').click();
  await page.getByTestId('doc-subtab-docs').click();
  await expect(page.getByTestId('docs-tree')).toBeVisible({ timeout: 15000 });
}

test.describe('batch-14 docs UI-PROOF (folder-grouped + edit round-trip)', () => {
  let token = '';
  let projectId = 0;

  test.beforeAll(async ({ request }) => {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    fs.mkdirSync(PROJ_DIR, { recursive: true });
    const loginResp = await request.post('/api/auth/login', { data: { credential: CRED } });
    const { token: t } = await loginResp.json();
    token = t;
    const projResp = await request.post('/api/projects', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { name: 'B14 UI Proof', directory: PROJ_DIR },
    });
    expect(projResp.ok()).toBeTruthy();
    const { project } = await projResp.json();
    projectId = project.id;
  });

  test.afterAll(async () => {
    try { fs.rmSync(PROJ_DIR, { recursive: true, force: true }); } catch {}
  });

  test('folder-grouped sections + edit save persists and re-renders', async ({ page }) => {
    test.setTimeout(120000);
    page.on('dialog', (d) => d.accept());

    await page.goto('/');
    await page.locator('input[placeholder="owner credential"]').fill(CRED);
    await page.click('button:has-text("Login")');
    await expect(page.getByTestId('nav-project-setup')).toBeVisible({ timeout: 15000 });

    await openDocsTab(page, projectId);

    await expect(page.getByTestId('docs-group-root')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('doc-row-overview.md')).toBeVisible();

    await page.getByTestId('docs-new-btn').click();
    await page.getByTestId('docs-new-folder').fill('reference');
    await page.getByTestId('docs-new-name').fill('batch14-proof.md');
    await page.getByTestId('docs-new-content').fill('# Batch14 Proof\n\nUI-created for folder grouping.\n');
    await page.getByTestId('docs-new-save').click();
    await expect(page.getByTestId('docs-group-reference')).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('doc-row-reference-batch14-proof.md')).toBeVisible();
    await page.screenshot({ path: path.join(SHOT_DIR, '01-folder-grouped.png'), fullPage: false });

    await page.getByTestId('doc-row-overview.md').click();
    await expect(page.getByTestId('viewed-doc-pane')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('md-view')).toBeVisible();

    await page.getByTestId('docs-edit-btn').click();
    await expect(page.getByTestId('docs-edit-textarea')).toBeVisible();
    const ta = page.getByTestId('docs-edit-textarea');
    const prior = await ta.inputValue();
    await ta.fill(prior + '\n\n' + EDIT_MARKER + '\n');

    await page.getByTestId('docs-edit-save').click();
    await expect(page.getByTestId('docs-edit-textarea')).not.toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('md-view')).toContainText(EDIT_MARKER, { timeout: 15000 });
    await page.screenshot({ path: path.join(SHOT_DIR, '02-edit-saved.png'), fullPage: false });

    await page.reload();
    await openDocsTab(page, projectId);
    await page.getByTestId('doc-row-overview.md').click();
    await expect(page.getByTestId('md-view')).toContainText(EDIT_MARKER, { timeout: 15000 });

    await page.getByTestId('doc-row-reference-batch14-proof.md').click();
    await page.getByTestId('docs-delete-btn').click();
    await expect(page.getByTestId('doc-row-reference-batch14-proof.md')).not.toBeVisible({ timeout: 10000 });
  });
});