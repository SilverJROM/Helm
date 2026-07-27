import { describe, it, expect } from 'vitest';
import { buildSessionPaneHtml, SESSION_PANE_CLASSES } from './web/public/session-pane.js';

/**
 * B3 / R5.19 foundation — session-pane shell smoke.
 * Proves the primitive displays a real terminal payload (string).
 */

describe('B3 session-pane smoke', () => {
  it('renders terminal-like payload under sp-pane-payload with shell classes', () => {
    const terminalPayload =
      'helm-impl-1:0.0\n' +
      '❯ implementer STATUS: WORKING\n' +
      '  patching src/services/foo.ts\n' +
      '❯ implementer STATUS: DONE — wired\n';

    const html = buildSessionPaneHtml({
      title: 'implementer · grok-4.5',
      payload: terminalPayload,
    });

    expect(html).toContain(`class="${SESSION_PANE_CLASSES.pane}"`);
    expect(html).toContain('data-testid="sp-pane"');
    expect(html).toContain('data-testid="sp-pane-body"');
    expect(html).toContain('data-testid="sp-pane-payload"');
    expect(html).toContain(SESSION_PANE_CLASSES.body);
    expect(html).toContain(SESSION_PANE_CLASSES.scrollOwner);
    expect(html).toContain('implementer · grok-4.5');
    // Escaped payload lines present
    expect(html).toContain('implementer STATUS: WORKING');
    expect(html).toContain('implementer STATUS: DONE — wired');
    expect(html).toContain('patching src/services/foo.ts');
    // Escape safety
    const withTags = buildSessionPaneHtml({ title: '<x>', payload: '<script>alert(1)</script>' });
    expect(withTags).not.toContain('<script>');
    expect(withTags).toContain('&lt;script&gt;');
  });

  it('empty payload shows empty placeholder, not payload pre', () => {
    const html = buildSessionPaneHtml({ title: 'validator', payload: '' });
    expect(html).toContain('sp-pane-payload-empty');
    expect(html).toContain('No live terminal');
  });
});
