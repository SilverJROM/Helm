// #46 (2026-07-20): run artifacts (briefs, callbacks.md, evidence, plan.json) were written to
// os.tmpdir()/helm-run-<projectId>-<batchId> at FIVE independent call sites sharing a copy-pasted
// formula. A mid-run reboot wipes /tmp, so a client loses the run's paperwork; and five copies of the
// path invite drift (a reader looking in the wrong place). This centralises the formula into ONE
// resolver so the location is a single knob.
//
// DEFAULT = os.tmpdir() (unchanged behavior). Durability is opt-in via HELM_RUN_ROOT because worker
// seats append to callbacks.md INSIDE the run dir under the Landlock write-fence — a durable run root
// must therefore also be on the sandbox allowlist (HELM_SANDBOX_RO_ALLOW / the fence config). Set both
// together for a client deployment that must survive a reboot.

import os from 'node:os';
import path from 'node:path';

/** Root under which per-run directories live. HELM_RUN_ROOT overrides; default is the OS temp dir. */
export function runRoot(): string {
  const override = (process.env.HELM_RUN_ROOT || '').trim();
  return override || os.tmpdir();
}

/** The canonical per-run directory. The ONE formula — all readers and writers must call this. */
export function resolveRunDir(projectId: number | string, batchId: string): string {
  return path.join(runRoot(), `helm-run-${projectId}-${batchId}`);
}
