/**
 * batch-B13-T02 regression spot-check — Studio / Setup / Memory render + core function.
 */
import { test, expect } from '@playwright/test';
import path from 'node:path';

const CRED = process.env.HELM_OWNER_CRED || 'JROM-OWNER-SECRET-2026';
const SHOTS = path.join(process.cwd(), 'plan/WK_0703/cc-redesign/batch-B13-T02/screenshots');

async function login(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.locator('input[placeholder="owner credential"]').fill(CRED);
  await page.click('button:has-text("Login")');
  await expect(page.getByTestId('nav-agent-studio')).toBeVisible({ timeout: 15000 });
}

test.describe('B13-T02: Studio / Setup / Memory regression spot-check', () => {
  let token = '';
  let projectId = 0;

  test.beforeAll(async ({ request }) => {
    const loginResp = await request.post('/api/auth/login', { data: { credential: CRED } });
    const { token: t } = await loginResp.json();
    token = t;
    const dir = `/tmp/b13t02-regression-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const projResp = await request.post('/api/projects', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { name: `B13T02-regression-${Date.now()}`, directory: dir },
    });
    expect(projResp.ok()).toBeTruthy();
    const body = await projResp.json();
    projectId = body.project?.id ?? body.id;
    expect(projectId).toBeTruthy();
  });

  test('Studio: agents list renders + agent detail loads', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    await login(page);
    await page.getByTestId('nav-agent-studio').click();
    await page.getByTestId('tab-agents').click();
    await expect(page.locator('[data-testid="agent-row"]').first()).toBeVisible({ timeout: 10000 });
    await page.locator('[data-testid="agent-row"]').filter({ hasText: 'master_agent' }).first().click();
    await expect(page.getByTestId('chat-panel').first()).toBeVisible({ timeout: 8000 });
    await page.getByTestId('as-configure-entry').click();
    await expect(page.getByTestId('agent-detail-workspace')).toBeVisible({ timeout: 8000 });
    await expect(page.getByTestId('agent-tab-identity')).toHaveClass(/active/);
    await expect(page.getByTestId('as-context-identity')).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS, 'studio-agents.png') });
    expect(errors.some((e) => /SyntaxError|Unexpected token/i.test(e))).toBeFalsy();
  });

  test('Studio: models tab renders + model rows visible', async ({ page }) => {
    await login(page);
    await page.getByTestId('nav-agent-studio').click();
    await page.getByTestId('tab-models').click();
    await expect(page.getByTestId('content-studio-models')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-testid="model-row"]').first()).toBeVisible();
    await expect(page.locator('[data-testid="model-test-btn"]').first()).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS, 'studio-models.png') });
  });

  test('Setup: project list renders + autonomy_default toggle round-trips', async ({ page, request }) => {
    await login(page);
    await page.getByTestId('nav-project-setup').click();
    await page.getByTestId('tab-projects').click();
    await expect(page.getByTestId('project-list')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId(`project-row-${projectId}`)).toBeVisible({ timeout: 8000 });
    await page.getByTestId(`project-row-${projectId}`).click();
    await expect(page.getByTestId('project-autonomy-default')).toBeVisible({ timeout: 8000 });

    await page.getByTestId('autonomy-autonomous-after-discovery').click();
    await page.waitForTimeout(400);
    const cfg1 = await request.get(`/api/projects/${projectId}/config`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const d1 = await cfg1.json();
    expect(d1.autonomy_default).toBe('autonomous_after_discovery');

    await page.getByTestId('autonomy-pause-after-planning').click();
    await page.waitForTimeout(400);
    const cfg2 = await request.get(`/api/projects/${projectId}/config`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const d2 = await cfg2.json();
    expect(d2.autonomy_default).toBe('pause_after_planning');
    await page.screenshot({ path: path.join(SHOTS, 'setup-projects-autonomy.png') });
  });

  test('Memory: scope/horizon filters + CRUD + promote', async ({ page, request }) => {
    const title = `B13T02-short-${Date.now()}`;
    await request.post('/api/memory', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { scope: 'app', title, body: 'short-term for promote test', horizon: 'short' },
    });

    await login(page);
    await page.getByTestId('nav-memory').click();
    await expect(page.getByTestId('content-memory').first()).toBeVisible({ timeout: 10000 });

    await page.getByTestId('memory-horizon-short').click();
    await page.getByTestId('memory-refresh-btn').click().catch(() => {});
    await page.waitForTimeout(500);
    await expect(page.locator('[data-testid^="memory-row-"]').filter({ hasText: title }).first()).toBeVisible({ timeout: 8000 });

    await page.getByTestId('memory-horizon-long').click();
    await page.waitForTimeout(300);

    await page.getByTestId('memory-add-btn').click();
    await expect(page.getByTestId('memory-form-title')).toBeVisible();
    const longTitle = `B13T02-long-${Date.now()}`;
    await page.getByTestId('memory-form-title').fill(longTitle);
    await page.getByTestId('memory-form-body').fill('regression CRUD body');
    await page.getByTestId('memory-save-btn').click();
    await page.waitForTimeout(400);
    await expect(page.getByText(longTitle)).toBeVisible({ timeout: 8000 });

    await page.getByTestId('memory-horizon-short').click();
    await page.waitForTimeout(300);
    const row = page.locator(`[data-testid^="memory-row-"]`).filter({ hasText: title }).first();
    await expect(row).toBeVisible({ timeout: 8000 });
    await row.locator('input[type="checkbox"]').check();
    await page.getByTestId('memory-promote-btn').click();
    await page.waitForTimeout(500);
    await page.getByTestId('memory-horizon-long').click();
    await page.getByTestId('memory-refresh-btn').click().catch(() => {});
    await page.waitForTimeout(500);
    await expect(page.locator('[data-testid^="memory-row-"]').filter({ hasText: title }).first()).toBeVisible({ timeout: 8000 });
    await page.screenshot({ path: path.join(SHOTS, 'memory-crud-promote.png') });
  });
});