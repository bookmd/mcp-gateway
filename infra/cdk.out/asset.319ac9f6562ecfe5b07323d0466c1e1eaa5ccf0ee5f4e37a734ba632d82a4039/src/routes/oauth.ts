import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createAuthUrl, handleCallback, initOAuthClient } from '../auth/oauth-client.js';
import { createAccessToken } from '../auth/middleware.js';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

declare module 'fastify' {
  interface Session {
    oauth_code_verifier?: string;
    oauth_state?: string;
    oauth_nonce?: string;
    oauth_pending?: string;
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    expires_at?: number;
    authenticated_at?: number;
    email?: string;
    hd?: string;
  }
}

export async function oauthRoutes(app: FastifyInstance): Promise<void> {
  await initOAuthClient();

  // GET /auth/login - Show fancy login page
  app.get('/auth/login', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const htmlPath = join(__dirname, '../views/login.html');
      const html = await readFile(htmlPath, 'utf-8');
      return reply.type('text/html').send(html);
    } catch (error) {
      console.error('[OAuth] Failed to load login.html:', error);
      // Fallback to direct redirect if HTML fails to load
      const { codeVerifier, state, nonce, authUrl } = createAuthUrl();
      request.session.set('oauth_code_verifier', codeVerifier);
      request.session.set('oauth_state', state);
      request.session.set('oauth_nonce', nonce);
      return reply.redirect(authUrl);
    }
  });

  // GET /auth/google - Actual Google OAuth redirect
  app.get('/auth/google', async (request: FastifyRequest, reply: FastifyReply) => {
    const { codeVerifier, state, nonce, authUrl } = createAuthUrl();

    request.session.set('oauth_code_verifier', codeVerifier);
    request.session.set('oauth_state', state);
    request.session.set('oauth_nonce', nonce);

    return reply.redirect(authUrl);
  });

  app.get('/auth/callback', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const params = new URLSearchParams(request.url.split('?')[1]);
      const googleState = params.get('state');

      if (!googleState) {
        return reply.code(400).send({ error: 'Missing state parameter' });
      }

      // First, check if this is an MCP OAuth callback (state in DynamoDB)
      // Import the DynamoDB check from mcp-oauth routes
      const { getOAuthState, storeAuthCode, deleteOAuthState } = await import('./mcp-oauth.js');
      
      const mcpState = await getOAuthState(googleState);
      
      if (mcpState && mcpState.clientId) {
        // This is an MCP OAuth callback - delegate to MCP handler logic
        console.log('[OAuth] Detected MCP OAuth callback in /auth/callback');
        
        // Exchange code with Google using MCP state
        const result = await handleCallback(params, {
          codeVerifier: mcpState.codeVerifier,
          state: googleState,
          nonce: mcpState.nonce
        });

        console.log(`[OAuth] MCP: Google auth successful for: ${result.email}`);

        // Generate authorization code for the MCP client
        const crypto = await import('crypto');
        const authCode = crypto.randomBytes(32).toString('base64url');

        // Store auth code with user data (including Google token expiry for refresh)
        await storeAuthCode(authCode, {
          userId: result.email,
          email: result.email,
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          googleTokenExpiresAt: result.expiresAt,  // Pass Google token expiry
          clientId: mcpState.clientId,
          redirectUri: mcpState.redirectUri,
          codeChallenge: mcpState.codeChallenge,
          scope: mcpState.scope
        });

        // Get client state for redirect
        const { DynamoDBClient, GetItemCommand, DeleteItemCommand } = await import('@aws-sdk/client-dynamodb');
        const { SESSIONS_TABLE } = await import('../config/aws.js');
        const dynamodb = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' });
        
        let clientState = '';
        try {
          const result2 = await dynamodb.send(new GetItemCommand({
            TableName: SESSIONS_TABLE,
            Key: { sessionId: { S: `CLIENT_STATE_REVERSE#${googleState}` } }
          }));
          clientState = result2.Item?.clientState?.S || '';
        } catch (error) {
          console.error('[OAuth] Failed to retrieve client state:', error);
        }

        // Clean up state
        await deleteOAuthState(googleState);
        if (clientState) {
          await deleteOAuthState(`CLIENT_STATE#${clientState}`);
          await dynamodb.send(new DeleteItemCommand({
            TableName: SESSIONS_TABLE,
            Key: { sessionId: { S: `CLIENT_STATE_REVERSE#${googleState}` } }
          }));
        }

        // Build redirect URL back to client
        const redirectUrl = new URL(mcpState.redirectUri);
        redirectUrl.searchParams.set('code', authCode);
        if (clientState) {
          redirectUrl.searchParams.set('state', clientState);
        }

        console.log(`[OAuth] MCP: Showing success page with redirect to client with state=${clientState?.substring(0, 10)}...`);
        
        // Show success page with auto-redirect to cursor:// URL
        const htmlPath = join(__dirname, '../views/mcp-success.html');
        let html = await readFile(htmlPath, 'utf-8');
        html = html.replace('{{redirectUrl}}', redirectUrl.toString());
        return reply.type('text/html').send(html);
      }

      // Otherwise, this is a browser OAuth callback (state in session)
      const stored = {
        codeVerifier: request.session.get('oauth_code_verifier') as string,
        state: request.session.get('oauth_state') as string,
        nonce: request.session.get('oauth_nonce') as string
      };

      if (!stored.codeVerifier || !stored.state) {
        return reply.code(400).send({ error: 'Invalid session state' });
      }

      const result = await handleCallback(params, stored);

      await request.session.regenerate();

      request.session.set('access_token', result.accessToken);
      request.session.set('refresh_token', result.refreshToken);
      request.session.set('id_token', result.idToken);
      request.session.set('expires_at', result.expiresAt);
      request.session.set('authenticated_at', Date.now());
      request.session.set('email', result.email);
      request.session.set('hd', result.hd);

      request.session.set('oauth_code_verifier', undefined);
      request.session.set('oauth_state', undefined);
      request.session.set('oauth_nonce', undefined);

      // Show fancy success page
      const htmlPath = join(__dirname, '../views/success.html');
      let html = await readFile(htmlPath, 'utf-8');
      html = html.replace('{{email}}', result.email);
      return reply.type('text/html').send(html);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Authentication failed';
      console.error('[OAuth] Callback error:', error);
      return reply.code(401).send({ error: message });
    }
  });

  app.get('/auth/status', async (request: FastifyRequest, reply: FastifyReply) => {
    const email = request.session.get('email');
    const authenticatedAt = request.session.get('authenticated_at') as number | undefined;
    const expiresAt = request.session.get('expires_at') as number | undefined;

    if (!email || !authenticatedAt) {
      return reply.send({ authenticated: false });
    }

    const weekInMs = 7 * 24 * 60 * 60 * 1000;
    const weeklyExpired = Date.now() - authenticatedAt >= weekInMs;
    const tokenExpired = expiresAt ? Date.now() >= expiresAt : true;

    return reply.send({
      authenticated: !weeklyExpired && !tokenExpired,
      email,
      authenticatedAt: new Date(authenticatedAt).toISOString(),
      weeklyExpiresAt: new Date(authenticatedAt + weekInMs).toISOString(),
      tokenExpiresAt: expiresAt ? new Date(expiresAt).toISOString() : null
    });
  });

  app.post('/auth/logout', async (request: FastifyRequest, reply: FastifyReply) => {
    await request.session.destroy();
    return reply.send({ success: true });
  });

  // GET /auth/token - Get a Bearer token for Cursor/MCP clients
  // Must be authenticated via browser first
  app.get('/auth/token', async (request: FastifyRequest, reply: FastifyReply) => {
    const accessToken = request.session.get('access_token') as string | undefined;
    const refreshToken = request.session.get('refresh_token') as string | undefined;
    const email = request.session.get('email') as string | undefined;

    if (!accessToken || !email) {
      return reply.code(401).send({
        error: 'authentication_required',
        message: 'Please authenticate at /auth/login first'
      });
    }

    const token = await createAccessToken(
      accessToken,
      refreshToken,
      email,
      request.session.sessionId
    );

    return reply.send({
      token,
      email,
      expiresIn: '7 days',
      usage: {
        header: `Authorization: Bearer ${token}`,
        cursorConfig: {
          mcpServers: {
            'google-workspace': {
              url: 'http://mcp-gateway.vim-corp.com/mcp/sse',
              headers: {
                Authorization: `Bearer ${token}`
              }
            }
          }
        }
      }
    });
  });
}
