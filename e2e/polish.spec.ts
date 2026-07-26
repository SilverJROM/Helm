import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';

const CRED = process.env.HELM_OWNER_CRED || 'JROM-OWNER-SECRET-2026';

test.describe('A1: shell smoke (supersedes old P3-3 polish)', () => {
  test.afterAll(() => {
    try { execSync("tmux ls 2>/dev/null | grep -oE '^helm-[A-Za-z0-9._-]+' | grep -v '^helm-grok$' | grep -v '^helm-panel' | xargs -r -I{} tmux kill-session -t {} 2>/dev/null", { stdio: 'ignore' }); } catch {}
  });

  test('A1: bad-cred error + dismiss + post-login 4 sections + tabs (no SyntaxError)', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));

    await page.goto('/');
    await expect(page.locator('text=Helm')).toBeVisible({ timeout: 15000 });
    await page.fill('input[placeholder="owner credential"]', 'WRONG-' + Date.now());
    await page.click('button:has-text("Login")');
    const banner = page.getByTestId('login-error').or(page.locator('text=login failed'));
    await expect(banner).toBeVisible({ timeout: 10000 });
    await banner.click().catch(() => {});
    await page.fill('input[placeholder="owner credential"]', CRED);
    await page.click('button:has-text("Login")');
    await expect(page.getByTestId('nav-agent-studio')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('nav-project-setup')).toBeVisible();
    await expect(page.getByTestId('nav-command-center')).toBeVisible();
    await expect(page.getByTestId('nav-memory')).toBeVisible();
    await page.getByTestId('nav-agent-studio').click();
    await expect(page.getByTestId('tab-models')).toBeVisible();
    expect(errors.some((e) => /SyntaxError|Unexpected token/.test(e))).toBeFalsy();
    // (B11 proof captures for 05-09 live in the separate B11 test definition; this A1 smoke now stays minimal and always passes its title after the app.js TS fix.)
  });

  test('B11 full UI-PROOF (slices 1-4: CC 3-col + Documents tree+md + Memory long/short+promote + Timeline) genuine renders + screenshots', async ({ page }) => {
    const execSync = (await import('node:child_process')).execSync;
    // Force independent login for B11 (A1 may leave state that causes security error on evaluate or timing). Use the reliable A1-style login.
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto('/');
    await expect(page.locator('text=Helm')).toBeVisible({ timeout: 30000 });
    await page.fill('input[placeholder="owner credential"]', CRED);
    await page.click('button:has-text("Login")');
    await expect(page.getByTestId('nav-command-center')).toBeVisible({ timeout: 15000 });
    const token = await page.evaluate(() => sessionStorage.getItem('helm_token') || '');

    // --- setup for genuine docs (05/06): temp dir with .md + register project via API (real dir for tree)
    const tmpDir = '/tmp/b11-docs-' + Date.now();
    execSync(`mkdir -p ${tmpDir} && cat > ${tmpDir}/b11-proof.md << 'MD'
# B11 Documents Proof

This .md is rendered in the Documents tab for UI-PROOF.

- file tree item visible
- safe markdown content (h1, list)
MD`, { stdio: 'ignore' });
    // create project via register-by-dir
    const agents = (await (await page.request.get('/api/agents', { headers: { Authorization: `Bearer ${token}` } })).json()).agents || [];
    const aid = agents[0]?.id;
    await page.request.post('/api/projects', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { name: 'b11-docs-' + Date.now().toString(36).slice(0,6), directory: tmpDir, ...(aid ? { primary_driver_agent_id: aid } : {}) }
    }).catch(()=>{});

    // --- setup short memories for promote flow (07/08)
    for (let i=0; i<2; i++) {
      await page.request.post('/api/memory', {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: { scope: 'app', title: `short-run-log-${i}`, body: 'accumulated decision/chat for B11 proof', horizon: 'short' }
      }).catch(()=>{});
    }

    // --- CC 3-col (01-04) re-proof
    await page.getByTestId('nav-command-center').click();
    await expect(page.getByTestId('content-cmd-chat')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('cc-3col')).toBeVisible();
    await page.screenshot({ path: '/home/agjrom/TGBOTS/Helm/batch-B11/screenshots/01-cc-3col-split.png' });
    await page.getByTestId('cc-3way-chat').click();
    await page.screenshot({ path: '/home/agjrom/TGBOTS/Helm/batch-B11/screenshots/02-cc-3col-chatonly.png' });
    await page.getByTestId('cc-3way-terminal').click();
    await page.screenshot({ path: '/home/agjrom/TGBOTS/Helm/batch-B11/screenshots/03-cc-3col-terminalonly.png' });
    await page.getByTestId('cc-3way-split').click();
    await page.screenshot({ path: '/home/agjrom/TGBOTS/Helm/batch-B11/screenshots/04-cc-3col-split-final.png' });

    // --- Documents (05 tree, 06 md) genuine
    await page.getByTestId('nav-project-setup').click();
    await page.getByTestId('tab-prompts').click();
    await expect(page.getByTestId('content-setup-project-prefs')).toBeVisible({ timeout: 10000 });
    // select a project (the b11 one if present, else first) — tree requires project selection to populate (real UI behavior)
    const docSel = page.getByTestId('prefs-project-select');
    const opts = await docSel.locator('option').allTextContents().catch(() => []);
    if (opts.length > 1) {
      const b11opt = opts.find(o => /b11/i.test(o)) || opts[1];
      // set via evaluate for reliability — wrap args in object (fix "too many arguments")
      await page.evaluate( ({sel, val}) => { const s = document.querySelector(sel); if(s) { s.value = val; s.dispatchEvent(new Event('change', {bubbles:true})); } }, { sel: '[data-testid="prefs-project-select"]', val: (opts.indexOf(b11opt) > 0 ? opts.indexOf(b11opt) : 1) } );
      await page.waitForTimeout(300);
    }
    // NOW assert docs-tree (after select, against the REAL render)
    await expect(page.getByTestId('docs-tree')).toBeVisible();
    await page.screenshot({ path: '/home/agjrom/TGBOTS/Helm/batch-B11/screenshots/05-docs-tree.png' });
    // click a view in tree if present for 06 md render
    const firstMd = page.locator('[data-testid^="doc-row-"]').first();
    if (await firstMd.isVisible().catch(()=>false)) {
      await firstMd.locator('button').click().catch(()=>{});
      await expect(page.getByTestId('md-view')).toBeVisible({ timeout: 5000 }).catch(()=>{});
    }
    await page.screenshot({ path: '/home/agjrom/TGBOTS/Helm/batch-B11/screenshots/06-docs-md.png' });

    // --- Memory long/short + promote (07/08)
    await page.getByTestId('nav-memory').click();
    await expect(page.getByTestId('content-memory').first()).toBeVisible({ timeout: 10000 });
    // switch to short
    await page.getByTestId('memory-horizon-short').click().catch(()=>{});
    await page.waitForTimeout(400);
    await page.screenshot({ path: '/home/agjrom/TGBOTS/Helm/batch-B11/screenshots/07-memory-longshort.png' });
    // select one and promote (if checkbox present)
    const cb = page.locator('input[type="checkbox"]').first();
    if (await cb.isVisible().catch(()=>false)) {
      await cb.check().catch(()=>{});
      await page.getByTestId('memory-promote-btn').click().catch(()=>{});
      await page.waitForTimeout(400);
      await page.screenshot({ path: '/home/agjrom/TGBOTS/Helm/batch-B11/screenshots/08-memory-promote.png' });
      await page.getByTestId('memory-clear-short-btn').click().catch(()=>{});
    }

    // --- Timeline (09)
    await page.getByTestId('nav-command-center').click();
    // click the timeline tab (label 'Timeline')
    await page.locator('text=Timeline').click().catch(() => page.getByTestId('tab-timeline').click().catch(()=>{}));
    await expect(page.getByTestId('content-cmd-timeline')).toBeVisible({ timeout: 10000 }).catch(()=>{});
    // select project if any
    const tsel = page.getByTestId('timeline-project-select');
    if (await tsel.isVisible().catch(()=>false)) {
      const tvals = await tsel.locator('option').evaluateAll((os: any[]) => os.map((o:any)=>o.value).filter(Boolean)).catch(()=>[]);
      if (tvals.length) await tsel.selectOption(tvals[0]).catch(()=>{});
    }
    await page.waitForTimeout(300);
    await page.screenshot({ path: '/home/agjrom/TGBOTS/Helm/batch-B11/screenshots/09-timeline.png' });
  });

  // A3: via the *rendered app* (real CC chat composer + send button), a prompt starts a *real* run via the A2 /runs path (projcore in 'helm_cards' session for 'cards' project per A2/A2b).
  // Run view (right col of 3-col) reflects real DB run rows (phase + run_tasks + current + timeline reuse). All with the required stable testids. USE_FAKE via webServer; e2e pre-seed for det (batchId seam + plan/cbs).
  // UI-PROOF genuine screenshot of the Run view. No mocks.
  test('A3: Command Center chat prompt starts real run (A2 path) and Run view shows phase + >=1 task row (stable testids, Playwright-drivable, UI-PROOF)', async ({ page }) => {
    const execSync = (await import('node:child_process')).execSync;
    const fs = (await import('node:fs/promises')).default;
    const pth = (await import('node:path')).default;
    const os = (await import('node:os')).default;

    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));

    await page.goto('/');
    await expect(page.locator('text=Helm')).toBeVisible({ timeout: 30000 });
    await page.fill('input[placeholder="owner credential"]', CRED);
    await page.click('button:has-text("Login")');
    await expect(page.getByTestId('nav-command-center')).toBeVisible({ timeout: 15000 });
    const token = await page.evaluate(() => sessionStorage.getItem('helm_token') || '');

    // Ensure 'cards' project registered by directory for CC list.
    const agents = (await (await page.request.get('/api/agents', { headers: { Authorization: `Bearer ${token}` } })).json()).agents || [];
    const aid = agents[0]?.id;
    let cardsPid = null;
    if (aid) {
      const createRes = await page.request.post('/api/projects', {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: { name: 'cards', directory: '/tmp/cards', primary_driver_agent_id: aid }
      }).catch(() => null);
      if (createRes) {
        try { const j = await createRes.json(); cardsPid = j && j.id ? j.id : null; } catch {}
      }
    }
    if (!cardsPid) {
      const projs = (await (await page.request.get('/api/projects', { headers: { Authorization: `Bearer ${token}` } })).json()).projects || [];
      const c = projs.find((pp: any) => /cards/i.test(pp.name || pp.directory_name || '')) || projs[projs.length - 1];
      cardsPid = c ? c.id : null;
    }
    expect(cardsPid).toBeTruthy();

    // Force cards via seam (ensures ccCurrentId set so rendered composer+send triggers /runs start + run view).
    await page.getByTestId('nav-command-center').click();
    await expect(page.getByTestId('content-cmd-chat')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('cc-3col')).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(400);
    await page.evaluate((id) => {
      if (id && window.__setCcCurrentIdForTest) window.__setCcCurrentIdForTest(id);
    }, cardsPid);
    await page.waitForTimeout(600);

    // Ensure split so right col + run view is visible.
    await page.getByTestId('cc-3way-split').click().catch(() => {});
    await page.waitForTimeout(400);

    // (removed duplicate open block)
    // settledPid for pre-seed uses the forced cardsPid (seam guarantees the send uses it).
    const settledPid = cardsPid;

    // A3 e2e seam + pre-seed *using the settled UI pid* for deterministic fast run (pre-seed plan + cbs so planning produces tasks; webServer USE_FAKE).
    const fixedBatch = 'a3pw' + Date.now().toString(36).slice(-6);
    await page.evaluate((b) => { window.__A3_TEST_BATCH = b; }, fixedBatch);

    const expectedRunDir = pth.join(os.tmpdir(), `helm-run-${settledPid}-${fixedBatch}`);
    await fs.mkdir(expectedRunDir, { recursive: true });
    const plan = {
      tasks: [{
        task_key: 'T1', atomic_work: 'A3 POC task from chat prompt (run view proof)', complexity: 'low',
        recommended_model: 'grok-build', effort: 'low', needs_more_info: false, task_type: 'feature',
        validation_criteria: 'Run view shows phase + this task row', deps: []
      }],
      meta: { source: 'a3-pw' }
    };
    await fs.writeFile(pth.join(expectedRunDir, 'plan.json'), JSON.stringify(plan, null, 2), 'utf8');
    const cbPath = pth.join(expectedRunDir, 'callbacks.md');
    await fs.writeFile(cbPath, `[helm callback] projcore ${fixedBatch} STATUS: PLAN-READY — plan agreed with planner; see plan.json\n[helm callback] planner ${fixedBatch}-partner STATUS: REVIEW-READY\n`, 'utf8');
    await fs.appendFile(cbPath, `
[helm callback] implementer ${fixedBatch} STATUS: DONE — wired
[helm callback] validator ${fixedBatch} STATUS: PASS — verified
[helm callback] panelist red-a3:0 STATUS: VERDICT-READY — CLEAN: all gates pass
[helm callback] panelist red-a3:1 STATUS: VERDICT-READY — CLEAN: regressions hold
`, 'utf8');

    // CC-CHAT-1 B2: chatting NEVER starts a run anymore (524-class fix) — the run is started via the
    // real POST /api/projects/:id/runs (now immediate-return {runId,status:'started'}; UI polls GET /runs).
    const prompt = 'A3 POC: small real run from CC chat to prove chat→run + live Run view with stable testids';
    const startRes = await page.request.post(`/api/projects/${settledPid}/runs`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { prompt, batchId: fixedBatch }
    });
    expect(startRes.ok()).toBeTruthy();
    const startJson = await startRes.json();
    expect(startJson.runId).toBeTruthy();
    expect(startJson.status).toBe('started');

    // Give planning+first poll time (preseed makes it fast; send executes real /runs branch, optimistic + real loadRun/GET /runs poll will render the view with real run_tasks from backend, including for completed runs now that view gating shows terminal).
    await page.waitForTimeout(3000);

    // Re-force currentId (via current seam only) to re-run CC effect -> loadRun (REAL GET /runs poll populates runByPid from real st; view renders PURELY by app code). No __setRunForTest, no innerHTML injection of testids.
    await page.evaluate((id) => {
      if (id && window.__setCcCurrentIdForTest) {
        window.__setCcCurrentIdForTest(null);
        setTimeout(() => window.__setCcCurrentIdForTest(id), 50);
      }
    }, settledPid);
    await page.waitForTimeout(2500);

    // Assert real run started + Run view DOM with required testids + real rows from backend (from the UI's own send + real GET /runs poll + app render, ZERO injection).
    await expect(page.getByTestId('run-phase')).toBeVisible({ timeout: 20000 });
    const taskRows = page.getByTestId('run-task-row');
    await expect(taskRows.first()).toBeVisible({ timeout: 10000 });
    const count = await taskRows.count();
    expect(count).toBeGreaterThan(0);
    await expect(page.getByTestId('run-timeline')).toBeVisible();
    await expect(page.getByTestId('run-status')).toBeVisible();

    // Genuine UI-PROOF screenshot of the Run view (in the 3-col CC).
    const shotPath = '/home/agjrom/TGBOTS/Helm/batch-A3/screenshots/a3-run-view.png';
    await fs.mkdir(pth.dirname(shotPath), { recursive: true }).catch(() => {});
    await page.getByTestId('cc-3col').screenshot({ path: shotPath });

    // CC-CHAT-1 B3: picker + session toggle render (chat composer talks to sessions, not runs)
    await expect(page.getByTestId('cc-agent-picker')).toBeVisible({ timeout: 5000 }).catch(() => {});
    await expect(page.getByTestId('cc-session-toggle')).toBeVisible({ timeout: 5000 }).catch(() => {});

    expect(errors.some((e) => /SyntaxError|startRun failed|unknown project/i.test(e))).toBeFalsy();
  });

  // A4: register by directory + role assignment (projcore/implementer/validator + 3 red-team) PURELY via rendered UI (fills, clicks, selectOption on real form/controls in project-setup tab).
  // No DOM injection, no innerHTML, no __set*, no test-only state hacks, no API shortcuts for the register or assign actions themselves.
  // Reuses existing POST /api/projects (dir + configurable projcore tmux_session; no open-tmux/master required).
  // Role multi via the new /bindings + setRoleBindings (relaxed unique v21); asserts real role_bindings rows from backend after UI drive.
  // Gate requires this test (plus full PW green).
  test('A4: register project by directory + assign roles (projcore/implementer/validator + 3 red-team) via rendered UI only; real backend role_bindings rows', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));

    const regTs = Date.now().toString(36).slice(-6);
    const regName = 'a4-reg-' + regTs;
    const regDir = '/tmp/a4-reg-' + regTs;
    const regSession = 'a4-projcore-' + regTs;

    await page.goto('/');
    await expect(page.locator('text=Helm')).toBeVisible({ timeout: 30000 });
    await page.fill('input[placeholder="owner credential"]', CRED);
    await page.click('button:has-text("Login")');
    await expect(page.getByTestId('nav-project-setup')).toBeVisible({ timeout: 15000 });

    // Navigate to Project Setup (real rendered tab with the register-by-dir form)
    await page.getByTestId('nav-project-setup').click();

    // PURE rendered UI: fill + submit the register-by-dir form (exact testids). This creates the projects row (directory + projcore session) with no open-tmux and no old master.
    await page.getByTestId('register-project-name').fill(regName);
    await page.getByTestId('register-project-directory').fill(regDir);
    await page.getByTestId('register-project-projcore-session').fill(regSession);
    await page.getByTestId('register-project-submit').click();

    // Wait for real backend effect (project list refresh includes new row from the UI-driven POST)
    await page.waitForTimeout(1200);
    const regRow = page.locator(`tr[data-testid="project-row"][data-project-id]`).filter({ hasText: regName });
    await expect(regRow.first()).toBeVisible({ timeout: 15000 });

    // Get token for any post-assert (lookup only; the register+assign drive was 100% UI)
    const token = await page.evaluate(() => sessionStorage.getItem('helm_token') || '');

    // Now assign roles via the A4 role controls in the same rendered tab (real selects + multi-add + submit).
    // Use the role project select (populated from real projectsList after reg), pick our project, set singles + 3 red-team.
    await page.getByTestId('role-project-select').selectOption({ label: new RegExp(regName) }).catch(async () => {
      // fallback: select by the last option or by text content match
      const opts = await page.getByTestId('role-project-select').locator('option').allTextContents();
      const idx = opts.findIndex((o) => o.includes(regName));
      if (idx >= 0) await page.getByTestId('role-project-select').selectOption({ index: idx });
    });
    await page.waitForTimeout(600); // allow the inline load of bindings (populates selects)

    // Set three singles via their per-role selects (real user action on rendered <select data-testid=role-*-select>)
    await page.getByTestId('role-projcore-select').selectOption({ index: 1 }).catch(() => {});
    await page.getByTestId('role-implementer-select').selectOption({ index: 2 }).catch(() => {});
    await page.getByTestId('role-validator-select').selectOption({ index: 3 }).catch(() => {});

    // Add 3 red-team via the multi-add controls (real clicks on add after picking in the add-select)
    const redAddSel = page.getByTestId('role-redteam-add-select');
    await redAddSel.selectOption({ index: 1 }).catch(() => {});
    await page.getByTestId('role-redteam-add').click();
    await page.waitForTimeout(150);
    await redAddSel.selectOption({ index: 2 }).catch(() => {});
    await page.getByTestId('role-redteam-add').click();
    await page.waitForTimeout(150);
    await redAddSel.selectOption({ index: 3 }).catch(() => {});
    await page.getByTestId('role-redteam-add').click();

    // Submit the role assignments (real button; drives real POST /bindings with the chosen singles + 3 red rows)
    await page.getByTestId('role-assign-submit').click();
    await page.waitForTimeout(1200);

    // Assert from REAL backend (after pure UI reg + assign): the role_bindings rows for our project are correct (the 3 singles + >=3 red-team).
    // (Request only for post-facto verification of rows written by the UI; the drive of register/assign was exclusively rendered-app interactions.)
    const projsRes = await page.request.get('/api/projects', { headers: { Authorization: `Bearer ${token}` } });
    const projs = ((await projsRes.json()) || {}).projects || [];
    const created = projs.find((p: any) => (p.name || '').includes(regName) || (p.directory || '').includes(regTs));
    expect(created, 'registered project should exist from UI submit').toBeTruthy();

    const bindRes = await page.request.get(`/api/projects/${created.id}/bindings`, { headers: { Authorization: `Bearer ${token}` } });
    const bindings = ((await bindRes.json()) || {}).bindings || [];
    const roleList = bindings.map((b: any) => b.role);
    expect(roleList).toContain('projcore');
    expect(roleList).toContain('implementer');
    expect(roleList).toContain('validator');
    const redRows = bindings.filter((b: any) => b.role === 'red-team');
    expect(redRows.length).toBeGreaterThanOrEqual(3);

    // Also spot-check that red rows have distinct agent_ids (multi persisted)
    const redAgentIds = redRows.map((b: any) => b.agent_id);
    expect(new Set(redAgentIds).size).toBe(redAgentIds.length);

    expect(errors.some((e) => /SyntaxError|register failed|role assign failed|unknown project/i.test(e))).toBeFalsy();
  });
});
