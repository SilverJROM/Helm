import { chromium } from '@playwright/test';

const PROMPT = "Add a Lucky 9 card game to this cards app. Rules: each player dealt 2 cards (option for a 3rd), hand value = sum of card values mod 10 (10/face=0, ace=1), closest to 9 wins. Wire it into the existing Express + socket.io multiplayer like Holdem/Blackjack, and add tests. Plan it, then build it.";

const log = (...a) => console.log('[poc]', ...a);
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', m => { const t = m.text(); if (/error|fail|400|401|run/i.test(t)) log('console:', t); });
try {
  await page.goto('http://localhost:3110', { waitUntil: 'networkidle' });
  // login
  await page.fill('input[type=password]', 'JROM-OWNER-SECRET-2026');
  await page.click('button:has-text("Login")');
  await page.waitForSelector('[data-testid=nav-command-center]', { timeout: 15000 });
  log('logged in');
  await page.click('[data-testid=nav-command-center]');
  await page.waitForSelector('[data-testid=content-cmd-chat]', { timeout: 10000 });

  // open the cards tab (id 1). Try existing item; else use the idle "+ open idle…" select in cc-col-left.
  let opened = await page.$('[data-testid=cc-proj-item-1]');
  if (!opened) {
    const sel = page.locator('[data-testid=cc-col-left] select').first();
    // select option whose label is "cards" (value = project id)
    await sel.selectOption({ label: 'cards' }).catch(async () => {
      // fallback: pick option by value 1
      await sel.selectOption('1');
    });
    await page.waitForTimeout(800);
  }
  // make cards active
  const item = await page.$('[data-testid=cc-proj-item-1]');
  if (item) { await item.click(); log('cards tab active'); }
  else log('WARN: cc-proj-item-1 not found after open attempt');
  await page.waitForTimeout(500);

  // type + send through the real chat composer
  await page.fill('[data-testid=chat-composer]', PROMPT);
  await page.waitForTimeout(300);
  await page.click('[data-testid=chat-send]');
  log('sent chat → projcore');
  await page.waitForTimeout(9000);

  // run-phase present?
  const phase = await page.$eval('[data-testid=run-phase]', el => el.textContent).catch(() => null);
  log('run-phase:', phase);
  const errToast = await page.$eval('[data-testid=login-error]', el => el.textContent).catch(() => null);
  if (errToast) log('error-toast:', errToast);
  // any visible error text
  const bodyErr = await page.evaluate(() => {
    const t = document.body.innerText;
    const m = t.match(/(400|401|duplicate|BRIEF-CONTRACT|BLOCK|error[^\n]{0,80})/i);
    return m ? m[0] : null;
  });
  if (bodyErr) log('body-error-hint:', bodyErr);

  // READ-ONLY runs query
  const runs = await page.evaluate(async () => {
    const t = sessionStorage.getItem('helm_token');
    try { const r = await fetch('/api/projects/1/runs', { headers: { Authorization: 'Bearer ' + t } }); return { status: r.status, body: await r.text() }; }
    catch (e) { return { err: String(e) }; }
  });
  log('GET /runs:', JSON.stringify(runs).slice(0, 600));

  await page.screenshot({ path: '/tmp/poc-shots/rerun.png', fullPage: false }).catch(() => {});
  log('done');
} catch (e) {
  log('SCRIPT ERROR:', e.message);
} finally {
  await browser.close();
}
