import { AuthService } from '../../auth/auth-service.js';
import { TgLoginService } from '../../auth/tg-login-service.js';
import { createRequireLocalLaunch } from '../../guardrails.js';
import type Database from 'better-sqlite3';

const AGJASSIST_TG_LOGIN_URL = 'http://127.0.0.1:3101/api/tg/login-challenge';

export function registerAuthRoutes(app: any, authService: AuthService, helmDb: Database.Database | undefined, config: { port: number }) {
  const tgLoginService = helmDb ? new TgLoginService(helmDb) : null;
  const helmTgCallbackUrl = `http://127.0.0.1:${config.port}/api/auth/tg-callback`;

  app.post('/api/auth/login', async (request: any, reply: any) => {
    const { credential } = request.body || {};
    // RTF-M2: require HELM_OWNER_CRED off-loopback (fail-fast); dev default only for 127.0.0.1
    const host = process.env.HELM_HOST || '127.0.0.1';
    const isLoopback = host === '127.0.0.1' || host === 'localhost' || host.startsWith('127.');
    const ownerCred = process.env.HELM_OWNER_CRED || (isLoopback ? 'JROM-OWNER-SECRET-2026' : null);
    if (!ownerCred || credential !== ownerCred) {
      return reply.code(401).send({ error: 'invalid owner credential' });
    }
    try {
      return authService.issueOwnerToken();
    } catch {
      return reply.code(503).send({ error: 'no unique active AGJAssist owner configured' });
    }
  });

  if (!tgLoginService) return;

  app.post('/api/auth/tg-login-start', async (_request: any, reply: any) => {
    const owner = authService.resolveActiveOwner();
    if (!owner) {
      return reply.code(502).send({ error: 'no unique active AGJAssist owner configured' });
    }
    const challenge = tgLoginService.generateChallenge();
    const body = {
      challengeId: challenge.challengeId,
      chatId: owner.telegramId,
      displayNumber: challenge.displayNumber,
      buttons: challenge.buttons,
      prompt: 'Sign-in attempt for Helm — tap the number you see on screen:',
      callbackUrl: helmTgCallbackUrl
    };

    try {
      const res = await fetch(AGJASSIST_TG_LOGIN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        tgLoginService.markResult(challenge.challengeId, 'fail');
        return reply.code(502).send({ error: 'telegram challenge dispatch failed' });
      }
    } catch {
      tgLoginService.markResult(challenge.challengeId, 'fail');
      return reply.code(502).send({ error: 'telegram challenge dispatch failed' });
    }

    return { challengeId: challenge.challengeId, displayNumber: challenge.displayNumber };
  });

  app.post('/api/auth/tg-callback', { preHandler: createRequireLocalLaunch() }, async (request: any) => {
    const { challengeId, result } = request.body || {};
    if (typeof challengeId === 'string' && (result === 'pass' || result === 'fail')) {
      tgLoginService.markResult(challengeId, result);
    }
    return { ok: true };
  });

  app.get('/api/auth/tg-status', async (request: any) => {
    const challengeId = request.query?.challengeId;
    if (typeof challengeId !== 'string' || !challengeId) {
      return { status: 'expired' };
    }
    const status = tgLoginService.getStatus(challengeId);
    if (status === 'pass' && tgLoginService.consumePassForToken(challengeId)) {
      try {
        return { status, ...authService.issueOwnerToken() };
      } catch {
        return { status: 'fail' };
      }
    }
    return { status };
  });
}
