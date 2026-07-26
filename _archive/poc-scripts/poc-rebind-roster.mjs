import { chromium } from '@playwright/test';
const log = (...a) => console.log('[roster]', ...a);
// Original multi-provider roster (now that grok+codex work under the sandbox):
// implementer=grok-build(1), validator=codex-5.4(16), red-team=[grok-build(1),grok-composer(14),spark(15)], projcore=claude-sonnet(3)
const browser = await chromium.launch();
const page = await browser.newPage();
try {
  await page.goto('http://localhost:3110', { waitUntil: 'networkidle' });
  await page.fill('input[type=password]', 'JROM-OWNER-SECRET-2026');
  await page.click('button:has-text("Login")');
  await page.waitForSelector('[data-testid=nav-project-setup]', { timeout: 15000 });
  await page.click('[data-testid=nav-project-setup]');
  await page.waitForSelector('[data-testid=role-project-select]', { timeout: 10000 });
  await page.selectOption('[data-testid=role-project-select]', '1');
  await page.waitForTimeout(1000);
  await page.selectOption('[data-testid=role-projcore-select]', '3');   // claude-sonnet
  await page.selectOption('[data-testid=role-implementer-select]', '1'); // grok-build
  await page.selectOption('[data-testid=role-validator-select]', '16');  // codex-5.4
  // red-team: clear all, then add grok-build(1), grok-composer(14), spark(15)
  for (let i = 0; i < 8; i++) {
    const btns = await page.$$('[data-testid^=role-redteam-remove-]');
    if (!btns.length) break;
    await btns[0].click(); await page.waitForTimeout(200);
  }
  for (const aid of ['1', '14', '15']) {
    await page.selectOption('[data-testid=role-redteam-add-select]', aid);
    await page.click('[data-testid=role-redteam-add]');
    await page.waitForTimeout(300);
  }
  await page.click('[data-testid=role-assign-submit]');
  await page.waitForTimeout(1500);
  const b = await page.evaluate(async () => {
    const t = sessionStorage.getItem('helm_token');
    const r = await fetch('/api/projects/1/bindings', { headers: { Authorization: 'Bearer ' + t } });
    return await r.json();
  });
  log('bindings:', JSON.stringify((b.bindings || []).map(x => `${x.role}:${x.agent_id}`)));
  await browser.close();
} catch (e) { log('ERROR', e.message); await browser.close(); process.exit(1); }
