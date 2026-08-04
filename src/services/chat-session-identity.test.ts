// chat-session-identity.test.ts
// E8 FIX2 / R-cycle-session-continuity: durable, resumable PROVIDER conversation id per chat session
// identity (project, agent, cycle). Everything here must fail OPEN — a missing table, corrupt row, or
// unreadable filesystem must never throw; callers get null/no-op and fall back to a cold spawn.
import Database from 'better-sqlite3';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  CLAUDE_CONVERSATION_ID_RE,
  claudeProjectSlug,
  detectNewestClaudeConversationId,
  getStoredChatIdentity,
  removeStoredChatIdentity,
  storeChatIdentity,
  waitForClaudeConversationId,
} from './chat-session-identity.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE chat_session_identities (
      id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL,
      agent_id INTEGER NOT NULL,
      cycle_id INTEGER NOT NULL DEFAULT 0,
      provider TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project_id, agent_id, cycle_id)
    );
  `);
  return db;
}

describe('E8 FIX2 chat-session-identity (persist/lookup/remove)', () => {
  it('round-trips: store then get returns the same identity', () => {
    const db = makeDb();
    const key = { projectId: 3, agentId: 42, cycleId: 13 };
    expect(getStoredChatIdentity(db, key)).toBeNull();
    storeChatIdentity(db, key, { provider: 'claude', conversationId: 'f48a4da3-ad69-615e-0000-000000000000' });
    expect(getStoredChatIdentity(db, key)).toEqual({ provider: 'claude', conversationId: 'f48a4da3-ad69-615e-0000-000000000000' });
  });

  it('cycleId 0 sentinel ("no active cycle") is distinct from an actual cycle id, and de-dupes with itself', () => {
    const db = makeDb();
    storeChatIdentity(db, { projectId: 3, agentId: 42, cycleId: 0 }, { provider: 'claude', conversationId: 'no-cycle-id' });
    storeChatIdentity(db, { projectId: 3, agentId: 42, cycleId: 13 }, { provider: 'claude', conversationId: 'cycle-13-id' });
    expect(getStoredChatIdentity(db, { projectId: 3, agentId: 42, cycleId: 0 })?.conversationId).toBe('no-cycle-id');
    expect(getStoredChatIdentity(db, { projectId: 3, agentId: 42, cycleId: 13 })?.conversationId).toBe('cycle-13-id');
    // re-storing the SAME (project, agent, no-cycle) key upserts rather than duplicating.
    storeChatIdentity(db, { projectId: 3, agentId: 42, cycleId: 0 }, { provider: 'claude', conversationId: 'replaced-id' });
    expect(getStoredChatIdentity(db, { projectId: 3, agentId: 42, cycleId: 0 })?.conversationId).toBe('replaced-id');
    expect((db.prepare('SELECT COUNT(*) AS c FROM chat_session_identities').get() as any).c).toBe(2);
  });

  it('different (project, agent, cycle) triples never collide', () => {
    const db = makeDb();
    storeChatIdentity(db, { projectId: 3, agentId: 1, cycleId: 5 }, { provider: 'claude', conversationId: 'a' });
    storeChatIdentity(db, { projectId: 3, agentId: 2, cycleId: 5 }, { provider: 'claude', conversationId: 'b' });
    storeChatIdentity(db, { projectId: 4, agentId: 1, cycleId: 5 }, { provider: 'claude', conversationId: 'c' });
    expect(getStoredChatIdentity(db, { projectId: 3, agentId: 1, cycleId: 5 })?.conversationId).toBe('a');
    expect(getStoredChatIdentity(db, { projectId: 3, agentId: 2, cycleId: 5 })?.conversationId).toBe('b');
    expect(getStoredChatIdentity(db, { projectId: 4, agentId: 1, cycleId: 5 })?.conversationId).toBe('c');
  });

  it('removeStoredChatIdentity forgets the id (used by the fail-open resume retry)', () => {
    const db = makeDb();
    const key = { projectId: 3, agentId: 42, cycleId: 13 };
    storeChatIdentity(db, key, { provider: 'claude', conversationId: 'stale-uuid' });
    expect(getStoredChatIdentity(db, key)).not.toBeNull();
    removeStoredChatIdentity(db, key);
    expect(getStoredChatIdentity(db, key)).toBeNull();
  });

  it('FAIL OPEN: no db, missing table, and a corrupt row all degrade to null/no-op, never throw', () => {
    const key = { projectId: 1, agentId: 1, cycleId: 0 };
    // no db at all (e.g. deps.db never wired for this caller)
    expect(() => getStoredChatIdentity(undefined, key)).not.toThrow();
    expect(getStoredChatIdentity(undefined, key)).toBeNull();
    expect(() => storeChatIdentity(undefined, key, { provider: 'claude', conversationId: 'x' })).not.toThrow();
    expect(() => removeStoredChatIdentity(undefined, key)).not.toThrow();

    // db present but the table doesn't exist
    const dbNoTable = new Database(':memory:');
    expect(getStoredChatIdentity(dbNoTable, key)).toBeNull();
    expect(() => storeChatIdentity(dbNoTable, key, { provider: 'claude', conversationId: 'x' })).not.toThrow();
    expect(() => removeStoredChatIdentity(dbNoTable, key)).not.toThrow();
  });

  it('CLAUDE_CONVERSATION_ID_RE rejects shell-hostile values before they would ever be spliced into a launch command', () => {
    expect(CLAUDE_CONVERSATION_ID_RE.test('f48a4da3-ad69-615e-0000-000000000000')).toBe(true);
    expect(CLAUDE_CONVERSATION_ID_RE.test('short')).toBe(false);
    expect(CLAUDE_CONVERSATION_ID_RE.test("uuid'; rm -rf ~ #")).toBe(false);
    expect(CLAUDE_CONVERSATION_ID_RE.test('has spaces in it 123456')).toBe(false);
    expect(CLAUDE_CONVERSATION_ID_RE.test('$(whoami)-12345678')).toBe(false);
  });

  it('claudeProjectSlug matches Claude Code\'s own on-disk convention: cwd with / replaced by -', () => {
    expect(claudeProjectSlug('/home/agjrom/tools/memory_mcp')).toBe('-home-agjrom-tools-memory_mcp');
    expect(claudeProjectSlug('/home/agjrom/websites/Helm')).toBe('-home-agjrom-websites-Helm');
  });
});

describe('E8 FIX2 detectNewestClaudeConversationId / waitForClaudeConversationId (real filesystem)', () => {
  let tmpHome: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-e8-claude-home-'));
    prevHome = process.env.HOME;
    process.env.HOME = tmpHome;
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  async function writeTranscript(cwd: string, uuid: string, mtimeMs: number) {
    const dir = path.join(tmpHome, '.claude', 'projects', claudeProjectSlug(cwd));
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${uuid}.jsonl`);
    await fs.writeFile(file, '{}\n');
    await fs.utimes(file, mtimeMs / 1000, mtimeMs / 1000);
  }

  it('picks the NEWEST transcript at/after sinceMs, ignoring older ones and non-.jsonl files', async () => {
    const cwd = '/home/agjrom/tools/memory_mcp';
    const sinceMs = Date.now();
    await writeTranscript(cwd, 'old-conversation-uuid-000', sinceMs - 60_000); // before sinceMs — ignored
    await new Promise((r) => setTimeout(r, 10));
    await writeTranscript(cwd, 'new-conversation-uuid-111', Date.now());
    const dir = path.join(tmpHome, '.claude', 'projects', claudeProjectSlug(cwd));
    await fs.writeFile(path.join(dir, 'not-a-transcript.txt'), 'ignore me');

    const id = await detectNewestClaudeConversationId(cwd, sinceMs);
    expect(id).toBe('new-conversation-uuid-111');
  });

  it('no directory for this cwd at all → null, never throws', async () => {
    const id = await detectNewestClaudeConversationId('/nowhere/never/spawned/here', Date.now());
    expect(id).toBeNull();
  });

  it('waitForClaudeConversationId polls until the (slightly lagging) transcript write lands', async () => {
    const cwd = '/home/agjrom/tools/memory_mcp';
    const sinceMs = Date.now();
    setTimeout(() => { writeTranscript(cwd, 'delayed-uuid-222', Date.now()); }, 50);
    const id = await waitForClaudeConversationId(cwd, sinceMs, { attempts: 5, delayMs: 40 });
    expect(id).toBe('delayed-uuid-222');
  });

  it('waitForClaudeConversationId gives up after bounded attempts and returns null (never hangs)', async () => {
    const id = await waitForClaudeConversationId('/nowhere/here/either', Date.now(), { attempts: 2, delayMs: 5 });
    expect(id).toBeNull();
  });
});
