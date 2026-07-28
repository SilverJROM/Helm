// ansi-strip.js
// E7: stripAnsiForDisplay extracted from app.js (was inline at app.js:14) so the Discovery
// session-mirror path and the Studio chat path share one implementation — the mirror's
// "byte-identical to stripAnsiForDisplay(pane)" guarantee only holds if there's a single
// source of truth for this function.

export function stripAnsiForDisplay(s) {
  return String(s || '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '');
}

export default { stripAnsiForDisplay };
