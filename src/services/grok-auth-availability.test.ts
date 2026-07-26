/**
 * B12 / AC-18 / DEC-13 — grok-expiry availability probe unit tests.
 * Pure helper only (injected now + authJson). No filesystem dependency.
 */
import { describe, it, expect } from 'vitest';
import {
  parseExpiresAt,
  extractGrokExpiresAtMs,
  isGrokAuthExpired,
  isGrokAuthAvailable,
  isProviderAuthAvailable,
  makeGrokAwareSlugAvailability,
  makeGrokAwareProviderModelAvailability,
} from './grok-auth-availability.js';
import { authFault } from './fault-class.js';

const DOMAIN = 'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828';

function authAt(expiresAt: unknown, extra: Record<string, unknown> = {}) {
  return {
    [DOMAIN]: {
      auth_mode: 'oauth',
      refresh_token: 'stc1B--fake-refresh-token-for-tests',
      expires_at: expiresAt,
      ...extra,
    },
  };
}

const NOW_MS = Date.parse('2026-07-22T12:00:00.000Z');

describe('parseExpiresAt', () => {
  it('parses ISO strings (incl. long fractional seconds)', () => {
    // Real grok auth.json form: nanosecond-ish fractional seconds.
    const ms = parseExpiresAt('2026-07-22T17:04:11.880687308Z');
    expect(ms).toBe(Date.parse('2026-07-22T17:04:11.880Z'));
  });

  it('parses ordinary ISO with Z', () => {
    expect(parseExpiresAt('2026-07-22T12:00:00.000Z')).toBe(NOW_MS);
  });

  it('parses unix seconds vs ms', () => {
    const sec = Math.floor(NOW_MS / 1000);
    expect(parseExpiresAt(sec)).toBe(sec * 1000);
    expect(parseExpiresAt(NOW_MS)).toBe(NOW_MS);
    expect(parseExpiresAt(String(sec))).toBe(sec * 1000);
    expect(parseExpiresAt(String(NOW_MS))).toBe(NOW_MS);
  });

  it('returns null for garbled / empty', () => {
    expect(parseExpiresAt(null)).toBeNull();
    expect(parseExpiresAt('')).toBeNull();
    expect(parseExpiresAt('not-a-date')).toBeNull();
    expect(parseExpiresAt({})).toBeNull();
  });
});

describe('extractGrokExpiresAtMs (nested auth.json)', () => {
  it('reads Object.values(authJson)[0].expires_at', () => {
    const ms = extractGrokExpiresAtMs(authAt('2026-07-22T17:04:11.880Z'));
    expect(ms).toBe(Date.parse('2026-07-22T17:04:11.880Z'));
  });

  it('accepts JSON string', () => {
    const ms = extractGrokExpiresAtMs(JSON.stringify(authAt(NOW_MS + 60_000)));
    expect(ms).toBe(NOW_MS + 60_000);
  });

  it('fail-safe null on empty / garbled', () => {
    expect(extractGrokExpiresAtMs({})).toBeNull();
    expect(extractGrokExpiresAtMs('{nope')).toBeNull();
    expect(extractGrokExpiresAtMs(null)).toBeNull();
    expect(extractGrokExpiresAtMs({ [DOMAIN]: { no_expires: true } })).toBeNull();
  });
});

