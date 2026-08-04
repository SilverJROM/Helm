// discovery-mirror.js
// E7: Discovery becomes a 1:1 SESSION MIRROR — stop reconstructing a chat from the pane.
// Pure ESM module (no DOM). Takes pane text ALREADY run through stripAnsiForDisplay() and
// formats it for readability. It never parses turn boundaries, never classifies
// thinking-vs-done, and never pairs HELM_REPLY markers — that inference is exactly what kept
// shipping bugs (E4/E6/E7). Classification here is presentational only, applied per-line, and
// a line that matches nothing still renders — nothing is ever dropped.
//
// Deliberately does NOT import extractHelmReply / extractAgentPaneSegment / paneLooksGenerating.
//
// Chrome detection is purely STRUCTURAL (box-drawing separators, the composer prompt glyph, the
// bypass-permissions footer glyph) — never keyed on the CLI's completion verb, which is
// randomised (Baked for / Cooked for / Osmosing / Grooving / Brewed for / ...) and can never be
// a complete list. An unrecognised verb renders exactly like a recognised one: unclassified,
// fully visible, undimmed.

const HELM_REPLY_DELIM_RE = /⟦\/?HELM_REPLY⟧|\[\[\/?HELM_REPLY\]\]/g;
const CALLBACK_STATUS_RE = /^\s*\[helm callback\].*STATUS:/i;
const BOX_LINE_RE = /^[\s─-╿]{3,}$/;
const PROMPT_LINE_RE = /^\s*[❯›]/;
const HINT_LINE_RE = /^\s*⏵⏵/;

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isChromeStructureLine(line) {
  return BOX_LINE_RE.test(line) || PROMPT_LINE_RE.test(line) || HINT_LINE_RE.test(line);
}

// Trailing contiguous run of structurally-recognisable composer/footer chrome, scanned from
// the bottom of the pane. Returns the index where the chrome block starts, or -1 if the pane
// doesn't end in one (never guesses — no match means no dimming).
function trailingChromeStart(lines) {
  let i = lines.length;
  while (i > 0 && isChromeStructureLine(lines[i - 1])) i--;
  return i === lines.length ? -1 : i;
}

function subdueDelimiters(escapedLine) {
  return escapedLine.replace(HELM_REPLY_DELIM_RE, (m) => `<span class="disc-mirror-delim">${m}</span>`);
}

/**
 * Build a 1:1 mirror of an already ANSI-stripped pane string. Every input line survives —
 * classification only wraps a line in a CSS hook, it never removes, reorders, or rewrites text.
 * @param {string} paneText - output of stripAnsiForDisplay(pane).
 * @param {{ paneTestId?: string, payloadTestId?: string }} [opts]
 * @returns {string}
 */
export function buildDiscoveryMirrorHtml(paneText, opts = {}) {
  const text = String(paneText || '');
  const paneTestId = opts.paneTestId || 'disc-mirror-pane';
  const payloadTestId = opts.payloadTestId || 'disc-mirror-payload';

  if (!text) {
    return `<div class="disc-mirror-pane" data-testid="${paneTestId}"><div class="disc-mirror-empty text-sec" data-testid="${payloadTestId}-empty">No live terminal for this seat yet.</div></div>`;
  }

  const lines = text.split('\n');
  const chromeStart = trailingChromeStart(lines);

  const body = lines
    .map((line, idx) => {
      const escaped = subdueDelimiters(escapeHtml(line));
      if (CALLBACK_STATUS_RE.test(line)) return `<span class="disc-mirror-callback">${escaped}</span>`;
      if (chromeStart >= 0 && idx >= chromeStart) return `<span class="disc-mirror-chrome">${escaped}</span>`;
      return escaped;
    })
    .join('\n');

  // No incidental whitespace around ${body}: the mirror's whole point is that its rendered
  // text content reconstructs stripAnsiForDisplay(pane) exactly once tags are stripped.
  return `<div class="disc-mirror-pane" data-testid="${paneTestId}"><pre class="disc-mirror-payload" data-testid="${payloadTestId}">${body}</pre></div>`;
}

export default { buildDiscoveryMirrorHtml };
