import { chromium } from '@playwright/test';
const log = (...a) => console.log('[rebind]', ...a);
const browser = await chromium.launch();
const page = await browser.newPage();
try {
  await page.goto('http://localhost:3110', { waitUntil: 'networkidle' });
  await page.fill('input[type=password]', 'JROM-OWNER-SECRET-2026');
  await page.click('button:has-text("Login")');
  await page.waitForSelector('[data-testid=nav-project-setup]', { timeout: 15000 });
  await page.click('[data-testid=nav-project-setup]');
  await page.waitForSelector('[data-testid=role-project-select]', { timeout: 10000 });
  // select cards project (id 1)
  await page.selectOption('[data-testid=role-project-select]', '1');
  await page.waitForTimeout(1000); // load current bindings
  // implementer -> claude-sonnet (3)
  await page.selectOption('[data-testid=role-implementer-select]', '3');
  // validator -> claude validator (6)
  await page.selectOption('[data-testid=role-validator-select]', '6');
  // remove all current red-team chips
  for (let i = 0; i < 8; i++) {
    const btns = await page.$$('[data-testid^=role-redteam-remove-]');
    if (!btns.length) break;
    await btns[0].click();
    await page.waitForTimeout(200);
  }
  // add panelist (11) as the sole red-teamer
  await page.selectOption('[data-testid=role-redteam-add-select]', '11');
  await page.click('[data-testid=role-redteam-add]');
  await page.waitForTimeout(300);
  // submit
  await page.click('[data-testid=role-assign-submit]');
  await page.waitForTimeout(1500);
  // verify
  const bindings = await page.evaluate(async () => {
    const t = sessionStorage.getItem('helm_token');
    const r = await fetch('/api/projects/1/bindings', { headers: { Authorization: 'Bearer ' + t } });
    return await r.json();
  });
  log('bindings now:', JSON.stringify((bindings.bindings || []).map(b => `${b.role}:${b.agent_id}`)));
  await browser.close();
} catch (e) { log('ERROR', e.message); await browser.close(); process.exit(1); }
