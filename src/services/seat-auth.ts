// Seat AUTH-failure detection (#47). Sibling of ./seat-binary.ts, and deliberately shaped the same way.
//
// Why this exists: on 2026-07-20 the grok OAuth token expired mid-session. Every implementer seat
// launched fine (the binary resolved, so the A1a/A1b binary checks were silent), printed
// "Authentication required — your session has expired", never produced a first callback, and was reaped
// at the ~62s no-first-callback budget. The loop then respawned a fresh seat and repeated. One task
// burned 6 attempts in ~6 minutes with NOTHING in the engine log, and would have churned to the
// 80-attempt cap (~80 min) before failing the run with a misleading "no callback" reason.
//
// The governing insight: an auth failure is NOT retryable. Retrying cannot fix an expired token, so the
// free-retry/escalation ladder is exactly the wrong response — it converts a 5-second operator fix
// ("run `grok login`") into an hour of silent churn. Detection must therefore be TERMINAL, not a reap.
//
// False-positive discipline (the hard part): unlike a missing binary, the words "authentication" and
// "unauthorized" legitimately appear in the code a worker is writing (a client project with a login
// flow would print them constantly). So a single generic keyword is NOT trusted. A line fires only when
// it is unmistakably a CLI auth-failure notice:
//   (a) it matches one of the EXACT vendor notices below, or
//   (b) it pairs a failure phrase WITH a login-remedy phrase on the same line.
// Combined with marker-scoping (only output after this launch's dispatch marker is scanned), that keeps
// a worker merely *writing* auth code from ever tripping the detector.

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
function stripAnsi(s: string): string {
  return (s ?? '').replace(ANSI_RE, '');
}

/** Terminal error raised when a launched seat's pane shows its CLI is not authenticated. Carries the
 *  offending pane line; the caller attaches provider/model and the remedy command. */
export class SeatAuthError extends Error {
  constructor(public readonly snippet: string, public readonly provider?: string) {
    super(`seat not authenticated${provider ? ` (${provider})` : ''} (pane: ${snippet.slice(0, 160)})`);
    this.name = 'SeatAuthError';
  }
}

// (a) Exact vendor notices — specific enough to trust on their own.
const EXACT_NOTICES: RegExp[] = [
  /authentication required\s*[—\-–:]\s*your session has expired/i,
  /your session has expired or your credentials were rejected/i,
  /credentials were rejected/i,
  /\bnot logged in\b.*\b(run|use)\b.*\blogin\b/i,
  /\bplease (?:run|use)\b[^.\n]*\b(?:grok|codex|claude)\s+login\b/i,
  /\b(?:grok|codex|claude)\s+login\b[^.\n]*\bto (?:re-?)?authenticat/i,
];

// (b) Paired signals — a failure phrase AND a remedy phrase on the SAME line.
const FAILURE_PHRASES: RegExp[] = [
  /\bauthentication (?:required|failed)\b/i,
  /\bsession (?:has )?expired\b/i,
  /\bunauthorized\b/i,
  /\b401\b/,
  /\binvalid (?:api[- ])?key\b/i,
  /\bnot authenticated\b/i,
  /\btoken (?:has )?expired\b/i,
];
const REMEDY_PHRASES: RegExp[] = [
  /\/login\b/i,
  /\blog ?in\b/i,
  /\bsign ?in\b/i,
  /\bre-?authenticate\b/i,
  /\brefresh your (?:token|credentials)\b/i,
];

export interface SeatAuthMatchOpts {
  /** Only scan pane output AFTER the last occurrence of this per-launch marker, so a reused tmux
   *  session's historical scrollback (an OLD auth error, already resolved) cannot fail a fresh launch.
   *  When the marker is not visible yet, returns null — a later capture will contain both. */
  marker?: string;
}

/** Returns the offending pane line if the (post-marker) capture shows a CLI auth-failure signature,
 *  else null. */
export function matchSeatAuthError(text: string, opts: SeatAuthMatchOpts = {}): string | null {
  let scan = stripAnsi(text).replace(/\r\n/g, '\n');
  if (opts.marker) {
    const idx = scan.lastIndexOf(opts.marker);
    if (idx < 0) return null; // marker not visible yet → never scan historical output
    scan = scan.slice(idx + opts.marker.length);
  }
  for (const raw of scan.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (EXACT_NOTICES.some((re) => re.test(line))) return line;
    if (
      FAILURE_PHRASES.some((re) => re.test(line)) &&
      REMEDY_PHRASES.some((re) => re.test(line))
    ) {
      return line;
    }
  }
  return null;
}

/** The operator-facing remedy for a provider whose seat failed to authenticate. Used in the terminal
 *  failure reason so the fix is in the error itself, not buried in a tmux pane nobody is watching. */
export function authRemedyFor(provider?: string): string {
  switch ((provider || '').toLowerCase()) {
    case 'grok':
      return 'run `grok login`';
    case 'codex':
      return 'run `codex login`';
    case 'claude':
      return 'run `claude` and complete /login';
    default:
      return `re-authenticate the ${provider || 'provider'} CLI`;
  }
}
