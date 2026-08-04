/**
 * S12 — Inline Discovery confirmation UI (ACs 7,12,14,16-17,22-24,30-31).
 *
 * HARD SAFETY:
 * - playwright.cap.config.ts → :3110 only.
 * - discovery-handoff GET/POST fully INTERCEPTED (no live S10/planning).
 * - Throwaway project shell only; NEVER cycle 13.
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.HELM_BASE_URL || 'http://127.0.0.1:3110';
const CRED = process.env.HELM_OWNER_CRED || 'cards2-harness-563f750bebc23bba';
const RUN_TS = Date.now();
const PROJECT_NAME = `s12-validation-${RUN_TS}`;
const PROJECT_DIR = `/home/agjrom/websites/s12-validation-${RUN_TS}`;
const OWNER_MARKER = '.s12-live-owned';

const ASK =
  'Initial Discovery docs are ready. May I ask Helm to start the configured Planning team?';
const CONFIRM_BUBBLE = 'Yes — start the planning team';
const DECLINE_BUBBLE = 'Not yet';
const MANIFEST_DIGEST =
  'a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456';

function fixturePayload(
  uiState: string,
  cycleId: number,
  projectId: number
): Record<string, unknown> {
  const basePreview = {
    plancore: {
      role: 'plancore',
      slot: null,
      provider: 'claude',
      model: 'claude-opus-4-8',
      effort: 'high',
      source: 'phase-owner',
      ready: true,
      reason: null,
    },
    coPlanners: [
      {
        role: 'co-planner',
        slot: 0,
        provider: 'claude',
        model: 'claude-opus-4-8',
        effort: 'high',
        source: 'primary',
        ready: true,
        reason: null,
      },
      {
        role: 'co-planner',
        slot: 1,
        provider: 'codex',
        model: 'gpt-5.3-codex',
        effort: 'med',
        source: 'primary',
        ready: true,
        reason: null,
      },
    ],
  };

  const handoffByState: Record<string, unknown> = {
    empty: null,
    pending: {
      id: 101,
      state: 'pending',
      digest: MANIFEST_DIGEST,
      planningRunId: null,
      reason: null,
    },
    starting: {
      id: 101,
      state: 'starting',
      digest: MANIFEST_DIGEST,
      planningRunId: 42,
      reason: null,
    },
    started: {
      id: 101,
      state: 'started',
      digest: MANIFEST_DIGEST,
      planningRunId: 42,
      reason: null,
    },
    declined: {
      id: 101,
      state: 'declined',
      digest: MANIFEST_DIGEST,
      planningRunId: null,
      reason: 'Not yet',
    },
    blocked: {
      id: 101,
      state: 'pending',
      digest: MANIFEST_DIGEST,
      planningRunId: null,
      reason: null,
    },
    failed: {
      id: 101,
      state: 'failed',
      digest: MANIFEST_DIGEST,
      planningRunId: null,
      reason: 'staffing mismatch',
    },
  };

  const blocked = uiState === 'blocked';
  return {
    cycleId,
    projectId,
    phase: 'discovery',
    ask: ASK,
    handoff: handoffByState[uiState] ?? null,
    digest: MANIFEST_DIGEST,
    blocked,
    blockReasons: blocked
      ? ['planning panel is empty: configure co-planners in Agent Studio']
      : [],
    emptyPanelMessage: blocked ? 'Configure co-planners in Agent Studio' : null,
    preview:
      uiState === 'blocked'
        ? { plancore: basePreview.plancore, coPlanners: [] }
        : basePreview,
    uiState,
  };
}

async function loginApi(): Promise<string> {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential: CRED }),
  });
  const d = await r.json();
  if (!d.token) throw new Error(`login failed: ${JSON.stringify(d)}`);
  return d.token;
}

test.describe('S12 live: Discovery handoff card (intercepted :3110)', () => {
  let token: string;
  let projectId: number;
  let cycleId: number;

  test.beforeAll(async () => {
    expect(BASE).toMatch(/127\.0\.0\.1:3110|localhost:3110/);
    if (fs.existsSync(PROJECT_DIR)) {
      throw new Error(`S12 refuse: PROJECT_DIR exists ${PROJECT_DIR}`);
    }
    fs.mkdirSync(PROJECT_DIR, { recursive: false });
    fs.writeFileSync(
      path.join(PROJECT_DIR, OWNER_MARKER),
      `owned-by e2e/S12.live.spec.ts ${PROJECT_NAME}\n`,
      'utf8'
    );
    token = await loginApi();

    const projResp = await fetch(`${BASE}/api/projects`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: PROJECT_NAME,
        directory: PROJECT_DIR,
        autonomy_default: 'pause_after_planning',
      }),
    });
    const projData = await projResp.json();
    if (!projResp.ok) throw new Error(`project create failed: ${JSON.stringify(projData)}`);
    projectId = projData.project.id;
    expect(projectId).not.toBe(13);

    const cycleResp = await fetch(`${BASE}/api/projects/${projectId}/cycles`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: `S12 handoff ${RUN_TS}` }),
    });
    const cycleData = await cycleResp.json();
    if (!cycleResp.ok) throw new Error(`cycle create failed: ${JSON.stringify(cycleData)}`);
    cycleId = cycleData.cycle.id;
    expect(cycleId).not.toBe(13);
  });

  test.afterAll(async () => {
    if (projectId != null) {
      try {
        await fetch(`${BASE}/api/projects/${projectId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch {
        /* best-effort */
      }
    }
    try {
      const markerPath = path.join(PROJECT_DIR, OWNER_MARKER);
      if (
        PROJECT_DIR.includes(`s12-validation-${RUN_TS}`) &&
        fs.existsSync(markerPath) &&
        fs.readFileSync(markerPath, 'utf8').includes(PROJECT_NAME)
      ) {
        fs.rmSync(PROJECT_DIR, { recursive: true, force: false });
      }
    } catch {
      /* leave orphan */
    }
  });

  test('fixtures, exact seats, one confirm POST, decline, 390px', async ({ page }) => {
    test.setTimeout(170000);
    const health = await fetch(`${BASE}/health`);
    expect(health.ok).toBe(true);

    let currentState = 'pending';
    const confirmPosts: string[] = [];
    const declinePosts: string[] = [];

    await page.route('**/api/cycles/*/discovery-handoff**', async (route) => {
      const req = route.request();
      const url = req.url();
      const method = req.method();
      if (!url.includes(`/api/cycles/${cycleId}/discovery-handoff`)) {
        return route.continue();
      }
      if (method === 'GET') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(fixturePayload(currentState, cycleId, projectId)),
        });
      }
      if (method === 'POST' && url.includes('/confirm')) {
        confirmPosts.push(req.postData() || '');
        currentState = 'starting';
        return route.fulfill({
          status: 202,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            status: 'starting',
            handoffId: 101,
            runId: 42,
            cycleId,
            digest: MANIFEST_DIGEST,
            already: confirmPosts.length > 1,
            runCreated: confirmPosts.length === 1,
          }),
        });
      }
      if (method === 'POST' && url.includes('/decline')) {
        declinePosts.push(req.postData() || '');
        currentState = 'declined';
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            status: 'declined',
            handoffId: 101,
            cycleId,
            runCreated: false,
          }),
        });
      }
      return route.fulfill({ status: 404, body: '{}' });
    });

    await page.goto(`${BASE}/`);
    const cred = page.locator('input[placeholder="owner credential"]');
    if (await cred.count()) {
      try {
        await cred.fill(CRED, { timeout: 5000 });
        await page.click('button:has-text("Login")');
      } catch {
        /* already */
      }
    }
    await page.getByTestId('nav-project-setup').waitFor({ state: 'visible', timeout: 20000 });
    await page.goto(`${BASE}/#07-command-center-overview`);
    await expect(page.getByTestId('ov-board')).toBeVisible({ timeout: 15000 });

    let opened = false;
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline && !opened) {
      for (const tab of ['ov-tab-pending', 'ov-tab-active'] as const) {
        const t = page.getByTestId(tab);
        if (await t.count()) await t.click();
        const card = page.getByTestId(`ov-card-${projectId}`);
        if ((await card.count()) && (await card.isVisible())) {
          await card.click();
          opened = true;
          break;
        }
      }
      if (!opened) {
        await page.goto(`${BASE}/#07-command-center-overview`);
        await page.waitForTimeout(800);
      }
    }
    expect(opened).toBe(true);
    await expect(page.getByTestId('content-cmd-workspace')).toBeVisible({ timeout: 15000 });
    const discTab = page.getByTestId('ws-tab-discovery');
    if (await discTab.count()) await discTab.click();
    await expect(page.getByTestId('ws-disc-split')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('ws-disc-handoff')).toBeVisible({ timeout: 15000 });

    // Pending: exact ASK + seats
    await expect(page.getByTestId('ws-disc-handoff')).toHaveAttribute('data-state', 'pending');
    await expect(page.getByTestId('ws-disc-handoff-ask')).toHaveText(ASK);
    await expect(page.getByTestId('ws-disc-handoff-seat-model-plancore')).toContainText(
      'claude-opus-4-8'
    );
    await expect(page.getByTestId('ws-disc-handoff-seat-model-cp-0')).toContainText(
      'claude-opus-4-8'
    );
    await expect(page.getByTestId('ws-disc-handoff-seat-model-cp-1')).toContainText(
      'gpt-5.3-codex'
    );

    // Double-click confirm → one POST + bubble
    await page.getByTestId('ws-disc-handoff-confirm').click();
    await page.getByTestId('ws-disc-handoff-confirm').click({ force: true }).catch(() => {});
    await expect(
      page.getByTestId('ws-disc-handoff-user-bubble').filter({ hasText: CONFIRM_BUBBLE })
    ).toBeVisible({ timeout: 10000 });
    await expect.poll(() => confirmPosts.length, { timeout: 10000 }).toBe(1);
    await expect(page.getByTestId('ws-disc-handoff-notice')).toContainText(/run #42/i);

    // Cycle fixtures via Retry (client re-GET)
    for (const st of ['empty', 'blocked', 'started', 'failed', 'declined'] as const) {
      currentState = st;
      const retry = page.getByTestId('ws-disc-handoff-retry');
      if (await retry.count()) {
        await retry.click();
      } else {
        // Force re-fetch by toggling tab
        await page.getByTestId('ws-tab-planning').click().catch(() => {});
        await page.getByTestId('ws-tab-discovery').click();
      }
      await expect(page.getByTestId('ws-disc-handoff')).toHaveAttribute('data-state', st, {
        timeout: 12000,
      });
      if (st === 'blocked') {
        await expect(page.getByTestId('ws-disc-handoff-status')).toContainText(
          /Configure co-planners|blocked/i
        );
      }
      if (st === 'started') {
        await expect(page.getByTestId('ws-disc-handoff-status')).toContainText(
          /started|run #42/i
        );
      }
      if (st === 'empty') {
        await expect(page.getByTestId('ws-disc-handoff-status')).toContainText(
          /No Discovery handoff/i
        );
      }
    }

    // Decline honesty
    currentState = 'pending';
    await page.getByTestId('ws-disc-handoff-retry').click();
    await expect(page.getByTestId('ws-disc-handoff')).toHaveAttribute('data-state', 'pending', {
      timeout: 10000,
    });
    await page.getByTestId('ws-disc-handoff-decline').click();
    await expect(
      page.getByTestId('ws-disc-handoff-user-bubble').filter({ hasText: DECLINE_BUBBLE })
    ).toBeVisible({ timeout: 10000 });
    await expect.poll(() => declinePosts.length).toBe(1);
    await expect(page.getByTestId('ws-disc-handoff-notice')).toContainText(/Declined/i);

    // 390px stack
    await page.setViewportSize({ width: 390, height: 800 });
    currentState = 'pending';
    await page.getByTestId('ws-disc-handoff-retry').click();
    const box = await page.getByTestId('ws-disc-handoff').boundingBox();
    expect(box).toBeTruthy();
    expect(box!.width).toBeLessThanOrEqual(390);

    fs.mkdirSync('validation/S12', { recursive: true });
    await page.screenshot({
      path: 'validation/S12/S12-handoff-pending-390.png',
      fullPage: true,
    });
  });
});
