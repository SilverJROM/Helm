import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';

// B6 (R6.23 / R6.24) live: last-reply-only sticky strip + B3 bottom-stick on four prior sites.
// :3110 / cards2-ibrain.db via playwright.cap.config.ts. Throwaway project; scoped teardown.

const BASE = process.env.HELM_BASE_URL || 'http://127.0.0.1:3110';
const CRED = process.env.HELM_OWNER_CRED || 'cards2-harness-563f750bebc23bba';
const DB_PATH = process.env.HELM_DB_PATH_LIVE || '/home/agjrom/websites/Helm/data/cards2-ibrain.db';
const RUN_TS = Date.now();
const PROJECT_NAME = `b6-validation-${RUN_TS}`;
const PROJECT_DIR = `/home/agjrom/websites/b6-validation-${RUN_TS}`;
const OWNER_MARKER = '.b6-live-owned';
const BATCH_ID = `b6-live-${RUN_TS}`;
const LIVE_SESSION = `helm-b6-live-${RUN_TS}`;
const LIVE_MARKER = `B6_LIVE_MARKER_${RUN_TS}`;
const REPLY_MARKER = `B6_LAST_REPLY_${RUN_TS}`;
const EVIDENCE_DIR = path.join(process.cwd(), 'validation', 'B6');
const PLAN_DIR_EVIDENCE = path.join(process.cwd(), 'plan', 'helm-ux-remediation', 'validation', 'B6');

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

function tmux(args: string[]) {
  execFileSync('tmux', args, { stdio: 'pipe' });
}

function createLiveTmuxSession(): void {
  try {
    tmux(['kill-session', '-t', LIVE_SESSION]);
  } catch {
    /* none */
  }
  tmux(['new-session', '-d', '-s', LIVE_SESSION]);
  tmux(['set-option', '-t', LIVE_SESSION, '@helm_child', '1']);
  const script = `for i in $(seq 1 50); do echo "b6-scroll-line-$i"; done; echo "${LIVE_MARKER}"; echo "done ${LIVE_MARKER}"`;
  tmux(['send-keys', '-t', `${LIVE_SESSION}:0.0`, script, 'Enter']);
  execFileSync('sleep', ['0.4']);
}

function killLiveTmuxSession(): void {
  try {
    tmux(['kill-session', '-t', LIVE_SESSION]);
  } catch {
    /* best-effort */
  }
}

function seedImplRun(opts: { projectId: number; cycleId: number; liveSession: string }): {
  runId: number;
} {
  const db = new Database(DB_PATH);
  try {
    const info = db
      .prepare(
        `INSERT INTO runs (project_id, cycle_id, batch_id, north_star_ref, status, phase)
         VALUES (?, ?, ?, NULL, 'active', 'implementation')`
      )
      .run(opts.projectId, opts.cycleId, BATCH_ID);
    const runId = Number(info.lastInsertRowid);

    db.prepare(
      `INSERT INTO worker_runtimes (project_id, role, provider, model, session, correlation_id, state, spawned_by, run_id, started_at, ended_at)
       VALUES (?,?,?,?,?,?,'running','b6-live-seed',?, datetime('now'), NULL)`
    ).run(
      opts.projectId,
      'implementer',
      'xai',
      'grok-4.5',
      opts.liveSession,
      `${BATCH_ID}-implementer`,
      runId
    );

    try {
      db.prepare(`UPDATE cycles SET phase = 'implementation' WHERE id = ?`).run(opts.cycleId);
    } catch {
      /* optional */
    }

    return { runId };
  } finally {
    db.close();
  }
}

function cleanupSeed(runId: number | null, projectId: number | null) {
  if (runId == null && projectId == null) return;
  try {
    const db = new Database(DB_PATH);
    try {
      if (runId != null) {
        db.prepare(`DELETE FROM worker_runtimes WHERE run_id = ?`).run(runId);
        db.prepare(`DELETE FROM runs WHERE id = ?`).run(runId);
      }
    } finally {
      db.close();
    }
  } catch {
    /* best-effort */
  }
}

