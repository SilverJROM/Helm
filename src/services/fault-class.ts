// #53 (JROM-locked 2026-07-20): the ONE non-retryable fault class.
//
// Three separate bugs this session were the same shape: Helm's retry ladder is its reflex for EVERY
// failure, including whole classes that retrying cannot fix — an expired auth token (#47) churned 6
// silent respawns; a missing-deps `npm test` exit 127 (this task) re-dispatched the implementer 5×; a
// fence-blocked gitdir (#49) made a worker improvise `git init`. Retrying any of them is pure waste:
// the fault lives in the environment/credentials, not the code. This module is the shared classifier
// that lets the loop short-circuit the ladder and PAUSE with a remedy instead of burning attempts.
//
// A non-retryable fault is OPERATOR-RECOVERABLE, so the run pauses (status='paused', resumable) rather
// than failing. `canFailover` encodes JROM's token-conservation rule: an auth logout on grok must NOT
// silently fail over to the scarce codex/claude seats — with codex/claude low, we stop and wait for the
// manual grok relogin (grok force-logs-out every ~6h). So auth faults are canFailover:false; the run
// holds until the operator re-auths, then resumes.

export type FaultKind =
  | 'auth' // CLI not authenticated (expired/rejected token). Provider-level; every seat on it fails alike.
  | 'env-missing-cmd' // a required command is not on PATH (exit 127 / "command not found").
  | 'env-missing-deps' // node_modules / a toolchain dep is absent (tests can't even start).
  | 'fence-denied'; // the write-fence refused a legitimate op (e.g. git commit to a gitdir outside projectDir).

export interface NonRetryableFault {
  kind: FaultKind;
  /** Provider whose seat/credentials are at fault, when known (auth). */
  provider?: string;
  /** Operator-facing remedy — goes into the pause artifact + page, so the fix is in the signal itself. */
  remedy: string;
  /** May the ladder legitimately try a different provider? FALSE for auth (token-conservation: never
   *  burn codex/claude to paper over a grok logout — pause and wait for relogin). */
  canFailover: boolean;
  /** The raw evidence line/snippet, for the artifact. */
  evidence: string;
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
const strip = (s: string) => (s ?? '').replace(ANSI_RE, '');

function remedyForProvider(provider?: string): string {
  switch ((provider || '').toLowerCase()) {
    case 'grok': return 'run `grok login` (grok force-logs-out ~every 6h), then resume this run';
    case 'codex': return 'run `codex login`, then resume this run';
    case 'claude': return 'run `claude` and complete /login, then resume this run';
    default: return `re-authenticate the ${provider || 'provider'} CLI, then resume this run`;
  }
}

/**
 * Classify a DETERMINISTIC-GATE failure (from its exit code + captured output) as a non-retryable
 * environment fault, or null if it is a genuine (retryable) test failure. Exit 127 is definitionally
 * "command not found"; a "<cmd>: not found" line or a missing-module signature says the toolchain isn't
 * provisioned — no amount of re-implementing fixes it. Anything else (a real assertion failure, a
 * nonzero exit WITH test output) is retryable and returns null.
 */
export function classifyGateFault(exitCode: number | undefined | null, output: string): NonRetryableFault | null {
  const text = strip(output);
  const isMissingCmd =
    exitCode === 127 ||
    /\b(?:command not found|not found)\b/i.test(text) && /sh:\s*\d+:|:\s*(?:command )?not found/i.test(text);
  if (isMissingCmd) {
    const m = text.match(/(?:sh:\s*\d+:\s*)?([\w./-]+):\s*(?:command )?not found/i);
    const cmd = m ? m[1] : undefined;
    // A missing project-local binary almost always means deps were never installed.
    const looksLikeDeps = cmd ? /^(?:tsx|vitest|jest|tsc|eslint|playwright|mocha|ts-node)$/i.test(cmd) : false;
    return looksLikeDeps
      ? { kind: 'env-missing-deps', remedy: `run \`npm install\` (or \`npm ci\`) in the project dir — \`${cmd}\` is not on PATH; then resume`, canFailover: false, evidence: (m?.[0] || 'exit 127').slice(0, 200) }
      : { kind: 'env-missing-cmd', remedy: `install / put \`${cmd ?? 'the required command'}\` on the seat PATH, then resume`, canFailover: false, evidence: (m?.[0] || `exit ${exitCode}`).slice(0, 200) };
  }
  // node_modules explicitly missing (some toolchains print this instead of 127).
  if (/Cannot find module|ERR_MODULE_NOT_FOUND|node_modules.*(?:ENOENT|not found)|Cannot find package/i.test(text)) {
    return { kind: 'env-missing-deps', remedy: 'run `npm install` (or `npm ci`) in the project dir, then resume', canFailover: false, evidence: (text.match(/.*(?:Cannot find (?:module|package)|ERR_MODULE_NOT_FOUND).*/i)?.[0] || 'missing module').slice(0, 200) };
  }
  return null; // genuine test failure → retryable
}

/**
 * Build the auth fault for a seat whose CLI reported it is not authenticated (pane already matched by
 * seat-auth.matchSeatAuthError). canFailover:false — never burn another provider to cover a logout.
 */
export function authFault(provider: string | undefined, evidence: string): NonRetryableFault {
  return { kind: 'auth', provider, remedy: remedyForProvider(provider), canFailover: false, evidence: (evidence || '').slice(0, 200) };
}

/**
 * Classify a git/worktree failure surfaced from a worker's own tooling as a fence-denied fault when the
 * gitdir sits outside the writable projectDir. Prevents the "worker improvises `git init`" anti-pattern
 * by turning it into an operator pause with the real fix.
 */
export function classifyGitFault(output: string): NonRetryableFault | null {
  const text = strip(output);
  if (/not a git repository|\.git file .* does not reference|gitdir:.*No such file|unable to (?:read|access) .*\.git|Operation not permitted.*\.git|Read-only file system.*\.git/i.test(text)) {
    return { kind: 'fence-denied', remedy: 'the cycle worktree\'s gitdir is outside the write-fence / missing — provision a self-contained repo in the project dir (or add the gitdir to HELM_SANDBOX_RO_ALLOW), then resume', canFailover: false, evidence: (text.split(/\r?\n/).find((l) => /git|gitdir/i.test(l)) || 'git fault').slice(0, 200) };
  }
  return null;
}
