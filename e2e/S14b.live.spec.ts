/**
 * S14b — Sessions panel + human manual-close UI (AC9/10/11 replacement UI).
 *
 * HARD SAFETY:
 * - Runs only via playwright.cap.config.ts against :3110.
 * - GET /api/sessions and POST /api/sessions/:name/close are FULLY INTERCEPTED.
 * - Zero live session closes. Zero reliance on real registry rows for the close path.
 * - HELM_SESSION_JANITOR production remains 0 (not flipped by this suite).
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.HELM_BASE_URL || 'http://127.0.0.1:3110';
const CRED = process.env.HELM_OWNER_CRED || 'cards2-harness-563f750bebc23bba';

const HUMAN_ACTIVE = 'helm-s14b-human-active';
const HELM_ACTIVE = 'helm-s14b-helm-active';
const LEGACY_ACTIVE = 'helm-s14b-legacy';
const HUMAN_REAPED = 'helm-s14b-human-reaped';

type SynthSession = {
  name: string;
  kind: string | null;
  status: string;
  owner: string | null;
  project_id: number | null;
  run_id: number | null;
  created_at: string;
  ended_at: string | null;
};

function seedSessions(): SynthSession[] {
  const now = new Date().toISOString();
  return [
    {
      name: HUMAN_ACTIVE,
      kind: 'chat',
      status: 'active',
      owner: 'human',
      project_id: null,
      run_id: null,
      created_at: now,
      ended_at: null,
    },
    {
      name: HELM_ACTIVE,
      kind: 'worker',
      status: 'active',
      owner: 'helm',
      project_id: 1,
      run_id: 99,
      created_at: now,
      ended_at: null,
    },
    {
      name: LEGACY_ACTIVE,
      kind: 'other',
      status: 'active',
      owner: 'legacy:unknown',
      project_id: null,
      run_id: null,
      created_at: now,
      ended_at: null,
    },
    {
      name: HUMAN_REAPED,
      kind: 'chat',
      status: 'reaped',
      owner: 'human',
      project_id: null,
      run_id: null,
      created_at: now,
      ended_at: now,
    },
  ];
}

test.describe('S14b Sessions panel (intercepted :3110, never live close)', () => {
  test('visibility, confirm, one POST, success refresh, refusal error', async ({ page }) => {
    test.setTimeout(60_000);

    // Prove we are under the cap config contract (baseURL :3110).
    expect(BASE).toMatch(/127\.0\.0\.1:3110|localhost:3110/);

    let sessions = seedSessions();
    const closePosts: { url: string; method: string }[] = [];
    /** When true, next human close returns 403 not_human instead of success. */
    let refuseNextClose = false;

    // FULL INTERCEPT — never continue session list/close to the live server.
    await page.route('**/api/sessions**', async (route) => {
      const req = route.request();
      const url = req.url();
      const method = req.method();

      // GET /api/sessions (exact list, not /close)
      if (method === 'GET' && /\/api\/sessions\/?(\?|$)/.test(url)) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ sessions }),
        });
      }

      // POST /api/sessions/:name/close
      const closeMatch = url.match(/\/api\/sessions\/([^/?]+)\/close\/?$/);
      if (method === 'POST' && closeMatch) {
        const name = decodeURIComponent(closeMatch[1]);
        closePosts.push({ url, method });

        if (refuseNextClose) {
          refuseNextClose = false;
          return route.fulfill({
            status: 403,
            contentType: 'application/json',
            body: JSON.stringify({
              error: 'only human-owned sessions may be closed manually (owner=helm)',
              reason: 'not_human',
            }),
          });
        }

        // Success: drop row (or mark reaped) so refresh proves honest UI update.
        sessions = sessions.filter((s) => s.name !== name);
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, closed: name, already_reaped: false }),
        });
      }

      // Any other /api/sessions* path: refuse rather than continue (HARD SAFETY).
      return route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'S14b intercept: unhandled sessions route' }),
      });
    });

    await page.goto(`${BASE}/`);
    await page.locator('input[placeholder="owner credential"]').fill(CRED);
    await page.click('button:has-text("Login")');
    await page.getByTestId('nav-sessions').waitFor({ state: 'visible', timeout: 20_000 });
    await page.getByTestId('nav-sessions').click();
    await page.getByTestId('sessions-panel').waitFor({ state: 'visible', timeout: 15_000 });

    // --- Visibility: owner + status for synthetic rows ---
    await expect(page.getByTestId(`sessions-row-${HUMAN_ACTIVE}`)).toBeVisible();
    await expect(page.getByTestId(`sessions-owner-${HUMAN_ACTIVE}`)).toHaveText('human');
    await expect(page.getByTestId(`sessions-status-${HUMAN_ACTIVE}`)).toHaveText('active');
    await expect(page.getByTestId(`sessions-owner-${HELM_ACTIVE}`)).toHaveText('helm');
    await expect(page.getByTestId(`sessions-status-${HELM_ACTIVE}`)).toHaveText('active');
    await expect(page.getByTestId(`sessions-owner-${LEGACY_ACTIVE}`)).toHaveText('legacy:unknown');
    await expect(page.getByTestId(`sessions-status-${HUMAN_REAPED}`)).toHaveText('reaped');

    // Close control ONLY for human non-reaped.
    await expect(page.getByTestId(`sessions-close-${HUMAN_ACTIVE}`)).toBeVisible();
    await expect(page.getByTestId(`sessions-close-${HELM_ACTIVE}`)).toHaveCount(0);
    await expect(page.getByTestId(`sessions-close-${LEGACY_ACTIVE}`)).toHaveCount(0);
    await expect(page.getByTestId(`sessions-close-${HUMAN_REAPED}`)).toHaveCount(0);

    // --- Confirm dismiss → zero POST ---
    page.once('dialog', async (d) => {
      expect(d.type()).toBe('confirm');
      await d.dismiss();
    });
    await page.getByTestId(`sessions-close-${HUMAN_ACTIVE}`).click();
    await page.waitForTimeout(300);
    expect(closePosts.length).toBe(0);
    await expect(page.getByTestId(`sessions-row-${HUMAN_ACTIVE}`)).toBeVisible();

    // --- Confirm accept → exactly one POST + success refresh removes row ---
    page.once('dialog', async (d) => {
      expect(d.message()).toContain(HUMAN_ACTIVE);
      await d.accept();
    });
    await page.getByTestId(`sessions-close-${HUMAN_ACTIVE}`).click();
    await expect(page.getByTestId(`sessions-row-${HUMAN_ACTIVE}`)).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByTestId('sessions-success')).toBeVisible();
    expect(closePosts.length).toBe(1);
    expect(closePosts[0].method).toBe('POST');
    expect(decodeURIComponent(closePosts[0].url)).toContain(`/api/sessions/${HUMAN_ACTIVE}/close`);

    // Non-human rows still present (unchanged).
    await expect(page.getByTestId(`sessions-row-${HELM_ACTIVE}`)).toBeVisible();
    await expect(page.getByTestId(`sessions-row-${LEGACY_ACTIVE}`)).toBeVisible();

    // --- Refusal / error rendering (re-seed human, intercept 403) ---
    sessions = [
      ...sessions,
      {
        name: HUMAN_ACTIVE,
        kind: 'chat',
        status: 'active',
        owner: 'human',
        project_id: null,
        run_id: null,
        created_at: new Date().toISOString(),
        ended_at: null,
      },
    ];
    refuseNextClose = true;
    await page.getByTestId('sessions-refresh-btn').click();
    await expect(page.getByTestId(`sessions-close-${HUMAN_ACTIVE}`)).toBeVisible({ timeout: 10_000 });

    page.once('dialog', async (d) => d.accept());
    await page.getByTestId(`sessions-close-${HUMAN_ACTIVE}`).click();
    await expect(page.getByTestId('sessions-error')).toBeVisible({ timeout: 10_000 });
    const errText = await page.getByTestId('sessions-error').innerText();
    expect(errText).toMatch(/not_human|only human-owned/i);
    // Exactly one additional POST (total 2); still fully synthetic.
    expect(closePosts.length).toBe(2);

    // Screenshot evidence (optional path under plan validation).
    const evidenceDir = path.join(process.cwd(), 'plan', 'janitor-consent-redesign', 'validation');
    fs.mkdirSync(evidenceDir, { recursive: true });
    await page.screenshot({
      path: path.join(evidenceDir, 'S14b-sessions-panel.png'),
      fullPage: true,
    });
  });
});
