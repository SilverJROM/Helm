export type SessionPaneOptions = {
  title?: string;
  payload?: string;
  footer?: string;
  emptyMessage?: string;
  paneTestId?: string;
  bodyTestId?: string;
  payloadTestId?: string;
};

export function buildSessionPaneHtml(opts?: SessionPaneOptions): string;

export const SESSION_PANE_CLASSES: {
  pane: string;
  header: string;
  body: string;
  footer: string;
  payload: string;
  empty: string;
  flexFill: string;
  scrollOwner: string;
};

declare const _default: {
  buildSessionPaneHtml: typeof buildSessionPaneHtml;
  SESSION_PANE_CLASSES: typeof SESSION_PANE_CLASSES;
};

export default _default;
