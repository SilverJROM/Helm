// R1 (CC-CHAT-3): reactive CLI-prompt interceptor — ONE source of truth for interactive
// interstitials a spawned CLI can show on launch INSTEAD of its ready marker.
//
// Live incident (run stalled at PLAN-READY): codex 0.142.x showed
//   "✨ Update available! → 1. Update now (runs npm install -g @openai/codex) / 2. Skip /
//    3. Skip until next version / Press enter to continue"
// Helm's spawn input triggered "Update now" → failing `npm install` (exit 243) → the codex TUI
// never started and the planning partner hung. The ready-probe loops (real-transport.ts +
// master-runtime-service.ts) now consult this ordered table on EVERY poll, BEFORE checking the
// ready marker: on a match they send the mapped keys (never "Update now"), log loudly, and keep
// polling. Auth/login-expired patterns are terminal: the probe must return a DISTINCT failure
// (spawn BLOCKED — needs a human), never guess keys, never hang silently.
//
// This module is pure (string-in → action-out): network/tmux-free by design so the table is
// unit-testable. Key SENDING lives with the callers (they own the tmux handle).

export interface InterstitialEntry {
  /** stable id — also the per-spawn "handled" guard key (never re-send the same response in a loop) */
  id: string;
  /** provider filter; undefined = applies to any provider */
  provider?: string;
  /** matched against the ANSI-STRIPPED pane text */
  test: RegExp;
  /**
   * tmux key names to send (send-keys, NOT literal -l), e.g. ['3', 'Enter'].
   * A function form resolves keys FROM the pane (e.g. find the menu number whose label is
   * "Skip until next version" — menus can renumber between CLI versions).
   * Empty array = log-only safety no-op.
   */
  keys: string[] | ((strippedPane: string) => string[]);
  note: string;
  /** true = do NOT send anything; the spawn must fail DISTINCTLY as BLOCKED (needs a human) */
  blocked?: boolean;
}

export interface InterstitialAction {
  id: string;
  keys: string[];
  note: string;
  blocked: boolean;
}

/** Distinct failure for auth/login interstitials: callers mark the spawn BLOCKED (needs a human). */
export class InterstitialBlockedError extends Error {
  constructor(public readonly interstitialId: string, note: string) {
    super(`cli interstitial BLOCKED (${interstitialId}): ${note}`);
    this.name = 'InterstitialBlockedError';
  }
}

// mirrors real-transport/master-runtime stripAnsi (applied defensively — idempotent on clean text)
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

// Ordered: most specific first; the broad auth patterns come LAST so a menu that merely mentions
// an account line is claimed by its specific entry first.
export const CLI_INTERSTITIALS: InterstitialEntry[] = [
  {
    id: 'codex-update-prompt',
    provider: 'codex',
    test: /Update available|Update now|Skip until next version/i,
    // Resolve the "Skip until next version" option number FROM the menu (fallback "Skip", then the
    // observed '3'). NEVER the Update-now number — a live `npm install -g` from inside the spawn
    // failed (exit 243) and killed the run.
    keys: (pane: string) => {
      const skipNext = pane.match(/(\d)[.)]\s*Skip until next version/i);
      if (skipNext) return [skipNext[1], 'Enter'];
      const skip = pane.match(/(\d)[.)]\s*Skip\b/i);
      if (skip) return [skip[1], 'Enter'];
      return ['3', 'Enter'];
    },
    note: 'codex update nag → choose "Skip until next version" (NEVER "Update now"; R2 preflight keeps codex fresh out-of-band)',
  },
  {
    id: 'claude-trust-dialog',
    provider: 'claude',
    test: /Do you trust|trust this folder/i,
    // Safety no-op: trust is pre-accepted (real-transport.ensureClaudeTrust writes ~/.claude.json)
    // and the claude composer-ready check refuses ready while this dialog is visible — if it still
    // appears we LOG it (once) and let the probe time out loudly rather than guess a keypress.
    keys: [],
    note: 'claude trust dialog (should be pre-accepted via ensureClaudeTrust) — logged, no keys sent',
  },
  {
    id: 'auth-login-expired',
    // any provider
    test: /not logged in|logged out|session (?:has )?expired|login (?:required|expired|failed)|please (?:log ?in|sign in|authenticate)|authentication (?:required|failed|expired)|sign in to continue|run (?:\/login|codex login|grok login)/i,
    // NOTE: deliberately TIGHTER than the seed regex /log ?in|authenticate/ — codex/grok boot
    // banners legitimately print "Logged in as <acct>", which the broad form would false-BLOCK
    // on every healthy spawn. Phrases above only match the negative/expired shapes.
    keys: [],
    note: 'auth/login expired — spawn BLOCKED (needs a human to re-authenticate; never guess keys, never hang)',
    blocked: true,
  },
];

/**
 * Consult the table against an (ideally ANSI-stripped) pane snapshot.
 * - `provider` filters provider-tagged entries (undefined-tagged entries always apply).
 * - `handled` is the per-spawn guard: entries whose id is already in it are skipped, so the same
 *   response is never re-sent in a tight polling loop. BLOCKED entries are returned even when
 *   handled (the caller throws immediately anyway).
 * Returns the FIRST matching entry's action, or null.
 */
export function matchInterstitial(
  pane: string,
  opts: { provider?: string; handled?: ReadonlySet<string> } = {}
): InterstitialAction | null {
  const stripped = (pane ?? '').replace(ANSI_RE, '');
  for (const entry of CLI_INTERSTITIALS) {
    if (entry.provider && opts.provider && entry.provider !== opts.provider) continue;
    if (!entry.blocked && opts.handled?.has(entry.id)) continue;
    if (!entry.test.test(stripped)) continue;
    const keys = typeof entry.keys === 'function' ? entry.keys(stripped) : entry.keys;
    return { id: entry.id, keys, note: entry.note, blocked: !!entry.blocked };
  }
  return null;
}
