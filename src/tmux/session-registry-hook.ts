import {
  sessionStatusTokenFromRow,
  type RegisterOpts,
  type SessionRegistryService,
} from '../services/session-registry-service.js';
import type { TmuxSessionRegistryHook } from './tmux-service.js';

/**
 * SL-R1 wiring: builds the TmuxSessionRegistryHook that binds a SessionRegistryService into the
 * single TmuxService.createSession/terminateSession choke point (wired onto the shared instance
 * in src/index.ts boot).
 *
 * AC19 / F-07: onCreate must NOT swallow a register() failure — TmuxService.publishCreatedSession
 * fail-closes the create (tears down the just-created session) on a thrown onCreate, so a durable
 * unowned active row can never survive a registry persist failure. onTerminate/onUse/onLookup keep
 * their existing fail-safe (never-invent-authority) contracts, which are unrelated to AC19.
 *
 * Extracted to its own side-effect-free module (rather than an inline object literal in index.ts)
 * so this exact wiring is importable in isolation for tests — index.ts runs main() at import time.
 */
export function buildTmuxSessionRegistryHook(sessionRegistry: SessionRegistryService): TmuxSessionRegistryHook {
  return {
    // A2 + S05: forward projectId/runId/kind/owner from createSession so helm_sessions rows land
    // linked with decision authority at the choke point. Owner is required pre-spawn in
    // createSession; register() also refuses missing owner (defensive).
    onCreate: (name, opts) => {
      // B02 C1: return create-time CAS token so callers retain it (never late get-by-name).
      const row = sessionRegistry.register(name, opts as RegisterOpts);
      if (row) return sessionStatusTokenFromRow(row);
      return undefined;
    },
    // B02 C1 R4: return true only when markReaped applied — gates kill-session in terminateSession.
    onTerminate: (_name, token) => {
      try {
        if (!token) return false;
        return sessionRegistry.markReaped(token).applied === true;
      } catch {
        return false;
      }
    },
    // SL-R2/R4: active-input refreshes last_used_at so the TTL means "idle for TTL" (in-use sessions kept).
    onUse: (name) => { try { sessionRegistry.touch(name); } catch {} },
    // B08 / AC9: createSession same-name replace eligibility — read-only registry lookup (no invent).
    onLookup: (name) => {
      try {
        return sessionRegistry.get(name) ?? undefined;
      } catch {
        return undefined;
      }
    },
  };
}
