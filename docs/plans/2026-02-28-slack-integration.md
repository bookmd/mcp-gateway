# Slack Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Slack query tools (search messages, read channel history, list channels/users) to the MCP gateway using user token OAuth.

**Architecture:** Mirror the HubSpot integration pattern exactly. Create `src/slack/` with client, handlers, and types. Add OAuth routes at `/auth/slack/*`. Store Slack tokens in the existing TokenSession structure.

**Tech Stack:** TypeScript, Fastify, Slack Web API, DynamoDB with KMS encryption

---

## Task 1: Create Slack OAuth Config

**Files:**
- Create: `src/config/slack-oauth.ts`

**Step 1: Create the OAuth config file**

```typescript
/**
 * Slack OAuth configuration loaded from environment variables.
 */

function getEnvVar(name: string, defaultValue?: string): string {
  const value = process.env[name];
  if (!value) {
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    return '';
  }
  return value;
}

export const slackOAuthConfig = {
  clientId: getEnvVar('SLACK_CLIENT_ID'),
  clientSecret: getEnvVar('SLACK_CLIENT_SECRET'),
  redirectUri: getEnvVar('SLACK_REDIRECT_URI', 'https://mgw.ext.getvim.com/auth/slack/callback'),
  teamId: getEnvVar('SLACK_TEAM_ID'), // Optional: restrict to single workspace
  // Slack OAuth endpoints
  authorizationUrl: 'https://slack.com/oauth/v2/authorize',
  tokenUrl: 'https://slack.com/api/oauth.v2.access',
  // User token scopes (not bot scopes)
  userScopes: [
    'search:read',
    'channels:read',
    'channels:history',
    'groups:read',
    'groups:history',
    'im:read',
    'im:history',
    'mpim:read',
    'mpim:history',
    'users:read',
    'team:read'
  ]
} as const;

/**
 * Check if Slack OAuth is configured
 */
export function isSlackConfigured(): boolean {
  return !!(slackOAuthConfig.clientId && slackOAuthConfig.clientSecret);
}
```

**Step 2: Commit**

```bash
git add src/config/slack-oauth.ts
git commit -m "feat(slack): add Slack OAuth configuration"
```

---

## Task 2: Create Slack Types

**Files:**
- Create: `src/slack/types.ts`

**Step 1: Create types file**

```typescript
/**
 * Slack API types
 */

export interface SlackTokens {
  accessToken: string;
  teamId: string;
  teamName: string;
  userId: string;
  // Note: User tokens don't expire and don't have refresh tokens
}

export interface SlackUser {
  id: string;
  name: string;
  real_name?: string;
  profile?: {
    email?: string;
    display_name?: string;
    image_72?: string;
  };
  is_admin?: boolean;
  is_bot?: boolean;
  deleted?: boolean;
}

export interface SlackChannel {
  id: string;
  name: string;
  is_channel?: boolean;
  is_group?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
  is_archived?: boolean;
  is_member?: boolean;
  num_members?: number;
  topic?: { value: string };
  purpose?: { value: string };
}

export interface SlackMessage {
  type: string;
  ts: string;
  user?: string;
  text: string;
  channel?: string;
  permalink?: string;
  username?: string;
  attachments?: Array<{
    text?: string;
    fallback?: string;
  }>;
}

export interface SlackSearchResult {
  messages: {
    matches: SlackMessage[];
    total: number;
    pagination: {
      total_count: number;
      page: number;
      per_page: number;
      page_count: number;
    };
  };
}

export interface SlackConversationsHistoryResponse {
  ok: boolean;
  messages: SlackMessage[];
  has_more: boolean;
  response_metadata?: {
    next_cursor?: string;
  };
}

export interface SlackConversationsListResponse {
  ok: boolean;
  channels: SlackChannel[];
  response_metadata?: {
    next_cursor?: string;
  };
}

export interface SlackUsersListResponse {
  ok: boolean;
  members: SlackUser[];
  response_metadata?: {
    next_cursor?: string;
  };
}

export interface SlackApiError {
  ok: false;
  error: string;
}
```

**Step 2: Commit**

```bash
git add src/slack/types.ts
git commit -m "feat(slack): add Slack API types"
```

