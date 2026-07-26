import { chromium } from '@playwright/test';
const b = await chromium.launch(); const p = await b.newPage();
try {
  await p.goto('http://localhost:3110', { waitUntil: 'networkidle' });
  await p.fill('input[type=password]', 'JROM-OWNER-SECRET-2026'); await p.click('button:has-text("Login")');
  await p.waitForSelector('[data-testid=nav-project-setup]', { timeout: 15000 }); await p.click('[data-testid=nav-project-setup]');
  await p.waitForSelector('[data-testid=role-project-select]', { timeout: 10000 });
  await p.selectOption('[data-testid=role-project-select]', '1'); await p.waitForTimeout(1000);
  await p.selectOption('[data-testid=role-projcore-select]', '1');   // grok-build
  await p.click('[data-testid=role-assign-submit]'); await p.waitForTimeout(1500);
  const r = await p.evaluate(async () => { const t = sessionStorage.getItem('helm_token'); const x = await fetch('/api/projects/1/bindings', { headers: { Authorization: 'Bearer ' + t } }); return await x.json(); });
  console.log('bindings:', JSON.stringify((r.bindings || []).map(x => `${x.role}:${x.agent_id}`)));
  await b.close();
} catch (e) { console.log('ERR', e.message); await b.close(); process.exit(1); }
