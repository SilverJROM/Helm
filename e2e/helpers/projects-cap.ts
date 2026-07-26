import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { APIRequestContext, Page } from '@playwright/test';

export const CRED = process.env.HELM_OWNER_CRED || 'JROM-OWNER-SECRET-2026';
export const BASE = process.env.HELM_BASE_URL || 'http://127.0.0.1:3110';
export const CARDS_ID = 1;
export const CARDS_DIR = '/home/agjrom/websites/cards';
export const DB_PATH = process.env.HELM_DB_PATH || '/home/agjrom/TGBOTS/Helm/data/helm.db';
export const OVERRIDE_AID = 20;

export const CAP_TASK_KEY = 'task-cap-seed';
export const CAP_TASKLIST = 'cap-e2e';
export const CAP_DOCS_FOLDER = 'cap-throwaway';
export const CAP_DOCS_FILE = 'proof.md';
export const CAP_EDIT_MARKER = 'CAP-CAPSTONE-EDIT-MARKER';
export const ORIGINAL_DOCS = ['overview.md', 'preferences.md', 'specs.md', 'tech-stack.md'];

export type CardsBaseline = {
  token: string;
  agentIds: number[];
  agentCount: number;
  description: string;
  overviewContent: string;
  taskKeys: string[];
  helmDocsFiles: string[];
  helmTasksEntries: string[];
};

export async function login(page: Page): Promise<void> {
  await page.goto(`${BASE}/`);
  await page.locator('input[placeholder="owner credential"]').fill(CRED);
  await page.click('button:has-text("Login")');
  await page.getByTestId('nav-project-setup').waitFor({ state: 'visible', timeout: 15000 });
}

export async function openCards(page: Page): Promise<void> {
  await page.getByTestId('nav-project-setup').click();
  await page.getByTestId('tab-projects').click();
  await page.getByTestId(`project-row-${CARDS_ID}`).click();
}

export async function openCardsAgentsSolo(page: Page): Promise<void> {
  await openCards(page);
  await page.getByTestId('project-subtab-agents').click();
  // B3: Solo/Team subtabs removed — unified agent list always renders
}

export async function openCardsDocs(page: Page): Promise<void> {
  await openCards(page);
  await page.getByTestId('project-subtab-documents').click();
  await page.getByTestId('doc-subtab-docs').click();
}

export async function openCardsTasks(page: Page): Promise<void> {
  await openCards(page);
  await page.getByTestId('project-subtab-documents').click();
  await page.getByTestId('doc-subtab-tasks').click();
}

export async function captureBaseline(request: APIRequestContext): Promise<CardsBaseline> {
  const loginResp = await request.post(`${BASE}/api/auth/login`, { data: { credential: CRED } });
  const { token } = await loginResp.json();
  const agentsResp = await request.get(`${BASE}/api/projects/${CARDS_ID}/agents`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const agentsData = await agentsResp.json();
  const agentIds = (agentsData.projectAgents || []).map((p: { agent_id: number }) => p.agent_id).sort((a: number, b: number) => a - b);

  const db = new Database(DB_PATH);
  const proj = db.prepare('SELECT description FROM projects WHERE id = ?').get(CARDS_ID) as { description: string | null };
  const taskKeys = (db.prepare('SELECT task_key FROM tasks WHERE project_id = ? AND task_key IS NOT NULL').all(CARDS_ID) as { task_key: string }[])
    .map((r) => r.task_key)
    .sort();
  db.close();

  const overviewPath = path.join(CARDS_DIR, 'helm_docs/overview.md');
  const overviewContent = fs.existsSync(overviewPath) ? fs.readFileSync(overviewPath, 'utf8') : '';

  const helmDocsDir = path.join(CARDS_DIR, 'helm_docs');
  const helmDocsFiles = fs.existsSync(helmDocsDir)
    ? fs.readdirSync(helmDocsDir).filter((f) => f.endsWith('.md')).sort()
    : [];

  const helmTasksDir = path.join(CARDS_DIR, 'helm_tasks');
  const helmTasksEntries = fs.existsSync(helmTasksDir) ? fs.readdirSync(helmTasksDir).sort() : [];

  return {
    token,
    agentIds,
    agentCount: agentIds.length,
    description: proj?.description || '',
    overviewContent,
    taskKeys,
    helmDocsFiles,
    helmTasksEntries,
  };
}

export function seedCapTasks(): void {
  const seedDir = path.join(CARDS_DIR, 'helm_tasks', CAP_TASKLIST, CAP_TASK_KEY);
  const nobadgeDir = path.join(CARDS_DIR, 'helm_tasks', CAP_TASKLIST, 'task-cap-nobadge');
  fs.mkdirSync(seedDir, { recursive: true });
  fs.mkdirSync(nobadgeDir, { recursive: true });
  fs.writeFileSync(path.join(seedDir, 'changes.md'), '# CAP seed task\n\nCapstone R5 status badge proof.\n');
  fs.writeFileSync(path.join(nobadgeDir, 'changes.md'), '# CAP nobadge task\n\nNo TaskRow — no badge expected.\n');

  const db = new Database(DB_PATH);
  const existing = db.prepare('SELECT id FROM tasks WHERE project_id = ? AND task_key = ?').get(CARDS_ID, CAP_TASK_KEY);
  if (!existing) {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO tasks (project_id, task_key, label, status, agent, position, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(CARDS_ID, CAP_TASK_KEY, 'CAP seed task', 'working', 'implementer', 0, now, now);
  }
  db.close();
}

export async function cleanupCapArtifacts(baseline: CardsBaseline): Promise<void> {
  try {
    const db = new Database(DB_PATH);
    db.prepare('DELETE FROM tasks WHERE project_id = ? AND task_key = ?').run(CARDS_ID, CAP_TASK_KEY);
    db.close();
  } catch {}

  try {
    fs.rmSync(path.join(CARDS_DIR, 'helm_tasks', CAP_TASKLIST), { recursive: true, force: true });
  } catch {}

  try {
    fs.rmSync(path.join(CARDS_DIR, 'helm_docs', CAP_DOCS_FOLDER), { recursive: true, force: true });
  } catch {}

  try {
    const overviewPath = path.join(CARDS_DIR, 'helm_docs/overview.md');
    let content = baseline.overviewContent;
    if (content.includes(CAP_EDIT_MARKER)) {
      content = content.replace(new RegExp(`\\n*${CAP_EDIT_MARKER}\\n*`, 'g'), '\n').trimEnd() + '\n';
      fs.writeFileSync(overviewPath, content, 'utf8');
    } else {
      fs.writeFileSync(overviewPath, baseline.overviewContent, 'utf8');
    }
  } catch {}

  try {
    const loginResp = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: CRED }),
    });
    const { token } = await loginResp.json();
    await fetch(`${BASE}/api/projects/${CARDS_ID}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'cards',
        directory: CARDS_DIR,
        description: baseline.description,
        dev_url: null,
        qa_url: null,
        tags: [],
      }),
    });
  } catch {}

  try {
    const loginResp = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: CRED }),
    });
    const { token } = await loginResp.json();
    await fetch(`${BASE}/api/projects/${CARDS_ID}/agents/${OVERRIDE_AID}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ effort_override: null }),
    });
  } catch {}
}