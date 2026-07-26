// Shared seat-binary "not found" detection (A1a/A1b + review #2). A CLI that vanished off the seat
// shell's PATH (an interrupted `npm i -g`) prints a shell/sandbox error within ms of the fenced launch;
// catch it FAST + clearly instead of masking it as a generic 30-60s ready-probe timeout.
//
// review #2 (false-positive on REUSED sessions): a reused tmux session carries historical scrollback — an
// OLD `command not found`, or an unrelated healthy line containing "No such file or directory" — which must
// NOT fail a fresh launch. So detection is scoped to output AFTER a per-launch marker, and (when the
// resolved binary is known) TIED to that binary: the bash/sh `<bin>: command not found` line and the
// helm-sandbox `execvp(<bin>) failed …` line both name the binary, so a generic signature that does not
// reference <bin> is ignored.

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
function stripAnsi(s: string): string {
  return (s ?? '').replace(ANSI_RE, '');
}
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A1b: distinct error a ready-probe (or the early scan) raises the instant a launched seat's pane shows a
// binary-not-found signature. The launch path catches it and fails the seat FAST (real cause), never as a
// generic startup timeout. Carries only the offending pane line; the caller attaches provider/model/bin.
export class SeatBinaryMissingError extends Error {
  constructor(public readonly snippet: string) {
    super(`seat binary missing (pane: ${snippet.slice(0, 160)})`);
    this.name = 'SeatBinaryMissingError';
  }
}

export interface SeatBinaryMatchOpts {
  /** Only scan pane output AFTER the last occurrence of this per-launch marker (drops reused-session
   *  history). When the marker is not yet visible in the capture, nothing THIS launch printed is present
   *  → returns null (no false positive; a later capture will contain both marker + error). */
  marker?: string;
  /** The resolved launch binary (argv[0]); ties generic signatures to this binary to avoid firing on an
   *  unrelated healthy line that merely contains "No such file or directory". */
  bin?: string;
}

/** Returns the offending pane line if the (post-marker) capture shows a binary-not-found signature for
 *  `bin`, else null. */
export function matchSeatBinaryError(text: string, opts: SeatBinaryMatchOpts = {}): string | null {
  let scan = stripAnsi(text).replace(/\r\n/g, '\n');
  if (opts.marker) {
    const idx = scan.lastIndexOf(opts.marker);
    if (idx < 0) return null; // marker not visible yet → do not scan historical output
    scan = scan.slice(idx + opts.marker.length);
  }
  const bin = opts.bin;
  for (const raw of scan.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (bin) {
      // bin-tied signatures (most specific): helm-sandbox execvp failure + shell "<bin>: command not found".
      if (new RegExp(`execvp\\(${escapeRe(bin)}\\)\\s*failed`, 'i').test(line)) return line;
      if (new RegExp(`(?:^|[\\s:/])${escapeRe(bin)}:\\s*(?:command not found|not found|no such file or directory)`, 'i').test(line)) return line;
    }
    if (/(?:command not found|no such file or directory|:\s*not found)/i.test(line)) {
      // A generic signature is only trusted when it references the expected binary (or when no bin is
      // known); otherwise an unrelated healthy line ("… No such file or directory") would false-fail.
      if (bin && !new RegExp(escapeRe(bin)).test(line)) continue;
      return line;
    }
  }
  return null;
}

/** review #6: parse an env int and clamp to a finite positive range; a nonnumeric/NaN/out-of-range value
 *  falls back (never yields NaN, which would make a `Date.now()-start > budget` guard never succeed and
 *  wedge a loop indefinitely). */
export function clampPositiveInt(raw: string | undefined | null, fallback: number, min = 1, max = 600000): number {
  const n = parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.min(n, max);
}
