#!/usr/bin/env node
/* Deterministic stub-agent for the Phase-2 scenario harness (nested-projcore run).
 * Exercises the REAL transport seam (tmux spawn → ready-probe → brief delivery → callback parse)
 * WITHOUT a real model, so we can force every helm-algo branch deterministically.
 *
 * Launched by Helm as: node tools/stub-agent.js <model>   (model = stub-<role>, e.g. stub-implementer)
 * - Prints "STUB-READY" so the provider readyProbe (signal:"STUB-READY") passes.
 * - Reads its control script at /tmp/stub-control/<role>.json (written by the harness per scenario):
 *     { callbacksPath, batchId, script: [ {delayMs, state, note} | {delayMs, raw} ] }
 *   "no-callback" scenario = empty script. "garbage" = a {raw:"..."} step.
 * - Emits each scripted callback by appending to callbacksPath (direct write — same fallback real
 *   agents use when emit-status.sh 403s), then stays alive until reaped (SIGTERM/SIGINT).
 */
import fs from 'node:fs';

const role = String(process.argv[2] || 'stub-implementer').replace(/^stub-/, '');
const ctrlPath = `/tmp/stub-control/${role}.json`;
let alive = true;
const stop = () => { alive = false; process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function emit(ctrl, step) {
  let line;
  if (step.raw !== undefined) {
    line = String(step.raw);
  } else {
    line = `[helm callback] ${role} ${ctrl.batchId} STATUS: ${step.state}` + (step.note ? ` — ${step.note}` : '');
  }
  try { fs.appendFileSync(ctrl.callbacksPath, line.endsWith('\n') ? line : line + '\n'); } catch (e) {
    process.stdout.write(`STUB-EMIT-ERROR ${role}: ${e.message}\n`);
  }
  process.stdout.write(`STUB-EMITTED ${role}: ${line}\n`);
}

(async () => {
  // 1) Signal ready repeatedly so the (capturePane-based) ready-probe catches it.
  for (let i = 0; i < 10 && alive; i++) { process.stdout.write(`STUB-READY role=${role}\n`); await sleep(400); }

  // 2) Load control (harness writes it before/just-after spawn).
  let ctrl = null;
  for (let i = 0; i < 40 && !ctrl && alive; i++) {
    try { ctrl = JSON.parse(fs.readFileSync(ctrlPath, 'utf8')); } catch { await sleep(500); }
  }
  if (!ctrl) { process.stdout.write(`STUB-NO-CONTROL ${role} (waited 20s) — idling\n`); }

  // 3) Pick this spawn's script. `sequence` (array of scripts) lets a role emit DIFFERENT callbacks on
  //    successive spawns (e.g. validator FAIL then PASS; brain bump-rung then escalate) via a per-role counter.
  //    Falls back to `script` (same every spawn).
  let script = (ctrl && Array.isArray(ctrl.script)) ? ctrl.script : [];
  if (ctrl && Array.isArray(ctrl.sequence) && ctrl.sequence.length) {
    const countFile = `/tmp/stub-control/${role}.count`;
    let idx = 0;
    try { idx = parseInt(fs.readFileSync(countFile, 'utf8'), 10) || 0; } catch {}
    script = ctrl.sequence[Math.min(idx, ctrl.sequence.length - 1)] || [];
    try { fs.writeFileSync(countFile, String(idx + 1)); } catch {}
    process.stdout.write(`STUB-SEQ ${role} spawn#${idx} (${script.length} steps)\n`);
  }

  // 4) Run the chosen callback script.
  if (script.length) {
    for (const step of script) {
      if (!alive) break;
      await sleep(step.delayMs != null ? step.delayMs : 1500);
      emit(ctrl, step);
    }
    process.stdout.write(`STUB-SCRIPT-DONE ${role} (${script.length} steps)\n`);
  }

  // 4) Stay alive until reaped (so the session/handle persists like a real agent).
  while (alive) { await sleep(1000); }
})();
