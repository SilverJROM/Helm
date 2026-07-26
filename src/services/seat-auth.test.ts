import { describe, it, expect } from 'vitest';
import { matchSeatAuthError, authRemedyFor, SeatAuthError } from './seat-auth.js';

// The real pane text that started all of this (grok, 2026-07-20). Kept verbatim as the anchor case.
const REAL_GROK_PANE = [
  '  ❯ Read /tmp/helm-harness/helm-run-1-rmrt7is0i/prompts/implementer.brief.md and follow its',
  '    instructions. (dispatch marker: DISPATCH-rmrt7is0i-implementer-85990-1784551142)',
  '  ┃  Authentication required — your session has expired or your credentials were rejected. Run /login to re-',
  '  ┃  authenticate, then resend your message.',
  '  Grok 4.5 (medium) · always-approve',
].join('\n');

describe('matchSeatAuthError', () => {
  it('fires on the real grok expired-session pane', () => {
    const hit = matchSeatAuthError(REAL_GROK_PANE);
    expect(hit).toBeTruthy();
    expect(hit).toMatch(/Authentication required/i);
  });

  it('fires on a paired failure+remedy line', () => {
    expect(matchSeatAuthError('Error: 401 Unauthorized. Please sign in to continue.')).toBeTruthy();
    expect(matchSeatAuthError('token expired — re-authenticate and retry')).toBeTruthy();
  });

  it('fires on explicit vendor login instructions', () => {
    expect(matchSeatAuthError('Please run `codex login` to continue.')).toBeTruthy();
    expect(matchSeatAuthError('You are not logged in. Run grok login first.')).toBeTruthy();
  });

  // The critical guard: a worker WRITING auth code must never trip the detector.
  it('does NOT fire on source code that merely mentions authentication', () => {
    const writingAuthCode = [
      '+ // Authentication required for this endpoint',
      "+ throw new Error('Unauthorized');",
      '+ if (!session) return res.status(401).json({ error: "unauthorized" });',
      '+ export function requireAuth(req) {',
      '+ // TODO: handle expired session tokens',
      '  ✓ src/auth.test.ts (12 tests) — authentication required returns 401',
    ].join('\n');
    expect(matchSeatAuthError(writingAuthCode)).toBeNull();
  });

  it('does NOT fire on ordinary healthy pane output', () => {
    const healthy = [
      '  ◆ Run pusoy-card tests and typecheck',
      '  ✓ tests/pusoy-card.test.ts (18 tests)',
      '  [rmrt8kmi1] PC01: src/pusoy-card.ts: strict total order over all 52 cards',
    ].join('\n');
    expect(matchSeatAuthError(healthy)).toBeNull();
  });

  describe('marker scoping', () => {
    const marker = 'DISPATCH-abc-implementer-123';

    it('ignores an auth error that predates this launch (reused session scrollback)', () => {
      const pane = [
        'Authentication required — your session has expired or your credentials were rejected. Run /login',
        `  ❯ Read brief.md (dispatch marker: ${marker})`,
        '  ◆ Working on the task',
      ].join('\n');
      expect(matchSeatAuthError(pane, { marker })).toBeNull();
    });

    it('fires on an auth error that follows this launch marker', () => {
      const pane = [
        '  ◆ previous healthy session output',
        `  ❯ Read brief.md (dispatch marker: ${marker})`,
        'Authentication required — your session has expired or your credentials were rejected. Run /login',
      ].join('\n');
      expect(matchSeatAuthError(pane, { marker })).toBeTruthy();
    });

    it('returns null when the marker is not visible yet (no premature verdict)', () => {
      expect(matchSeatAuthError(REAL_GROK_PANE, { marker: 'DISPATCH-not-in-pane' })).toBeNull();
    });
  });

  it('tolerates ANSI escapes', () => {
    const ansi = '\x1b[31mAuthentication required — your session has expired or your credentials were rejected. Run /login\x1b[0m';
    expect(matchSeatAuthError(ansi)).toBeTruthy();
  });

  it('handles empty/blank input without throwing', () => {
    expect(matchSeatAuthError('')).toBeNull();
    expect(matchSeatAuthError('\n\n   \n')).toBeNull();
  });
});

describe('authRemedyFor', () => {
  it('names the exact command per provider', () => {
    expect(authRemedyFor('grok')).toMatch(/grok login/);
    expect(authRemedyFor('codex')).toMatch(/codex login/);
    expect(authRemedyFor('claude')).toMatch(/login/);
    expect(authRemedyFor('kloo')).toMatch(/kloo/);
    expect(authRemedyFor(undefined)).toBeTruthy();
  });
});

describe('SeatAuthError', () => {
  it('carries the snippet and provider in a readable message', () => {
    const e = new SeatAuthError('Authentication required — session expired', 'grok');
    expect(e.name).toBe('SeatAuthError');
    expect(e.message).toMatch(/grok/);
    expect(e.message).toMatch(/Authentication required/);
    expect(e.snippet).toMatch(/Authentication required/);
  });
});
