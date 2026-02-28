/**
 * HubSpot OAuth routes
 *
 * Handles HubSpot OAuth flow for connecting HubSpot accounts
 * after the user has already authenticated with Google.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'crypto';
import { DynamoDBClient, PutItemCommand, GetItemCommand, DeleteItemCommand } from '@aws-sdk/client-dynamodb';
import { SESSIONS_TABLE } from '../config/aws.js';
import { hubspotOAuthConfig, isHubSpotConfigured } from '../config/hubspot-oauth.js';
import { exchangeCodeForTokens } from '../hubspot/client.js';
import { addHubSpotTokens, removeHubSpotTokens, getSessionByToken } from '../storage/token-store.js';
import { requireAuth } from '../auth/middleware.js';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const dynamodb = new DynamoDBClient({ region: AWS_REGION });

const STATE_EXPIRY_SECONDS = 600; // 10 minutes

// Get base URL from request headers
function getBaseUrl(request: FastifyRequest): string {
  const proto = request.headers['x-forwarded-proto'] || 'http';
  const host = request.headers['x-forwarded-host'] || request.headers.host || 'localhost:3000';
  return `${proto}://${host}`;
}

// Generate PKCE code verifier and challenge
function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  // Generate random code verifier (43-128 chars, URL-safe)
  const codeVerifier = crypto.randomBytes(32).toString('base64url');

  // Generate code challenge using SHA256
  const codeChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');

  return { codeVerifier, codeChallenge };
}

// Store OAuth state in DynamoDB
async function storeHubSpotState(
  state: string,
  data: { bearerToken: string; email: string; redirectUri: string; codeVerifier: string }
): Promise<void> {
  const expiresAt = Math.floor(Date.now() / 1000) + STATE_EXPIRY_SECONDS;

  await dynamodb.send(new PutItemCommand({
    TableName: SESSIONS_TABLE,
    Item: {
      sessionId: { S: `HUBSPOT_STATE#${state}` },
      bearerToken: { S: data.bearerToken },
      email: { S: data.email },
      redirectUri: { S: data.redirectUri },
      codeVerifier: { S: data.codeVerifier },
      expiresAt: { N: String(expiresAt) },
      ttl: { N: String(expiresAt) }
    }
  }));
}

// Get OAuth state from DynamoDB
async function getHubSpotState(state: string): Promise<{
  bearerToken: string;
  email: string;
  redirectUri: string;
  codeVerifier: string;
} | null> {
  const result = await dynamodb.send(new GetItemCommand({
    TableName: SESSIONS_TABLE,
    Key: { sessionId: { S: `HUBSPOT_STATE#${state}` } }
  }));

  if (!result.Item) return null;

  return {
    bearerToken: result.Item.bearerToken?.S || '',
    email: result.Item.email?.S || '',
    redirectUri: result.Item.redirectUri?.S || '',
    codeVerifier: result.Item.codeVerifier?.S || '',
  };
}

// Delete OAuth state
async function deleteHubSpotState(state: string): Promise<void> {
  await dynamodb.send(new DeleteItemCommand({
    TableName: SESSIONS_TABLE,
    Key: { sessionId: { S: `HUBSPOT_STATE#${state}` } }
  }));
}

export async function hubspotOAuthRoutes(app: FastifyInstance): Promise<void> {
  // Check if HubSpot is configured
  if (!isHubSpotConfigured()) {
    console.log('[HubSpot] OAuth not configured - HUBSPOT_CLIENT_ID or HUBSPOT_CLIENT_SECRET missing');

    // Register stub routes that return helpful errors
    app.get('/auth/hubspot', async (request, reply) => {
      return reply.code(501).send({
        error: 'hubspot_not_configured',
        message: 'HubSpot OAuth is not configured on this server'
      });
    });

    app.get('/auth/hubspot/callback', async (request, reply) => {
      return reply.code(501).send({
        error: 'hubspot_not_configured',
        message: 'HubSpot OAuth is not configured on this server'
      });
    });

    return;
  }

  console.log('[HubSpot] OAuth routes registered');

  // GET /auth/hubspot - Initiate HubSpot OAuth flow
  // Requires valid Bearer token (user must be authenticated with Google first)
  app.get('/auth/hubspot', async (request: FastifyRequest, reply: FastifyReply) => {
    // Get Bearer token from header
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return reply.code(401).send({
        error: 'unauthorized',
        message: 'Bearer token required. Please authenticate with Google first.'
      });
    }

    const bearerToken = authHeader.slice(7);
    const session = await getSessionByToken(bearerToken);

    if (!session) {
      return reply.code(401).send({
        error: 'invalid_token',
        message: 'Invalid or expired Bearer token. Please re-authenticate.'
      });
    }

    // Check if already connected
    if (session.hubspotAccessToken) {
      return reply.code(400).send({
        error: 'already_connected',
        message: 'HubSpot is already connected. Use /auth/hubspot/disconnect to remove it first.',
        hubspotPortalId: session.hubspotPortalId
      });
    }

    // Generate state for CSRF protection and PKCE
    const state = crypto.randomBytes(32).toString('hex');
    const { codeVerifier, codeChallenge } = generatePKCE();
    const baseUrl = getBaseUrl(request);
    const redirectUri = hubspotOAuthConfig.redirectUri || `${baseUrl}/auth/hubspot/callback`;

    // Store state with bearer token and PKCE verifier for callback
    await storeHubSpotState(state, {
      bearerToken,
      email: session.email,
      redirectUri,
      codeVerifier
    });

    // Build HubSpot authorization URL with PKCE
    const authUrl = new URL(hubspotOAuthConfig.authorizationUrl);
    authUrl.searchParams.set('client_id', hubspotOAuthConfig.clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('state', state);
    // PKCE parameters (required for MCP Auth Apps)
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');

    // Only add scopes if configured (MCP Auth Apps don't need them in URL)
    if (hubspotOAuthConfig.scopes.length > 0) {
      authUrl.searchParams.set('scope', hubspotOAuthConfig.scopes.join(' '));
    }

    console.log(`[HubSpot] Initiating OAuth for ${session.email}, state=${state.substring(0, 10)}...`);

    return reply.redirect(authUrl.toString());
  });

  // GET /auth/hubspot/callback - Handle HubSpot OAuth callback
  app.get('/auth/hubspot/callback', async (request: FastifyRequest<{
    Querystring: { code?: string; state?: string; error?: string; error_description?: string }
  }>, reply: FastifyReply) => {
    const { code, state, error, error_description } = request.query;

    if (error) {
      console.error(`[HubSpot] OAuth error: ${error} - ${error_description}`);
      return reply.type('text/html').send(getErrorPage('HubSpot Connection Failed', error_description || error));
    }

    if (!state || !code) {
      return reply.type('text/html').send(getErrorPage('Invalid Request', 'Missing state or code parameter'));
    }

    // Get stored state
    const storedState = await getHubSpotState(state);
    if (!storedState) {
      return reply.type('text/html').send(getErrorPage('Session Expired', 'Please try connecting HubSpot again'));
    }

    try {
      // Exchange code for tokens (with PKCE code_verifier)
      const tokens = await exchangeCodeForTokens(code, storedState.redirectUri, storedState.codeVerifier);

      console.log(`[HubSpot] Token exchange successful for ${storedState.email}, portal: ${tokens.portalId}`);

      // Add HubSpot tokens to the Bearer token record
      await addHubSpotTokens(
        storedState.bearerToken,
        tokens.accessToken,
        tokens.refreshToken,
        tokens.expiresAt,
        tokens.portalId
      );

      // Clean up state
      await deleteHubSpotState(state);

      // Show success page
      const htmlPath = join(__dirname, '../views/hubspot-success.html');
      let html = await readFile(htmlPath, 'utf-8');
      html = html.replace('{{email}}', storedState.email);
      html = html.replace('{{portalId}}', tokens.portalId || 'Unknown');
      return reply.type('text/html').send(html);

    } catch (err) {
      console.error('[HubSpot] Token exchange failed:', err);
      await deleteHubSpotState(state);
      const message = err instanceof Error ? err.message : 'Token exchange failed';
      return reply.type('text/html').send(getErrorPage('Connection Failed', message));
    }
  });

  // POST /auth/hubspot/disconnect - Disconnect HubSpot
  app.post('/auth/hubspot/disconnect', async (request: FastifyRequest, reply: FastifyReply) => {
    // Get Bearer token from header
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return reply.code(401).send({
        error: 'unauthorized',
        message: 'Bearer token required'
      });
    }

    const bearerToken = authHeader.slice(7);
    const session = await getSessionByToken(bearerToken);

    if (!session) {
      return reply.code(401).send({
        error: 'invalid_token',
        message: 'Invalid or expired Bearer token'
      });
    }

    if (!session.hubspotAccessToken) {
      return reply.code(400).send({
        error: 'not_connected',
        message: 'HubSpot is not connected'
      });
    }

    try {
      await removeHubSpotTokens(bearerToken);
      console.log(`[HubSpot] Disconnected for ${session.email}`);

      return reply.send({
        success: true,
        message: 'HubSpot disconnected successfully'
      });
    } catch (err) {
      console.error('[HubSpot] Disconnect failed:', err);
      return reply.code(500).send({
        error: 'disconnect_failed',
        message: 'Failed to disconnect HubSpot'
      });
    }
  });

  // GET /auth/hubspot/status - Check HubSpot connection status
  app.get('/auth/hubspot/status', async (request: FastifyRequest, reply: FastifyReply) => {
    // Get Bearer token from header
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return reply.code(401).send({
        error: 'unauthorized',
        message: 'Bearer token required'
      });
    }

    const bearerToken = authHeader.slice(7);
    const session = await getSessionByToken(bearerToken);

    if (!session) {
      return reply.code(401).send({
        error: 'invalid_token',
        message: 'Invalid or expired Bearer token'
      });
    }

    const baseUrl = getBaseUrl(request);

    return reply.send({
      connected: !!session.hubspotAccessToken,
      portalId: session.hubspotPortalId || null,
      connectedAt: session.hubspotConnectedAt ? new Date(session.hubspotConnectedAt).toISOString() : null,
      connectUrl: `${baseUrl}/auth/hubspot`
    });
  });
}

// Error page HTML
function getErrorPage(title: string, message: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <title>${title}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      color: #fff;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      background: rgba(255, 255, 255, 0.05);
      backdrop-filter: blur(10px);
      border-radius: 24px;
      padding: 48px;
      max-width: 480px;
      width: 100%;
      text-align: center;
      border: 1px solid rgba(255, 255, 255, 0.1);
    }
    .error-icon {
      width: 64px;
      height: 64px;
      margin-bottom: 24px;
    }
    h1 {
      font-size: 24px;
      font-weight: 600;
      margin-bottom: 12px;
      color: #ff6b6b;
    }
    p {
      color: rgba(255, 255, 255, 0.7);
      line-height: 1.6;
      margin-bottom: 32px;
    }
    .btn {
      display: inline-block;
      padding: 14px 28px;
      background: rgba(255, 255, 255, 0.1);
      color: #fff;
      text-decoration: none;
      border-radius: 12px;
      font-weight: 500;
      transition: all 0.2s;
      border: 1px solid rgba(255, 255, 255, 0.2);
    }
    .btn:hover {
      background: rgba(255, 255, 255, 0.15);
    }
  </style>
</head>
<body>
  <div class="container">
    <svg class="error-icon" viewBox="0 0 24 24" fill="none" stroke="#ff6b6b" stroke-width="2">
      <circle cx="12" cy="12" r="10"/>
      <line x1="15" y1="9" x2="9" y2="15"/>
      <line x1="9" y1="9" x2="15" y2="15"/>
    </svg>
    <h1>${title}</h1>
    <p>${message}</p>
    <a href="javascript:window.close()" class="btn">Close Window</a>
  </div>
</body>
</html>`;
}
