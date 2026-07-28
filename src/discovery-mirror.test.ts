// discovery-mirror.test.ts
// E7 required tests (verbatim from brief): the Discovery mirror renders the FULL pane text —
// nothing dropped, no content transformation, indifferent to the CLI's randomised completion
// verb. Runs against the real captured fixtures.

// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildDiscoveryMirrorHtml } from './web/public/discovery-mirror.js';
import { stripAnsiForDisplay } from './web/public/ansi-strip.js';

const FIXTURES = [
  {
    file: 'discovery-finished-turn-20260727.txt',
    top: 'CLAUDE_CODE_DISABLE_CLAUDE_MDS=1',
    middle: 'Write(cycle/ui-upgrade_0727/conversation-log.md)',
    bottom: '⏵⏵ bypass permissions on (shift+tab to cycle)',
  },
  {
    file: 'discovery-sent-echoed-in-composer-20260728.txt',
    top: 'CLAUDE_CODE_DISABLE_CLAUDE_MDS=1',
    middle: 'Q3 — Does the verbatim rule bind a human?',
    bottom: '(a) — recall output is unreadable, keep text mode frozen',
  },
];

function readPaneFixture(file) {
  const raw = readFileSync(new URL(`./test-fixtures/panes/${file}`, import.meta.url), 'utf8');
  return raw.replace(/^# HELM_PROVENANCE: source_session=[^\n]+ capture_date=\d{4}-\d{2}-\d{2}\n/, '');
}

// Strip HTML markup and unescape entities — proves the mirror is a straight pass-through of
// stripAnsiForDisplay(pane) with classification spans as the ONLY difference.
function textFromMirrorHtml(html) {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
}

describe('E7 discovery-mirror (pure renderer)', () => {
  it('renders the FULL pane text — top/middle/bottom substrings all present, nothing dropped', () => {
    for (const fx of FIXTURES) {
      const pane = readPaneFixture(fx.file);
      const stripped = stripAnsiForDisplay(pane);
      const mirrorHtml = buildDiscoveryMirrorHtml(stripped);
      expect(mirrorHtml, `${fx.file}: top`).toContain(fx.top);
      expect(mirrorHtml, `${fx.file}: middle`).toContain(fx.middle);
      expect(mirrorHtml, `${fx.file}: bottom`).toContain(fx.bottom);
    }
  });

  it('is byte-identical to stripAnsiForDisplay(pane) once markup is stripped', () => {
    for (const fx of FIXTURES) {
      const pane = readPaneFixture(fx.file);
      const stripped = stripAnsiForDisplay(pane);
      const mirrorHtml = buildDiscoveryMirrorHtml(stripped);
      const reconstructed = textFromMirrorHtml(mirrorHtml);
      expect(reconstructed, fx.file).toBe(stripped);
    }
  });

  it('escapes HTML-special characters instead of interpreting them', () => {
    const html = buildDiscoveryMirrorHtml('plain line\n<script>alert(1)</script>\nanother line');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('is indifferent to the CLI\'s randomised completion verb — no hardcoded vocabulary', () => {
    const paneWith = (verb) =>
      [
        '  ⟦HELM_REPLY⟧',
        '  Status: INTERVIEWING',
        '  ⟦/HELM_REPLY⟧',
        '',
        `✻ ${verb}`,
        '',
        '─────────────────────────────',
        '❯ ',
        '─────────────────────────────',
        '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent',
      ].join('\n');

    const verbs = ['Baked for 1m 20s', 'Cooked for 45s', 'Osmosing… (12s · ↑ 2.1k tokens)', 'Grooving for 3s', 'Brewed for 9s', 'Frobnicating the discourse for 7s'];
    const rendered = verbs.map((v) => buildDiscoveryMirrorHtml(paneWith(v)));

    // every verb's own literal text survives untouched, regardless of vocabulary
    verbs.forEach((v, i) => {
      expect(rendered[i], v).toContain(v);
    });

    // structurally IDENTICAL treatment across verbs: substituting only the verb text produces
    // mirror output that differs ONLY by the verb substring itself — proving no verb-specific
    // branching exists anywhere in the render path.
    const normalized = rendered.map((html, i) => html.split(verbs[i]).join('__VERB__'));
    normalized.forEach((n) => expect(n).toBe(normalized[0]));
  });

  it('handles an unclassifiable line by showing it as plain content, never dropping it', () => {
    const mystery = 'a totally unrecognised terminal line #!$%^&*() no pattern matches this';
    const html = buildDiscoveryMirrorHtml(`before\n${mystery}\nafter`);
    expect(html).toContain('before');
    expect(html).toContain('after');
    // present verbatim (HTML-escaped) even though it matches no classification
    expect(html).toContain(mystery.replace(/&/g, '&amp;'));
  });

  it('highlights [helm callback] ... STATUS: ... lines', () => {
    const html = buildDiscoveryMirrorHtml('some text\n  [helm callback] north ui-upgrade_0727 STATUS: INTERVIEWING\nmore text');
    expect(html).toMatch(/<span class="disc-mirror-callback">\s*\[helm callback\] north ui-upgrade_0727 STATUS: INTERVIEWING<\/span>/);
  });

  it('subdues HELM_REPLY delimiters inline without removing them', () => {
    const html = buildDiscoveryMirrorHtml('  ⟦HELM_REPLY⟧\nbody text\n  ⟦/HELM_REPLY⟧');
    expect(html).toContain('<span class="disc-mirror-delim">⟦HELM_REPLY⟧</span>');
    expect(html).toContain('<span class="disc-mirror-delim">⟦/HELM_REPLY⟧</span>');
    expect(html).toContain('body text');
  });

  it('dims the trailing composer/footer chrome block without deleting it', () => {
    const pane = [
      'real reply content line 1',
      'real reply content line 2',
      '─────────────────────────────',
      '❯ echoed composer text',
      '─────────────────────────────',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent',
    ].join('\n');
    const html = buildDiscoveryMirrorHtml(pane);
    expect(html).toContain('real reply content line 1');
    expect(html).toContain('real reply content line 2');
    // the whole trailing block is dimmed (present, wrapped, not deleted)
    expect(html).toContain('<span class="disc-mirror-chrome">─────────────────────────────</span>');
    expect(html).toContain('echoed composer text');
    expect(html).toMatch(/<span class="disc-mirror-chrome">❯ echoed composer text<\/span>/);
    expect(html).toMatch(/<span class="disc-mirror-chrome">\s*⏵⏵ bypass permissions on \(shift\+tab to cycle\) · ← 1 agent<\/span>/);
  });

  it('empty pane renders an empty placeholder, not an error', () => {
    const html = buildDiscoveryMirrorHtml('');
    expect(html).toContain('No live terminal for this seat yet.');
  });
});
