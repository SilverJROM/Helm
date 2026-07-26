// F2 round-8 (sol finding #1, HIGH): SID↔scope binding on the scoped chat `:sid` routes.
// The delivery channel (project:<pid> / studio:<agentId>) used to be derived from the ROUTE scope alone,
// never verifying the :sid belongs to that scope — so an owner could stream/ack/POST a session they own
// under a FOREIGN project/agent route and read/consume/mis-record another channel; the ACK route did no SID
// check at all. This suite proves the shared resolver + pre-handler bind route scope to the session BEFORE
// any channel is selected, and that a rejection mutates NOTHING (send queue + delivery ledger untouched).
process.env.USE_FAKE_TMUX = '1';
process.env.HELM_TEST_FAST_WD = '1';

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import {
  canonicalPositiveInt,
  resolveScopedChannel,
  createScopedChatSidPre,
  deliveryChannelFor,
} from './delivery-channel.js';
import { ChatSessionService } from './chat-session-service.js';
import { TmuxService } from '../tmux/tmux-service.js';

// ─────────────────────────────────────────────────────────────────────────────
// Part A — pure resolver: canonical-int + scope binding (rules 1–4)
// ─────────────────────────────────────────────────────────────────────────────

describe('canonicalPositiveInt — canonical positive-integer route segment', () => {
  it('accepts a plain positive integer string / number', () => {
    expect(canonicalPositiveInt('1')).toBe(1);
    expect(canonicalPositiveInt('7')).toBe(7);
    expect(canonicalPositiveInt('42')).toBe(42);
    expect(canonicalPositiveInt(7)).toBe(7);
  });
  it('REJECTS non-canonical / invalid forms → null', () => {
    expect(canonicalPositiveInt('01')).toBeNull();   // leading zero
    expect(canonicalPositiveInt('1.5')).toBeNull();  // decimal
    expect(canonicalPositiveInt('abc')).toBeNull();  // non-numeric
    expect(canonicalPositiveInt('-1')).toBeNull();   // negative
    expect(canonicalPositiveInt('0')).toBeNull();    // zero
    expect(canonicalPositiveInt('')).toBeNull();
    expect(canonicalPositiveInt(' 1')).toBeNull();   // whitespace
    expect(canonicalPositiveInt('1e3')).toBeNull();  // exponent
    expect(canonicalPositiveInt(1.5)).toBeNull();    // non-integer number
    expect(canonicalPositiveInt(-1)).toBeNull();
    expect(canonicalPositiveInt(0)).toBeNull();
    expect(canonicalPositiveInt(null)).toBeNull();
    expect(canonicalPositiveInt(undefined)).toBeNull();
  });
});

const projSession = { agentId: 5, projectId: 7 };       // a project-fenced session (pid 7, agent 5)
const studioSession = { agentId: 3, projectId: undefined }; // a Studio (unfenced) session, agent 3

