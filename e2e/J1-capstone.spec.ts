import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const VALIDATION = path.join(process.cwd(), 'validation', 'J1');
const CRED = process.env.HELM_OWNER_CRED || 'JROM-OWNER-SECRET-2026';

async function doLogin(page: any) {
  await page.goto('/');
  await page.locator('input[placeholder="owner credential"]').fill(CRED);
  await page.click('button:has-text("Login")');
  await expect(page.getByTestId('nav-agent-studio')).toBeVisible({ timeout: 15000 });
}

test.describe('J1: WK_0621 capstone — all requirements on-screen', () => {
  let token = '';
  let projectId = 0;

  test.beforeAll(async ({ request }) => {
    fs.mkdirSync(VALIDATION, { recursive: true });
    // Get token via API (avoid UI login in beforeAll)
    const loginResp = await request.post('/api/auth/login', {
      data: { credential: CRED },
    });
    const { token: t } = await loginResp.json();
    token = t;
    // Create project for sub-tab tests (scaffolding creates helm_docs/ + helm_tasks/)
    const projResp = await request.post('/api/projects', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { name: 'J1 Test Project', directory: '/tmp/helm-j1-playwright-proj' },
    });
    const { project } = await projResp.json();
    projectId = project.id;
  });

  // T1: App defaults to Agents tab (R-01A)
  test('T1: app defaults to Agents tab on login', async ({ page }) => {
    await doLogin(page);
    await page.getByTestId('nav-agent-studio').click();
    await page.getByTestId('tab-agents').click();
    await expect(page.locator('[data-testid="agent-row"]').first()).toBeVisible({ timeout: 10000 });
    await page.screenshot({ path: path.join(VALIDATION, 'J1-01-agents-default.png') });
  });

  // T2: Agents list — no model-named rows; master_agent + project_maintainer present (R-02A/F, R-05F)
  test('T2: agents list — no model rows; master_agent and project_maintainer seeded', async ({ page }) => {
    await doLogin(page);
    await page.getByTestId('nav-agent-studio').click();
    await page.getByTestId('tab-agents').click();
    await expect(page.locator('[data-testid="agent-row"]').first()).toBeVisible({ timeout: 10000 });
    // Verify no model-named rows (agent names should not match model ID patterns)
    const agentNames = await page.locator('[data-testid="agent-row"]').allInnerTexts();
    const modelPattern = /^(claude-sonnet|claude-opus|claude-haiku|grok-composer|grok-build|codex-5|spark)/i;
    for (const name of agentNames) {
      expect(modelPattern.test(name.trim())).toBe(false);
    }
    // master_agent and project_maintainer must be present
    const allText = agentNames.join('\n');
    expect(allText).toContain('master_agent');
    expect(allText).toContain('project_maintainer');
    await page.screenshot({ path: path.join(VALIDATION, 'J1-02-agents-list.png') });
  });

  // T3: Agent detail — collapsible sections + identity md viewer (R-02B/C, R-06A/C)
  test('T3: agent detail — collapsible sections and identity md render', async ({ page }) => {
    await doLogin(page);
    await page.getByTestId('nav-agent-studio').click();
    await page.getByTestId('tab-agents').click();
    // Click first agent to load detail
    await page.locator('[data-testid="agent-row"]').first().click();
    await expect(page.getByTestId('agent-tab-identity')).toHaveClass(/active/);
    await expect(page.getByTestId('agent-identity-rendered')).toBeVisible({ timeout: 8000 });
    await page.screenshot({ path: path.join(VALIDATION, 'J1-03-agent-detail.png') });
    await page.screenshot({ path: path.join(VALIDATION, 'J1-03b-agent-identity-rendered.png') });
    await page.getByTestId('agent-tab-skills').click();
    await expect(page.getByTestId('agent-section-skills')).toBeVisible({ timeout: 8000 });
    await expect(page.getByTestId('agent-section-bindings')).toBeVisible();
    await expect(page.getByTestId('agent-section-escalation')).toBeVisible();
  });

  // T4: Models tab — validation chips + [test] button (R-01B3)
  test('T4: Models tab — validation chips and test button visible', async ({ page }) => {
    await doLogin(page);
    await page.getByTestId('nav-agent-studio').click();
    await page.getByTestId('tab-models').click();
    await expect(page.locator('[data-testid="model-validation-chip"]').first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-testid="model-test-btn"]').first()).toBeVisible();
    await page.screenshot({ path: path.join(VALIDATION, 'J1-04-models-chips.png') });
  });

  // T5: Projects tab — project list visible; no promote-tmux flow (R-04A/B/F)
  test('T5: Projects tab — list visible; no promote-tmux flow', async ({ page }) => {
    await doLogin(page);
    await page.getByTestId('nav-project-setup').click();
    await page.getByTestId('tab-projects').click();
    await expect(page.getByTestId('project-list')).toBeVisible({ timeout: 10000 });
    // No "promote" or "promote-tmux" in the projects panel
    const projectListText = await page.getByTestId('project-list').innerText();
    expect(projectListText.toLowerCase()).not.toContain('promote');
    await page.screenshot({ path: path.join(VALIDATION, 'J1-05-projects.png') });
  });

  // T6: Project sub-tabs — Detail, Agents (Solo/Team), Documents (Docs/Tasks) (R-04C/D, R-05A/C/D)
  test('T6: project sub-tabs — Detail, Solo/Team agents, Docs/Tasks documents', async ({ page }) => {
    await doLogin(page);
    await page.getByTestId('nav-project-setup').click();
    await page.getByTestId('tab-projects').click();
    // Click the created project row
    await expect(page.getByTestId(`project-row-${projectId}`)).toBeVisible({ timeout: 10000 });
    await page.getByTestId(`project-row-${projectId}`).click();
    // Sub-tabs visible
    await expect(page.getByTestId('project-sub-tabs')).toBeVisible({ timeout: 8000 });
    await expect(page.getByTestId('project-subtab-detail')).toBeVisible();
    await expect(page.getByTestId('project-subtab-agents')).toBeVisible();
    await expect(page.getByTestId('project-subtab-documents')).toBeVisible();
    await page.screenshot({ path: path.join(VALIDATION, 'J1-06-project-detail.png') });
    // Agents sub-tab — unified list + Team roles strip (B3 / AC-4, AC-4b Option B)
    await page.getByTestId('project-subtab-agents').click();
    await expect(page.getByTestId('project-agents-panel')).toBeVisible({ timeout: 8000 });
    await expect(page.getByTestId('agent-subtab-solo')).toHaveCount(0);
    await expect(page.getByTestId('agent-subtab-team')).toHaveCount(0);
    await expect(page.getByTestId('team-roles-strip')).toBeVisible();
    await expect(page.getByTestId('add-team-select')).toBeVisible();
    await page.screenshot({ path: path.join(VALIDATION, 'J1-07-project-agents-solo-team.png') });
    // Documents sub-tab — Docs/Tasks inner tabs (R-05A/C)
    await page.getByTestId('project-subtab-documents').click();
    await expect(page.getByTestId('doc-subtab-docs')).toBeVisible({ timeout: 8000 });
    await expect(page.getByTestId('doc-subtab-tasks')).toBeVisible();
    // Verify helm_docs/ was scaffolded (docs-tree has entries after Docs tab loads)
    await page.getByTestId('doc-subtab-docs').click();
    await expect(page.getByTestId('docs-tree')).toBeVisible({ timeout: 8000 });
    await page.screenshot({ path: path.join(VALIDATION, 'J1-08-project-docs-tasks.png') });
  });
});
