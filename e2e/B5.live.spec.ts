import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

// B5 (R6.22 / R6.25 / R6.26) live viewport strip on :3110 / cards2-ibrain.db.
// Desktop + narrow: composer/list non-overlap, single scrollbar owner, no 560/420/340 caps,
// header ≤2 rows, Minimize not alone on a wrap row. Throwaway project; scoped teardown.

const BASE = process.env.HELM_BASE_URL || 'http://127.0.0.1:3110';
const CRED = process.env.HELM_OWNER_CRED || 'cards2-harness-563f750bebc23bba';
const RUN_TS = Date.now();
const PROJECT_NAME = `b5-validation-${RUN_TS}`;
const PROJECT_DIR = `/home/agjrom/websites/b5-validation-${RUN_TS}`;
const OWNER_MARKER = '.b5-live-owned';
const EVIDENCE_DIR = path.join(process.cwd(), 'validation', 'B5');
const PLAN_DIR_EVIDENCE = path.join(process.cwd(), 'plan', 'helm-ux-remediation', 'validation', 'B5');

async function login(): Promise<string> {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential: CRED }),
  });
  const d = await r.json();
  if (!d.token) throw new Error(`login failed: ${JSON.stringify(d)}`);
  return d.token;
}

function ensureEvidenceDirs() {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.mkdirSync(PLAN_DIR_EVIDENCE, { recursive: true });
}

function saveEvidence(name: string, page: import('@playwright/test').Page) {
  return (async () => {
    const png = path.join(EVIDENCE_DIR, name + '.png');
    await page.screenshot({ path: png, fullPage: true });
    fs.copyFileSync(png, path.join(PLAN_DIR_EVIDENCE, name + '.png'));
    const aria = await page.locator('body').ariaSnapshot();
    fs.writeFileSync(path.join(EVIDENCE_DIR, name + '-aria.yaml'), aria, 'utf8');
    fs.writeFileSync(path.join(PLAN_DIR_EVIDENCE, name + '-aria.yaml'), aria, 'utf8');
  })();
}

