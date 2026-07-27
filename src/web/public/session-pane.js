// session-pane.js
// B3 / R5.19 foundation: shared session-pane shell for Planning, Implementation, Discovery.
// CSS class contract (.sp-pane / header / body / footer) + pure HTML builder for smoke tests.
// Does NOT redesign Discovery content, does NOT consume SEAM-1 seats (B4), does NOT rewire scroll (B6).

/**
 * Build a plain HTML string for the shared session-pane shell.
 * Pure — no DOM. Suitable for unit smoke and for later Preact wrappers.
 *
 * @param {{
 *   title?: string,
 *   payload?: string,
 *   footer?: string,
 *   emptyMessage?: string,
 *   paneTestId?: string,
 *   bodyTestId?: string,
 *   payloadTestId?: string,
 * }} [opts]
 * @returns {string}
 */
export function buildSessionPaneHtml(opts = {}) {
  const title = opts.title != null ? String(opts.title) : 'Session';
  const payload = opts.payload != null ? String(opts.payload) : '';
  const footer = opts.footer != null ? String(opts.footer) : '';
  const emptyMessage = opts.emptyMessage != null ? String(opts.emptyMessage) : 'No live terminal for this seat yet.';
  const paneTestId = opts.paneTestId || 'sp-pane';
  const bodyTestId = opts.bodyTestId || 'sp-pane-body';
  const payloadTestId = opts.payloadTestId || 'sp-pane-payload';

  const escape = (s) =>
    String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const bodyInner = payload
    ? `<pre class="sp-pane-payload" data-testid="${escape(payloadTestId)}">${escape(payload)}</pre>`
    : `<div class="sp-pane-empty text-sec" data-testid="${escape(payloadTestId)}-empty">${escape(emptyMessage)}</div>`;

  const footerHtml = footer
    ? `<div class="sp-pane-footer">${escape(footer)}</div>`
    : '';

  return [
    `<div class="sp-pane" data-testid="${escape(paneTestId)}">`,
    `  <div class="sp-pane-header"><span class="sp-pane-title">${escape(title)}</span></div>`,
    `  <div class="sp-pane-body sp-scroll-owner" data-testid="${escape(bodyTestId)}">`,
    `    ${bodyInner}`,
    `  </div>`,
    footerHtml ? `  ${footerHtml}` : '',
    `</div>`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Class names used by the shell — B4/B5 import these rather than inventing parallel strings. */
export const SESSION_PANE_CLASSES = {
  pane: 'sp-pane',
  header: 'sp-pane-header',
  body: 'sp-pane-body',
  footer: 'sp-pane-footer',
  payload: 'sp-pane-payload',
  empty: 'sp-pane-empty',
  flexFill: 'sp-flex-fill',
  scrollOwner: 'sp-scroll-owner',
};

export default {
  buildSessionPaneHtml,
  SESSION_PANE_CLASSES,
};