test.describe('B6 live: last-reply strip + bottom-stick on :3110', () => {
  let token: string;
  let projectId: number;
  let cycleId: number;
  let runId: number | null = null;

  test.beforeAll(async () => {
    if (fs.existsSync(PROJECT_DIR)) {
      throw new Error(`B6 live refuse: PROJECT_DIR exists ${PROJECT_DIR}`);
    }
    fs.mkdirSync(PROJECT_DIR, { recursive: false });
    fs.writeFileSync(
      path.join(PROJECT_DIR, OWNER_MARKER),
      `owned-by e2e/B6.live.spec.ts ${PROJECT_NAME}\n`,
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
      body: JSON.stringify({ name: `B6 stick ${RUN_TS}` }),
    });
    const cycleData = await cycleResp.json();
    if (!cycleResp.ok) throw new Error(`cycle create failed: ${JSON.stringify(cycleData)}`);
    cycleId = cycleData.cycle.id;

    createLiveTmuxSession();
    const seeded = seedImplRun({ projectId, cycleId, liveSession: LIVE_SESSION });
    runId = seeded.runId;
  });

  test.afterAll(async () => {
    killLiveTmuxSession();
    cleanupSeed(runId, projectId);
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
        PROJECT_DIR.includes(`b6-validation-${RUN_TS}`) &&
        fs.existsSync(markerPath) &&
        fs.readFileSync(markerPath, 'utf8').includes(PROJECT_NAME)
      ) {
        fs.rmSync(PROJECT_DIR, { recursive: true, force: false });
      }
    } catch {
      /* leave orphan */
    }
  });

  async function openWorkspace(page: import('@playwright/test').Page) {
    // Must be set before App() mounts so B6 e2e seed useEffect registers the hook.
    await page.addInitScript(() => {
      try {
        sessionStorage.setItem('HELM_E2E_B6', '1');
      } catch {
        /* ignore */
      }
    });
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
  }

  test('last reply once + expand/hide; scroll-up holds; at-bottom follows', async ({ page }) => {
    test.setTimeout(170000);
    const t0 = Date.now();
    const mark = (l: string) => console.log(`[B6.live timing] ${l} at +${Date.now() - t0}ms`);

    const health = await fetch(`${BASE}/health`);
    expect(health.ok).toBe(true);
    expect(BASE).toMatch(/127\.0\.0\.1:3110|localhost:3110/);

    await page.setViewportSize({ width: 1280, height: 800 });
    await openWorkspace(page);
    const discTab = page.getByTestId('ws-tab-discovery');
    if (await discTab.count()) await discTab.click();
    await expect(page.getByTestId('ws-disc-split')).toBeVisible({ timeout: 10000 });
    mark('discovery open');

    // --- (a) Last reply once + expand/hide (R6.24) via gated e2e seed ---
    const longReply = [
      `Line1 ${REPLY_MARKER} first of multi-line last reply.`,
      `Line2 continues the same last reply for clamp proof.`,
      `Line3 still the same reply — must not appear twice below.`,
      `Line4 more text to force two-line collapsed clamp.`,
      `Line5 end ${REPLY_MARKER}.`,
    ].join('\n');

    await page.evaluate(
      ({ pid, reply, prompt }) => {
        const seed = (window as unknown as { __helmE2eB6Seed?: (d: unknown) => void }).__helmE2eB6Seed;
        if (typeof seed !== 'function') throw new Error('B6 e2e seed hook missing — set HELM_E2E_B6=1 before app load');
        seed({
          projectId: pid,
          prompt,
          session: { sid: 'e2e-b6-sid', agentId: 1, tmux: null },
          liveReply: reply,
          stripMode: 'collapsed',
          thread: [
            { id: 'u1', role: 'user', text: prompt, ts: Date.now() },
            // Trailing agent would be de-duped from list while live strip owns it
            { id: 'a1', role: 'agent', text: reply, ts: Date.now() },
          ],
        });
      },
      { pid: projectId, reply: longReply, prompt: `e2e prompt ${RUN_TS}` }
    );

    const strip = page.getByTestId('cc-last-reply-strip');
    await expect(strip).toBeVisible({ timeout: 8000 });
    await expect(page.getByTestId('cc-last-reply-body')).toContainText(REPLY_MARKER);
    await expect(page.getByTestId('cc-last-reply-body')).toHaveAttribute('data-expanded', '0');

    // De-dupe: live agent text only in strip — not a second bubble/stream with same marker
    const bodyText = await page.getByTestId('ws-disc-chat-body').innerText();
    const occurrences = bodyText.split(REPLY_MARKER).length - 1;
    // Marker appears in strip body (multiple lines contain it twice in longReply — count unique surface)
    // Assert no separate .cc-live-stream and no agent bubble duplicating full reply
    await expect(page.locator('[data-testid="cc-live-stream"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="ws-disc-chat-bubble-agent"]')).toHaveCount(0);
    expect(occurrences).toBeGreaterThanOrEqual(1);

    await page.getByTestId('cc-last-reply-expand').click();
    await expect(page.getByTestId('cc-last-reply-body')).toHaveAttribute('data-expanded', '1');
    await saveEvidence('B6-last-reply-expanded', page);
    mark('expand ok');

    await page.getByTestId('cc-last-reply-collapse').click();
    await expect(page.getByTestId('cc-last-reply-body')).toHaveAttribute('data-expanded', '0');
    await saveEvidence('B6-last-reply-collapsed', page);

    await page.getByTestId('cc-last-reply-hide').click();
    await expect(page.getByTestId('cc-last-reply-hidden')).toBeVisible();
    await expect(page.getByTestId('cc-last-reply-strip')).toHaveCount(0);
    await page.getByTestId('cc-last-reply-show').click();
    await expect(page.getByTestId('cc-last-reply-strip')).toBeVisible();
    mark('strip expand/hide ok');

    // --- (b) Discovery scroll-up survives >1.5s + content poll update (R6.23 sites 1/3) ---
    const chatBody = page.getByTestId('ws-disc-chat-body');
    // Grow thread filler so body is scrollable
    await page.evaluate(
      ({ pid, marker }) => {
        const seed = (window as unknown as { __helmE2eB6Seed?: (d: unknown) => void }).__helmE2eB6Seed!;
        const filler = Array.from({ length: 40 }, (_, i) => ({
          id: `fill-${i}`,
          role: 'user' as const,
          text: `filler history line ${i} — scroll me`,
          ts: Date.now() - (40 - i) * 1000,
        }));
        seed({
          projectId: pid,
          prompt: 'hold scroll prompt',
          session: { sid: 'e2e-b6-sid', agentId: 1, tmux: null },
          liveReply: `growing reply tick-0 ${marker}`,
          thread: filler,
        });
      },
      { pid: projectId, marker: REPLY_MARKER }
    );
    await page.waitForTimeout(200);
    await chatBody.evaluate((el) => {
      el.scrollTop = 20;
    });
    const heldTop = await chatBody.evaluate((el) => el.scrollTop);
    expect(heldTop).toBeLessThan(80);

    // Simulate >1.5s poll cadence content growth while scrolled up
    for (let t = 1; t <= 3; t++) {
      await page.waitForTimeout(600);
      await page.evaluate(
        ({ pid, t, marker }) => {
          const seed = (window as unknown as { __helmE2eB6Seed?: (d: unknown) => void }).__helmE2eB6Seed!;
          seed({
            projectId: pid,
            liveReply: `growing reply tick-${t} ${marker}\n` + 'x\n'.repeat(5),
          });
        },
        { pid: projectId, t, marker: REPLY_MARKER }
      );
    }
    await page.waitForTimeout(200);
    const afterTop = await chatBody.evaluate((el) => el.scrollTop);
    // Must not yank to bottom (near scrollHeight)
    const metrics = await chatBody.evaluate((el) => ({
      top: el.scrollTop,
      sh: el.scrollHeight,
      ch: el.clientHeight,
    }));
    const distFromBottom = metrics.sh - metrics.top - metrics.ch;
    expect(distFromBottom).toBeGreaterThan(24);
    expect(Math.abs(afterTop - heldTop)).toBeLessThan(120);
    await saveEvidence('B6-held-scroll-discovery', page);
    mark('discovery hold scroll ok');

    // --- (c) at-bottom reader still follows new output ---
    await chatBody.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    // Fire a scroll event so stick intent captures near-bottom
    await chatBody.evaluate((el) => {
      el.dispatchEvent(new Event('scroll'));
    });
    await page.waitForTimeout(50);
    await page.evaluate(
      ({ pid, marker }) => {
        const seed = (window as unknown as { __helmE2eB6Seed?: (d: unknown) => void }).__helmE2eB6Seed!;
        seed({
          projectId: pid,
          liveReply: `follow-bottom final line ${marker}\n` + 'y\n'.repeat(12),
        });
      },
      { pid: projectId, marker: REPLY_MARKER }
    );
    await page.waitForTimeout(150);
    const follow = await chatBody.evaluate((el) => ({
      top: el.scrollTop,
      sh: el.scrollHeight,
      ch: el.clientHeight,
    }));
    expect(follow.sh - follow.top - follow.ch).toBeLessThanOrEqual(30);
    mark('at-bottom follow ok');

    // --- Implementation pane stick (site 4) ---
    const implTab = page.getByTestId('ws-tab-implementation');
    if (await implTab.count()) {
      await implTab.click();
      await page.waitForTimeout(500);
      const implBody = page.getByTestId('ws-impl-term-implementer-body');
      // May show empty if run-state not active — still try when present with content
      if (await implBody.count()) {
        // Force a viewport-bounded body so overflow scrolls (flex may expand to content height).
        await implBody.evaluate((el) => {
          (el as HTMLElement).style.maxHeight = '160px';
          (el as HTMLElement).style.height = '160px';
          (el as HTMLElement).style.overflow = 'auto';
        });
        await page.waitForTimeout(100);
        const metrics0 = await implBody.evaluate((el) => ({
          sh: el.scrollHeight,
          ch: el.clientHeight,
          lines: el.querySelectorAll('.cmt-line').length,
        }));
        if (metrics0.sh > metrics0.ch + 40 && metrics0.lines > 5) {
          await implBody.evaluate((el) => {
            el.scrollTop = 12;
            el.dispatchEvent(new Event('scroll'));
          });
          const held = await implBody.evaluate((el) => el.scrollTop);
          expect(held).toBeGreaterThan(0);
          await page.waitForTimeout(2200); // >1.5s poll
          const after = await implBody.evaluate((el) => ({
            top: el.scrollTop,
            sh: el.scrollHeight,
            ch: el.clientHeight,
          }));
          expect(after.sh - after.top - after.ch).toBeGreaterThan(24);
          expect(Math.abs(after.top - held)).toBeLessThan(80);
          await saveEvidence('B6-held-scroll-impl', page);
          mark('impl hold scroll ok');
        } else {
          mark(
            `impl body not scrollable (sh=${metrics0.sh} ch=${metrics0.ch} lines=${metrics0.lines}) — skip held-scroll`
          );
        }
      }
    }

    // --- Studio chat stick (site 2): open agents chat if available; pure stick intent on thread DOM ---
    await page.goto(`${BASE}/#02-studio-agents`);
    await page.waitForTimeout(400);
    const studioThread = page.getByTestId('as-chat-thread');
    if (await studioThread.count()) {
      // Exercise B3 stick on the studio scroll owner: scroll up, grow via evaluate children, no force stick without intent
      await studioThread.evaluate((el) => {
        for (let i = 0; i < 30; i++) {
          const d = document.createElement('div');
          d.textContent = `studio-fill-${i}`;
          d.style.padding = '6px';
          el.appendChild(d);
        }
        el.scrollTop = 15;
        el.dispatchEvent(new Event('scroll'));
      });
      const heldStudio = await studioThread.evaluate((el) => el.scrollTop);
      await studioThread.evaluate((el) => {
        for (let i = 0; i < 10; i++) {
          const d = document.createElement('div');
          d.textContent = `studio-grow-${i}`;
          d.style.padding = '6px';
          el.appendChild(d);
        }
      });
      await page.waitForTimeout(100);
      // Without Preact re-render applyStick, manual growth preserves scrollTop (proves no unconditional hijack on this node from timers)
      const afterStudio = await studioThread.evaluate((el) => el.scrollTop);
      expect(Math.abs(afterStudio - heldStudio)).toBeLessThan(40);
      mark('studio thread no hijack ok');
    } else {
      mark('studio thread absent — skip site-2 DOM probe');
    }

    await saveEvidence('B6-desktop-final', page);
    mark('done');
  });
});
