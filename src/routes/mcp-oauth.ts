/**
 * MCP OAuth 2.1 Implementation (RFC 8414 + RFC 9470)
 *
 * Enables Cursor/Claude to authenticate via browser OAuth flow.
 *
 * Flow:
 * 1. Client hits /mcp/sse → 401 with WWW-Authenticate header
 * 2. Client fetches /.well-known/oauth-protected-resource/mcp/sse
 * 3. Client fetches /.well-known/oauth-authorization-server
 * 4. Client opens browser to /oauth/authorize with PKCE
 * 5. User authenticates via Google
 * 6. Backend issues authorization code
 * 7. Client exchanges code for tokens at /oauth/token
 * 8. Client uses Bearer token on /mcp/sse
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'crypto';
import { DynamoDBClient, PutItemCommand, GetItemCommand, DeleteItemCommand } from '@aws-sdk/client-dynamodb';
import { SESSIONS_TABLE } from '../config/aws.js';
import { oauthConfig } from '../config/oauth.js';
import { createAuthUrl, handleCallback, initOAuthClient } from '../auth/oauth-client.js';
import { createAccessToken } from '../storage/token-store.js';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const dynamodb = new DynamoDBClient({ region: AWS_REGION });

// Token expiry
const AUTH_CODE_EXPIRE_SECONDS = 600; // 10 minutes
const ACCESS_TOKEN_EXPIRE_SECONDS = 7 * 24 * 60 * 60; // 7 days

// Get base URL from request headers
function getBaseUrl(request: FastifyRequest): string {
  const proto = request.headers['x-forwarded-proto'] || 'http';
  const host = request.headers['x-forwarded-host'] || request.headers.host || 'localhost:3000';
  return `${proto}://${host}`;
}

// PKCE verification
function verifyPkceChallenge(codeVerifier: string, codeChallenge: string): boolean {
  const digest = crypto.createHash('sha256').update(codeVerifier, 'ascii').digest();
  const computed = digest.toString('base64url');
  return computed === codeChallenge;
}

// Store OAuth state in DynamoDB
async function storeOAuthState(
  state: string,
  data: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    scope: string;
    codeVerifier?: string;
    nonce?: string;
  }
): Promise<void> {
  const expiresAt = Math.floor(Date.now() / 1000) + AUTH_CODE_EXPIRE_SECONDS;

  await dynamodb.send(new PutItemCommand({
    TableName: SESSIONS_TABLE,
    Item: {
      sessionId: { S: `OAUTH_STATE#${state}` },
      clientId: { S: data.clientId },
      redirectUri: { S: data.redirectUri },
      codeChallenge: { S: data.codeChallenge },
      scope: { S: data.scope },
      codeVerifier: { S: data.codeVerifier || '' },
      nonce: { S: data.nonce || '' },
      expiresAt: { N: String(expiresAt) },
      ttl: { N: String(expiresAt) }
    }
  }));
}

// Get OAuth state from DynamoDB
async function getOAuthState(state: string): Promise<{
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  codeVerifier: string;
  nonce: string;
} | null> {
  const result = await dynamodb.send(new GetItemCommand({
    TableName: SESSIONS_TABLE,
    Key: { sessionId: { S: `OAUTH_STATE#${state}` } }
  }));

  if (!result.Item) return null;

  return {
    clientId: result.Item.clientId?.S || '',
    redirectUri: result.Item.redirectUri?.S || '',
    codeChallenge: result.Item.codeChallenge?.S || '',
    scope: result.Item.scope?.S || '',
    codeVerifier: result.Item.codeVerifier?.S || '',
    nonce: result.Item.nonce?.S || ''
  };
}

// Delete OAuth state
async function deleteOAuthState(state: string): Promise<void> {
  await dynamodb.send(new DeleteItemCommand({
    TableName: SESSIONS_TABLE,
    Key: { sessionId: { S: `OAUTH_STATE#${state}` } }
  }));
}

// Store authorization code
async function storeAuthCode(
  code: string,
  data: {
    userId: string;
    email: string;
    accessToken: string;
    refreshToken?: string;
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    scope: string;
  }
): Promise<void> {
  const expiresAt = Math.floor(Date.now() / 1000) + AUTH_CODE_EXPIRE_SECONDS;

  await dynamodb.send(new PutItemCommand({
    TableName: SESSIONS_TABLE,
    Item: {
      sessionId: { S: `OAUTH_CODE#${code}` },
      userId: { S: data.userId },
      email: { S: data.email },
      accessToken: { S: data.accessToken },
      refreshToken: { S: data.refreshToken || '' },
      clientId: { S: data.clientId },
      redirectUri: { S: data.redirectUri },
      codeChallenge: { S: data.codeChallenge },
      scope: { S: data.scope },
      expiresAt: { N: String(expiresAt) },
      ttl: { N: String(expiresAt) }
    }
  }));
}

// Get and delete authorization code (single use)
async function getAndDeleteAuthCode(code: string): Promise<{
  userId: string;
  email: string;
  accessToken: string;
  refreshToken?: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
} | null> {
  const result = await dynamodb.send(new GetItemCommand({
    TableName: SESSIONS_TABLE,
    Key: { sessionId: { S: `OAUTH_CODE#${code}` } }
  }));

  if (!result.Item) return null;

  // Delete immediately (single use)
  await dynamodb.send(new DeleteItemCommand({
    TableName: SESSIONS_TABLE,
    Key: { sessionId: { S: `OAUTH_CODE#${code}` } }
  }));

  return {
    userId: result.Item.userId?.S || '',
    email: result.Item.email?.S || '',
    accessToken: result.Item.accessToken?.S || '',
    refreshToken: result.Item.refreshToken?.S || undefined,
    clientId: result.Item.clientId?.S || '',
    redirectUri: result.Item.redirectUri?.S || '',
    codeChallenge: result.Item.codeChallenge?.S || '',
    scope: result.Item.scope?.S || ''
  };
}

// Export helper functions for use by /auth/callback
export { getOAuthState, deleteOAuthState, storeAuthCode };

export async function mcpOAuthRoutes(app: FastifyInstance): Promise<void> {
  // Initialize Google OAuth client
  await initOAuthClient();

  // ============================================================================
  // Discovery Endpoints (RFC 8414 + RFC 9470)
  // ============================================================================

  // OAuth Authorization Server Metadata
  app.get('/.well-known/oauth-authorization-server', async (request, reply) => {
    const baseUrl = getBaseUrl(request);

    return reply.send({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      registration_endpoint: `${baseUrl}/oauth/register`,
      scopes_supported: ['openid', 'email', 'profile'],
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      service_documentation: 'https://github.com/anthropics/mcp-gateway'
    });
  });

  // Also handle path-specific discovery (RFC 8414)
  app.get('/.well-known/oauth-authorization-server/*', async (request, reply) => {
    const baseUrl = getBaseUrl(request);

    return reply.send({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      registration_endpoint: `${baseUrl}/oauth/register`,
      scopes_supported: ['openid', 'email', 'profile'],
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      service_documentation: 'https://github.com/anthropics/mcp-gateway'
    });
  });

  // OAuth Protected Resource Metadata (RFC 9470)
  app.get('/.well-known/oauth-protected-resource/*', async (request, reply) => {
    const baseUrl = getBaseUrl(request);
    const path = (request.params as any)['*'] || 'mcp/sse';

    return reply.send({
      resource: `${baseUrl}/${path}`,
      authorization_servers: [baseUrl],
      bearer_methods_supported: ['header'],
      scopes_supported: ['openid', 'email', 'profile'],
      resource_name: 'MCP Gateway for Google Workspace'
    });
  });

  // ============================================================================
  // Dynamic Client Registration (RFC 7591)
  // ============================================================================

  app.post('/oauth/register', async (request: FastifyRequest<{
    Body: {
      client_name?: string;
      redirect_uris?: string[];
      grant_types?: string[];
      response_types?: string[];
      token_endpoint_auth_method?: string;
    }
  }>, reply) => {
    const body = request.body || {};

    // Generate a client_id for this registration
    const clientId = `mcp_client_${crypto.randomBytes(16).toString('hex')}`;

    console.log(`[OAuth] Dynamic client registration: ${body.client_name || 'Unknown'}`);

    // Store client registration in DynamoDB (optional - we allow any client)
    const expiresAt = Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60); // 30 days

    await dynamodb.send(new PutItemCommand({
      TableName: SESSIONS_TABLE,
      Item: {
        sessionId: { S: `OAUTH_CLIENT#${clientId}` },
        clientName: { S: body.client_name || 'MCP Client' },
        redirectUris: { S: JSON.stringify(body.redirect_uris || []) },
        grantTypes: { S: JSON.stringify(body.grant_types || ['authorization_code']) },
        responseTypes: { S: JSON.stringify(body.response_types || ['code']) },
        tokenEndpointAuthMethod: { S: body.token_endpoint_auth_method || 'none' },
        createdAt: { N: String(Math.floor(Date.now() / 1000)) },
        expiresAt: { N: String(expiresAt) },
        ttl: { N: String(expiresAt) }
      }
    }));

    // Return registration response per RFC 7591
    return reply.code(201).send({
      client_id: clientId,
      client_name: body.client_name || 'MCP Client',
      redirect_uris: body.redirect_uris || [],
      grant_types: body.grant_types || ['authorization_code'],
      response_types: body.response_types || ['code'],
      token_endpoint_auth_method: body.token_endpoint_auth_method || 'none',
      client_id_issued_at: Math.floor(Date.now() / 1000)
    });
  });

  // ============================================================================
  // OAuth Authorization Endpoint
  // ============================================================================

  app.get('/oauth/authorize', async (request: FastifyRequest<{
    Querystring: {
      response_type?: string;
      client_id?: string;
      redirect_uri?: string;
      state?: string;
      code_challenge?: string;
      code_challenge_method?: string;
      scope?: string;
    }
  }>, reply) => {
    const {
      response_type,
      client_id,
      redirect_uri,
      state,
      code_challenge,
      code_challenge_method,
      scope
    } = request.query;

    // Validate required params
    if (response_type !== 'code') {
      return reply.code(400).send({
        error: 'unsupported_response_type',
        error_description: "Only 'code' response type is supported"
      });
    }

    if (!client_id || !redirect_uri || !state || !code_challenge) {
      return reply.code(400).send({
        error: 'invalid_request',
        error_description: 'Missing required parameters: client_id, redirect_uri, state, code_challenge'
      });
    }

    if (code_challenge_method && code_challenge_method !== 'S256') {
      return reply.code(400).send({
        error: 'invalid_request',
        error_description: 'Only S256 code_challenge_method is supported'
      });
    }

    // Validate redirect_uri - allow localhost and custom protocols for MCP clients
    const parsedUri = new URL(redirect_uri);
    const isLocalhost = parsedUri.hostname === 'localhost' || parsedUri.hostname === '127.0.0.1';
    const isCustomProtocol = ['cursor', 'vscode', 'vscode-insiders', 'code-oss'].includes(parsedUri.protocol.replace(':', ''));

    if (!isLocalhost && !isCustomProtocol) {
      console.log(`[OAuth] Rejecting redirect_uri: ${redirect_uri}`);
      return reply.code(400).send({
        error: 'invalid_redirect_uri',
        error_description: 'redirect_uri must be localhost or a supported custom protocol'
      });
    }

    // Generate our own PKCE for Google
    const { codeVerifier, state: googleState, nonce, authUrl } = createAuthUrl();

    // Store the mapping: googleState -> client's params + our verifier
    await storeOAuthState(googleState, {
      clientId: client_id,
      redirectUri: redirect_uri,
      codeChallenge: code_challenge,
      scope: scope || 'openid email profile',
      codeVerifier,
      nonce
    });

    // Store client state -> google state mapping
    await storeOAuthState(`CLIENT_STATE#${state}`, {
      clientId: client_id,
      redirectUri: redirect_uri,
      codeChallenge: code_challenge,
      scope: scope || 'openid email profile',
      codeVerifier: googleState, // Store google state here for lookup
      nonce: ''
    });

    // Store reverse mapping for callback lookup
    const expiresAt = Math.floor(Date.now() / 1000) + AUTH_CODE_EXPIRE_SECONDS;
    await dynamodb.send(new PutItemCommand({
      TableName: SESSIONS_TABLE,
      Item: {
        sessionId: { S: `CLIENT_STATE_REVERSE#${googleState}` },
        clientState: { S: state },
        expiresAt: { N: String(expiresAt) },
        ttl: { N: String(expiresAt) }
      }
    }));

    console.log(`[OAuth] Redirecting to Google OAuth, googleState=${googleState.substring(0, 10)}..., clientState=${state.substring(0, 10)}...`);
    return reply.redirect(authUrl);
  });

  // ============================================================================
  // OAuth Callback (from Google)
  // ============================================================================

  app.get('/oauth/callback', async (request: FastifyRequest, reply) => {
    try {
      const params = new URLSearchParams(request.url.split('?')[1] || '');
      const googleState = params.get('state');
      const error = params.get('error');

      if (error) {
        console.error(`[OAuth] Google returned error: ${error}`);
        return reply.type('text/html').send(getErrorPage('Authentication Failed', error));
      }

      if (!googleState) {
        return reply.type('text/html').send(getErrorPage('Invalid Request', 'Missing state parameter'));
      }

      // Get stored OAuth state
      const storedState = await getOAuthState(googleState);
      if (!storedState || !storedState.codeVerifier) {
        console.error('[OAuth] State not found or missing codeVerifier');
        return reply.type('text/html').send(getErrorPage('Session Expired', 'Please try again'));
      }

      // Exchange code with Google
      const result = await handleCallback(params, {
        codeVerifier: storedState.codeVerifier,
        state: googleState,
        nonce: storedState.nonce
      });

      console.log(`[OAuth] Google auth successful for: ${result.email}`);

      // Generate authorization code for the MCP client
      const authCode = crypto.randomBytes(32).toString('base64url');

      // Store auth code with user data
      await storeAuthCode(authCode, {
        userId: result.email,
        email: result.email,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        clientId: storedState.clientId,
        redirectUri: storedState.redirectUri,
        codeChallenge: storedState.codeChallenge,
        scope: storedState.scope
      });

      // Find the original client state by looking up CLIENT_STATE entries
      let clientState = '';
      try {
        const result = await dynamodb.send(new GetItemCommand({
          TableName: SESSIONS_TABLE,
          Key: { sessionId: { S: `CLIENT_STATE_REVERSE#${googleState}` } }
        }));
        clientState = result.Item?.clientState?.S || '';
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
      const redirectUrl = new URL(storedState.redirectUri);
      redirectUrl.searchParams.set('code', authCode);
      if (clientState) {
        redirectUrl.searchParams.set('state', clientState);
      }

      console.log(`[OAuth] Showing MCP success page with redirect to: ${redirectUrl.origin}... with state=${clientState?.substring(0, 10)}...`);
      
      // Show success page with auto-redirect to cursor:// URL
      const { readFile } = await import('fs/promises');
      const { join } = await import('path');
      const { fileURLToPath } = await import('url');
      const { dirname } = await import('path');
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = dirname(__filename);
      
      const htmlPath = join(__dirname, '../views/mcp-success.html');
      let html = await readFile(htmlPath, 'utf-8');
      html = html.replace('{{redirectUrl}}', redirectUrl.toString());
      return reply.type('text/html').send(html);

    } catch (error) {
      console.error('[OAuth] Callback error:', error);
      const message = error instanceof Error ? error.message : 'Authentication failed';
      return reply.type('text/html').send(getErrorPage('Authentication Failed', message));
    }
  });

  // ============================================================================
  // OAuth Token Endpoint
  // ============================================================================

  app.post('/oauth/token', async (request: FastifyRequest<{
    Body: {
      grant_type?: string;
      code?: string;
      redirect_uri?: string;
      code_verifier?: string;
      client_id?: string;
    }
  }>, reply) => {
    const { grant_type, code, redirect_uri, code_verifier, client_id } = request.body || {};

    console.log(`[OAuth/Token] Request received:`, {
      grant_type,
      code: code?.substring(0, 10) + '...',
      redirect_uri,
      client_id,
      has_verifier: !!code_verifier,
      verifier_length: code_verifier?.length
    });

    if (grant_type !== 'authorization_code') {
      console.error(`[OAuth/Token] FAIL: Unsupported grant_type: ${grant_type}`);
      return reply.code(400).send({
        error: 'unsupported_grant_type',
        error_description: 'Only authorization_code grant is supported'
      });
    }

    if (!code || !redirect_uri || !code_verifier) {
      console.error(`[OAuth/Token] FAIL: Missing required parameters`, {
        has_code: !!code,
        has_redirect_uri: !!redirect_uri,
        has_code_verifier: !!code_verifier
      });
      return reply.code(400).send({
        error: 'invalid_request',
        error_description: 'Missing required parameters: code, redirect_uri, code_verifier'
      });
    }

    // Get auth code data
    const codeData = await getAndDeleteAuthCode(code);
    if (!codeData) {
      console.error(`[OAuth/Token] FAIL: Authorization code not found or expired: ${code?.substring(0, 10)}...`);
      return reply.code(400).send({
        error: 'invalid_grant',
        error_description: 'Invalid or expired authorization code'
      });
    }

    console.log(`[OAuth/Token] Code data retrieved successfully:`, {
      email: codeData.email,
      userId: codeData.userId,
      clientId: codeData.clientId,
      redirectUri: codeData.redirectUri,
      scope: codeData.scope,
      has_accessToken: !!codeData.accessToken,
      has_refreshToken: !!codeData.refreshToken
    });

    // Verify redirect_uri matches
    if (redirect_uri !== codeData.redirectUri) {
      console.error(`[OAuth/Token] FAIL: redirect_uri mismatch`, {
        expected: codeData.redirectUri,
        received: redirect_uri
      });
      return reply.code(400).send({
        error: 'invalid_grant',
        error_description: 'redirect_uri mismatch'
      });
    }

    // Verify PKCE
    if (!verifyPkceChallenge(code_verifier, codeData.codeChallenge)) {
      console.error('[OAuth/Token] FAIL: PKCE verification failed', {
        challenge: codeData.codeChallenge,
        verifier_length: code_verifier?.length
      });
      return reply.code(400).send({
        error: 'invalid_grant',
        error_description: 'PKCE verification failed'
      });
    }

    console.log(`[OAuth/Token] All validations passed, creating access token for ${codeData.email}`);

    // Create our own access token for MCP
    try {
      const accessToken = await createAccessToken(
        codeData.accessToken,
        codeData.refreshToken,
        codeData.email,
        codeData.userId
      );

      console.log(`[OAuth/Token] SUCCESS: Issued access token for ${codeData.email}`);

      return reply.send({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: ACCESS_TOKEN_EXPIRE_SECONDS,
        scope: codeData.scope
      });
    } catch (error) {
      console.error(`[OAuth/Token] FAIL: Error creating access token:`, error);
      return reply.code(500).send({
        error: 'server_error',
        error_description: 'Failed to create access token'
      });
    }
  });
}

// Error page HTML
function getErrorPage(title: string, message: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <title>${title}</title>
  <style>
    body { font-family: -apple-system, sans-serif; background: #0a0a12; color: #fff;
           display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .container { background: rgba(255,255,255,0.05); border-radius: 16px; padding: 40px;
                 text-align: center; max-width: 400px; }
    h1 { color: #ef4444; margin-bottom: 16px; }
    p { color: rgba(255,255,255,0.7); }
    a { color: #22d3ee; }
  </style>
</head>
<body>
  <div class="container">
    <h1>${title}</h1>
    <p>${message}</p>
    <p style="margin-top: 24px;"><a href="javascript:window.close()">Close this window</a></p>
  </div>
</body>
</html>`;
}
