/**
 * Slack OAuth routes
 *
 * Handles Slack OAuth flow for connecting Slack accounts
 * after the user has already authenticated with Google.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'crypto';
import { DynamoDBClient, PutItemCommand, GetItemCommand, DeleteItemCommand } from '@aws-sdk/client-dynamodb';
import { SESSIONS_TABLE } from '../config/aws.js';
import { slackOAuthConfig, isSlackConfigured } from '../config/slack-oauth.js';
import { exchangeCodeForTokens } from '../slack/client.js';
import { addSlackTokens, removeSlackTokens, getSessionByToken } from '../storage/token-store.js';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const dynamodb = new DynamoDBClient({ region: AWS_REGION });

const STATE_EXPIRY_SECONDS = 600; // 10 minutes

function getBaseUrl(request: FastifyRequest): string {
  const proto = request.headers['x-forwarded-proto'] || 'http';
  const host = request.headers['x-forwarded-host'] || request.headers.host || 'localhost:3000';
  return `${proto}://${host}`;
}

async function storeSlackState(
  state: string,
  data: { bearerToken: string; email: string; redirectUri: string }
): Promise<void> {
  const expiresAt = Math.floor(Date.now() / 1000) + STATE_EXPIRY_SECONDS;

  await dynamodb.send(new PutItemCommand({
    TableName: SESSIONS_TABLE,
    Item: {
      sessionId: { S: `SLACK_STATE#${state}` },
      bearerToken: { S: data.bearerToken },
      email: { S: data.email },
      redirectUri: { S: data.redirectUri },
      expiresAt: { N: String(expiresAt) },
      ttl: { N: String(expiresAt) }
    }
  }));
}

async function getSlackState(state: string): Promise<{
  bearerToken: string;
  email: string;
  redirectUri: string;
} | null> {
  const result = await dynamodb.send(new GetItemCommand({
    TableName: SESSIONS_TABLE,
    Key: { sessionId: { S: `SLACK_STATE#${state}` } }
  }));

  if (!result.Item || !result.Item.bearerToken?.S) return null;

  return {
    bearerToken: result.Item.bearerToken.S,
    email: result.Item.email?.S || '',
    redirectUri: result.Item.redirectUri?.S || '',
  };
}

async function deleteSlackState(state: string): Promise<void> {
  await dynamodb.send(new DeleteItemCommand({
    TableName: SESSIONS_TABLE,
    Key: { sessionId: { S: `SLACK_STATE#${state}` } }
  }));
}

export async function slackOAuthRoutes(app: FastifyInstance): Promise<void> {
  if (!isSlackConfigured()) {
    console.log('[Slack] OAuth not configured - SLACK_CLIENT_ID or SLACK_CLIENT_SECRET missing');

    app.get('/auth/slack', async (request, reply) => {
      return reply.code(501).send({
        error: 'slack_not_configured',
        message: 'Slack OAuth is not configured on this server'
      });
    });

    app.get('/auth/slack/callback', async (request, reply) => {
      return reply.code(501).send({
        error: 'slack_not_configured',
        message: 'Slack OAuth is not configured on this server'
      });
    });

    return;
  }

  console.log('[Slack] OAuth routes registered');

  // GET /auth/slack - Initiate Slack OAuth flow
  app.get('/auth/slack', async (request: FastifyRequest<{
    Querystring: { connect_token?: string }
  }>, reply: FastifyReply) => {
    let email: string;
    let bearerToken: string | undefined;

    const connectToken = request.query.connect_token;
    if (connectToken) {
      const result = await dynamodb.send(new GetItemCommand({
        TableName: SESSIONS_TABLE,
        Key: { sessionId: { S: `SLACK_CONNECT#${connectToken}` } }
      }));

      if (!result.Item || !result.Item.bearerToken?.S) {
        return reply.code(401).send({
          error: 'invalid_token',
          message: 'Invalid or expired connection link. Please generate a new one using the slack_connect tool.'
        });
      }

      await dynamodb.send(new DeleteItemCommand({
        TableName: SESSIONS_TABLE,
        Key: { sessionId: { S: `SLACK_CONNECT#${connectToken}` } }
      }));

      bearerToken = result.Item.bearerToken.S;
    } else {
      const authHeader = request.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        return reply.code(401).send({
          error: 'unauthorized',
          message: 'Use the slack_connect MCP tool to get a connection URL'
        });
      }
      bearerToken = authHeader.slice(7);
    }

    const session = await getSessionByToken(bearerToken);
    if (!session) {
      return reply.code(401).send({
        error: 'invalid_token',
        message: 'Invalid or expired Bearer token. Please re-authenticate with the MCP gateway.'
      });
    }

    email = session.email;

    if (session.slackAccessToken) {
      return reply.code(400).send({
        error: 'already_connected',
        message: 'Slack is already connected. Use /auth/slack/disconnect to remove it first.',
        slackTeamId: session.slackTeamId
      });
    }

    const state = crypto.randomBytes(32).toString('hex');
    const baseUrl = getBaseUrl(request);
    const redirectUri = slackOAuthConfig.redirectUri || `${baseUrl}/auth/slack/callback`;

    await storeSlackState(state, { bearerToken, email, redirectUri });

    // Build Slack authorization URL
    const authUrl = new URL(slackOAuthConfig.authorizationUrl);
    authUrl.searchParams.set('client_id', slackOAuthConfig.clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('user_scope', slackOAuthConfig.userScopes.join(','));

    // Restrict to specific team if configured
    if (slackOAuthConfig.teamId) {
      authUrl.searchParams.set('team', slackOAuthConfig.teamId);
    }

    console.log(`[Slack] Initiating OAuth for ${email}, state=${state.substring(0, 10)}...`);

    return reply.redirect(authUrl.toString());
  });

  // GET /auth/slack/callback - Handle Slack OAuth callback
  app.get('/auth/slack/callback', async (request: FastifyRequest<{
    Querystring: { code?: string; state?: string; error?: string }
  }>, reply: FastifyReply) => {
    const { code, state, error } = request.query;

    if (error) {
      console.error(`[Slack] OAuth error: ${error}`);
      return reply.type('text/html').send(getErrorPage('Slack Connection Failed', error));
    }

    if (!state || !code) {
      return reply.type('text/html').send(getErrorPage('Invalid Request', 'Missing state or code parameter'));
    }

    const storedState = await getSlackState(state);
    if (!storedState) {
      return reply.type('text/html').send(getErrorPage('Session Expired', 'Please try connecting Slack again'));
    }

    try {
      const tokens = await exchangeCodeForTokens(code, storedState.redirectUri);

      console.log(`[Slack] Token exchange successful for ${storedState.email}, team: ${tokens.teamName} (${tokens.teamId})`);

      await addSlackTokens(
        storedState.bearerToken,
        tokens.accessToken,
        tokens.teamId,
        tokens.teamName,
        tokens.userId
      );

      await deleteSlackState(state);

      // Show success page
      return reply.type('text/html').send(getSuccessPage(storedState.email, tokens.teamName));

    } catch (err) {
      console.error('[Slack] Token exchange failed:', err);
      await deleteSlackState(state);
      const message = err instanceof Error ? err.message : 'Token exchange failed';
      return reply.type('text/html').send(getErrorPage('Connection Failed', message));
    }
  });

  // POST /auth/slack/disconnect - Disconnect Slack
  app.post('/auth/slack/disconnect', async (request: FastifyRequest, reply: FastifyReply) => {
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

    if (!session.slackAccessToken) {
      return reply.code(400).send({
        error: 'not_connected',
        message: 'Slack is not connected'
      });
    }

    try {
      await removeSlackTokens(bearerToken);
      console.log(`[Slack] Disconnected for ${session.email}`);

      return reply.send({
        success: true,
        message: 'Slack disconnected successfully'
      });
    } catch (err) {
      console.error('[Slack] Disconnect failed:', err);
      return reply.code(500).send({
        error: 'disconnect_failed',
        message: 'Failed to disconnect Slack'
      });
    }
  });

  // GET /auth/slack/status - Check Slack connection status
  app.get('/auth/slack/status', async (request: FastifyRequest, reply: FastifyReply) => {
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
      connected: !!session.slackAccessToken,
      teamId: session.slackTeamId || null,
      teamName: session.slackTeamName || null,
      connectedAt: session.slackConnectedAt ? new Date(session.slackConnectedAt).toISOString() : null,
      connectUrl: `${baseUrl}/auth/slack`
    });
  });
}

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
      cursor: pointer;
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
    <button class="btn" onclick="window.close()">Close Window</button>
  </div>
</body>
</html>`;
}

function getSuccessPage(email: string, teamName: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Slack Connected</title>
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
    .success-icon {
      width: 64px;
      height: 64px;
      margin-bottom: 24px;
    }
    h1 {
      font-size: 24px;
      font-weight: 600;
      margin-bottom: 12px;
      color: #4CAF50;
    }
    p {
      color: rgba(255, 255, 255, 0.7);
      line-height: 1.6;
      margin-bottom: 16px;
    }
    .team-name {
      color: #E01E5A;
      font-weight: 600;
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
      cursor: pointer;
      margin-top: 16px;
    }
    .btn:hover {
      background: rgba(255, 255, 255, 0.15);
    }
  </style>
</head>
<body>
  <div class="container">
    <svg class="success-icon" viewBox="0 0 24 24" fill="none" stroke="#4CAF50" stroke-width="2">
      <circle cx="12" cy="12" r="10"/>
      <path d="M9 12l2 2 4-4"/>
    </svg>
    <h1>Slack Connected!</h1>
    <p>Successfully connected to workspace <span class="team-name">${teamName}</span></p>
    <p>You can now use Slack tools in your MCP client.</p>
    <button class="btn" onclick="window.close()">Close Window</button>
  </div>
</body>
</html>`;
}
