import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

// A14 (D8/R4.31 sole owner) live proof on :3110 / cards2-ibrain.db via playwright.cap.config.ts only.
// helm_pm is a SHARED face for BOTH plancore and ibrain (role-alias.ts, SD3 permanent safety — the
// model must never see anything else). Human-facing chat must show the TRUE internal role, resolved
// via run/dispatch context (this run's own worker_runtimes windows), never a naive helm_pm->plancore
// string replace. This spec drives a REAL planning-phase gate whose plancore side emits the LITERAL
// helm_pm face token (matching brief-writer-service.ts's actual contract, not the internal 'plancore'
// shorthand every other row's fixtures use) and confirms GET /api/projects/:id/chat resolves it to
// 'plancore' via the real worker_runtimes dispatch row registerWorkerRuntime already wrote. It then
// seeds a synthetic ibrain wake (a second worker_runtimes dispatch window + a later helm_pm line) —
// short-circuiting a real mid-run escalation the same way every other row injects synthetic callback
// lines — and confirms that SAME ambiguous face now resolves to 'ibrain', not 'plancore', proving the
// resolution is genuinely context-sensitive rather than a static per-run guess.

const BASE = process.env.HELM_BASE_URL || 'http://127.0.0.1:3110';
const CRED = process.env.HELM_OWNER_CRED || 'cards2-harness-563f750bebc23bba';
const DB_PATH = process.env.HELM_DB_PATH_LIVE || '/home/agjrom/websites/Helm/data/cards2-ibrain.db';
const RUN_TS = Date.now();
const PROJECT_NAME = `a14-validation-${RUN_TS}`;
const PROJECT_DIR = `/home/agjrom/websites/a14-validation-${RUN_TS}`;
const OWNER_MARKER = '.a14-live-owned';
const BATCH_ID = `a14-live-${RUN_TS}`;
const HELM_RUN_ROOT = process.env.HELM_RUN_ROOT_OVERRIDE || '/home/agjrom/websites/Helm/data/runs';
const EVIDENCE_DIR = path.join(process.cwd(), 'validation', 'A14');
const PLAN_DIR_EVIDENCE = path.join(process.cwd(), 'plan', 'helm-ux-remediation', 'validation', 'A14');

const VALID_NS = '# North star\n\nA14 role-resolution proof: plan a small utility feature (throwaway).\n';
const VALID_OGREQ = '# Requirements\n\n- **R4.31** — human-facing chat shows true role, not a shared face.\n';
const VALID_PLAN_MD =
  '# Plan\n\n```json\n[{"id":"T1","batch":"A14","title":"A14 role-resolution proof task","req_refs":["R4.31"],"assignee":"grok-4.5","validator_lane":"L2","effort":"low","type":"feature"}]\n```\n';

function predictRunDir(projectId: number, batchId: string): string {
  return path.join(HELM_RUN_ROOT, `helm-run-${projectId}-${batchId}`);
}

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

function readCycle(cycleId: number): any {
  const db = new Database(DB_PATH, { readonly: true });
  const row = db.prepare('SELECT phase, autonomy, awaiting_approval FROM cycles WHERE id = ?').get(cycleId);
  db.close();
  return row;
}

function readRun(runId: number): any {
  const db = new Database(DB_PATH, { readonly: true });
  const row = db.prepare('SELECT id, phase, status FROM runs WHERE id = ?').get(runId);
  db.close();
  return row;
}

function insertIbrainDispatch(projectId: number, runId: number, batchId: string): void {
  const db = new Database(DB_PATH);
  db.prepare(
    `INSERT INTO worker_runtimes (project_id, role, provider, model, session, correlation_id, state, spawned_by, run_id, started_at, ended_at)
     VALUES (?, 'ibrain', 'grok', 'grok-4.5', 'a14-ibrain-session', ?, 'done', 'a14-live-seed', ?, datetime('now'), NULL)`
  ).run(projectId, `ibrain-wake-${batchId}`, runId);
  db.close();
}

