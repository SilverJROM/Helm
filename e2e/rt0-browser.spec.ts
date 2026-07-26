import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';

const CRED = process.env.HELM_OWNER_CRED || 'JROM-OWNER-SECRET-2026';

test.describe('A1: shell smoke (supersedes old RT0 browser flow)', () => {
  test.afterAll(() => {
    try { execSync("tmux ls 2>/dev/null | grep -oE '^helm-[A-Za-z0-9._-]+' | grep -v '^helm-grok$' | grep -v '^helm-panel' | xargs -r -I{} tmux kill-session -t {} 2>/dev/null", { stdio: 'ignore' }); } catch {}
  });

  test('A1: login + 4 sections + tabs (no SyntaxError)', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));

    await page.goto('/');
    await expect(page.locator('text=Helm')).toBeVisible({ timeout: 15000 });
    await page.fill('input[placeholder="owner credential"]', CRED);
    await page.click('button:has-text("Login")');
    await expect(page.getByTestId('nav-agent-studio')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('nav-project-setup')).toBeVisible();
    await expect(page.getByTestId('nav-command-center')).toBeVisible();
    await expect(page.getByTestId('nav-memory')).toBeVisible();
    await page.getByTestId('nav-agent-studio').click();
    await expect(page.getByTestId('tab-models')).toBeVisible();
    expect(errors.some((e) => /SyntaxError|Unexpected token/.test(e))).toBeFalsy();
  });
});
