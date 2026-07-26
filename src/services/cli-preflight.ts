// R2 (CC-CHAT-3): CLI freshness preflight — belt-and-suspenders on top of the R1 reactive
// interstitial interceptor (cli-interstitials.ts). Keeping codex current means its
// "✨ Update available!" nag (which once hijacked a live spawn into a failing `npm install`)
// rarely appears at all.
//
// Contract: ONCE at server startup, best-effort, NON-BLOCKING — every step is inside try/catch,
// the caller never awaits it on the boot path, and it can NEVER block or fail boot. Not per-spawn.
// HELM_SKIP_CLI_PREFLIGHT=1 skips it entirely.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function runCliFreshnessPreflight(): Promise<void> {
  if (process.env.HELM_SKIP_CLI_PREFLIGHT === '1') {
    console.log('[cli-preflight] skipped (HELM_SKIP_CLI_PREFLIGHT=1)');
    return;
  }
  try {
    const { stdout, stderr } = await exec('codex', ['update'], { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
    const tail = `${stdout || ''}\n${stderr || ''}`.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-3).join(' | ').slice(0, 300);
    console.log(`[cli-preflight] codex update (best-effort): ${tail || 'ok (no output)'}`);
  } catch (e: any) {
    // best-effort only — a missing binary / network failure / old codex without `update` must
    // never matter for boot; R1 still intercepts the nag reactively at spawn time.
    console.warn(`[cli-preflight] codex update best-effort failed (non-blocking): ${(e?.message || String(e)).slice(0, 300)}`);
  }
  try {
    const { stdout } = await exec('codex', ['--version'], { timeout: 15_000 });
    console.log(`[cli-preflight] codex version: ${(stdout || '').trim()}`);
  } catch (e: any) {
    console.warn(`[cli-preflight] codex --version failed (non-blocking): ${(e?.message || String(e)).slice(0, 200)}`);
  }
}
