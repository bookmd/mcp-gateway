import { FastifyRequest, FastifyReply } from 'fastify';
import { getSessionByToken, createAccessToken, updateBearerTokenRecord } from '../storage/token-store.js';
import { isRevokedTokenError, clearRevokedSession, createRevokedTokenResponse } from './oauth-errors.js';
import { ensureTokenFreshness } from './token-refresh-middleware.js';

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
      // Create userContext first
      request.userContext = {
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        expiresAt: session.expiresAt,
        email: session.email,
        sessionId: session.sessionId
      };

      // Check if Google access token needs refresh (same logic as session cookie flow)
      const now = Date.now();
      const timeUntilExpiry = session.expiresAt ? session.expiresAt - now : null;
      const minutesUntilExpiry = timeUntilExpiry ? Math.floor(timeUntilExpiry / 60000) : null;

      // Debug log to trace token expiry (remove after verification)
      console.log(`[Auth] Bearer token check: email=${session.email}, googleTokenExpiry=${session.expiresAt ? new Date(session.expiresAt).toISOString() : 'not set'}, minutesUntilExpiry=${minutesUntilExpiry}, hasRefreshToken=${!!session.refreshToken}`);

      if (session.expiresAt && session.refreshToken &&
          (now >= session.expiresAt || (timeUntilExpiry && timeUntilExpiry < 5 * 60 * 1000))) {
        const minutesUntilExpiry = timeUntilExpiry ? Math.floor(timeUntilExpiry / 60000) : 'expired';
        console.log(`[Auth] Bearer token needs refresh: ${minutesUntilExpiry}min remaining, attempting...`);

        const refreshed = await ensureTokenFreshness(request.userContext);

        if (refreshed) {
          // Update the Bearer token record in DynamoDB with refreshed tokens
          try {
            await updateBearerTokenRecord(
              token,
              request.userContext.accessToken,
              request.userContext.refreshToken,
              request.userContext.expiresAt
            );
            console.log(`[Auth] Bearer token refreshed successfully, new expiry: ${request.userContext.expiresAt ? new Date(request.userContext.expiresAt).toISOString() : 'unknown'}`);
          } catch (updateError) {
            // Log but don't fail - the in-memory context has fresh tokens
            console.error(`[Auth] Failed to persist refreshed Bearer tokens:`, updateError);
          }
        } else {
          console.log(`[Auth] Bearer token refresh failed or not attempted`);
        }
      }

      // Re-check expiry after potential refresh
      if (request.userContext.expiresAt && now >= request.userContext.expiresAt) {
        console.log(`[Auth] Bearer token still expired after refresh attempt, returning 401`);
        reply
          .code(401)
          .header('WWW-Authenticate', getWwwAuthenticateHeader(request))
          .send({
            error: 'token_expired',
            message: 'Access token expired and refresh failed. Please re-authenticate.'
          });
        return;
      }

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
  let accessToken = request.session.get('access_token') as string | undefined;
  let refreshToken = request.session.get('refresh_token') as string | undefined;
  let expiresAt = request.session.get('expires_at') as number | undefined;
  const authenticatedAt = request.session.get('authenticated_at') as number | undefined;
  const email = request.session.get('email') as string | undefined;

  if (!accessToken || !authenticatedAt || !email) {
    console.log(`[Auth] Missing credentials: accessToken=${!!accessToken}, authenticatedAt=${!!authenticatedAt}, email=${!!email}`);
    reply
      .code(401)
      .header('WWW-Authenticate', getWwwAuthenticateHeader(request))
      .send({
        error: 'authentication_required',
        message: 'Please authenticate at /auth/login'
      });
    return;
  }

  const now = Date.now();
  const timeUntilExpiry = expiresAt ? expiresAt - now : null;
  const minutesUntilExpiry = timeUntilExpiry ? Math.floor(timeUntilExpiry / 60000) : null;
  
  // Try to refresh token if expired or expiring soon
  if (expiresAt && refreshToken && (now >= expiresAt || (timeUntilExpiry && timeUntilExpiry < 5 * 60 * 1000))) {
    console.log(`[Auth] Token needs refresh: ${minutesUntilExpiry}min remaining, attempting refresh...`);
    
    // Create temporary UserContext for refresh
    const tempUserContext = {
      accessToken,
      refreshToken,
      expiresAt,
      email,
      sessionId: request.session.sessionId
    };
    
    const refreshed = await ensureTokenFreshness(tempUserContext);
    
    if (refreshed) {
      // Update local variables with refreshed tokens
      accessToken = tempUserContext.accessToken;
      refreshToken = tempUserContext.refreshToken;
      expiresAt = tempUserContext.expiresAt;
      
      // Update session storage with refreshed tokens
      request.session.set('access_token', accessToken);
      if (refreshToken) {
        request.session.set('refresh_token', refreshToken);
      }
      if (expiresAt) {
        request.session.set('expires_at', expiresAt);
      }
      
      console.log(`[Auth] Token successfully refreshed, new expiry: ${expiresAt ? new Date(expiresAt).toISOString() : 'unknown'}`);
    } else {
      console.log(`[Auth] Token refresh failed or not attempted`);
    }
  }
  
  // Re-check expiry after potential refresh
  if (expiresAt && now >= expiresAt) {
    console.log(`[Auth] Token expired: expiresAt=${new Date(expiresAt).toISOString()}, now=${new Date(now).toISOString()}, expired=${Math.floor((now - expiresAt) / 60000)}min ago, hasRefreshToken=${!!refreshToken}`);
    reply
      .code(401)
      .header('WWW-Authenticate', getWwwAuthenticateHeader(request))
      .send({
        error: 'token_expired',
        message: 'Access token expired. Please re-authenticate at /auth/login'
      });
    return;
  }

  if (expiresAt && minutesUntilExpiry !== null && minutesUntilExpiry < 10) {
    console.log(`[Auth] Token expiring soon: ${minutesUntilExpiry}min remaining, hasRefreshToken=${!!refreshToken}`);
  }

  const sessionAge = now - authenticatedAt;
  if (sessionAge >= WEEK_IN_MS) {
    console.log(`[Auth] Session too old: age=${Math.floor(sessionAge / 86400000)}days, limit=7days`);
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