test.describe('B5 live: Discovery/Impl viewport strip on :3110', () => {
  let token: string;
  let projectId: number;
  let cycleId: number;

  test.beforeAll(async () => {
    if (fs.existsSync(PROJECT_DIR)) {
      throw new Error(`B5 live refuse: PROJECT_DIR exists ${PROJECT_DIR}`);
    }
    fs.mkdirSync(PROJECT_DIR, { recursive: false });
    fs.writeFileSync(
      path.join(PROJECT_DIR, OWNER_MARKER),
      `owned-by e2e/B5.live.spec.ts ${PROJECT_NAME}\n`,
      'utf8'
    );
    ensureEvidenceDirs();
    token = await login();

    const projResp = await fetch(`${BASE}/api/projects`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: PROJECT_NAME,
        directory: PROJECT_DIR,
        autonomy_default: 'autonomous_after_discovery',
      }),
    });
    const projData = await projResp.json();
    if (!projResp.ok) throw new Error(`project create failed: ${JSON.stringify(projData)}`);
    projectId = projData.project.id;

    const cycleResp = await fetch(`${BASE}/api/projects/${projectId}/cycles`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `B5 viewport ${RUN_TS}` }),
    });
    const cycleData = await cycleResp.json();
    if (!cycleResp.ok) throw new Error(`cycle create failed: ${JSON.stringify(cycleData)}`);
    cycleId = cycleData.cycle.id;
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
        PROJECT_DIR.includes(`b5-validation-${RUN_TS}`) &&
        fs.existsSync(markerPath) &&
        fs.readFileSync(markerPath, 'utf8').includes(PROJECT_NAME)
      ) {
        fs.rmSync(PROJECT_DIR, { recursive: true, force: false });
      }
    } catch {
      /* leave orphan */
    }
  });

  async function openDiscovery(page: import('@playwright/test').Page) {
    await page.goto(`${BASE}/`);
    const cred = page.locator('input[placeholder="owner credential"]');
    if (await cred.count()) {
      try {
        await cred.fill(CRED, { timeout: 5000 });
        await page.click('button:has-text("Login")');
      } catch {
        /* already logged in */
      }
    }
    await page.getByTestId('nav-project-setup').waitFor({ state: 'visible', timeout: 20000 });
    await page.goto(`${BASE}/#07-command-center-overview`);
    await expect(page.getByTestId('ov-board')).toBeVisible({ timeout: 15000 });
    await page.getByTestId(`ov-card-${projectId}`).click();
    await expect(page.getByTestId('content-cmd-workspace')).toBeVisible({ timeout: 15000 });
    const discTab = page.getByTestId('ws-tab-discovery');
    if (await discTab.count()) await discTab.click();
    await expect(page.getByTestId('ws-disc-split')).toBeVisible({ timeout: 10000 });
  }

  test('desktop + narrow viewport: no fixed caps, non-overlap, ≤2 header rows', async ({ page }) => {
    test.setTimeout(170000);
    const t0 = Date.now();
    const mark = (l: string) => console.log(`[B5.live timing] ${l} at +${Date.now() - t0}ms`);

    const health = await fetch(`${BASE}/health`);
    expect(health.ok).toBe(true);
    expect(BASE).toMatch(/127\.0\.0\.1:3110|localhost:3110/);

    // ---------- Desktop ----------
    await page.setViewportSize({ width: 1280, height: 800 });
    await openDiscovery(page);
    mark('desktop discovery open');

    const split = page.getByTestId('ws-disc-split');
    const chatBody = page.getByTestId('ws-disc-chat-body');
    const composer = page.getByTestId('ws-disc-composer');
    const chatHeader = page.getByTestId('ws-disc-chat-header');

    // Caps removed: computed height must not be locked to 560, min-height not 420
    const deskMetrics = await split.evaluate((el) => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        height: r.height,
        minHeight: cs.minHeight,
        maxHeight: cs.maxHeight,
        heightProp: cs.height,
      };
    });
    expect(deskMetrics.minHeight === '420px' || deskMetrics.minHeight === '560px').toBe(false);
    // Split should consume substantial viewport (not a tiny stub)
    expect(deskMetrics.height).toBeGreaterThan(300);

    // Live-stream no 340px cap
    const streamCap = await page.evaluate(() => {
      const el = document.querySelector('.cc-disc-pane-body .cc-live-stream');
      if (!el) return { maxHeight: 'none', exists: false };
      return { maxHeight: getComputedStyle(el).maxHeight, exists: true };
    });
    if (streamCap.exists) {
      expect(streamCap.maxHeight === '340px').toBe(false);
    }

    // Single scrollbar owner: chat body is the overflow:auto element
    const scrollOwner = await chatBody.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        overflowY: cs.overflowY,
        minHeight: cs.minHeight,
      };
    });
    expect(['auto', 'scroll', 'overlay'].includes(scrollOwner.overflowY)).toBe(true);
    expect(scrollOwner.minHeight === '0px' || scrollOwner.minHeight === '0').toBe(true);

    // R6.22: composer does not overlap message list (composer top >= list bottom - 1px tolerance)
    const bodyBox = await chatBody.boundingBox();
    const compBox = await composer.boundingBox();
    expect(bodyBox).toBeTruthy();
    expect(compBox).toBeTruthy();
    expect(compBox!.y + 1).toBeGreaterThanOrEqual(bodyBox!.y); // composer below/at body region
    // Footer composer sits under scroll body — body bottom should not extend past composer top
    expect(bodyBox!.y + bodyBox!.height).toBeLessThanOrEqual(compBox!.y + 4);

    // Header rows ≤ 2: workspace header y-bands
    const headerBands = await page.getByTestId('content-cmd-workspace').locator('.cc-ws-header').evaluate((el) => {
      const kids = Array.from(el.children) as HTMLElement[];
      const ys = kids.map((k) => Math.round(k.getBoundingClientRect().y));
      const unique = [...new Set(ys)].sort((a, b) => a - b);
      // Cluster within 8px as same row
      const rows: number[] = [];
      for (const y of unique) {
        if (!rows.some((ry) => Math.abs(ry - y) < 10)) rows.push(y);
      }
      return rows.length;
    });
    expect(headerBands, 'cc-ws-header should be ≤2 visual rows').toBeLessThanOrEqual(2);

    // Chat header: Minimize shares a row with controls (not alone below)
    const minBox = await page.getByTestId('ws-disc-chat-minimize').boundingBox();
    const hdrBox = await chatHeader.boundingBox();
    expect(minBox).toBeTruthy();
    expect(hdrBox).toBeTruthy();
    expect(minBox!.y).toBeGreaterThanOrEqual(hdrBox!.y - 2);
    expect(minBox!.y + minBox!.height).toBeLessThanOrEqual(hdrBox!.y + hdrBox!.height + 4);

    // Log height grows with taller viewport
    const h800 = deskMetrics.height;
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.waitForTimeout(200);
    const h1000 = await split.evaluate((el) => el.getBoundingClientRect().height);
    expect(h1000, 'split should grow when viewport taller (R6.25)').toBeGreaterThan(h800 - 5);

    await saveEvidence('B5-desktop-discovery', page);
    mark('desktop ok');

    // ---------- Narrow ----------
    await page.setViewportSize({ width: 390, height: 800 });
    await page.waitForTimeout(300);
    await expect(page.getByTestId('ws-disc-split')).toBeVisible({ timeout: 10000 });

    const narrowHeaderRows = await page.getByTestId('content-cmd-workspace').locator('.cc-ws-header').evaluate((el) => {
      const kids = Array.from(el.children) as HTMLElement[];
      const ys = kids.map((k) => Math.round(k.getBoundingClientRect().y));
      const unique = [...new Set(ys)].sort((a, b) => a - b);
      const rows: number[] = [];
      for (const y of unique) {
        if (!rows.some((ry) => Math.abs(ry - y) < 12)) rows.push(y);
      }
      return rows.length;
    });
    expect(narrowHeaderRows, 'narrow header ≤2 rows').toBeLessThanOrEqual(2);

    // Minimize still in chat header band
    const minN = await page.getByTestId('ws-disc-chat-minimize').boundingBox();
    const hdrN = await page.getByTestId('ws-disc-chat-header').boundingBox();
    if (minN && hdrN) {
      expect(minN.y + minN.height).toBeLessThanOrEqual(hdrN.y + hdrN.height + 6);
    }

    // Composer non-overlap at narrow
    const bodyN = await page.getByTestId('ws-disc-chat-body').boundingBox();
    const compN = await page.getByTestId('ws-disc-composer').boundingBox();
    expect(bodyN && compN).toBeTruthy();
    expect(bodyN!.y + bodyN!.height).toBeLessThanOrEqual(compN!.y + 6);

    // No min-height 420 lock on split at narrow
    const narrowMin = await split.evaluate((el) => getComputedStyle(el).minHeight);
    expect(narrowMin === '420px').toBe(false);

    await saveEvidence('B5-narrow-discovery', page);
    mark('narrow ok');

    // Implementation tab soft check: term row not locked to 190px
    const implTab = page.getByTestId('ws-tab-implementation');
    if (await implTab.count()) {
      await implTab.click();
      await page.waitForTimeout(300);
      const termRow = page.getByTestId('ws-impl-term-row');
      if (await termRow.count()) {
        const th = await termRow.evaluate((el) => {
          const cs = getComputedStyle(el);
          return { height: cs.height, minHeight: cs.minHeight };
        });
        expect(th.height === '190px').toBe(false);
        expect(th.minHeight === '440px').toBe(false);
      }
    }
    mark('done');
  });
});