describe('resolveScopedChannel — bind route scope to the session (rules 1–4)', () => {
  it('VALID project route → ok, channel from the VALIDATED numeric scope (== the pre-fix deliveryChannelFor string)', () => {
    const r = resolveScopedChannel({ pid: '7', sid: 's1' }, projSession);
    expect(r).toEqual({ ok: true, channel: 'project:7' });
    expect((r as any).channel).toBe(deliveryChannelFor({ pid: 7 })); // behaviour UNCHANGED for valid routes
  });
  it('VALID studio route → ok, channel studio:<agentId>', () => {
    expect(resolveScopedChannel({ agentId: '3', sid: 's1' }, studioSession)).toEqual({ ok: true, channel: 'studio:3' });
  });

  it('rule 1 — nonexistent SID (no session) → reject', () => {
    expect(resolveScopedChannel({ pid: '7', sid: 'nope' }, undefined)).toEqual({ ok: false });
    expect(resolveScopedChannel({ agentId: '3', sid: 'nope' }, null)).toEqual({ ok: false });
  });
  it('rule 2 — wrong-project SID (session.projectId ≠ pid) → reject', () => {
    expect(resolveScopedChannel({ pid: '8', sid: 's1' }, projSession)).toEqual({ ok: false });
  });
  it('rule 3 — wrong-agent SID → reject', () => {
    expect(resolveScopedChannel({ agentId: '9', sid: 's1' }, studioSession)).toEqual({ ok: false });
  });
  it('rule 3 — a project-scoped SID on a Studio route (same agent) → reject (cannot rebind to studio channel)', () => {
    // projSession.agentId === 5, but it is project-fenced (projectId 7); the Studio route must NOT accept it.
    expect(resolveScopedChannel({ agentId: '5', sid: 's1' }, projSession)).toEqual({ ok: false });
  });
  it('rules 2/3 — non-canonical / invalid numeric scope → reject (even when the SID otherwise matches)', () => {
    for (const pid of ['01', '1.5', 'abc', '-1', '0']) {
      // use a session whose projectId equals Number(pid) where finite, to prove the CANONICAL check fires first
      const sess = { agentId: 5, projectId: Number(pid) };
      expect(resolveScopedChannel({ pid, sid: 's1' }, sess)).toEqual({ ok: false });
    }
    for (const agentId of ['01', '1.5', 'abc', '-1', '0']) {
      const sess = { agentId: Number(agentId), projectId: undefined };
      expect(resolveScopedChannel({ agentId, sid: 's1' }, sess)).toEqual({ ok: false });
    }
  });
  it('rule 4 — every rejection is the SAME opaque {ok:false} (no cross-scope existence leak)', () => {
    const nonexistent = resolveScopedChannel({ pid: '7', sid: 'nope' }, undefined);
    const wrongScope = resolveScopedChannel({ pid: '8', sid: 's1' }, projSession); // valid in project 7, not 8
    expect(nonexistent).toEqual(wrongScope); // indistinguishable — cannot tell "missing" from "another scope"
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Part B — the shared pre-handler gates EVERY scoped :sid verb, and a rejection
// mutates NOTHING (real ChatSessionService ledger + a spied sendMessage).
// ─────────────────────────────────────────────────────────────────────────────

class StubTmux extends TmuxService {
  async capturePane(): Promise<string> { return ''; }
  async sessionExists(): Promise<boolean> { return true; }
  async terminateSession(): Promise<void> {}
  async sendLiteralText(): Promise<void> {}
  async sendEnter() { return { message: 'enter', blocked: false }; }
  async sendKeys(k: string) { return { message: k, blocked: false }; }
}

const PROJ_SID = 'proj-sid';   // project-fenced session: pid 7, agent 5 → channel project:7
const STUDIO_SID = 'studio-sid'; // Studio session: agent 3, no project → channel studio:3

function makeSvc(): ChatSessionService {
  const svc = new ChatSessionService({ tmux: new StubTmux() as any, modelService: {} as any, assignmentService: {} as any, resolverService: {} as any });
  (svc as any).sessions.set(PROJ_SID, { agentId: 5, projectId: 7, tmuxSession: 't', paneTarget: 't:0.0', lastSnapshot: '', createdAt: Date.now(), bootstrapSent: true, bootstrapEndMarker: '', bootstrapMarkerSeen: true, spawnProvider: 'claude', spawnModel: 'm' });
  (svc as any).sessions.set(STUDIO_SID, { agentId: 3, projectId: undefined, tmuxSession: 't', paneTarget: 't:0.0', lastSnapshot: '', createdAt: Date.now(), bootstrapSent: true, bootstrapEndMarker: '', bootstrapMarkerSeen: true, spawnProvider: 'claude', spawnModel: 'm' });
  return svc;
}
function seedChannel(svc: ChatSessionService, channel: string, seq: number) {
  (svc as any).channelLedger.set(channel, {
    seq,
    failures: Array.from({ length: seq }, (_, i) => ({ seq: i + 1, msgId: `m${i + 1}`, text: 't', reason: 'r' })),
    evictedThrough: 0, ackedThrough: 0, emittedThrough: seq, updatedAt: Date.now(),
  });
}
const ledger = (svc: ChatSessionService) => (svc as any).channelLedger as Map<string, any>;

// Build a minimal app wiring the REAL shared pre-handler to handlers that mirror production's channel use.
async function buildApp(svc: ChatSessionService) {
  const pre = createScopedChatSidPre(svc);
  const owner = (req: any, _r: any, done: any) => { req.user = { role: 'owner' }; done(); };
  const app = Fastify({ logger: false });
  const message = async (request: any, reply: any) => {
    // mirrors index.ts chatSessionMessageHandler: derive channel from the VALIDATED scope, fire delivery.
    const body = request.body || {};
    const text = (body.text || '').trim();
    if (!text) return reply.code(400).send({ error: 'text required' });
    const msgId = String(body.msgId || 'dm-x');
    const channel = request.deliveryChannel;
    void svc.sendMessage(request.params.sid, text, msgId, channel);
    return { ok: true, accepted: true, msgId, channel };
  };
  const ack = async (request: any) => {
    const channel = request.deliveryChannel;            // mirrors chatDeliveryAckHandler
    const throughSeq = Number((request.body || {}).throughSeq);
    if (Number.isFinite(throughSeq)) svc.ackDelivery(channel, throughSeq);
    return { ok: true };
  };
  const stream = async (request: any, reply: any) => reply.send({ ran: true, channel: request.deliveryChannel });
  // Studio scope
  app.post('/api/agents/:agentId/chat-session/:sid/message', { preHandler: [owner, pre] }, message);
  app.post('/api/agents/:agentId/chat-session/:sid/chat-delivery-ack', { preHandler: [owner, pre] }, ack);
  app.get('/api/agents/:agentId/chat-session/:sid/stream', { preHandler: [owner, pre] }, stream);
  // Project scope
  app.post('/api/projects/:pid/agent-chat/:sid/message', { preHandler: [owner, pre] }, message);
  app.post('/api/projects/:pid/agent-chat/:sid/chat-delivery-ack', { preHandler: [owner, pre] }, ack);
  app.get('/api/projects/:pid/agent-chat/:sid/stream', { preHandler: [owner, pre] }, stream);
  await app.ready();
  return app;
}

describe('scopedChatSidPre — VALID routes behave EXACTLY as before', () => {
  let svc: ChatSessionService; let app: any; let sendSpy: any; let ackSpy: any;
  beforeEach(async () => {
    svc = makeSvc();
    sendSpy = vi.spyOn(svc, 'sendMessage').mockResolvedValue(undefined as any);
    ackSpy = vi.spyOn(svc, 'ackDelivery');
    seedChannel(svc, 'project:7', 3);
    seedChannel(svc, 'studio:3', 3);
    app = await buildApp(svc);
  });

  it('valid PROJECT message → 200, delivered under the validated channel project:7', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/projects/7/agent-chat/${PROJ_SID}/message`, payload: { text: 'hi', msgId: 'u1' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accepted: true, channel: 'project:7' });
    expect(sendSpy).toHaveBeenCalledWith(PROJ_SID, 'hi', 'u1', 'project:7');
  });
  it('valid STUDIO message → 200, delivered under studio:3', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/agents/3/chat-session/${STUDIO_SID}/message`, payload: { text: 'yo', msgId: 'u2' } });
    expect(res.statusCode).toBe(200);
    expect(sendSpy).toHaveBeenCalledWith(STUDIO_SID, 'yo', 'u2', 'studio:3');
  });
  it('valid PROJECT ack advances the ledger watermark (unchanged behaviour)', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/projects/7/agent-chat/${PROJ_SID}/chat-delivery-ack`, payload: { throughSeq: 2 } });
    expect(res.statusCode).toBe(200);
    expect(ackSpy).toHaveBeenCalledWith('project:7', 2);
    expect(ledger(svc).get('project:7').ackedThrough).toBe(2); // watermark advanced
  });
  it('valid STUDIO stream → pre-handler passes through with the validated channel', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/agents/3/chat-session/${STUDIO_SID}/stream` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ran: true, channel: 'studio:3' });
  });
});