---

## Task 3: Create Slack API Client

**Files:**
- Create: `src/slack/client.ts`

**Step 1: Create the client**

```typescript
/**
 * Slack API client factory
 */

import { slackOAuthConfig } from '../config/slack-oauth.js';
import type { SlackTokens } from './types.js';

const SLACK_API_BASE = 'https://slack.com/api';

export interface SlackClient {
  get: <T>(method: string, params?: Record<string, string>) => Promise<T>;
  post: <T>(method: string, body?: Record<string, unknown>) => Promise<T>;
}

/**
 * Create a Slack API client with the given access token
 */
export function createSlackClient(accessToken: string): SlackClient {
  const makeRequest = async <T>(
    httpMethod: 'GET' | 'POST',
    slackMethod: string,
    options?: { params?: Record<string, string>; body?: Record<string, unknown> }
  ): Promise<T> => {
    let url = `${SLACK_API_BASE}/${slackMethod}`;

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${accessToken}`,
    };

    let body: string | undefined;

    if (httpMethod === 'GET' && options?.params) {
      const searchParams = new URLSearchParams(options.params);
      url += `?${searchParams.toString()}`;
    } else if (httpMethod === 'POST' && options?.body) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
      body = JSON.stringify(options.body);
    }

    const response = await fetch(url, {
      method: httpMethod,
      headers,
      body,
    });

    const data = await response.json() as T & { ok: boolean; error?: string };

    if (!data.ok) {
      throw new Error(`Slack API error: ${data.error || 'Unknown error'}`);
    }

    return data;
  };

  return {
    get: <T>(method: string, params?: Record<string, string>) =>
      makeRequest<T>('GET', method, { params }),
    post: <T>(method: string, body?: Record<string, unknown>) =>
      makeRequest<T>('POST', method, { body }),
  };
}

/**
 * Exchange authorization code for user token
 */
export async function exchangeCodeForTokens(code: string, redirectUri: string): Promise<SlackTokens> {
  const response = await fetch(slackOAuthConfig.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: slackOAuthConfig.clientId,
      client_secret: slackOAuthConfig.clientSecret,
      code,
      redirect_uri: redirectUri,
    }).toString(),
  });

  const data = await response.json() as {
    ok: boolean;
    error?: string;
    authed_user?: {
      id: string;
      access_token: string;
    };
    team?: {
      id: string;
      name: string;
    };
  };

  if (!data.ok) {
    throw new Error(`Slack token exchange failed: ${data.error}`);
  }

  if (!data.authed_user?.access_token) {
    throw new Error('Slack token exchange failed: no user token received');
  }

  return {
    accessToken: data.authed_user.access_token,
    teamId: data.team?.id || '',
    teamName: data.team?.name || '',
    userId: data.authed_user.id,
  };
}
```

**Step 2: Commit**

```bash
git add src/slack/client.ts
git commit -m "feat(slack): add Slack API client"
```

---

## Task 4: Extend Token Store for Slack

**Files:**
- Modify: `src/storage/token-store.ts`

**Step 1: Add Slack fields to TokenSession interface**

Find the `TokenSession` interface and add Slack fields:

```typescript
interface TokenSession {
  accessToken: string;
  refreshToken?: string;
  email: string;
  sessionId: string;
  expiresAt: number;
  // HubSpot tokens (optional)
  hubspotAccessToken?: string;
  hubspotRefreshToken?: string;
  hubspotTokenExpiresAt?: number;
  hubspotPortalId?: string;
  hubspotConnectedAt?: number;
  // Slack tokens (optional)
  slackAccessToken?: string;
  slackTeamId?: string;
  slackTeamName?: string;
  slackUserId?: string;
  slackConnectedAt?: number;
}
```

**Step 2: Update getSessionByToken to return Slack fields**

In the `getSessionByToken` function return statement, add:

```typescript
    return {
      // ... existing fields ...
      // Slack tokens
      slackAccessToken: tokenData.slackAccessToken,
      slackTeamId: tokenData.slackTeamId,
      slackTeamName: tokenData.slackTeamName,
      slackUserId: tokenData.slackUserId,
      slackConnectedAt: tokenData.slackConnectedAt,
    };
