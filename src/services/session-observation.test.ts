/**
 * S10 — pure residual-path observation helper (AC16/17/18, AC21 trigger, AC26).
 * Synthetic facts only. No live tmux. No DB. HELM_SESSION_JANITOR stays 0.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_IDLE_THRESHOLD_MS,
  effectiveActivityMs,
  observeSessionIdleness,
  parseRegistryTimestampMs,
  sessionActivityToMs,
  type ObservationAction,
  type SessionObservationResult,
} from './session-observation.js';

const NOW = Date.parse('2026-07-28T02:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const FOUR_H = DEFAULT_IDLE_THRESHOLD_MS;

function isoMsAgo(msAgo: number): string {
  return new Date(NOW - msAgo).toISOString().replace(/\.\d{3}Z$/, 'Z').replace('T', ' ').replace('Z', '');
}

function epochSecAgo(msAgo: number): number {
  return Math.floor((NOW - msAgo) / 1000);
}

describe('S10 session-observation pure helper (AC16/17/18)', () => {
  it('parseRegistryTimestampMs accepts SQLite space form and ISO', () => {
    const a = parseRegistryTimestampMs('2026-07-28 01:00:00');
    const b = parseRegistryTimestampMs('2026-07-28T01:00:00.000Z');
    expect(a).toBe(Date.parse('2026-07-28T01:00:00.000Z'));
    expect(b).toBe(Date.parse('2026-07-28T01:00:00.000Z'));
    expect(parseRegistryTimestampMs(null)).toBeNull();
    expect(parseRegistryTimestampMs('')).toBeNull();
    expect(parseRegistryTimestampMs('not-a-date')).toBeNull();
  });

  it('sessionActivityToMs multiplies S08 epoch seconds', () => {
    expect(sessionActivityToMs(1_732_713_600)).toBe(1_732_713_600_000);
    expect(sessionActivityToMs(null)).toBeNull();
    expect(sessionActivityToMs(-1)).toBeNull();
    expect(sessionActivityToMs(Number.NaN)).toBeNull();
  });

  it('effectiveActivityMs = max(last_used_at, session_activity); missing sides ignored', () => {
    const staleDb = isoMsAgo(10 * HOUR);
    const recentTmux = epochSecAgo(5 * 60 * 1000);
    const maxMs = effectiveActivityMs({
      lastUsedAt: staleDb,
      sessionActivity: recentTmux,
    });
    expect(maxMs).toBe(sessionActivityToMs(recentTmux));

    const freshDb = isoMsAgo(2 * 60 * 1000);
    const staleTmux = epochSecAgo(10 * HOUR);
    const maxMs2 = effectiveActivityMs({
      lastUsedAt: freshDb,
      sessionActivity: staleTmux,
    });
    expect(maxMs2).toBe(parseRegistryTimestampMs(freshDb));

    expect(
      effectiveActivityMs({ lastUsedAt: null, sessionActivity: null })
    ).toBeNull();
  });

  const cases: Array<{
    name: string;
    facts: Parameters<typeof observeSessionIdleness>[0];
    action: ObservationAction;
    reason: string;
  }> = [
    {
      name: 'stale DB + recent tmux → KEEP (AC16 max prefers live activity)',
      facts: {
        lastUsedAt: isoMsAgo(10 * HOUR),
        sessionActivity: epochSecAgo(3 * 60 * 1000),
        sessionAttached: false,
        runId: 42,
        nowMs: NOW,
      },
      action: 'KEEP',
      reason: 'within_idle_threshold',
    },
    {
      name: 'fresh DB + stale tmux → KEEP',
      facts: {
        lastUsedAt: isoMsAgo(2 * 60 * 1000),
        sessionActivity: epochSecAgo(12 * HOUR),
        sessionAttached: false,
        runId: 7,
        nowMs: NOW,
      },
      action: 'KEEP',
      reason: 'within_idle_threshold',
    },
    {
      name: 'attached=true hours-stale → KEEP (AC17)',
      facts: {
        lastUsedAt: isoMsAgo(12 * HOUR),
        sessionActivity: epochSecAgo(12 * HOUR),
        sessionAttached: true,
        runId: null,
        nowMs: NOW,
      },
      action: 'KEEP',
      reason: 'attached_excluded',
    },
    {
      name: 'attached=null (unknown probe) → KEEP fail-safe',
      facts: {
        lastUsedAt: isoMsAgo(12 * HOUR),
        sessionActivity: epochSecAgo(12 * HOUR),
        sessionAttached: null,
        runId: 1,
        nowMs: NOW,
      },
      action: 'KEEP',
      reason: 'attached_unknown',
    },
    {
      name: 'both activity probes unknown → KEEP (missing facts ≠ abandonment)',
      facts: {
        lastUsedAt: null,
        sessionActivity: null,
        sessionAttached: false,
        runId: null,
        nowMs: NOW,
      },
      action: 'KEEP',
      reason: 'missing_activity_facts',
    },
    {
      name: 'run_id NULL + fresh activity → KEEP (AC18: null run not abandonment)',
      facts: {
        lastUsedAt: isoMsAgo(5 * 60 * 1000),
        sessionActivity: epochSecAgo(5 * 60 * 1000),
        sessionAttached: false,
        runId: null,
        nowMs: NOW,
      },
      action: 'KEEP',
      reason: 'within_idle_threshold',
    },
    {
      name: 'run_id NULL + hours-idle positive → INVESTIGATE (idle signal, not null-run)',
      facts: {
        lastUsedAt: isoMsAgo(12 * HOUR),
        sessionActivity: epochSecAgo(12 * HOUR),
        sessionAttached: false,
        runId: null,
        nowMs: NOW,
      },
      action: 'INVESTIGATE',
      reason: 'hours_idle_anomaly',
    },
    {
      name: 'hours-idle both sources stale, detached → INVESTIGATE (AC21/26)',
      facts: {
        lastUsedAt: isoMsAgo(FOUR_H + HOUR),
        sessionActivity: epochSecAgo(FOUR_H + 2 * HOUR),
        sessionAttached: false,
        runId: 99,
        nowMs: NOW,
      },
      action: 'INVESTIGATE',
      reason: 'hours_idle_anomaly',
    },
    {
      name: 'exactly at threshold → INVESTIGATE (idleAge >= threshold)',
      facts: {
        lastUsedAt: isoMsAgo(FOUR_H),
        sessionActivity: epochSecAgo(FOUR_H),
        sessionAttached: false,
        runId: 3,
        nowMs: NOW,
      },
      action: 'INVESTIGATE',
      reason: 'hours_idle_anomaly',
    },
    {
      name: 'just under threshold → KEEP',
      facts: {
        lastUsedAt: isoMsAgo(FOUR_H - 60_000),
        sessionActivity: epochSecAgo(FOUR_H - 60_000),
        sessionAttached: false,
        runId: 3,
        nowMs: NOW,
      },
      action: 'KEEP',
      reason: 'within_idle_threshold',
    },
    {
      name: 'createdAt fallback when last_used_at null + recent tmux → KEEP',
      facts: {
        lastUsedAt: null,
        createdAt: isoMsAgo(20 * HOUR),
        sessionActivity: epochSecAgo(10 * 60 * 1000),
        sessionAttached: false,
        runId: 5,
        nowMs: NOW,
      },
      action: 'KEEP',
      reason: 'within_idle_threshold',
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const r = observeSessionIdleness(c.facts);
      expect(r.action).toBe(c.action);
      expect(r.reason).toBe(c.reason);
    });
  }

  it('return type / result never carries REAP (AC26 investigation-only)', () => {
    const samples: SessionObservationResult[] = [
      observeSessionIdleness({
        lastUsedAt: isoMsAgo(12 * HOUR),
        sessionActivity: epochSecAgo(12 * HOUR),
        sessionAttached: false,
        runId: null,
        nowMs: NOW,
      }),
      observeSessionIdleness({
        lastUsedAt: isoMsAgo(1 * HOUR),
        sessionActivity: epochSecAgo(1 * HOUR),
        sessionAttached: true,
        runId: 1,
        nowMs: NOW,
      }),
    ];
    for (const r of samples) {
      expect(r.action === 'KEEP' || r.action === 'INVESTIGATE').toBe(true);
      expect((r as { action: string }).action).not.toBe('REAP');
      expect(JSON.stringify(r)).not.toMatch(/REAP/);
    }

    // Source-level guard: observation module must not emit REAP vocabulary.
    const src = fs.readFileSync(
      path.join(__dirname, 'session-observation.ts'),
      'utf8'
    );
    expect(src).not.toMatch(/\bREAP\b/);
    expect(src).not.toMatch(/terminateSession|markReaped|sessionJanitor/);
  });

  it('HELM_SESSION_JANITOR remains 0 in deployed config', () => {
    const eco = fs.readFileSync(
      path.join(__dirname, '../../ecosystem.config.cjs'),
      'utf8'
    );
    expect(eco).toMatch(/HELM_SESSION_JANITOR:\s*["']0["']/);
    const envPath = path.join(__dirname, '../../.env');
    if (fs.existsSync(envPath)) {
      expect(fs.readFileSync(envPath, 'utf8')).toMatch(/HELM_SESSION_JANITOR=0/);
    }
  });
});