describe('scopedChatSidPre — REJECTED (404) and the send queue + delivery ledger stay UNTOUCHED', () => {
  let svc: ChatSessionService; let app: any; let sendSpy: any; let ackSpy: any;
  beforeEach(async () => {
    svc = makeSvc();
    sendSpy = vi.spyOn(svc, 'sendMessage').mockResolvedValue(undefined as any);
    ackSpy = vi.spyOn(svc, 'ackDelivery');
    seedChannel(svc, 'project:7', 3);
    seedChannel(svc, 'studio:3', 3);
    app = await buildApp(svc);
  });

  // helper: assert NOTHING mutated after a rejected request
  function assertUntouched(foreignChannels: string[]) {
    expect(sendSpy).not.toHaveBeenCalled();          // no enqueue
    expect(ackSpy).not.toHaveBeenCalled();           // no ledger mutation
    expect(ledger(svc).get('project:7').ackedThrough).toBe(0); // no seq/watermark advance
    expect(ledger(svc).get('project:7').failures).toHaveLength(3);
    expect(ledger(svc).get('studio:3').ackedThrough).toBe(0);
    for (const ch of foreignChannels) expect(ledger(svc).has(ch)).toBe(false); // no foreign channel entry created
  }

  const rejectCases: Array<{ name: string; method: string; url: string; foreign: string[] }> = [
    // wrong-project SID (proj session belongs to pid 7)
    { name: 'wrong-project message', method: 'POST', url: `/api/projects/8/agent-chat/${PROJ_SID}/message`, foreign: ['project:8'] },
    { name: 'wrong-project stream', method: 'GET', url: `/api/projects/8/agent-chat/${PROJ_SID}/stream`, foreign: ['project:8'] },
    { name: 'wrong-project ACK', method: 'POST', url: `/api/projects/8/agent-chat/${PROJ_SID}/chat-delivery-ack`, foreign: ['project:8'] },
    // a project-scoped SID pointed at the Studio route for its own agent (agent 5)
    { name: 'project-SID on Studio message', method: 'POST', url: `/api/agents/5/chat-session/${PROJ_SID}/message`, foreign: ['studio:5'] },
    { name: 'project-SID on Studio ACK', method: 'POST', url: `/api/agents/5/chat-session/${PROJ_SID}/chat-delivery-ack`, foreign: ['studio:5'] },
    // wrong-agent SID (studio session is agent 3)
    { name: 'wrong-agent message', method: 'POST', url: `/api/agents/9/chat-session/${STUDIO_SID}/message`, foreign: ['studio:9'] },
    { name: 'wrong-agent stream', method: 'GET', url: `/api/agents/9/chat-session/${STUDIO_SID}/stream`, foreign: ['studio:9'] },
    // nonexistent SID — the ACK route did NO sid check before this fix
    { name: 'nonexistent-SID ACK (project)', method: 'POST', url: `/api/projects/7/agent-chat/ghost/chat-delivery-ack`, foreign: [] },
    { name: 'nonexistent-SID ACK (studio)', method: 'POST', url: `/api/agents/3/chat-session/ghost/chat-delivery-ack`, foreign: [] },
    { name: 'nonexistent-SID message', method: 'POST', url: `/api/projects/7/agent-chat/ghost/message`, foreign: [] },
    // non-canonical / invalid numeric scope
    { name: 'pid=01 message', method: 'POST', url: `/api/projects/01/agent-chat/${PROJ_SID}/message`, foreign: ['project:01', 'project:1'] },
    { name: 'pid=1.5 message', method: 'POST', url: `/api/projects/1.5/agent-chat/${PROJ_SID}/message`, foreign: ['project:1.5'] },
    { name: 'pid=abc ACK', method: 'POST', url: `/api/projects/abc/agent-chat/${PROJ_SID}/chat-delivery-ack`, foreign: ['project:abc'] },
    { name: 'agentId=-1 stream', method: 'GET', url: `/api/agents/-1/chat-session/${STUDIO_SID}/stream`, foreign: ['studio:-1'] },
  ];

  for (const c of rejectCases) {
    it(`REJECT ${c.name} → 404, nothing enqueued, ledger untouched`, async () => {
      const res = await app.inject({ method: c.method as any, url: c.url, payload: c.method === 'POST' ? { text: 'x', throughSeq: 2 } : undefined });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'unknown session' }); // opaque — no cross-scope leak
      assertUntouched(c.foreign);
    });
  }
});
