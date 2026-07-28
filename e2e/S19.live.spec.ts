/**
 * S19 — GATE-ATOMIC + RELEASE-ATOMIC capstone UI evidence (AC9–11 UI, AC28/29/31 UI).
 *
 * HARD SAFETY:
 * - Runs only via playwright.cap.config.ts against :3110.
 * - Sessions list/close and Studio agents/models routes are FULLY INTERCEPTED.
 * - Zero live session close. Zero live agent/escalation mutation.
 * - HELM_SESSION_JANITOR production remains 0 (not flipped by this suite).
 *
 * Purpose: capstone screenshots for manual close panel + Housekeeper Studio
 * under controlled synthetic fixtures (evidence-only; no product redesign).
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.HELM_BASE_URL || 'http://127.0.0.1:3110';
const CRED = process.env.HELM_OWNER_CRED || 'cards2-harness-563f750bebc23bba';

const HUMAN_ACTIVE = 'helm-s19-human-active';
const HELM_ACTIVE = 'helm-s19-helm-active';
const LEGACY_ACTIVE = 'helm-s19-legacy';

const HK_ID = 91019;
const MODEL_MAIN = 91011;
const MODEL_B1 = 91012;
const MODEL_B2 = 91013;

const HK_PROMPT =
  '# housekeeper — S19 capstone fixture\n\nKeep-biased. needs-human on uncertainty. Evidence recorded. helm-owned seats only. Cooldown. Bounded-input.\n';

const EVIDENCE_DIR = path.join(process.cwd(), 'plan', 'janitor-consent-redesign', 'validation');

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
  ];
}

test.describe('S19 capstone UI evidence (intercepted :3110)', () => {
  test('manual-close Sessions panel screenshot', async ({ page }) => {
    test.setTimeout(90_000);
    expect(BASE).toMatch(/127\.0\.0\.1:3110|localhost:3110/);

    const sessions = seedSessions();

    await page.route('**/api/sessions**', async (route) => {
      const req = route.request();
      const url = req.url();
      const method = req.method();

      if (method === 'GET' && /\/api\/sessions\/?(\?|$)/.test(url)) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ sessions }),
        });
      }

      // HARD SAFETY: never continue close (or any other sessions mutation) to live.
      return route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'S19 intercept: sessions mutation blocked', method, url }),
      });
    });

    await page.goto(`${BASE}/`);
    await page.locator('input[placeholder="owner credential"]').fill(CRED);
    await page.click('button:has-text("Login")');
    await page.getByTestId('nav-sessions').waitFor({ state: 'visible', timeout: 20_000 });
    await page.getByTestId('nav-sessions').click();
    await page.getByTestId('sessions-panel').waitFor({ state: 'visible', timeout: 15_000 });

    await expect(page.getByTestId(`sessions-row-${HUMAN_ACTIVE}`)).toBeVisible();
    await expect(page.getByTestId(`sessions-owner-${HUMAN_ACTIVE}`)).toHaveText('human');
    await expect(page.getByTestId(`sessions-close-${HUMAN_ACTIVE}`)).toBeVisible();
    await expect(page.getByTestId(`sessions-close-${HELM_ACTIVE}`)).toHaveCount(0);
    await expect(page.getByTestId(`sessions-close-${LEGACY_ACTIVE}`)).toHaveCount(0);
    await expect(page.getByTestId(`sessions-owner-${HELM_ACTIVE}`)).toHaveText('helm');
    await expect(page.getByTestId(`sessions-owner-${LEGACY_ACTIVE}`)).toHaveText('legacy:unknown');

    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    await page.screenshot({
      path: path.join(EVIDENCE_DIR, 'S19-manual-close.png'),
      fullPage: true,
    });
  });

  test('Housekeeper Studio house+tiered screenshot', async ({ page }) => {
    test.setTimeout(90_000);
    expect(BASE).toMatch(/127\.0\.0\.1:3110|localhost:3110/);

    const now = new Date().toISOString();
    const agent = {
      id: HK_ID,
      name: 'housekeeper',
      provider: 'grok',
      model: 'grok-4.5',
      default_effort: 'medium',
      definition_md: HK_PROMPT,
      default_model_id: MODEL_MAIN,
      backup_model_id: null as number | null,
      spawn_pref: 'tmux',
      in_development: false,
      kind: 'house' as const,
      agent_type: 'house' as const,
      classification: 'tiered' as const,
      created_at: now,
      updated_at: now,
    };
    const escalations = [
      { position: 1, model_id: MODEL_B1, trigger: 'on-fail', effort: null as string | null },
      { position: 2, model_id: MODEL_B2, trigger: 'on-fail', effort: null as string | null },
    ];
    const models = [
      {
        id: MODEL_MAIN,
        name: 'grok45',
        provider: 'grok',
        model_id: 'grok-4.5',
        cli: 'grok',
        slug: 'grok45',
        display_name: 'grok45',
        validation_status: 'valid',
        effort: 'medium',
      },
      {
        id: MODEL_B1,
        name: 'spark',
        provider: 'claude',
        model_id: 'claude-spark',
        cli: 'claude',
        slug: 'spark',
        display_name: 'spark',
        validation_status: 'valid',
        effort: 'medium',
      },
      {
        id: MODEL_B2,
        name: 'haiku',
        provider: 'claude',
        model_id: 'claude-haiku',
        cli: 'claude',
        slug: 'haiku',
        display_name: 'haiku',
        validation_status: 'valid',
        effort: 'low',
      },
    ];

    await page.route('**/api/models**', async (route) => {
      const req = route.request();
      const url = req.url();
      const method = req.method();
      if (method === 'GET' && /\/api\/models\/?(\?|$)/.test(url)) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ models }),
        });
      }
      if (method === 'GET' && /\/api\/models\/clis/.test(url)) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ clis: ['claude', 'grok', 'codex'] }),
        });
      }
      if (method === 'GET' && /\/api\/models\/providers/.test(url)) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ providers: ['claude', 'grok'] }),
        });
      }
      return route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'S19 intercept: unhandled models route' }),
      });
    });

    await page.route('**/api/agents**', async (route) => {
      const req = route.request();
      const url = req.url();
      const method = req.method();

      if (method === 'GET' && /\/api\/agents\/?(\?|$)/.test(url)) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ agents: [agent] }),
        });
      }
      if (method === 'GET' && /\/api\/agents\/active-sessions/.test(url)) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ sessions: [] }),
        });
      }
      const escGet = url.match(/\/api\/agents\/(\d+)\/escalations\/?$/);
      if (method === 'GET' && escGet) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ escalations }),
        });
      }
      if (method === 'GET' && /\/api\/agents\/\d+\/toolkits\/?$/.test(url)) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ toolkits: [] }),
        });
      }
      const detailGet = url.match(/\/api\/agents\/(\d+)\/?(\?|$)/);
      if (method === 'GET' && detailGet && !/\/api\/agents\/\d+\//.test(url.replace(/\?.*$/, ''))) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ agent, identity: agent.definition_md, tiers: {} }),
        });
      }
      // HARD SAFETY: block mutations rather than continue to live.
      if (method !== 'GET') {
        return route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'S19 intercept: agent mutation blocked', method, url }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ agents: [agent] }),
      });
    });

    await page.route('**/api/proposals**', async (route) => {
      if (route.request().method() === 'GET') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ proposals: [] }),
        });
      }
      return route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'S19 intercept: proposals mutation blocked' }),
      });
    });

    await page.goto(`${BASE}/`);
    await page.locator('input[placeholder="owner credential"]').fill(CRED);
    await page.click('button:has-text("Login")');
    await page.getByTestId('nav-agent-studio').waitFor({ state: 'visible', timeout: 20_000 });
    await page.getByTestId('nav-agent-studio').click();

    await expect(page.getByTestId('roster-section-house-wrap')).toBeVisible({ timeout: 15_000 });
    const hkRow = page.locator('[data-testid="agent-row"][data-kind="house"]').filter({ hasText: 'housekeeper' });
    await expect(hkRow).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`studio-agent-classification-chip-${HK_ID}`)).toHaveAttribute(
      'data-class',
      'tiered'
    );
    await hkRow.click();

    await expect(page.getByTestId('agent-tab-models-panel')).toHaveAttribute(
      'data-classification',
      'tiered',
      { timeout: 10_000 }
    );
    await expect(page.getByTestId('agent-model-l1')).toHaveValue(String(MODEL_MAIN));
    await expect(page.getByTestId('agent-escalation-rung-1')).toBeVisible();
    await expect(page.getByTestId('agent-escalation-rung-2')).toBeVisible();
    await expect(page.getByTestId('agent-model-l2')).toHaveValue(String(MODEL_B1));
    await expect(page.getByTestId('agent-model-l3')).toHaveValue(String(MODEL_B2));

    await page.getByTestId('agent-tab-identity').click();
    await expect(page.getByTestId('agent-identity-rendered')).toContainText(/Keep-biased|keep-biased/i);

    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    await page.screenshot({
      path: path.join(EVIDENCE_DIR, 'S19-housekeeper-studio.png'),
      fullPage: true,
    });
  });
});
