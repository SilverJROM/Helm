import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  BASE,
  CAP_DOCS_FILE,
  CAP_DOCS_FOLDER,
  CAP_EDIT_MARKER,
  CAP_TASK_KEY,
  CAP_TASKLIST,
  CARDS_DIR,
  CARDS_ID,
  DB_PATH,
  ORIGINAL_DOCS,
  OVERRIDE_AID,
  captureBaseline,
  cleanupCapArtifacts,
  login,
  openCards,
  openCardsAgentsSolo,
  openCardsDocs,
  openCardsTasks,
  seedCapTasks,
  type CardsBaseline,
} from './helpers/projects-cap.js';

test.describe('batch-cap — full Projects section journey (live cards :3110)', () => {
  let baseline: CardsBaseline;
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];

  test.beforeAll(async ({ request }) => {
    baseline = await captureBaseline(request);
    seedCapTasks();
  });

  test.afterEach(async () => {
    await cleanupCapArtifacts(baseline);
  });

  test.afterAll(async () => {
    await cleanupCapArtifacts(baseline);
  });

  test('R1-R5 integration journey + clean-state verification', async ({ page, request }) => {
    test.setTimeout(180000);
    page.on('dialog', (d) => d.accept());
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await login(page);

    // ── R1: Solo table identity ──
    await openCardsAgentsSolo(page);
    const soloRows = page.locator('[data-testid^="project-agent-row-"]');
    await expect(soloRows).toHaveCount(baseline.agentCount, { timeout: 15000 });
    const rowCount = await soloRows.count();
    for (let i = 0; i < rowCount; i++) {
      const row = soloRows.nth(i);
      const text = await row.innerText();
      expect(text).not.toMatch(/^[\s—-]*$/);
      expect(text).not.toContain('\n—\n');
      const html = await row.innerHTML();
      expect(html).toMatch(/chip/);
      expect(text.split('\n')[0]?.trim().length).toBeGreaterThan(0);
    }

    // ── R2: Detail tab ──
    await page.getByTestId('project-subtab-detail').click();
    await expect(page.getByTestId('project-detail-description')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('project-detail-status')).toBeVisible();
    await expect(page.getByTestId('project-detail-branch')).toBeVisible();
    await expect(page.getByTestId('project-detail-last-activity')).toBeVisible();
    await expect(page.getByTestId('project-detail-agent-count')).toHaveText(`${baseline.agentCount} assigned`);
    const techStack = page.getByTestId('project-detail-tech-stack');
    const techMissing = page.getByTestId('project-detail-tech-stack-missing');
    await expect(techStack.or(techMissing)).toBeVisible();
    await expect(page.getByTestId('project-detail-tags')).toBeVisible();

    const descMarker = `CAP-DESC-${Date.now()}`;
    await page.getByTestId('edit-project-btn').click();
    await page.getByTestId('edit-proj-description').fill(descMarker);
    await page.getByTestId('save-edit-project-btn').click();
    await expect(page.getByTestId('project-detail-description')).toContainText(descMarker, { timeout: 10000 });

    // ── R3: Override drawer (agent 20 — no baseline overrides) ──
    await page.getByTestId('project-subtab-agents').click();
    await expect(page.getByTestId(`project-agent-row-${OVERRIDE_AID}`)).toBeVisible();
    const dot = page.getByTestId(`project-agent-has-overrides-${OVERRIDE_AID}`);
    await expect(dot).not.toBeVisible();

    await page.getByTestId(`project-agent-row-${OVERRIDE_AID}`).click();
    await expect(page.getByTestId(`project-agent-override-drawer-${OVERRIDE_AID}`)).toBeVisible();
    await expect(page.getByTestId('pa-inherited-hint').first()).toBeVisible();
    // B4 AC-5: solo drawer root is multi-column grid
    const overrideCls = await page.getByTestId(`project-agent-override-drawer-${OVERRIDE_AID}`).getAttribute('data-classification');
    if (overrideCls === 'solo') {
      const grid = page.getByTestId(`pa-drawer-grid-${OVERRIDE_AID}`);
      await expect(grid).toBeVisible();
      const colTracks = await grid.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(/\s+/).filter(Boolean).length);
      expect(colTracks).toBeGreaterThanOrEqual(2);
    }
    await page.getByTestId(`project-agent-effort-select-${OVERRIDE_AID}`).selectOption('high');
    await page.waitForTimeout(500);
    await page.keyboard.press('Escape');
    await expect(dot).toBeVisible({ timeout: 10000 });

    await page.reload();
    await openCardsAgentsSolo(page);
    await expect(dot).toBeVisible();

    await page.getByTestId(`project-agent-row-${OVERRIDE_AID}`).click();
    await page.getByTestId(`project-agent-effort-reset-${OVERRIDE_AID}`).click();
    await page.waitForTimeout(500);
    await page.keyboard.press('Escape');
    await expect(dot).not.toBeVisible();

    // ── Cross-cutting: tab switching preserves reachability ──
    await page.getByTestId('project-subtab-detail').click();
    await expect(page.getByTestId('project-detail-description')).toBeVisible();
    await page.getByTestId('project-subtab-documents').click();
    await page.getByTestId('doc-subtab-docs').click();

    // ── R4: Docs subtab ──
    await expect(page.getByTestId('docs-tree')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('docs-group-root')).toBeVisible();

    await page.getByTestId('doc-row-overview.md').click();
    await expect(page.getByTestId('viewed-doc-pane')).toBeVisible();
    await expect(page.getByTestId('md-view')).toBeVisible();

    await page.getByTestId('docs-edit-btn').click();
    const ta = page.getByTestId('docs-edit-textarea');
    const prior = await ta.inputValue();
    await ta.fill(prior + `\n\n${CAP_EDIT_MARKER}\n`);
    await page.getByTestId('docs-edit-save').click();
    await expect(page.getByTestId('md-view')).toContainText(CAP_EDIT_MARKER, { timeout: 15000 });

    await page.getByTestId('docs-new-btn').click();
    await page.getByTestId('docs-new-folder').fill('..');
    await page.getByTestId('docs-new-name').fill('evil.md');
    await page.getByTestId('docs-new-save').click();
    await expect(page.getByTestId('docs-new-err')).toBeVisible({ timeout: 10000 });

    await page.getByTestId('docs-new-folder').fill(CAP_DOCS_FOLDER);
    await page.getByTestId('docs-new-name').fill(CAP_DOCS_FILE);
    await page.getByTestId('docs-new-content').fill('# CAP throwaway\n');
    await page.getByTestId('docs-new-save').click();
    await expect(page.getByTestId(`docs-group-${CAP_DOCS_FOLDER}`)).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId(`doc-row-${CAP_DOCS_FOLDER}-${CAP_DOCS_FILE.replace('.md', '')}.md`)).toBeVisible();

    await page.getByTestId(`doc-row-${CAP_DOCS_FOLDER}-${CAP_DOCS_FILE.replace('.md', '')}.md`).click();
    await page.getByTestId('docs-delete-btn').click();
    await expect(page.getByTestId(`doc-row-${CAP_DOCS_FOLDER}-${CAP_DOCS_FILE.replace('.md', '')}.md`)).not.toBeVisible({ timeout: 10000 });

    // ── R5: Tasks subtab ──
    await page.getByTestId('doc-subtab-tasks').click();
    await expect(page.getByTestId('tasks-tree')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId(`tasks-group-${CAP_TASKLIST}`)).toBeVisible();
    await expect(page.getByTestId(`task-unit-${CAP_TASK_KEY}`)).toBeVisible();
    await expect(page.getByTestId(`task-status-${CAP_TASK_KEY}`)).toHaveText('working');
    await expect(page.getByTestId('task-unit-task-cap-nobadge')).toBeVisible();
    await expect(page.getByTestId('task-status-task-cap-nobadge')).toHaveCount(0);

    // ── No page/console errors during journey (R4 bad-write 400 is expected UX) ──
    const allowedConsole = [/Failed to load resource:.*400 \(Bad Request\)/];
    const unexpectedConsole = consoleErrors.filter((e) => !allowedConsole.some((p) => p.test(e)));
    expect(pageErrors, `page errors: ${pageErrors.join('; ')}`).toEqual([]);
    expect(unexpectedConsole, `console errors: ${unexpectedConsole.join('; ')}`).toEqual([]);

    // ── CLEAN-STATE assertion (explicit end — not just teardown hope) ──
    await cleanupCapArtifacts(baseline);

    const agentsResp = await request.get(`${BASE}/api/projects/${CARDS_ID}/agents`, {
      headers: { Authorization: `Bearer ${baseline.token}` },
    });
    const agentsData = await agentsResp.json();
    const endAgentIds = (agentsData.projectAgents || []).map((p: { agent_id: number }) => p.agent_id).sort((a: number, b: number) => a - b);
    expect(endAgentIds).toEqual(baseline.agentIds);
    expect(endAgentIds.length).toBe(baseline.agentCount);

    const db = new Database(DB_PATH);
    const endTaskKeys = (db.prepare('SELECT task_key FROM tasks WHERE project_id = ? AND task_key IS NOT NULL').all(CARDS_ID) as { task_key: string }[])
      .map((r) => r.task_key)
      .sort();
    db.close();
    expect(endTaskKeys).toEqual(baseline.taskKeys);
    expect(endTaskKeys).not.toContain(CAP_TASK_KEY);

    const helmDocsFiles = fs.readdirSync(path.join(CARDS_DIR, 'helm_docs')).filter((f) => f.endsWith('.md')).sort();
    expect(helmDocsFiles).toEqual(baseline.helmDocsFiles);
    expect(helmDocsFiles).toEqual(ORIGINAL_DOCS);
    expect(fs.existsSync(path.join(CARDS_DIR, 'helm_docs', CAP_DOCS_FOLDER))).toBe(false);

    const helmTasksEntries = fs.existsSync(path.join(CARDS_DIR, 'helm_tasks'))
      ? fs.readdirSync(path.join(CARDS_DIR, 'helm_tasks'))
      : [];
    expect(helmTasksEntries).toEqual(baseline.helmTasksEntries);
    expect(helmTasksEntries).not.toContain(CAP_TASKLIST);

    const dbDesc = new Database(DB_PATH);
    const row = dbDesc.prepare('SELECT description FROM projects WHERE id = ?').get(CARDS_ID) as { description: string | null };
    dbDesc.close();
    expect(row?.description || '').toBe(baseline.description);

    await openCardsAgentsSolo(page);
    await expect(page.getByTestId(`project-agent-has-overrides-${OVERRIDE_AID}`)).not.toBeVisible();

    const overview = fs.readFileSync(path.join(CARDS_DIR, 'helm_docs/overview.md'), 'utf8');
    expect(overview).not.toContain(CAP_EDIT_MARKER);

    await openCardsTasks(page);
    await expect(page.getByTestId(`tasks-group-${CAP_TASKLIST}`)).not.toBeVisible();
    await expect(page.getByTestId('tasks-unmapped-note')).not.toBeVisible();
  });
});