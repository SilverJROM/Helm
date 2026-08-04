/**
 * S09 — In-process registry for Discovery ready-callback credentials.
 *
 * Raw tokens are held only long enough to inject into the agent sidecar; the registry
 * stores the hash + binding. Browser APIs never receive the raw token.
 */
import {
  hashHandoffCredential,
  mintHandoffCredential,
} from './discovery-handoff-service.js';

export interface DiscoveryCallbackBinding {
  projectId: number;
  cycleId: number;
  chatSessionId: string;
  agentId: number;
  credentialHash: string;
  issuedAt: string;
  /** Set when the credential has been used for a successful ready accept. */
  usedAt: string | null;
}

const byHash = new Map<string, DiscoveryCallbackBinding>();
/** Latest raw credential per chat session (sidecar only; never listed via HTTP). */
const rawBySession = new Map<string, string>();

export function issueDiscoveryCallbackCredential(binding: {
  projectId: number;
  cycleId: number;
  chatSessionId: string;
  agentId: number;
}): { rawCredential: string; binding: DiscoveryCallbackBinding } {
  // Rotate: drop prior raw for this session
  const priorRaw = rawBySession.get(binding.chatSessionId);
  if (priorRaw) {
    byHash.delete(hashHandoffCredential(priorRaw));
  }
  const rawCredential = mintHandoffCredential();
  const credentialHash = hashHandoffCredential(rawCredential);
  const row: DiscoveryCallbackBinding = {
    projectId: binding.projectId,
    cycleId: binding.cycleId,
    chatSessionId: binding.chatSessionId,
    agentId: binding.agentId,
    credentialHash,
    issuedAt: new Date().toISOString(),
    usedAt: null,
  };
  byHash.set(credentialHash, row);
  rawBySession.set(binding.chatSessionId, rawCredential);
  return { rawCredential, binding: row };
}

export function lookupDiscoveryCallbackCredential(
  rawCredential: string
): DiscoveryCallbackBinding | null {
  const hash = hashHandoffCredential(rawCredential);
  return byHash.get(hash) ?? null;
}

export function markDiscoveryCallbackCredentialUsed(rawCredential: string): void {
  const hash = hashHandoffCredential(rawCredential);
  const row = byHash.get(hash);
  if (row) {
    row.usedAt = new Date().toISOString();
    byHash.set(hash, row);
  }
  // Drop raw so it cannot be re-injected from registry
  if (row) {
    const cur = rawBySession.get(row.chatSessionId);
    if (cur && hashHandoffCredential(cur) === hash) {
      rawBySession.delete(row.chatSessionId);
    }
  }
}

/** Test helper — clear process registry. */
export function clearDiscoveryCallbackCredentialsForTests(): void {
  byHash.clear();
  rawBySession.clear();
}

/**
 * Exact sidecar instruction block for Discovery ready POST (AC7/8).
 * Raw credential appears only here (agent workspace), never in browser responses.
 */
export function formatDiscoveryReadyCallbackInstruction(opts: {
  rawCredential: string;
  projectId: number;
  cycleId: number;
  chatSessionId: string;
  agentId: number;
  baseUrl?: string;
}): string {
  const base = (opts.baseUrl || 'http://127.0.0.1:3110').replace(/\/$/, '');
  const path = '/api/discovery/handoff/ready';
  const body = JSON.stringify({
    role: 'discovery',
    status: 'NORTH-STAR-READY',
    projectId: opts.projectId,
    cycleId: opts.cycleId,
    sessionId: opts.chatSessionId,
    agentId: opts.agentId,
    credential: opts.rawCredential,
  });
  return [
    '## Discovery ready callback (STRUCTURED — not pane prose)',
    'When Discovery documents are ready, submit the ready state ONLY via this structured POST.',
    'Do NOT treat printed `[helm callback] …` pane text as a transition; pane/SSE is display-only.',
    'This credential is callback-only: it cannot call owner-confirm or Start Planning endpoints.',
    '',
    `POST ${base}${path}`,
    'Content-Type: application/json',
    '',
    'Exact JSON body (credential is one-use; do not share with the browser):',
    '```json',
    body,
    '```',
    '',
    'After a successful ready POST, ask the operator exactly the Discovery ready ASK string from the phase contract.',
  ].join('\n');
}
