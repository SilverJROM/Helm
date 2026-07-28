// chat-session-identity.ts
// E8 FIX2 / R-cycle-session-continuity: durable, resumable PROVIDER conversation identity for a
// Helm chat session, keyed by (project, agent, cycle). ChatSessionService's own session bookkeeping
// is an in-memory Map (dies on server restart); this table survives restarts so a reopened chat can
// `--resume <uuid>` the SAME provider-side conversation instead of cold-spawning and re-prompting.
//
// Scope (deliberate): claude only — the only provider with a concrete, verified resume mechanism
// here (`claude --resume <uuid>`, explicit id, never bare `-c` — see plan/_backlog/
// R-cycle-session-continuity.md on why bare `-c` is unsafe when seats share a cwd). Every function
// here is best-effort and fails OPEN: a missing table, a corrupt row, or an unreadable filesystem
// must never block a chat session from spawning — callers get `null` and fall back to a cold spawn.

import type Database from 'better-sqlite3';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ChatIdentityKey {
  projectId: number;
  agentId: number;
  /** 0 sentinel = no active cycle (chat identity scoped to project+agent only). */
  cycleId: number;
}

export interface StoredChatIdentity {
  provider: string;
  conversationId: string;
}

// Claude Code session ids are UUIDs (the .jsonl transcript filename stem). Validated before ANY use
// in a shell-interpolated launch command — a stored value is untrusted-by-construction once it has
// round-tripped through the database.
export const CLAUDE_CONVERSATION_ID_RE = /^[a-zA-Z0-9-]{8,64}$/;

function keyCycleId(cycleId: number | null | undefined): number {
  return typeof cycleId === 'number' && Number.isInteger(cycleId) && cycleId > 0 ? cycleId : 0;
}

/** Look up a stored resumable conversation id. Never throws — a missing table/row is just `null`. */
export function getStoredChatIdentity(db: Database.Database | undefined, key: ChatIdentityKey): StoredChatIdentity | null {
  if (!db) return null;
  try {
    const row = db
      .prepare(
        `SELECT provider, conversation_id FROM chat_session_identities
         WHERE project_id = ? AND agent_id = ? AND cycle_id = ?`
      )
      .get(key.projectId, key.agentId, keyCycleId(key.cycleId)) as { provider: string; conversation_id: string } | undefined;
    return row ? { provider: row.provider, conversationId: row.conversation_id } : null;
  } catch {
    return null;
  }
}

/** Persist (upsert) a resumable conversation id. Best-effort — persistence failures never propagate. */
export function storeChatIdentity(db: Database.Database | undefined, key: ChatIdentityKey, identity: StoredChatIdentity): void {
  if (!db) return;
  try {
    db.prepare(
      `INSERT INTO chat_session_identities (project_id, agent_id, cycle_id, provider, conversation_id, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(project_id, agent_id, cycle_id) DO UPDATE SET
         provider = excluded.provider, conversation_id = excluded.conversation_id, updated_at = excluded.updated_at`
    ).run(key.projectId, key.agentId, keyCycleId(key.cycleId), identity.provider, identity.conversationId);
  } catch {
    // best-effort — the live session this turn is unaffected either way
  }
}

/** Forget a stored id — used when a resume attempt turns out to be unresumable (fail-open retry). */
export function removeStoredChatIdentity(db: Database.Database | undefined, key: ChatIdentityKey): void {
  if (!db) return;
  try {
    db.prepare(
      `DELETE FROM chat_session_identities WHERE project_id = ? AND agent_id = ? AND cycle_id = ?`
    ).run(key.projectId, key.agentId, keyCycleId(key.cycleId));
  } catch {
    // best-effort
  }
}

/** Claude Code's on-disk project directory name: cwd with every `/` replaced by `-`. */
export function claudeProjectSlug(cwd: string): string {
  return path.resolve(cwd).replace(/\//g, '-');
}

/** Newest `<uuid>.jsonl` transcript written for `cwd` at/after `sinceMs`, or null. Never throws. */
export async function detectNewestClaudeConversationId(cwd: string, sinceMs: number): Promise<string | null> {
  try {
    const dir = path.join(os.homedir(), '.claude', 'projects', claudeProjectSlug(cwd));
    const entries = await fs.readdir(dir);
    let newest: { id: string; mtimeMs: number } | null = null;
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const stat = await fs.stat(path.join(dir, entry)).catch(() => null);
      if (!stat || stat.mtimeMs < sinceMs) continue;
      if (!newest || stat.mtimeMs > newest.mtimeMs) newest = { id: entry.slice(0, -'.jsonl'.length), mtimeMs: stat.mtimeMs };
    }
    return newest ? newest.id : null;
  } catch {
    return null;
  }
}

/**
 * Poll for the transcript file — Claude Code's write can lag the process launch by a beat. Bounded
 * (default ~2s total) and never throws; a miss just means this spawn won't be resumable next time.
 */
export async function waitForClaudeConversationId(
  cwd: string,
  sinceMs: number,
  opts?: { attempts?: number; delayMs?: number }
): Promise<string | null> {
  const attempts = opts?.attempts ?? 5;
  const delayMs = opts?.delayMs ?? 400;
  for (let i = 0; i < attempts; i++) {
    const id = await detectNewestClaudeConversationId(cwd, sinceMs);
    if (id) return id;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return null;
}
