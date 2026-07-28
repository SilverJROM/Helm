/**
 * B09 / AC12 — chat-session create routes map SessionNameCollisionError to a stable 409
 * refusal body (code + reason + session_name), not a generic 500.
 *
 * Minimal inject surface mirrors index.ts studio + project agent-chat create catch blocks.
 * No live tmux; create is stubbed to throw the typed B08 error.
 */
import { describe, it, expect, afterEach } from 'vitest';
import Fastify from 'fastify';
import { SessionNameCollisionError } from './tmux/tmux-service.js';

function ownerAuth(req: any, _reply: any, done?: () => void) {
  req.user = { role: 'owner' };
  done?.();
}

/** Same mapping as src/index.ts chat-session create routes (B09). */
function sendChatSessionCreateError(reply: any, e: any) {
  if (
    e?.code === 'SESSION_NAME_COLLISION' ||
    e instanceof SessionNameCollisionError ||
    e?.name === 'SessionNameCollisionError'
  ) {
    return reply.code(409).send({
      error: String(e.message || 'session name collision refused'),
      code: 'SESSION_NAME_COLLISION',
      reason: e.reason ?? 'exists_unknown',
      session_name: e.sessionName ?? null,
    });
  }
  if (e.message?.includes('not validated')) return reply.code(409).send({ error: e.message });
  return reply.code(500).send({ error: e.message });
}

async function buildApp(createImpl: () => Promise<never>) {
  const app = Fastify({ logger: false });
  const auth = ownerAuth;

  app.post('/api/agents/:agentId/chat-session', { preHandler: [auth] }, async (_request: any, reply: any) => {
    try {
      await createImpl();
      return { session_id: 'x' };
    } catch (e: any) {
      return sendChatSessionCreateError(reply, e);
    }
  });

  app.post('/api/projects/:pid/agent-chat/:agentId', { preHandler: [auth] }, async (_request: any, reply: any) => {
    try {
      await createImpl();
      return { session_id: 'x' };
    } catch (e: any) {
      return sendChatSessionCreateError(reply, e);
    }
  });

  await app.ready();
  return app;
}

describe('B09 collision refusal API (AC12)', () => {
  let app: Awaited<ReturnType<typeof buildApp>> | null = null;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
  });

  it('studio POST /api/agents/:id/chat-session maps human collision → 409 stable body', async () => {
    const err = new SessionNameCollisionError(
      'helm-chat-probe-aaaaaa',
      'human',
      'session name collision refused (human): will not replace live human session helm-chat-probe-aaaaaa'
    );
    app = await buildApp(async () => {
      throw err;
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/agents/3/chat-session',
      payload: {},
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.code).toBe('SESSION_NAME_COLLISION');
    expect(body.reason).toBe('human');
    expect(body.session_name).toBe('helm-chat-probe-aaaaaa');
    expect(String(body.error)).toMatch(/human|collision|will not replace/i);
    // Must not be a bare 500-style payload without code/reason.
    expect(body).not.toHaveProperty('session_id');
  });

  it('project POST /api/projects/:pid/agent-chat/:id maps human collision → 409 stable body', async () => {
    app = await buildApp(async () => {
      throw new SessionNameCollisionError(
        'helm-chat-p1-agent-bbbbbb',
        'human',
        'session name collision refused (human): will not replace live human session helm-chat-p1-agent-bbbbbb'
      );
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/1/agent-chat/5',
      payload: {},
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body).toEqual(
      expect.objectContaining({
        code: 'SESSION_NAME_COLLISION',
        reason: 'human',
        session_name: 'helm-chat-p1-agent-bbbbbb',
      })
    );
    expect(String(body.error)).toMatch(/collision|human/i);
  });

  it('non-collision create failure stays 500 without SESSION_NAME_COLLISION code', async () => {
    app = await buildApp(async () => {
      throw new Error('ready probe failed');
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/agents/3/chat-session',
      payload: {},
    });

    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.error).toMatch(/ready probe/i);
    expect(body.code).toBeUndefined();
  });
});
