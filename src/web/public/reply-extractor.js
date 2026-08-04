// reply-extractor.js
// Pure ESM module for Helm reply extraction (Studio + CC chat parity).
// Extracted from app.js for testability + hardening (G1).
// No DOM, no html, no browser globals. Self-contained for vitest + <script type=module>.

const HELM_REPLY_OPEN_RE = /⟦HELM_REPLY⟧|\[\[HELM_REPLY\]\]/g;
const HELM_REPLY_CLOSE_RE = /⟦\/HELM_REPLY⟧|\[\[\/HELM_REPLY\]\]/;

// iter3: helpers for whitespace-tolerant turn location + bounding (to handle wrapped prompts + queued noise)
function normalizeWs(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function findAfterLastUserPromptRobust(pane, afterUserText) {
  if (!pane) return '';
  const sent = (afterUserText || '').trim();
  if (!sent) {
    return getAfterLastUserPrompt(pane);
  }
  // 1. gather exact matches.
  const exactMatches = findAllLiteralMatches(pane, sent);
  // 2. normalize ws to single space in both, then map to original by flexible search.
  const normSent = normalizeWs(sent);
  const normPane = normalizeWs(pane);
  const normIdx = normPane.lastIndexOf(normSent);
  const flexMatches = [];
  if (normIdx >= 0) {
    const words = sent.split(/\s+/).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const flexRe = new RegExp(words.join('\\s+'), 'g');
    let m;
    while ((m = flexRe.exec(pane)) !== null) {
      flexMatches.push({ index: m.index, length: m[0].length });
    }
  }
  const matches = dedupePromptMatches([...exactMatches, ...flexMatches]);
  if (matches.length) {
    return afterBestUserPromptMatch(pane, matches);
  }
  return getAfterLastUserPrompt(pane);
}

function findAllLiteralMatches(text, needle) {
  const matches = [];
  let from = 0;
  while (from <= text.length) {
    const index = text.indexOf(needle, from);
    if (index < 0) break;
    matches.push({ index, length: needle.length });
    from = index + needle.length;
  }
  return matches;
}

function dedupePromptMatches(matches) {
  const seen = new Set();
  return matches
    .sort((a, b) => a.index - b.index || a.length - b.length)
    .filter(match => {
      const key = `${match.index}:${match.length}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function afterBestUserPromptMatch(pane, matches) {
  const fallback = matches[matches.length - 1];
  let best = null;
  for (const match of matches) {
    const after = boundCurrentTurn(pane.slice(match.index + match.length));
    const content = stripChrome(after.replace(/─/g, '')).trim();
    if (content && !looksLikeChrome(content)) {
      best = match;
    }
  }
  const chosen = best || fallback;
  return boundCurrentTurn(pane.slice(chosen.index + chosen.length));
}

function boundCurrentTurn(after) {
  if (!after) return '';
  // cut at next prompt-with-content or box separator so queued follow-ups don't leak
  let cut = after.length;
  const box = after.match(/─────/);
  if (box && box.index > 0) cut = box.index;
  const nextP = after.match(/\n[❯›]\s*\S/);
  if (nextP && nextP.index > 0 && nextP.index < cut) cut = nextP.index;
  return after.slice(0, cut).trim();
}

// Chrome / TUI footer / spinner patterns to strip so they never become reply bubbles.
const CHROME_PATTERNS = [
  /esc to (interrupt|cancel|dismiss)/i,
  /bypass permissions on/i,
  /shift\+tab to cycle/i,
  /Responding…|Thinking…|Working…|Generating…|Baked for|Cogitat|⏹/i,
  /\[Pasted Content|tab to queue|paste again to expand/i,
  /tokens?\s*(used|left|remaining)?/i,
  /^\s*[❯›>]\s*$/m,
  /^\s*>\s*$/m
];

/**
 * G1 correction: anchor to the LAST user-prompt boundary in the pane.
 * Finds the rightmost ❯/› prompt prefix and returns content after it.
 * This ensures multi-turn extraction uses the most recent user message + following answer,
 * never an earlier stale reply (even when pendingUserText is cleared or absent).
 */
function getAfterLastUserPrompt(pane) {
  if (!pane) return '';
  const re = /[❯›]\s*/g;
  const afterPositions = [];
  let m;
  while ((m = re.exec(pane)) !== null) {
    afterPositions.push(m.index + m[0].length);
  }
  if (afterPositions.length >= 2) {
    // penultimate after last user prompt (last is final composer)
    const lastUserAfter = afterPositions[afterPositions.length - 2];
    return pane.slice(lastUserAfter).trimStart();
  }
  if (afterPositions.length === 1) {
    const after = pane.slice(afterPositions[0]).trimStart();
    if (!after || /^[❯›\s]*$/.test(after)) {
      return pane.slice(0, afterPositions[0]).trim();
    }
    return after;
  }
  return pane;
}

function paneLooksGenerating(pane) {
  return /esc to interrupt|esc to cancel|Responding…|Thinking…|Working…|Cogitat|Generating…|⏹/i.test(pane || '');
}

function looksLikeChrome(text) {
  if (!text || !text.trim()) return true;
  const t = text.trim();
  // If every non-empty line matches a chrome pattern, treat as chrome-only.
  const lines = t.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return true;
  return lines.every(line => CHROME_PATTERNS.some(re => re.test(line)));
}

function stripChrome(text) {
  if (!text) return '';
  let out = String(text);
  // Remove whole lines that are pure chrome or prompts
  out = out.split('\n').filter(line => {
    const l = line.trim();
    if (!l) return false;
    if (CHROME_PATTERNS.some(re => re.test(l))) return false;
    return true;
  }).join('\n').trim();
  // Also nuke inline chrome fragments
  CHROME_PATTERNS.forEach(re => {
    out = out.replace(re, '').trim();
  });
  // Final trim of stray prompt tails
  out = out.replace(/[❯›>]\s*$/gm, '').trim();
  return out;
}

/**
 * Scope + extract the latest assistant block after the given user text.
 * Hardened for plain-prose (no markers): cut at next composer line, strip TUI chrome.
 * Returns '' for chrome-only / empty / no real content (prevents chrome-as-reply).
 */
function extractAgentPaneSegment(prevPane, nextPane, pendingUserText) {
  if (!nextPane || nextPane === prevPane) return '';
  let delta = nextPane;
  const u = (pendingUserText || '').trim();
  if (prevPane && nextPane.startsWith(prevPane)) {
    delta = nextPane.slice(prevPane.length);
  } else if (u && nextPane.lastIndexOf(u) >= 0) {
    const idx = nextPane.lastIndexOf(u);
    delta = nextPane.slice(idx + u.length);
  } else if (!u) {
    // G1 correction: no pendingUserText (common after prior turn) -> anchor after LAST user prompt boundary
    delta = getAfterLastUserPrompt(nextPane);
  } else {
    // pending provided but not found -> full (will be trimmed by later logic)
    delta = nextPane;
  }
  delta = String(delta || '').trim();
  if (!delta) return '';

  if (u) {
    delta = delta.split('\n').filter(l => l.trim() !== u).join('\n').trim();
  }

  // NEW (G1): cut at the NEXT composer line (❯ or ›) after the user content.
  // This prevents pulling in the footer/composer chrome that follows the reply.
  const composerMatch = delta.match(/^[\s\S]*?[❯›](?=\s|$)/m);
  if (composerMatch) {
    // Keep only up to (but not including) the first subsequent composer marker.
    const cutIdx = delta.indexOf(composerMatch[0]);
    if (cutIdx > 0) {
      delta = delta.slice(0, cutIdx);
    }
  }

  delta = delta.replace(/[❯›>]\s*$/gm, '').trim();

  if (delta.length > 600) {
    const parts = delta.split(/\n{2,}/).filter(Boolean);
    delta = (parts[parts.length - 1] || delta).trim();
  }

  // Strip TUI chrome so footer/hints never become a bubble.
  delta = stripChrome(delta);

  // G1: for interleaved tool noise (plain-prose case), drop obvious tool/log lines so only
  // the final assistant prose remains (test case requires clean extraction without [tool] etc).
  delta = delta.split('\n').filter(l => {
    const t = l.trim();
    if (!t) return false;
    if (/^\s*\[tool\]|^\s*(ls|file\d+\.|src\/|[\w-]+\.ts\s*$)/i.test(t)) return false;
    return true;
  }).join('\n').trim();

  // Re-strip after filter and prefer last prose block
  delta = stripChrome(delta);
  if (delta.length > 200) {
    const parts = delta.split(/\n{2,}/).filter(Boolean);
    delta = (parts[parts.length - 1] || delta).trim();
  }

  if (!delta || looksLikeChrome(delta)) return '';
  return delta;
}

// → { state: 'reply'|'thinking'|'fallback'|'empty', text }
// iter3: whitespace-tolerant robust location of current turn + bound scope, then extract *within* bounded scope.
// 1. find after last sent (norm ws to handle wrapped "❯ ... \n  include ...")
// 2. bound to current turn (cut at next ❯-content or ───── box)
// 3. within bounded: marked last complete wins; else plain (strip ● • ✻ Listed ctrl+o etc.)
// Never scan full pane for markers; never rely on raw lastIndexOf or pure ❯ count for scope.
function extractHelmReply(pane, afterUserText) {
  if (!pane || !pane.trim()) return { state: 'empty', text: '' };

  let scope = findAfterLastUserPromptRobust(pane, afterUserText);

  const scopeHasMarkers = HELM_REPLY_OPEN_RE.test(scope) || HELM_REPLY_CLOSE_RE.test(scope);
  HELM_REPLY_OPEN_RE.lastIndex = 0;
  const paneHasMarkers = pane.includes('⟦HELM_REPLY⟧') || pane.includes('[[HELM_REPLY]]') ||
    pane.includes('⟦/HELM_REPLY⟧') || pane.includes('[[/HELM_REPLY]]');
  if (!scopeHasMarkers && paneHasMarkers && !paneLooksGenerating(pane)) {
    const footerOnly = stripChrome(scope.replace(/─/g, '')).trim();
    if (!footerOnly) scope = pane;
  }
  if (!scope) {
    return { state: 'thinking', text: '' };
  }

  // within bounded scope only
  const opens = [...scope.matchAll(HELM_REPLY_OPEN_RE)];
  if (opens.length) {
    const lastOpen = opens[opens.length - 1];
    const afterOpen = scope.slice(lastOpen.index + lastOpen[0].length);
    const closeM = afterOpen.match(HELM_REPLY_CLOSE_RE);
    if (closeM) {
      return { state: 'reply', text: afterOpen.slice(0, closeM.index).trim() };
    }
    // DC-R1: open marker with NO matching close in the capture window.
    // Only stay "thinking" if the pane is genuinely still generating. If the pane
    // is idle (agent finished, close marker scrolled off / was truncated), do NOT
    // stick on 'thinking' forever — extract the text after the last open marker,
    // strip chrome, and surface it as the reply (fallback to the segmenter if empty).
    if (paneLooksGenerating(scope)) {
      return { state: 'thinking', text: '' };
    }
    const openText = stripChrome(afterOpen);
    if (openText) return { state: 'reply', text: openText };
    const fb = extractAgentPaneSegment('', pane, afterUserText);
    return fb ? { state: 'fallback', text: fb } : { state: 'empty', text: '' };
  }

  let closeScope = scope;
  let closeOnly = closeScope.match(HELM_REPLY_CLOSE_RE);
  if (!closeOnly && ![...pane.matchAll(HELM_REPLY_OPEN_RE)].length) {
    closeScope = pane;
    closeOnly = closeScope.match(HELM_REPLY_CLOSE_RE);
  }
  if (closeOnly) {
    const beforeClose = closeScope
      .slice(0, closeOnly.index)
      .split('\n')
      .map(l => l.replace(/^[●•]\s*/, '').trim())
      .join('\n');
    const closeText = stripChrome(beforeClose);
    if (closeText) return { state: 'reply', text: closeText };
  }

  // plain-prose within scope: strip specified TUI noise + tool noise (to keep existing tests)
  let text = scope
    .split('\n')
    .map(l => l.replace(/^[●•]\s*/, '').trim())
    .filter(l => {
      if (!l) return false;
      if (/^✻ /.test(l)) return false;
      if (/^Listed \d+ /.test(l)) return false;
      if (/ctrl\+o/.test(l)) return false;
      if (/^\s*\[tool\]|^\s*(ls |file\d|src\/|[\w-]+\.ts\s*$)/i.test(l)) return false;
      if (/[❯›]/.test(l)) return false;
      return true;
    })
    .join('\n')
    .trim();

  if (!text) {
    // compatibility fallback for old test panes that don't have literal sent text
    const fb = extractAgentPaneSegment('', pane, afterUserText);
    return fb ? { state: 'fallback', text: fb } : { state: 'thinking', text: '' };
  }
  if (paneLooksGenerating(scope)) return { state: 'thinking', text: '' };
  return { state: 'fallback', text };
}

/**
 * E8 FIX3: the last-reply STRIP is a distinct surface from the current-turn bubble extractors above —
 * it must show the agent's LAST REPLY ONLY, deliberately marked with ⟦HELM_REPLY⟧ delimiters, never
 * raw pane / tmux chrome (pager text like "+65 lines (ctrl+o to expand)", composer echoes, etc.).
 * Scans the WHOLE pane (not scoped to "after the last user prompt" — the strip must keep showing the
 * last reply even while a later, not-yet-submitted composer draft sits below it) for every complete
 * OPEN...CLOSE pair and returns the text of the LAST one. No complete pair anywhere → '' (never falls
 * back to raw pane).
 */
function lastCompleteHelmReplyText(pane) {
  if (!pane) return '';
  const text = String(pane);
  HELM_REPLY_OPEN_RE.lastIndex = 0;
  let lastReply = '';
  let openMatch;
  while ((openMatch = HELM_REPLY_OPEN_RE.exec(text)) !== null) {
    const afterOpen = text.slice(openMatch.index + openMatch[0].length);
    const closeMatch = afterOpen.match(HELM_REPLY_CLOSE_RE);
    if (closeMatch) lastReply = afterOpen.slice(0, closeMatch.index).trim();
  }
  return lastReply;
}

// Re-export the consts for tests that may want them.
export {
  HELM_REPLY_OPEN_RE,
  HELM_REPLY_CLOSE_RE,
  paneLooksGenerating,
  extractAgentPaneSegment,
  extractHelmReply,
  lastCompleteHelmReplyText,
  stripChrome,
  looksLikeChrome
};

export default {
  HELM_REPLY_OPEN_RE,
  HELM_REPLY_CLOSE_RE,
  paneLooksGenerating,
  extractAgentPaneSegment,
  extractHelmReply,
  lastCompleteHelmReplyText
};
