import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Blank-slate agent homes for Helm-spawned CLIs (JROM directive 2026-07-06).
 *
 * codex and grok auto-load the OPERATOR's own skills/agents from their home config dirs
 * (~/.codex/skills, ~/.grok/{agents,skills}) — feature-disable flags do NOT stop this. When Helm
 * drives them they must be a blank slate (the project + Helm definitions govern), never the
 * operator's personal agent library. So Helm points each spawn at an ISOLATED home that read-only
 * symlinks the auth + config it needs but deliberately OMITS the skills/agents dirs.
 *
 * This is Helm-only and NON-destructive: the operator's real ~/.codex / ~/.grok are never touched —
 * these are separate dirs that only symlink INTO the real ones (read-only). The operator keeps every
 * skill/agent when using the CLIs directly.
 *
 * Location: under ~/.cache (the Landlock sandbox grants RW there, and it's persistent — unlike /tmp).
 * The CLIs write their sqlite/session state into the isolated home; reads of the symlinked auth land
 * on the real files (the sandbox allows root-ro reads).
 */

const BASE = path.join(os.homedir(), '.cache', 'helm-agent-homes');

/** Idempotently (re)point linkPath → target when target exists; best-effort, never throws. */
function linkIfPresent(target: string, linkPath: string): void {
  try {
    if (!fs.existsSync(target)) return;
    try {
      const cur = fs.readlinkSync(linkPath);
      if (cur === target) return; // already correct
      fs.unlinkSync(linkPath);
    } catch {
      // not a symlink / absent — remove any stale entry then relink
      try { fs.unlinkSync(linkPath); } catch { /* absent */ }
    }
    fs.symlinkSync(target, linkPath);
  } catch { /* best-effort */ }
}

/**
 * Isolated CODEX_HOME: auth + config only, NO skills/ or plugins/ → codex loads none of the
 * operator's ~/.codex/skills. Returns the absolute path (for `CODEX_HOME=<path>`).
 */
export function ensureBlankCodexHome(): string {
  const dir = path.join(BASE, 'codex');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const real = path.join(os.homedir(), '.codex');
    for (const f of ['auth.json', 'config.toml', 'config.toml.save', 'version.json']) {
      linkIfPresent(path.join(real, f), path.join(dir, f));
    }
  } catch { /* best-effort — a missing home just means fewer symlinks */ }
  return dir;
}

/**
 * Isolated grok HOME: a home whose ~/.grok has auth + config but NO agents/ or skills/ dirs → grok
 * discovers none of the operator's agents/skills. grok has no config-dir env var, so we override HOME
 * (the Landlock sandbox derives its rules from the REAL passwd home, not $HOME, so this only redirects
 * grok's own reads/writes — it does not widen the sandbox). Returns the home path (for `HOME=<path>`).
 */
export function ensureBlankGrokHome(): string {
  const home = path.join(BASE, 'grok');
  try {
    const g = path.join(home, '.grok');
    fs.mkdirSync(g, { recursive: true });
    const real = path.join(os.homedir(), '.grok');
    for (const f of ['auth.json', 'auth.json.lock', 'config.toml', 'managed_config.lock', 'agent_id', '.metadata_version']) {
      linkIfPresent(path.join(real, f), path.join(g, f));
    }
    // grok's shell tools may want the operator's git identity; symlink it (read-only) into the home.
    linkIfPresent(path.join(os.homedir(), '.gitconfig'), path.join(home, '.gitconfig'));
  } catch { /* best-effort */ }
  return home;
}
