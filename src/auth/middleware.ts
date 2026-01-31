import { FastifyRequest, FastifyReply } from 'fastify';

const WEEK_IN_MS = 7 * 24 * 60 * 60 * 1000;

export interface UserContext {
  accessToken: string;
  email: string;
  sessionId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    userContext?: UserContext;
  }
}

export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const accessToken = request.session.get('access_token') as string | undefined;
  const expiresAt = request.session.get('expires_at') as number | undefined;
  const authenticatedAt = request.session.get('authenticated_at') as number | undefined;
  const email = request.session.get('email') as string | undefined;

  if (!accessToken || !authenticatedAt || !email) {
    reply.code(401).send({
      error: 'authentication_required',
      message: 'Please authenticate at /auth/login'
    });
    return;
  }

  if (expiresAt && Date.now() >= expiresAt) {
    reply.code(401).send({
      error: 'token_expired',
      message: 'Access token expired. Please re-authenticate at /auth/login'
    });
    return;
  }

  if (Date.now() - authenticatedAt >= WEEK_IN_MS) {
    reply.code(401).send({
      error: 'reauthentication_required',
      message: 'Weekly re-authentication required. Please log in again at /auth/login'
    });
    return;
  }

  request.userContext = {
    accessToken,
    email,
    sessionId: request.session.sessionId
  };
}
