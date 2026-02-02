import { FastifyRequest, FastifyReply } from 'fastify';
import { getSessionByToken, createAccessToken } from '../storage/token-store.js';
import { isRevokedTokenError, clearRevokedSession, createRevokedTokenResponse } from './oauth-errors.js';

const WEEK_IN_MS = 7 * 24 * 60 * 60 * 1000;

// Build WWW-Authenticate header with resource_metadata for MCP OAuth discovery
function getWwwAuthenticateHeader(request: FastifyRequest): string {
  const proto = request.headers['x-forwarded-proto'] || 'http';
  const host = request.headers['x-forwarded-host'] || request.headers.host || 'localhost:3000';
  const baseUrl = `${proto}://${host}`;
  return `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`;
}

export interface UserContext {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  email: string;
  sessionId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    userContext?: UserContext;
  }
}

export { createAccessToken };

export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  // Check for Bearer token first (for Cursor/MCP clients)
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const session = await getSessionByToken(token);

    if (session) {
      request.userContext = {
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        expiresAt: session.expiresAt,
        email: session.email,
        sessionId: session.sessionId
      };
      return;
    }

    reply
      .code(401)
      .header('WWW-Authenticate', getWwwAuthenticateHeader(request))
      .send({
        error: 'invalid_token',
        message: 'Invalid or expired access token'
      });
    return;
  }

  // Fall back to session cookie auth
  const accessToken = request.session.get('access_token') as string | undefined;
  const refreshToken = request.session.get('refresh_token') as string | undefined;
  const expiresAt = request.session.get('expires_at') as number | undefined;
  const authenticatedAt = request.session.get('authenticated_at') as number | undefined;
  const email = request.session.get('email') as string | undefined;

  if (!accessToken || !authenticatedAt || !email) {
    reply
      .code(401)
      .header('WWW-Authenticate', getWwwAuthenticateHeader(request))
      .send({
        error: 'authentication_required',
        message: 'Please authenticate at /auth/login'
      });
    return;
  }

  if (expiresAt && Date.now() >= expiresAt) {
    reply
      .code(401)
      .header('WWW-Authenticate', getWwwAuthenticateHeader(request))
      .send({
        error: 'token_expired',
        message: 'Access token expired. Please re-authenticate at /auth/login'
      });
    return;
  }

  if (Date.now() - authenticatedAt >= WEEK_IN_MS) {
    reply
      .code(401)
      .header('WWW-Authenticate', getWwwAuthenticateHeader(request))
      .send({
        error: 'reauthentication_required',
        message: 'Weekly re-authentication required. Please log in again at /auth/login'
      });
    return;
  }

  request.userContext = {
    accessToken,
    refreshToken,
    expiresAt,
    email,
    sessionId: request.session.sessionId
  };
}