test.describe('A14 live: human-facing chat resolves the shared helm_pm face via run/dispatch context', () => {
  let token: string;
  let projectId: number;
  let cycleId: number;
  let cycleDir = '';
  let runId: number | null = null;
  let runDir = '';

  test.beforeAll(async () => {
    if (fs.existsSync(PROJECT_DIR)) {
      throw new Error(
        `A14 live refuse: PROJECT_DIR already exists (${PROJECT_DIR}). ` +
          `Refusing to reuse or delete a path this test did not create.`
      );
    }
    fs.mkdirSync(PROJECT_DIR, { recursive: false });
    fs.writeFileSync(
      path.join(PROJECT_DIR, OWNER_MARKER),
      `owned-by e2e/A14.live.spec.ts ${PROJECT_NAME}\n`,
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
        autonomy_default: 'pause_after_planning',
      }),
    });
    const projData = await projResp.json();
    if (!projResp.ok) throw new Error(`project create failed: ${JSON.stringify(projData)}`);
    projectId = projData.project.id;

    const cycleResp = await fetch(`${BASE}/api/projects/${projectId}/cycles`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `A14 role-resolution ${RUN_TS}`,
        autonomy: 'pause_after_planning',
      }),
    });
    const cycleData = await cycleResp.json();
    if (!cycleResp.ok) throw new Error(`cycle create failed: ${JSON.stringify(cycleData)}`);
    cycleId = cycleData.cycle.id;
    cycleDir = path.join(PROJECT_DIR, 'cycle', String(cycleData.cycle.folder_name));
    fs.mkdirSync(cycleDir, { recursive: true });
    fs.writeFileSync(path.join(cycleDir, 'north-star.md'), VALID_NS, 'utf8');
    fs.writeFileSync(path.join(cycleDir, 'og-requirements.md'), VALID_OGREQ, 'utf8');
    fs.writeFileSync(path.join(cycleDir, 'plan.md'), VALID_PLAN_MD, 'utf8');
    runDir = predictRunDir(projectId, BATCH_ID);
  });

  test.afterAll(async () => {
    if (runId != null) {
      try {
        const row = readRun(runId);
        const terminal = row && (['complete', 'failed', 'blocked'].includes(String(row.phase)));
        if (!terminal) {
          await fetch(`${BASE}/api/runs/${runId}/stop`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: 'A14 live evidence capture complete' }),
          });
          await new Promise((r) => setTimeout(r, 1500));
        }
      } catch { /* best-effort */ }
    }

    // worker_runtimes.run_id has no ON DELETE CASCADE (A6/A6b/A8/A9/A11/A13 precedent) — clean up
    // explicitly before the project DELETE cascades runs, or it 400s with a FOREIGN KEY constraint
    // failure. This includes the synthetic ibrain-wake row this spec itself inserted.
    if (runId != null) {
      try {
        const db = new Database(DB_PATH);
        db.prepare('DELETE FROM worker_runtimes WHERE run_id = ?').run(runId);
        db.prepare('DELETE FROM helm_sessions WHERE run_id = ?').run(runId);
        db.prepare('DELETE FROM run_tasks WHERE run_id = ?').run(runId);
        db.close();
      } catch { /* best-effort */ }
    }

    if (projectId != null) {
      try {
        await fetch(`${BASE}/api/projects/${projectId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch { /* best-effort */ }
    }

    try {
      if (runDir && runDir.includes(`helm-run-${projectId}-`)) {
        fs.rmSync(runDir, { recursive: true, force: true });
      }
    } catch { /* best-effort */ }

    try {
      const markerPath = path.join(PROJECT_DIR, OWNER_MARKER);
      if (
        PROJECT_DIR.includes(`a14-validation-${RUN_TS}`) &&
        fs.existsSync(markerPath) &&
        fs.readFileSync(markerPath, 'utf8').includes(PROJECT_NAME)
      ) {
        fs.rmSync(PROJECT_DIR, { recursive: true, force: false });
      }
    } catch { /* leave orphan unique dir rather than widen blast radius */ }
  });

  test('a literal helm_pm face resolves to plancore during planning, and to ibrain for a seeded later wake', async ({ page }) => {
    test.setTimeout(170000);
    const t0 = Date.now();
    const mark = (label: string) => console.log(`[A14.live timing] ${label} at +${Date.now() - t0}ms`);

    const health = await fetch(`${BASE}/health`);
    expect(health.ok).toBe(true);
    expect(BASE).toMatch(/127\.0\.0\.1:3110|localhost:3110/);

    expect(readCycle(cycleId).phase).toBe('discovery');

    const startResp = await fetch(`${BASE}/api/cycles/${cycleId}/start-planning`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        batchId: BATCH_ID,
        prompt: 'Plan a small utility feature for this throwaway A14 role-resolution proof cycle.',
      }),
    });
    const startData = await startResp.json();
    if (!startResp.ok) throw new Error(`start-planning failed: ${JSON.stringify(startData)}`);
    runId = startData.runId;
    expect(runId).toBeTruthy();
    mark('start-planning returned');

    const driveDeadline = Date.now() + 20000;
    let drove = false;
    while (Date.now() < driveDeadline) {
      try {
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(path.join(runDir, 'north-star.md'), VALID_NS, 'utf8');
        fs.writeFileSync(path.join(runDir, 'conversation-log.md'), 'A14 role-resolution proof.\n', 'utf8');
        fs.appendFileSync(
          path.join(runDir, 'callbacks.md'),
          `[helm callback] discovery ${BATCH_ID} STATUS: NORTH-STAR-READY — a14 live drive\n`,
          'utf8'
        );
        drove = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    expect(drove, 'could not write discovery drive artifacts into runDir').toBe(true);
    mark('north-star-ready injected');

    let sawPlancoreSeat = false;
    const plancoreSeatDeadline = Date.now() + 90000;
    while (Date.now() < plancoreSeatDeadline) {
      const r = await fetch(`${BASE}/api/cycles/${cycleId}/seats`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) {
        const d = await r.json();
        if (Array.isArray(d.seats) && d.seats.some((s: any) => s.role === 'plancore')) {
          sawPlancoreSeat = true;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    mark('plancore seat observed');
    expect(sawPlancoreSeat, 'plancore seat never registered under /api/cycles/:id/seats').toBe(true);

    // Seed CallbackTsCache EARLY (before the ambiguous lines exist) — its first-observation heuristic
    // stamps every line existing at THAT moment with the run's own start time. Polling /chat live as a
    // run progresses (the cache's actual designed operating mode) means each NEW line appended after
    // this point gets stamped with "now" instead — genuinely after plancore's own dispatch started_at,
    // which is what real dispatch-window matching needs. A single end-of-run /chat catch-up read would
    // (incorrectly) stamp historical lines as if they preceded the dispatch that emitted them.
    await fetch(`${BASE}/api/projects/${projectId}/chat`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
    mark('chat cache seeded pre-PLAN-READY');

    // Drive the whole-plan gate to CLEAN using the LITERAL helm_pm face token for plancore's own
    // line (matching brief-writer-service.ts's real contract), not the internal 'plancore' shorthand
    // other rows' fixtures use — this is the actually-ambiguous case A14 must resolve correctly.
    let planPass = false;
    const planDeadline = Date.now() + 60000;
    while (Date.now() < planDeadline) {
      try {
        fs.appendFileSync(
          path.join(runDir, 'callbacks.md'),
          `[helm callback] helm_pm ${BATCH_ID} STATUS: PLAN-READY — plan.json present\n` +
            `[helm callback] planner ${BATCH_ID}-partner STATUS: VERDICT-READY — CLEAN: clean\n`,
          'utf8'
        );
      } catch { /* dir materializing */ }
      const runRow = readRun(runId!);
      if (runRow && !['interview', 'planning'].includes(String(runRow.phase))) { planPass = true; break; }
      await new Promise((r) => setTimeout(r, 1500));
    }
    mark('whole-plan gate resolved');
    expect(planPass, 'planning never resolved past interview/planning').toBe(true);

    // API proof: GET /chat resolves the plancore-side helm_pm line to 'plancore', via this run's own
    // real worker_runtimes dispatch row (registerWorkerRuntime already wrote it during planning) —
    // never the raw ambiguous face, never a naive guess.
    let plancoreLabelled = false;
    const chatDeadline1 = Date.now() + 20000;
    let chatData: any = null;
    while (Date.now() < chatDeadline1) {
      const r = await fetch(`${BASE}/api/projects/${projectId}/chat`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) {
        chatData = await r.json();
        const msgs = Array.isArray(chatData?.messages) ? chatData.messages : [];
        if (msgs.some((m: any) => m.state === 'PLAN-READY' && m.role === 'plancore')) { plancoreLabelled = true; break; }
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(plancoreLabelled, 'PLAN-READY helm_pm line was not resolved to role=plancore in /chat').toBe(true);
    mark('plancore path confirmed via /chat API');

    // Seed a synthetic ibrain wake: a SECOND worker_runtimes dispatch window (role=ibrain, started
    // strictly after plancore's own dispatch) plus a later helm_pm-faced callback line — the same
    // short-circuit-real-latency pattern every other row's live spec uses for synthetic callbacks,
    // applied here to a dispatch row instead.
    insertIbrainDispatch(projectId, runId!, BATCH_ID);
    await new Promise((r) => setTimeout(r, 1200)); // ensure the ibrain window's started_at is in the past relative to the new line below
    fs.appendFileSync(
      path.join(runDir, 'callbacks.md'),
      `[helm callback] helm_pm ${BATCH_ID} STATUS: DECISION-READY — mid-run escalation classified (a14 seeded ibrain wake)\n`,
      'utf8'
    );
    mark('ibrain wake seeded');

    let ibrainLabelled = false;
    const chatDeadline2 = Date.now() + 20000;
    while (Date.now() < chatDeadline2) {
      const r = await fetch(`${BASE}/api/projects/${projectId}/chat`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) {
        chatData = await r.json();
        const msgs = Array.isArray(chatData?.messages) ? chatData.messages : [];
        if (msgs.some((m: any) => m.state === 'DECISION-READY' && m.role === 'ibrain')) { ibrainLabelled = true; break; }
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(ibrainLabelled, 'DECISION-READY helm_pm line was not resolved to role=ibrain (seeded wake) in /chat').toBe(true);
    // The SAME shared face must never collapse both into one label.
    const decisionMsg = (chatData.messages as any[]).find((m: any) => m.state === 'DECISION-READY');
    expect(decisionMsg.role).not.toBe('plancore');
    mark('ibrain path confirmed via /chat API');

    // UI proof: log in, open the Command Center CHAT page (a legacy hash route distinct from the
    // cmd-workspace tabs other rows screenshot) pre-seeded via localStorage so it loads this
    // project's tab directly (the project-open dropdown carries no stable selector to click).
    await page.goto(`${BASE}/`);
    await page.locator('input[placeholder="owner credential"]').fill(CRED);
    await page.click('button:has-text("Login")');
    await page.getByTestId('nav-project-setup').waitFor({ state: 'visible', timeout: 15000 });

    // ccOpenTabs is read via a LAZY useState initializer — it only re-reads localStorage on a fresh
    // mount, not on a same-document hash change. Seed localStorage, then force an actual full reload
    // (token lives in sessionStorage, which survives a reload) so the tab is open from first render.
    await page.evaluate((pid) => {
      localStorage.setItem('helm_cc_tabs', JSON.stringify([pid]));
    }, projectId);
    await page.goto(`${BASE}/#07-command-center-chat`);
    await page.reload();
    if (await page.locator('input[placeholder="owner credential"]').isVisible().catch(() => false)) {
      await page.locator('input[placeholder="owner credential"]').fill(CRED);
      await page.click('button:has-text("Login")');
    }
    await expect(page.getByTestId('content-cmd-chat')).toBeVisible({ timeout: 15000 });

    await expect(page.locator('[data-testid="chat-message"]', { hasText: 'plancore' }).first()).toBeVisible({ timeout: 15000 });
    mark('plancore label visible in UI');
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'A14-chat-plancore-path.png'), fullPage: true });
    const plancoreAria = await page.getByTestId('cc-col-chat').ariaSnapshot();
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'A14-chat-plancore-path-aria-snapshot.yaml'), plancoreAria, 'utf8');

    await expect(page.locator('[data-testid="chat-message"]', { hasText: 'ibrain' }).first()).toBeVisible({ timeout: 15000 });
    mark('ibrain label visible in UI');
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'A14-chat-ibrain-path.png'), fullPage: true });
    const ibrainAria = await page.getByTestId('cc-col-chat').ariaSnapshot();
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'A14-chat-ibrain-path-aria-snapshot.yaml'), ibrainAria, 'utf8');

    for (const f of [
      'A14-chat-plancore-path.png', 'A14-chat-plancore-path-aria-snapshot.yaml',
      'A14-chat-ibrain-path.png', 'A14-chat-ibrain-path-aria-snapshot.yaml',
    ]) {
      fs.copyFileSync(path.join(EVIDENCE_DIR, f), path.join(PLAN_DIR_EVIDENCE, f));
    }
    mark('evidence written');
  });
});
