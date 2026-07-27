import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

// B8 (R6.27) live: Discovery paste/upload → B7 chat-file writer on :3110 / cards2-ibrain.db.
// Cases: paste text → on-disk tmp + ref in composer; paste/attach image → same; error preserves draft.

const BASE = process.env.HELM_BASE_URL || 'http://127.0.0.1:3110';
const CRED = process.env.HELM_OWNER_CRED || 'cards2-harness-563f750bebc23bba';
const RUN_TS = Date.now();
const PROJECT_NAME = `b8-validation-${RUN_TS}`;
const PROJECT_DIR = `/home/agjrom/websites/b8-validation-${RUN_TS}`;
const OWNER_MARKER = '.b8-live-owned';
const PASTE_TEXT = `B8 paste text body ${RUN_TS}\nline two for file intent.`;
const EVIDENCE_DIR = path.join(process.cwd(), 'validation', 'B8');
const PLAN_DIR_EVIDENCE = path.join(process.cwd(), 'plan', 'helm-ux-remediation', 'validation', 'B8');

// 1x1 PNG
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

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

test.describe('B8 live: Discovery paste → chat-files on :3110', () => {
  let token: string;
  let projectId: number;
  let cycleId: number;
  let cycleFolder: string;
  let projectDir: string;

  test.beforeAll(async () => {
    if (fs.existsSync(PROJECT_DIR)) {
      throw new Error(`B8 live refuse: PROJECT_DIR exists ${PROJECT_DIR}`);
    }
    fs.mkdirSync(PROJECT_DIR, { recursive: false });
    fs.writeFileSync(
      path.join(PROJECT_DIR, OWNER_MARKER),
      `owned-by e2e/B8.live.spec.ts ${PROJECT_NAME}\n`,
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
    projectDir = projData.project.directory || PROJECT_DIR;

    const cycleResp = await fetch(`${BASE}/api/projects/${projectId}/cycles`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `B8 paste ${RUN_TS}` }),
    });
    const cycleData = await cycleResp.json();
    if (!cycleResp.ok) throw new Error(`cycle create failed: ${JSON.stringify(cycleData)}`);
    cycleId = cycleData.cycle.id;
    cycleFolder = cycleData.cycle.folder_name;
    if (!cycleFolder) throw new Error(`missing cycle folder_name: ${JSON.stringify(cycleData)}`);
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
        PROJECT_DIR.includes(`b8-validation-${RUN_TS}`) &&
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

  test('paste text + image refs; error preserves draft', async ({ page }) => {
    test.setTimeout(170000);
    const t0 = Date.now();
    const mark = (l: string) => console.log(`[B8.live timing] ${l} at +${Date.now() - t0}ms`);

    const health = await fetch(`${BASE}/health`);
    expect(health.ok).toBe(true);
    expect(BASE).toMatch(/127\.0\.0\.1:3110|localhost:3110/);

    // --- API smoke: text chat-file lands under project/tmp/<folder>/ ---
    const textName = `e2e-text-${RUN_TS}.txt`;
    const apiText = await fetch(`${BASE}/api/cycles/${cycleId}/chat-files`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ filename: textName, content: PASTE_TEXT }),
    });
    const apiTextBody = await apiText.json();
    expect(apiText.ok, JSON.stringify(apiTextBody)).toBe(true);
    expect(apiTextBody.path).toBe(`tmp/${cycleFolder}/${textName}`);
    const textAbs = path.join(projectDir, apiTextBody.path);
    expect(fs.existsSync(textAbs)).toBe(true);
    expect(fs.readFileSync(textAbs, 'utf8')).toBe(PASTE_TEXT);
    mark('api text ok');

    // --- API smoke: image ---
    const imgName = `e2e-img-${RUN_TS}.png`;
    const apiImg = await fetch(`${BASE}/api/cycles/${cycleId}/chat-files`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ filename: imgName, contentBase64: PNG_B64 }),
    });
    const apiImgBody = await apiImg.json();
    expect(apiImg.ok, JSON.stringify(apiImgBody)).toBe(true);
    expect(apiImgBody.path).toBe(`tmp/${cycleFolder}/${imgName}`);
    const imgAbs = path.join(projectDir, apiImgBody.path);
    expect(fs.existsSync(imgAbs)).toBe(true);
    expect(fs.readFileSync(imgAbs).equals(Buffer.from(PNG_B64, 'base64'))).toBe(true);
    mark('api image ok');

    // --- UI Discovery: paste text → composer ref ---
    await page.setViewportSize({ width: 1280, height: 800 });
    await openDiscovery(page);
    mark('discovery open');

    const composer = page.getByTestId('ws-disc-chat-composer');
    await expect(composer).toBeVisible({ timeout: 10000 });
    // Enable composer even if no agent (stage refs for agent path)
    await composer.evaluate((el: HTMLTextAreaElement) => {
      el.disabled = false;
      el.removeAttribute('disabled');
    });

    const uiPasteText = `UI paste body ${RUN_TS} multi-line\nsecond line`;
    await composer.focus();
    await composer.evaluate((el: HTMLTextAreaElement, text: string) => {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      el.dispatchEvent(
        new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: dt,
        } as ClipboardEventInit)
      );
    }, uiPasteText);

    // Wait for upload + composer insert
    await expect
      .poll(async () => (await composer.inputValue()).includes('tmp/'), { timeout: 10000 })
      .toBe(true);
    const afterTextPaste = await composer.inputValue();
    expect(afterTextPaste).toMatch(/tmp\/[^/\s]+\/paste-.*\.txt/);
    const textRef = afterTextPaste.trim().split(/\s+/).find((t) => t.startsWith('tmp/'));
    expect(textRef).toBeTruthy();
    const uiTextAbs = path.join(projectDir, textRef!);
    expect(fs.existsSync(uiTextAbs)).toBe(true);
    expect(fs.readFileSync(uiTextAbs, 'utf8')).toBe(uiPasteText);
    mark('ui text paste ok');
    await saveEvidence('B8-paste-text-ref', page);

    // --- UI attach image → same chat-files contract + composer path ---
    const draftBeforeImg = await composer.inputValue();
    const pngPath = path.join(PROJECT_DIR, `attach-${RUN_TS}.png`);
    fs.writeFileSync(pngPath, Buffer.from(PNG_B64, 'base64'));
    await page.getByTestId('ws-disc-attach-input').setInputFiles(pngPath);
    await expect
      .poll(async () => {
        const v = await composer.inputValue();
        return v.includes('.png') && v.length > draftBeforeImg.length;
      }, { timeout: 10000 })
      .toBe(true);
    const afterImg = await composer.inputValue();
    // Draft preserved + new ref appended
    expect(afterImg.startsWith(draftBeforeImg.trim()) || afterImg.includes(draftBeforeImg.trim())).toBe(
      true
    );
    const imgRef = afterImg
      .trim()
      .split(/\s+/)
      .find((t) => t.startsWith('tmp/') && t.endsWith('.png'));
    expect(imgRef).toBeTruthy();
    const uiImgAbs = path.join(projectDir, imgRef!);
    expect(fs.existsSync(uiImgAbs)).toBe(true);
    mark('ui image attach ok');
    await saveEvidence('B8-paste-image-ref', page);

    // --- Error case: failed upload preserves draft (page.route 409) ---
    const draftBeforeErr = await composer.inputValue();
    expect(draftBeforeErr.includes('tmp/')).toBe(true);

    await page.route(`**/api/cycles/${cycleId}/chat-files`, async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'chat-file already exists: e2e-forced' }),
        });
        return;
      }
      await route.continue();
    });

    await composer.focus();
    await composer.evaluate((el: HTMLTextAreaElement, text: string) => {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      el.dispatchEvent(
        new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: dt,
        } as ClipboardEventInit)
      );
    }, `forced-fail paste ${RUN_TS}`);

    await expect(page.getByTestId('ws-disc-attach-err')).toBeVisible({ timeout: 8000 });
    await expect(page.getByTestId('ws-disc-attach-err')).toContainText(/already exists|failed|Upload/i);
    const afterErr = await composer.inputValue();
    expect(afterErr.includes('tmp/')).toBe(true);
    // Prior draft refs still present (error path must not clear composer)
    expect(afterErr).toContain(draftBeforeErr.trim().split(/\s+/).find((t) => t.startsWith('tmp/')) || 'tmp/');
    await page.unroute(`**/api/cycles/${cycleId}/chat-files`);
    mark('error preserves draft ok');
    await saveEvidence('B8-error-preserves-draft', page);

    mark('done');
  });
});