```

**Step 3: Add addSlackTokens function**

```typescript
/**
 * Add Slack tokens to an existing Bearer token record.
 * Called after user completes Slack OAuth flow.
 */
export async function addSlackTokens(
  bearerToken: string,
  slackAccessToken: string,
  slackTeamId: string,
  slackTeamName: string,
  slackUserId: string
): Promise<void> {
  try {
    const existing = await getSessionByToken(bearerToken);
    if (!existing) {
      throw new Error('Bearer token not found');
    }

    const tokenData = JSON.stringify({
      googleAccessToken: existing.accessToken,
      googleRefreshToken: existing.refreshToken,
      googleTokenExpiresAt: existing.expiresAt,
      // Preserve HubSpot tokens
      hubspotAccessToken: existing.hubspotAccessToken,
      hubspotRefreshToken: existing.hubspotRefreshToken,
      hubspotTokenExpiresAt: existing.hubspotTokenExpiresAt,
      hubspotPortalId: existing.hubspotPortalId,
      hubspotConnectedAt: existing.hubspotConnectedAt,
      // Add Slack tokens
      slackAccessToken,
      slackTeamId,
      slackTeamName,
      slackUserId,
      slackConnectedAt: Date.now(),
    });

    const encrypted = await encryptSessionData(tokenData);

    await dynamodb.send(new UpdateItemCommand({
      TableName: SESSIONS_TABLE,
      Key: {
        sessionId: { S: `TOKEN#${bearerToken}` }
      },
      UpdateExpression: 'SET encryptedData = :ed, encryptedKey = :ek, iv = :iv, authTag = :at',
      ExpressionAttributeValues: {
        ':ed': { S: encrypted.encryptedData },
        ':ek': { S: encrypted.encryptedKey },
        ':iv': { S: encrypted.iv },
        ':at': { S: encrypted.authTag }
      }
    }));

    console.log(`[TokenStore] Added Slack tokens, team: ${slackTeamName} (${slackTeamId})`);
  } catch (error) {
    console.error('[TokenStore] Failed to add Slack tokens:', error);
    throw error;
  }
}
```

**Step 4: Add removeSlackTokens function**

```typescript
/**
 * Remove Slack tokens from a Bearer token record.
 * Called when user disconnects Slack.
 */
