/**
 * B09 — Visible human-session collision refusal UI (AC12 / F-03 R3).
 *
 * HARD SAFETY:
 * - Runs only via playwright.cap.config.ts against :3110 (never default playwright.config.ts :3111).
 * - POST chat-session / agent-chat create routes are FULLY INTERCEPTED with a synthetic
 *   SESSION_NAME_COLLISION reason=human body — never continue to live spawn.
 * - Zero real session create/close. HELM_SESSION_JANITOR stays 0 (not flipped here).
 * - Spec name B09.live.spec.ts matches cap testMatch [ABS]\d+ (distinct from helm-ux B9.live.spec.ts).
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.HELM_BASE_URL || 'http://127.0.0.1:3110';
const CRED = process.env.HELM_OWNER_CRED || 'cards2-harness-563f750bebc23bba';
const EVIDENCE_DIR = path.join(process.cwd(), 'validation', 'B09');
const PLAN_DIR_EVIDENCE = path.join(
  process.cwd(),
  'plan',
  'janitor-audit-remediation',
  'validation',
  'B09'
);

const COLLISION_BODY = {
  error:
    'session name collision refused (human): will not replace live human session helm-b09-human-live',
  code: 'SESSION_NAME_COLLISION',
  reason: 'human',
  session_name: 'helm-b09-human-live',
};

function ensureEvidenceDirs() {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.mkdirSync(PLAN_DIR_EVIDENCE, { recursive: true });
}

test.describe('B09 live: human collision refusal visible (intercepted :3110)', () => {
  test('Studio Session On shows SESSION_NAME_COLLISION human refusal', async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    ensureEvidenceDirs();

    // --- Spec-name / config trap: must be cap config on :3110, not default :3111 ---
    expect(BASE).toMatch(/127\.0\.0\.1:3110|localhost:3110/);
    const baseURL = String(testInfo.project.use.baseURL || '');
    expect(baseURL).toMatch(/3110/);
    expect(baseURL).not.toMatch(/3111/);
    // Cap config file name is playwright.cap.config.ts; default config points at :3111 + fake tmux.
    const configPath = String((testInfo.config as { configFile?: string }).configFile || '');
    if (configPath) {
      expect(configPath).toMatch(/playwright\.cap\.config/);
      expect(configPath).not.toMatch(/playwright\.config\.ts$/);
    }

    const createPosts: { url: string; method: string }[] = [];

    // FULL INTERCEPT — never continue chat create to the live server.
    await page.route('**/api/agents/*/chat-session', async (route) => {
      const req = route.request();
      if (req.method() === 'POST') {
        createPosts.push({ url: req.url(), method: req.method() });
        return route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify(COLLISION_BODY),
        });
      }
      // GET/other on this pattern: block mutations only; allow non-POST to fail closed too.
      return route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'B09 intercept: only POST create is simulated' }),
      });
    });
    await page.route('**/api/projects/*/agent-chat/*', async (route) => {
      const req = route.request();
      const url = req.url();
      // Only intercept create: POST .../agent-chat/:agentId (no extra /:sid segment after agent id for message)
      // Create path is /api/projects/:pid/agent-chat/:agentId — no further path after agentId numeric.
      if (req.method() === 'POST' && /\/agent-chat\/\d+\/?(\?|$)/.test(url)) {
        createPosts.push({ url, method: req.method() });
        return route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify(COLLISION_BODY),
        });
      }
      // Message/stream/etc. — still do not hit live for safety on this suite's intercepted surface.
      if (req.method() !== 'GET') {
        return route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'B09 intercept: non-create agent-chat blocked' }),
        });
      }
      return route.continue();
    });

    await page.goto(`${BASE}/`);
    await page.locator('input[placeholder="owner credential"]').fill(CRED);
    await page.click('button:has-text("Login")');
    await page.getByTestId('nav-agent-studio').waitFor({ state: 'visible', timeout: 20_000 });

    await page.goto(`${BASE}/#02-studio-agents`);
    await expect(page.getByTestId('content-studio-agents')).toBeVisible({ timeout: 20_000 });

    // Select first agent. selectAgent opens configure; return to chat for Session On.
    const agentRow = page.getByTestId('agent-row').first();
    await expect(agentRow).toBeVisible({ timeout: 20_000 });
    await agentRow.click();
    const backToChat = page.getByTestId('as-configure-back');
    await expect(backToChat).toBeVisible({ timeout: 15_000 });
    await backToChat.click();

    const sessionToggle = page.getByTestId('as-chat-session-toggle');
    await expect(sessionToggle).toBeVisible({ timeout: 15_000 });
    await sessionToggle.click();

    const err = page.getByTestId('chat-err');
    await expect(err).toBeVisible({ timeout: 15_000 });
    const errText = await err.innerText();
    expect(errText).toMatch(/collision|will not replace|human/i);
    expect(errText).not.toMatch(/^fetch fail$/i);

    // At least one create POST was intercepted (never live).
    expect(createPosts.length).toBeGreaterThanOrEqual(1);
    expect(createPosts.every((p) => p.method === 'POST')).toBe(true);

    const shotName = 'B09-human-collision-refusal';
    const png = path.join(EVIDENCE_DIR, `${shotName}.png`);
    await page.screenshot({ path: png, fullPage: true });
    fs.copyFileSync(png, path.join(PLAN_DIR_EVIDENCE, `${shotName}.png`));
  });
});
