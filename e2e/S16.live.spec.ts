/**
 * S16 — GATE-ATOMIC Studio house+tiered UI proof (AC28/29/31).
 *
 * HARD SAFETY:
 * - Runs only via playwright.cap.config.ts against :3110.
 * - GET/PUT agents, escalations, and models list are FULLY INTERCEPTED for the synthetic housekeeper.
 * - Zero live DB writes for agent/escalation mutations.
 * - HELM_SESSION_JANITOR production remains 0 (not flipped by this suite).
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.HELM_BASE_URL || 'http://127.0.0.1:3110';
const CRED = process.env.HELM_OWNER_CRED || 'cards2-harness-563f750bebc23bba';

const HK_ID = 91016;
const MODEL_MAIN = 91001;
const MODEL_B1 = 91002;
const MODEL_B2 = 91003;
const MODEL_ALT = 91004;

const SEED_PROMPT =
  '# housekeeper — S16 fixture\n\nKeep-biased. needs-human on uncertainty. Evidence recorded. helm-owned seats only. Cooldown. Bounded-input: pane tail + callback.\n';
const EDITED_PROMPT = '# housekeeper — S16 edited prompt\n\nStudio-persisted definition_md for AC31.\n';

type SynthAgent = {
  id: number;
  name: string;
  provider: string;
  model: string;
  default_effort: string;
  definition_md: string;
  default_model_id: number;
  backup_model_id: number | null;
  spawn_pref: string;
  in_development: boolean;
  kind: 'house';
  agent_type: 'house';
  classification: 'tiered';
  created_at: string;
  updated_at: string;
};

type SynthEsc = {
  position: number;
  model_id: number;
  trigger: string;
  effort: string | null;
};

type SynthModel = {
  id: number;
  name: string;
  provider: string;
  model_id: string;
  cli: string;
  slug: string;
  display_name: string;
  validation_status: 'valid';
  effort: string;
};

function seedModels(): SynthModel[] {
  return [
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
    {
      id: MODEL_ALT,
      name: 'sonnet5',
      provider: 'claude',
      model_id: 'claude-sonnet-4-6',
      cli: 'claude',
      slug: 'sonnet5',
      display_name: 'sonnet5',
      validation_status: 'valid',
      effort: 'high',
    },
  ];
}

function seedHousekeeper(): SynthAgent {
  const now = new Date().toISOString();
  return {
    id: HK_ID,
    name: 'housekeeper',
    provider: 'grok',
    model: 'grok-4.5',
    default_effort: 'medium',
    definition_md: SEED_PROMPT,
    default_model_id: MODEL_MAIN,
    backup_model_id: null,
    spawn_pref: 'tmux',
    in_development: false,
    kind: 'house',
    agent_type: 'house',
    classification: 'tiered',
    created_at: now,
    updated_at: now,
  };
}

function seedEscalations(): SynthEsc[] {
  return [
    { position: 1, model_id: MODEL_B1, trigger: 'on-fail', effort: null },
    { position: 2, model_id: MODEL_B2, trigger: 'on-fail', effort: null },
  ];
}

test.describe('S16 Studio house+tiered (intercepted :3110, never live agent mutate)', () => {
  test('renders main+2 rungs+prompt; PUT payloads persist via controlled reload', async ({ page }) => {
    test.setTimeout(90_000);
    expect(BASE).toMatch(/127\.0\.0\.1:3110|localhost:3110/);

    let agent = seedHousekeeper();
    let escalations = seedEscalations();
    const models = seedModels();
    const putAgentBodies: unknown[] = [];
    const putEscBodies: unknown[] = [];

    // FULL INTERCEPT for agents / escalations / models used by Studio editor.
    await page.route('**/api/models**', async (route) => {
      const req = route.request();
      const url = req.url();
      const method = req.method();
      // Only list endpoint; let validate/etc. fail closed rather than hit live with our ids.
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
        body: JSON.stringify({ error: 'S16 intercept: unhandled models route' }),
      });
    });

    await page.route('**/api/agents**', async (route) => {
      const req = route.request();
      const url = req.url();
      const method = req.method();

      // GET list
      if (method === 'GET' && /\/api\/agents\/?(\?|$)/.test(url)) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ agents: [agent] }),
        });
      }

      // GET active-sessions (noise; keep Studio happy)
      if (method === 'GET' && /\/api\/agents\/active-sessions/.test(url)) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ sessions: [] }),
        });
      }

      // GET /api/agents/:id/escalations
      const escGet = url.match(/\/api\/agents\/(\d+)\/escalations\/?$/);
      if (method === 'GET' && escGet) {
        const id = Number(escGet[1]);
        if (id !== HK_ID) {
          return route.fulfill({
            status: 404,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'unknown agent' }),
          });
        }
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ escalations }),
        });
      }

      // PUT /api/agents/:id/escalations
      const escPut = url.match(/\/api\/agents\/(\d+)\/escalations\/?$/);
      if (method === 'PUT' && escPut) {
        const id = Number(escPut[1]);
        expect(id).toBe(HK_ID);
        const body = req.postDataJSON() as { rungs?: SynthEsc[] };
        putEscBodies.push(body);
        const rungs = (body.rungs || []).filter((r) => r.model_id != null);
        escalations = rungs.map((r) => ({
          position: Number(r.position),
          model_id: Number(r.model_id),
          trigger: r.trigger || 'on-fail',
          effort: r.effort ?? null,
        }));
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ escalations }),
        });
      }

      // GET /api/agents/:id/toolkits
      if (method === 'GET' && /\/api\/agents\/\d+\/toolkits\/?$/.test(url)) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ toolkits: [] }),
        });
      }

      // GET /api/agents/:id (detail) — not subpaths
      const detailGet = url.match(/\/api\/agents\/(\d+)\/?(\?|$)/);
      if (method === 'GET' && detailGet && !/\/api\/agents\/\d+\//.test(url.replace(/\?.*$/, ''))) {
        const id = Number(detailGet[1]);
        if (id !== HK_ID) {
          return route.fulfill({
            status: 404,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'unknown agent' }),
          });
        }
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            agent,
            identity: agent.definition_md,
            tiers: {},
          }),
        });
      }

      // PUT /api/agents/:id
      const agentPut = url.match(/\/api\/agents\/(\d+)\/?$/);
      if (method === 'PUT' && agentPut) {
        const id = Number(agentPut[1]);
        expect(id).toBe(HK_ID);
        const body = req.postDataJSON() as Partial<SynthAgent>;
        putAgentBodies.push(body);
        agent = {
          ...agent,
          ...body,
          id: HK_ID,
          name: body.name || agent.name,
          kind: 'house',
          agent_type: 'house',
          classification: (body.classification as 'tiered') || agent.classification,
          definition_md:
            body.definition_md !== undefined && body.definition_md !== null
              ? String(body.definition_md)
              : agent.definition_md,
          default_model_id:
            body.default_model_id != null ? Number(body.default_model_id) : agent.default_model_id,
          backup_model_id:
            body.backup_model_id === undefined
              ? agent.backup_model_id
              : body.backup_model_id == null
                ? null
                : Number(body.backup_model_id),
          updated_at: new Date().toISOString(),
        };
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ agent }),
        });
      }

      // Refuse other agent mutations rather than continue (HARD SAFETY).
      if (method !== 'GET') {
        return route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'S16 intercept: unhandled agents route', url, method }),
        });
      }

      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ agents: [agent] }),
      });
    });

    // Empty proposals so identity tab stays quiet.
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
        body: JSON.stringify({ error: 'S16 intercept: proposals mutation blocked' }),
      });
    });

    await page.goto(`${BASE}/`);
    await page.locator('input[placeholder="owner credential"]').fill(CRED);
    await page.click('button:has-text("Login")');
    await page.getByTestId('nav-agent-studio').waitFor({ state: 'visible', timeout: 20_000 });
    await page.getByTestId('nav-agent-studio').click();

    // House roster + housekeeper row (kind + classification chips).
    await expect(page.getByTestId('roster-section-house-wrap')).toBeVisible({ timeout: 15_000 });
    const hkRow = page.locator('[data-testid="agent-row"][data-kind="house"]').filter({ hasText: 'housekeeper' });
    await expect(hkRow).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`studio-agent-classification-chip-${HK_ID}`)).toHaveAttribute(
      'data-class',
      'tiered'
    );
    await hkRow.click();

    // Models tab opens by selectAgent; prove tiered panel + main + two backup rungs.
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

    // Identity prompt visible (selectAgent sets rendered mode).
    await page.getByTestId('agent-tab-identity').click();
    await expect(page.getByTestId('agent-tab-identity-panel')).toBeVisible();
    await expect(page.getByTestId('agent-identity-rendered')).toContainText(/Keep-biased|keep-biased/i);

    // Edit definition_md and Save → PUT /api/agents/:id with new prompt.
    await page.getByTestId('agent-def-md-view-btn').click(); // rendered → edit
    await expect(page.getByTestId('agent-def-md')).toBeVisible();
    await page.getByTestId('agent-def-md').fill(EDITED_PROMPT);
    await page.getByTestId('agent-save-btn').click();
    await expect.poll(() => putAgentBodies.length).toBeGreaterThanOrEqual(1);
    const lastPut = putAgentBodies[putAgentBodies.length - 1] as { definition_md?: string; classification?: string };
    expect(lastPut.definition_md).toBe(EDITED_PROMPT);
    expect(lastPut.classification).toBe('tiered');

    // After save, selectAgent resets to Models tab — re-open Identity and prove controlled persisted prompt.
    await page.getByTestId('agent-tab-identity').click();
    await expect(page.getByTestId('agent-identity-rendered')).toContainText('S16 edited prompt', {
      timeout: 10_000,
    });

    // Mutate backup-2 (L3 / position=2) on Models tab; ladder saves immediately via PUT escalations.
    await page.getByTestId('agent-tab-models').click();
    await expect(page.getByTestId('agent-model-l3')).toBeVisible();
    await page.getByTestId('agent-model-l3').selectOption(String(MODEL_ALT));
    await expect.poll(() => putEscBodies.length).toBeGreaterThanOrEqual(1);
    const lastEsc = putEscBodies[putEscBodies.length - 1] as {
      rungs: Array<{ position: number; model_id: number }>;
    };
    const pos2 = lastEsc.rungs.find((r) => Number(r.position) === 2);
    expect(pos2).toBeTruthy();
    expect(Number(pos2!.model_id)).toBe(MODEL_ALT);
    // pos1 retained in payload when changing L3
    const pos1 = lastEsc.rungs.find((r) => Number(r.position) === 1);
    expect(pos1).toBeTruthy();
    expect(Number(pos1!.model_id)).toBe(MODEL_B1);

    await expect(page.getByTestId('agent-model-l3')).toHaveValue(String(MODEL_ALT));
    await expect(page.getByTestId('agent-model-l1')).toHaveValue(String(MODEL_MAIN));
    await expect(page.getByTestId('agent-model-l2')).toHaveValue(String(MODEL_B1));

    // Re-select housekeeper from roster → controlled GET escalations show persisted backup-2.
    await page.locator('[data-testid="agent-row"][data-kind="house"]').filter({ hasText: 'housekeeper' }).click();
    await expect(page.getByTestId('agent-model-l3')).toHaveValue(String(MODEL_ALT), { timeout: 10_000 });
    await expect(page.getByTestId('agent-tab-models-panel')).toHaveAttribute(
      'data-classification',
      'tiered'
    );

    // Screenshot evidence under plan validation.
    const evidenceDir = path.join(process.cwd(), 'plan', 'janitor-consent-redesign', 'validation');
    fs.mkdirSync(evidenceDir, { recursive: true });
    await page.screenshot({
      path: path.join(evidenceDir, 'S16-studio-house-tiered.png'),
      fullPage: true,
    });
  });
});
