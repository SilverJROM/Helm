import { AuthService } from './auth-service.js';

export function createAuthMiddleware(authService: AuthService) {
  return async (request: any, reply: any) => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      reply.code(401).send({ error: 'missing or invalid authorization header' });
      return;
    }
    const token = authHeader.slice(7);
    const user = authService.verifyToken(token);
    if (!user) {
      reply.code(401).send({ error: 'invalid or expired token' });
      return;
    }
    request.user = user;
  };
}

export function createRequireOwner() {
  return (request: any, reply: any, done: any) => {
    if (request.user?.role !== 'owner') {
      reply.code(403).send({ error: 'owner role required' });
      return;
    }
    done();
  };
}

export function createSseAuthMiddleware(authService: AuthService) {
  return async (request: any, reply: any) => {
    // Consensus #3 + brief: try Authorization: Bearer header FIRST (existing createAuthMiddleware path),
    // else fall back to ?access_token query param (required because EventSource cannot set custom headers).
    // Then verify + set request.user. 401 on missing/invalid. (requireOwnerPre follows in preHandler.)
    let token: string | null = null;
    const authHeader = request.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7);
    } else if (request.query && request.query.access_token) {
      token = String(request.query.access_token);
    }
    if (!token) {
      reply.code(401).send({ error: 'missing or invalid authorization (use Authorization: Bearer or ?access_token)' });
      return;
    }
    const user = authService.verifyToken(token);
    if (!user) {
      reply.code(401).send({ error: 'invalid or expired token' });
      return;
    }
    request.user = user;
  };
}