export async function removeSlackTokens(bearerToken: string): Promise<void> {
  try {
    const existing = await getSessionByToken(bearerToken);
    if (!existing) {
      throw new Error('Bearer token not found');
    }

    const tokenData = JSON.stringify({
      googleAccessToken: existing.accessToken,
      googleRefreshToken: existing.refreshToken,
      googleTokenExpiresAt: existing.expiresAt,
      // Preserve HubSpot tokens
      hubspotAccessToken: existing.hubspotAccessToken,
      hubspotRefreshToken: existing.hubspotRefreshToken,
      hubspotTokenExpiresAt: existing.hubspotTokenExpiresAt,
      hubspotPortalId: existing.hubspotPortalId,
      hubspotConnectedAt: existing.hubspotConnectedAt,
      // Slack fields intentionally omitted
    });

    const encrypted = await encryptSessionData(tokenData);

    await dynamodb.send(new UpdateItemCommand({
      TableName: SESSIONS_TABLE,
      Key: {
        sessionId: { S: `TOKEN#${bearerToken}` }
      },
      UpdateExpression: 'SET encryptedData = :ed, encryptedKey = :ek, iv = :iv, authTag = :at',
      ExpressionAttributeValues: {
        ':ed': { S: encrypted.encryptedData },
        ':ek': { S: encrypted.encryptedKey },
        ':iv': { S: encrypted.iv },
        ':at': { S: encrypted.authTag }
      }
    }));

    console.log(`[TokenStore] Removed Slack tokens from Bearer token record`);
  } catch (error) {
    console.error('[TokenStore] Failed to remove Slack tokens:', error);
    throw error;
  }
}
```

**Step 5: Commit**

```bash
git add src/storage/token-store.ts
git commit -m "feat(slack): extend token store for Slack tokens"
```

---

## Task 5: Create Slack OAuth Routes

**Files:**
- Create: `src/routes/slack-oauth.ts`

**Step 1: Create the OAuth routes file**

```typescript
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
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
```

**Step 2: Commit**

```bash
git add src/routes/slack-oauth.ts
git commit -m "feat(slack): add Slack OAuth routes"
```

---

## Task 6: Create Slack MCP Tool Handlers

**Files:**
- Create: `src/slack/handlers.ts`

**Step 1: Create the handlers file**

```typescript
/**
 * Slack MCP tool handlers
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getUserContextBySessionId } from '../routes/sse.js';
import { createSlackClient } from './client.js';
import { getSessionByToken } from '../storage/token-store.js';
import { isSlackConfigured } from '../config/slack-oauth.js';
import type {
  SlackSearchResult,
  SlackConversationsHistoryResponse,
  SlackConversationsListResponse,
  SlackUsersListResponse
} from './types.js';

// Helper to get Slack client for user
async function getSlackClientForUser(sessionId: string): Promise<{
  client: ReturnType<typeof createSlackClient>;
  teamId?: string;
  teamName?: string;
} | { error: string }> {
  const userContext = sessionId ? getUserContextBySessionId(sessionId) : undefined;

  if (!userContext) {
    return { error: 'No user context available' };
  }

  const token = (userContext as any).bearerToken;
  if (!token) {
    return { error: 'Slack is not connected. Use the slack_connect tool to connect your Slack account.' };
  }

  const session = await getSessionByToken(token);
  if (!session) {
    return { error: 'Session not found' };
  }

  if (!session.slackAccessToken) {
    return {
      error: 'Slack is not connected. Use the slack_connect tool to get the connection URL.'
    };
  }

  return {
    client: createSlackClient(session.slackAccessToken),
    teamId: session.slackTeamId,
    teamName: session.slackTeamName
  };
}

function errorResponse(message: string) {
  return {
    content: [{ type: 'text' as const, text: `Error: ${message}` }],
    isError: true
  };
}

function successResponse(data: unknown) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify(data, null, 2)
    }]
  };
}

export function registerSlackHandlers(server: McpServer): void {
  if (!isSlackConfigured()) {
    console.log('[Slack] Handlers not registered - Slack not configured');
    return;
  }

  // ============================================================
  // Connection Management Tools
  // ============================================================

  server.registerTool('slack_status', {
    description: 'Check Slack connection status'
  }, async (extra: any) => {
    const sessionId = extra?.sessionId;
    const userContext = sessionId ? getUserContextBySessionId(sessionId) : undefined;

    if (!userContext) {
      return errorResponse('No user context available');
    }

    const token = (userContext as any).bearerToken;
    if (!token) {
      return successResponse({
        connected: false,
        message: 'Use slack_connect to get the connection URL'
      });
    }

    const session = await getSessionByToken(token);
    if (!session) {
      return successResponse({
        connected: false,
        message: 'Session not found'
      });
    }

    return successResponse({
      connected: !!session.slackAccessToken,
      teamId: session.slackTeamId || null,
      teamName: session.slackTeamName || null,
      connectedAt: session.slackConnectedAt
        ? new Date(session.slackConnectedAt).toISOString()
        : null
    });
  });

  server.registerTool('slack_connect', {
    description: 'Get a URL to connect your Slack account. Open the returned URL in your browser to authorize Slack access.'
  }, async (extra: any) => {
    const sessionId = extra?.sessionId;
    const userContext = sessionId ? getUserContextBySessionId(sessionId) : undefined;

    if (!userContext) {
      return errorResponse('Authentication required');
    }

    const token = (userContext as any).bearerToken;
    if (!token) {
      return errorResponse('Bearer token not found. Please re-authenticate.');
    }

    const crypto = await import('crypto');
    const { DynamoDBClient, PutItemCommand } = await import('@aws-sdk/client-dynamodb');
    const { SESSIONS_TABLE } = await import('../config/aws.js');

    const dynamodb = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' });

    const connectToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = Math.floor(Date.now() / 1000) + 600; // 10 minutes

    await dynamodb.send(new PutItemCommand({
      TableName: SESSIONS_TABLE,
      Item: {
        sessionId: { S: `SLACK_CONNECT#${connectToken}` },
        bearerToken: { S: token },
        expiresAt: { N: String(expiresAt) },
        ttl: { N: String(expiresAt) }
      }
    }));

    const baseUrl = process.env.BASE_URL || 'https://mgw.ext.getvim.com';
    const connectUrl = `${baseUrl}/auth/slack?connect_token=${connectToken}`;

    return successResponse({
      message: 'Open this URL in your browser to connect Slack:',
      url: connectUrl,
      expiresIn: '10 minutes',
      note: 'This link is single-use and will expire in 10 minutes'
    });
  });

  // ============================================================
  // Search Tools
  // ============================================================

  server.registerTool('slack_search', {
    description: 'Search messages in Slack. Searches across all channels and DMs you have access to.',
    inputSchema: {
      query: z.string().describe('Search query string'),
      count: z.number().min(1).max(100).optional().describe('Number of results to return (1-100, default 20)'),
      page: z.number().min(1).optional().describe('Page number for pagination (default 1)')
    }
  }, async (args: any, extra: any) => {
    const result = await getSlackClientForUser(extra?.sessionId);
    if ('error' in result) return errorResponse(result.error);

    const { client, teamName } = result;
    const { query, count = 20, page = 1 } = args;

    try {
      const response = await client.get<SlackSearchResult>('search.messages', {
        query,
        count: String(count),
        page: String(page)
      });

      return successResponse({
        team: teamName,
        query,
        total: response.messages.total,
        page: response.messages.pagination.page,
        pageCount: response.messages.pagination.page_count,
        messages: response.messages.matches.map(m => ({
          text: m.text,
          user: m.user || m.username,
          channel: m.channel,
          timestamp: m.ts,
          permalink: m.permalink
        }))
      });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : 'Failed to search messages');
    }
  });

  // ============================================================
  // Channel Tools
  // ============================================================

  server.registerTool('slack_list_channels', {
    description: 'List Slack channels you have access to',
    inputSchema: {
      types: z.string().optional().describe('Comma-separated channel types: public_channel, private_channel, mpim, im (default: public_channel,private_channel)'),
      limit: z.number().min(1).max(1000).optional().describe('Maximum number of channels to return (default 100)'),
      cursor: z.string().optional().describe('Pagination cursor for next page')
    }
  }, async (args: any, extra: any) => {
    const result = await getSlackClientForUser(extra?.sessionId);
    if ('error' in result) return errorResponse(result.error);

    const { client, teamName } = result;
    const { types = 'public_channel,private_channel', limit = 100, cursor } = args;

    try {
      const params: Record<string, string> = {
        types,
        limit: String(limit),
        exclude_archived: 'true'
      };
      if (cursor) params.cursor = cursor;

      const response = await client.get<SlackConversationsListResponse>('conversations.list', params);

      return successResponse({
        team: teamName,
        channels: response.channels.map(c => ({
          id: c.id,
          name: c.name,
          isPrivate: c.is_private,
          isChannel: c.is_channel,
          isGroup: c.is_group,
          isMember: c.is_member,
          numMembers: c.num_members,
          topic: c.topic?.value,
          purpose: c.purpose?.value
        })),
        nextCursor: response.response_metadata?.next_cursor || null
      });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : 'Failed to list channels');
    }
  });

  server.registerTool('slack_channel_history', {
    description: 'Get recent messages from a Slack channel',
    inputSchema: {
      channel: z.string().describe('Channel ID (e.g., C1234567890)'),
      limit: z.number().min(1).max(1000).optional().describe('Number of messages to return (default 50)'),
      cursor: z.string().optional().describe('Pagination cursor for older messages')
    }
  }, async (args: any, extra: any) => {
    const result = await getSlackClientForUser(extra?.sessionId);
    if ('error' in result) return errorResponse(result.error);

    const { client } = result;
    const { channel, limit = 50, cursor } = args;

    try {
      const params: Record<string, string> = {
        channel,
        limit: String(limit)
      };
      if (cursor) params.cursor = cursor;

      const response = await client.get<SlackConversationsHistoryResponse>('conversations.history', params);

      return successResponse({
        channel,
        messages: response.messages.map(m => ({
          text: m.text,
          user: m.user,
          timestamp: m.ts,
          type: m.type
        })),
        hasMore: response.has_more,
        nextCursor: response.response_metadata?.next_cursor || null
      });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : 'Failed to get channel history');
    }
  });

  // ============================================================
  // Users Tools
  // ============================================================

  server.registerTool('slack_list_users', {
    description: 'List users in the Slack workspace',
    inputSchema: {
      limit: z.number().min(1).max(1000).optional().describe('Maximum number of users to return (default 100)'),
      cursor: z.string().optional().describe('Pagination cursor for next page')
    }
  }, async (args: any, extra: any) => {
    const result = await getSlackClientForUser(extra?.sessionId);
    if ('error' in result) return errorResponse(result.error);

    const { client, teamName } = result;
    const { limit = 100, cursor } = args;

    try {
      const params: Record<string, string> = {
        limit: String(limit)
      };
      if (cursor) params.cursor = cursor;

      const response = await client.get<SlackUsersListResponse>('users.list', params);

      return successResponse({
        team: teamName,
        users: response.members
          .filter(u => !u.deleted && !u.is_bot)
          .map(u => ({
            id: u.id,
            name: u.name,
            realName: u.real_name,
            displayName: u.profile?.display_name,
            email: u.profile?.email,
            isAdmin: u.is_admin
          })),
        nextCursor: response.response_metadata?.next_cursor || null
      });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : 'Failed to list users');
    }
  });

  console.log('[Slack] Registered tools: slack_status, slack_connect, slack_search, slack_list_channels, slack_channel_history, slack_list_users');
}
```

**Step 2: Commit**

```bash
git add src/slack/handlers.ts
git commit -m "feat(slack): add Slack MCP tool handlers"
```

---

## Task 7: Register Slack Handlers and Routes

**Files:**
- Modify: `src/mcp/handlers.ts`
- Modify: `src/server.ts`

**Step 1: Add Slack handlers to MCP registration**

In `src/mcp/handlers.ts`, add the import and registration:

```typescript
import { registerSlackHandlers } from '../slack/handlers.js';
```

And add the registration call after HubSpot:

```typescript
  // Register Slack tools (optional - only if configured)
  registerSlackHandlers(server);

  console.log('[MCP] Handlers registered: whoami, test_auth, gmail_*, calendar_*, drive_*, docs_*, sheets_*, slides_*, hubspot_* (if configured), slack_* (if configured)');
```

**Step 2: Add Slack OAuth routes to server**

In `src/server.ts`, find where `hubspotOAuthRoutes` is imported and registered, and add Slack:

Add import:
```typescript
import { slackOAuthRoutes } from './routes/slack-oauth.js';
```

Add registration (after hubspotOAuthRoutes):
```typescript
await slackOAuthRoutes(app);
```

**Step 3: Commit**

```bash
git add src/mcp/handlers.ts src/server.ts
git commit -m "feat(slack): register Slack handlers and OAuth routes"
```

---

## Task 8: Add Slack Environment Variables to CDK

**Files:**
- Modify: `infra/lib/mcp-gateway-stack.ts`

**Step 1: Add Slack secrets to CDK stack**

Find the environment variables section in the ECS task definition and add:

```typescript
SLACK_CLIENT_ID: process.env.SLACK_CLIENT_ID || '',
SLACK_CLIENT_SECRET: process.env.SLACK_CLIENT_SECRET || '',
SLACK_TEAM_ID: process.env.SLACK_TEAM_ID || '',
```

**Step 2: Commit**

```bash
git add infra/lib/mcp-gateway-stack.ts
git commit -m "feat(slack): add Slack environment variables to CDK"
```

---

## Task 9: Test and Deploy

**Step 1: Build locally**

```bash
npm run build
```

Expected: No TypeScript errors

**Step 2: Set environment variables locally for testing**

```bash
export SLACK_CLIENT_ID="your-client-id"
export SLACK_CLIENT_SECRET="your-client-secret"
export SLACK_TEAM_ID="your-team-id"  # Optional
```

**Step 3: Deploy to AWS**

```bash
cd infra && AWS_PROFILE=corp-admin npx cdk deploy --require-approval never
```

**Step 4: Commit all changes**

```bash
git push
```