describe('isGrokAuthExpired / isGrokAuthAvailable', () => {
  it('expired timestamp ⇒ true (unavailable)', () => {
    expect(
      isGrokAuthExpired({ now: NOW_MS, authJson: authAt('2026-07-22T11:00:00.000Z') }),
    ).toBe(true);
    expect(
      isGrokAuthAvailable({ now: NOW_MS, authJson: authAt('2026-07-22T11:00:00.000Z') }),
    ).toBe(false);
  });

  it('future timestamp ⇒ false (available)', () => {
    expect(
      isGrokAuthExpired({ now: NOW_MS, authJson: authAt('2026-07-22T18:00:00.000Z') }),
    ).toBe(false);
    expect(
      isGrokAuthAvailable({ now: NOW_MS, authJson: authAt('2026-07-22T18:00:00.000Z') }),
    ).toBe(true);
  });

  it('unix-seconds form works', () => {
    const pastSec = Math.floor(NOW_MS / 1000) - 3600;
    const futureSec = Math.floor(NOW_MS / 1000) + 3600;
    expect(isGrokAuthExpired({ now: NOW_MS, authJson: authAt(pastSec) })).toBe(true);
    expect(isGrokAuthExpired({ now: NOW_MS, authJson: authAt(futureSec) })).toBe(false);
  });

  it('past-expiry + refresh_token still unavailable (cannot verify silent refresh)', () => {
    // Safe AC-18 behavior: do not false-available on refresh_token presence alone.
    const expired = authAt('2026-07-22T01:00:00.000Z', {
      refresh_token: 'stc1B--still-present-but-unverified',
    });
    expect(isGrokAuthExpired({ now: NOW_MS, authJson: expired })).toBe(true);
  });

  it('missing / garbled auth ⇒ unavailable (fail-safe)', () => {
    expect(isGrokAuthExpired({ now: NOW_MS, authJson: {} })).toBe(true);
    expect(isGrokAuthExpired({ now: NOW_MS, authJson: 'not-json{' })).toBe(true);
    expect(
      isGrokAuthExpired({
        now: NOW_MS,
        authPath: '/tmp/helm-b12-definitely-missing-auth.json',
        // force FS path with no authJson
      }),
    ).toBe(true);
    expect(
      isGrokAuthExpired({
        now: NOW_MS,
        authJson: { [DOMAIN]: { expires_at: 'bogus' } },
      }),
    ).toBe(true);
  });
});

describe('isProviderAuthAvailable', () => {
  it('only probes grok; codex/claude always auth-available from this probe', () => {
    const expired = authAt('2020-01-01T00:00:00.000Z');
    expect(isProviderAuthAvailable('grok', { now: NOW_MS, authJson: expired })).toBe(false);
    expect(isProviderAuthAvailable('codex', { now: NOW_MS, authJson: expired })).toBe(true);
    expect(isProviderAuthAvailable('claude', { now: NOW_MS, authJson: expired })).toBe(true);
    expect(isProviderAuthAvailable(null, { now: NOW_MS, authJson: expired })).toBe(true);
  });
});

describe('makeGrokAwareSlugAvailability / provider-model', () => {
  it('slug checker: grok slug down when expired; non-grok stays up', async () => {
    const providers: Record<string, string> = {
      grok45: 'grok',
      codex55: 'codex',
    };
    const check = makeGrokAwareSlugAvailability((s) => providers[s] ?? null, {
      now: NOW_MS,
      authJson: authAt('2020-01-01T00:00:00.000Z'),
    });
    expect(await check('grok45')).toBe(false);
    expect(await check('codex55')).toBe(true);
  });

  it('provider-model checker composes with base binary gate', async () => {
    const check = makeGrokAwareProviderModelAvailability(
      async (p, m) => !(p === 'codex' && m === 'down-bin'),
      { now: NOW_MS, authJson: authAt('2020-01-01T00:00:00.000Z') },
    );
    expect(await check('grok', 'grok-4.5')).toBe(false); // expired auth
    expect(await check('codex', 'gpt-5.5')).toBe(true);
    expect(await check('codex', 'down-bin')).toBe(false); // base gate
  });
});

/**
 * #53 REGRESSION (JROM-LOCKED): post-spawn auth fault still canFailover:false / pause-class.
 * We do NOT modify fault-class.ts — only prove the contract is unchanged.
 */
describe('#53 regression — post-spawn auth pause unchanged (fault-class)', () => {
  it('authFault(grok) remains canFailover:false with relogin remedy', () => {
    const f = authFault('grok', 'Authentication required — session expired');
    expect(f.kind).toBe('auth');
    expect(f.canFailover).toBe(false);
    expect(f.remedy).toMatch(/grok login/);
    expect(f.provider).toBe('grok');
  });

  it('authFault forbids failover on every provider (token-conservation)', () => {
    expect(authFault('codex', 'x').canFailover).toBe(false);
    expect(authFault('claude', 'x').canFailover).toBe(false);
    expect(authFault(undefined, 'x').canFailover).toBe(false);
  });
});
