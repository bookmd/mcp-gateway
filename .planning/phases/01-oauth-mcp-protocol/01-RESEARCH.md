# Phase 1: OAuth + MCP Protocol - Research

**Researched:** 2026-01-31
**Domain:** OAuth 2.0/2.1 + Model Context Protocol (MCP) with SSE Transport
**Confidence:** MEDIUM

## Summary

This phase combines two distinct technical domains: Google OAuth 2.0 authentication with PKCE (Proof Key for Code Exchange) and the Model Context Protocol (MCP) for establishing connections from Cursor IDE. Research reveals that both domains are actively evolving in 2026, with OAuth 2.1 solidifying best practices and MCP transitioning from SSE to Streamable HTTP transport.

The standard approach for Phase 1 is to implement a Backend-for-Frontend (BFF) pattern using the official TypeScript MCP SDK with server-side OAuth session management. Google OAuth with PKCE provides strong security for domain-restricted authentication, while MCP's transport layer enables Cursor to communicate with the gateway server. The weekly re-authentication requirement simplifies architecture by eliminating refresh token rotation complexity.

**Critical finding:** MCP officially deprecated SSE transport as of March 2025 (version 2025-03-26) in favor of Streamable HTTP. However, Cursor and existing MCP implementations still widely support SSE for backward compatibility. For Phase 1, SSE remains the pragmatic choice given Cursor's current support, with a migration path to Streamable HTTP available for future phases.

**Primary recommendation:** Use `@modelcontextprotocol/sdk` v1.x (stable) with stdio/SSE transport, `openid-client` for Google OAuth PKCE implementation, `@fastify/sse` for SSE endpoints, and server-side session storage for OAuth tokens.

## Standard Stack

The established libraries/tools for this domain:

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@modelcontextprotocol/sdk` | 1.x (stable) | MCP server/client implementation | Official TypeScript SDK from Anthropic; v2 in pre-alpha, v1 recommended for production |
| `openid-client` | 6.x+ | OAuth 2.0/OIDC with PKCE | Industry-standard Node.js OIDC library, certified implementation, built-in PKCE support |
| `@fastify/sse` | 5.x+ | Server-Sent Events for Fastify | Official Fastify plugin, first-class SSE support with route-level API |
| `fastify` | 5.x+ | Web framework | High-performance, TypeScript-friendly, plugin ecosystem |
| `zod` | 3.25+ | Schema validation | Required peer dependency for MCP SDK, runtime type safety |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `google-auth-library` | Latest | Google OAuth alternative | Alternative to openid-client if Google-specific features needed |
| `@fastify/cookie` | Latest | Secure cookie handling | Session cookie management for OAuth tokens |
| `@fastify/session` | Latest | Session management | Stateful server-side session storage |
| `ioredis` | Latest | Redis client | Production session store (distributed sessions) |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `openid-client` | `passport-google-oauth20` | Passport more batteries-included but adds abstraction layers; openid-client more direct control over PKCE |
| `@fastify/sse` | `fastify-sse-v2` | Community plugin with similar API; official plugin preferred for long-term support |
| Server-side sessions | JWT-only (stateless) | JWTs avoid session storage but require refresh token rotation for weekly re-auth, adding complexity |

**Installation:**
```bash
npm install @modelcontextprotocol/sdk zod openid-client fastify @fastify/sse @fastify/cookie @fastify/session
# Optional production dependencies
npm install ioredis
```

## Architecture Patterns

### Recommended Project Structure

```
src/
├── auth/
│   ├── oauth-client.ts      # openid-client configuration
│   ├── pkce.ts              # PKCE code generation/validation
│   ├── session.ts           # Session management
│   └── middleware.ts        # Auth middleware for routes
├── mcp/
│   ├── server.ts            # MCP server instance
│   ├── transports/
│   │   └── sse.ts           # SSE transport setup
│   ├── tools/               # MCP tools (future phases)
│   └── handlers.ts          # MCP protocol handlers
├── routes/
│   ├── oauth.ts             # OAuth callback routes
│   └── sse.ts               # SSE endpoint for MCP
├── config/
│   └── oauth.ts             # OAuth configuration
└── server.ts                # Main Fastify server
```

### Pattern 1: Backend-for-Frontend (BFF) with Server-Side Sessions

**What:** Server stores OAuth tokens in sessions, exposes session cookies to client. MCP connections reference user session to retrieve credentials.

**When to use:** Always for this use case - protects tokens from client-side attacks, simplifies token lifecycle.

**Example:**
```typescript
// Source: Auth0 Token Storage Best Practices
// https://auth0.com/docs/secure/security-guidance/data-security/token-storage

import Fastify from 'fastify';
import fastifySession from '@fastify/session';
import fastifyCookie from '@fastify/cookie';

const app = Fastify();

// Session storage with HTTP-only cookies
await app.register(fastifyCookie);
await app.register(fastifySession, {
  secret: process.env.SESSION_SECRET,
  cookie: {
    secure: true,      // HTTPS only
    httpOnly: true,    // No JavaScript access
    sameSite: 'strict', // CSRF protection
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  },
  store: redisStore // Production: use Redis for distributed sessions
});

// Store OAuth tokens in session
app.post('/auth/callback', async (request, reply) => {
  const tokens = await exchangeCodeForTokens(request.query.code);

  // Validate hd claim
  const idToken = parseIdToken(tokens.id_token);
  if (idToken.hd !== 'company.com') {
    throw new Error('Invalid domain');
  }

  // Store in session (server-side only)
  request.session.set('access_token', tokens.access_token);
  request.session.set('id_token', tokens.id_token);
  request.session.set('expires_at', Date.now() + tokens.expires_in * 1000);

  return reply.redirect('/');
});
```

### Pattern 2: PKCE Flow Implementation

**What:** Generate code verifier/challenge, validate on callback, exchange for tokens.

**When to use:** All OAuth 2.0/2.1 authorization flows - mandatory in 2026.

**Example:**
```typescript
// Source: openid-client documentation
// https://github.com/panva/openid-client

import { Issuer, generators } from 'openid-client';

// Discover Google's OAuth endpoints
const googleIssuer = await Issuer.discover('https://accounts.google.com');

const client = new googleIssuer.Client({
  client_id: process.env.GOOGLE_CLIENT_ID,
  client_secret: process.env.GOOGLE_CLIENT_SECRET,
  redirect_uris: ['https://gateway.company.com/auth/callback'],
  response_types: ['code']
});

// Authorization request
app.get('/auth/login', async (request, reply) => {
  const code_verifier = generators.codeVerifier();
  const code_challenge = generators.codeChallenge(code_verifier);

  // Store in session for callback validation
  request.session.set('code_verifier', code_verifier);
  request.session.set('state', generators.state());

  const authUrl = client.authorizationUrl({
    scope: 'openid email profile',
    code_challenge,
    code_challenge_method: 'S256',
    state: request.session.get('state'),
    hd: 'company.com' // Domain hint for Google Workspace
  });

  return reply.redirect(authUrl);
});

// Token exchange
app.get('/auth/callback', async (request, reply) => {
  const params = client.callbackParams(request.raw);

  // Validate state (CSRF protection)
  if (params.state !== request.session.get('state')) {
    throw new Error('State mismatch');
  }

  const tokenSet = await client.callback(
    'https://gateway.company.com/auth/callback',
    params,
    {
      code_verifier: request.session.get('code_verifier'),
      state: request.session.get('state')
    }
  );

  // Validate hd claim
  const claims = tokenSet.claims();
  if (claims.hd !== 'company.com') {
    throw new Error('Invalid domain');
  }

  // Store tokens in session
  request.session.set('access_token', tokenSet.access_token);
  request.session.set('id_token', tokenSet.id_token);
  request.session.set('expires_at', tokenSet.expires_at);

  return reply.redirect('/');
});
```

### Pattern 3: MCP Server with SSE Transport

**What:** MCP server exposing SSE endpoint that maintains per-user OAuth context.

**When to use:** MCP servers requiring user-specific authentication.

**Example:**
```typescript
// Source: MCP TypeScript SDK + Fastify SSE
// https://github.com/modelcontextprotocol/typescript-sdk
// https://github.com/fastify/sse

import { Server as McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';

// MCP Server initialization
const mcpServer = new McpServer({
  name: 'mcp-gateway',
  version: '1.0.0',
  capabilities: {
    tools: {},
    resources: {}
  }
});

// SSE endpoint with authentication
app.get('/mcp/sse', {
  sse: true,
  preHandler: async (request, reply) => {
    // Verify user session
    const accessToken = request.session.get('access_token');
    const expiresAt = request.session.get('expires_at');

    if (!accessToken || Date.now() >= expiresAt) {
      reply.code(401).send({ error: 'Authentication required' });
      return;
    }

    // Attach user context for MCP handlers
    request.userContext = {
      accessToken,
      email: request.session.get('email')
    };
  }
}, async (request, reply) => {
  // Create SSE transport for this connection
  const transport = new SSEServerTransport('/mcp/sse', reply.sse);

  // Connect MCP server with user context
  await mcpServer.connect(transport, {
    userContext: request.userContext
  });
});

// MCP protocol handlers use userContext to make API calls
mcpServer.setRequestHandler('tools/call', async (request, context) => {
  const { accessToken } = context.userContext;

  // Use user's OAuth token for API calls
  const response = await fetch('https://api.google.com/...', {
    headers: {
      'Authorization': `Bearer ${accessToken}`
    }
  });

  return response.json();
});
```

### Pattern 4: Weekly Re-Authentication Check

**What:** Middleware that validates token freshness on each MCP request.

**When to use:** AUTH-04 requirement - enforce 7-day re-authentication.

**Example:**
```typescript
// Session expiration middleware
const requireFreshAuth = async (request, reply) => {
  const expiresAt = request.session.get('expires_at');
  const authenticatedAt = request.session.get('authenticated_at');

  // Check if access token expired
  if (!expiresAt || Date.now() >= expiresAt) {
    return reply.code(401).send({
      error: 'authentication_required',
      message: 'Access token expired. Please re-authenticate.'
    });
  }

  // Check if 7 days have passed since initial authentication
  const weekInMs = 7 * 24 * 60 * 60 * 1000;
  if (!authenticatedAt || Date.now() - authenticatedAt >= weekInMs) {
    return reply.code(401).send({
      error: 'authentication_required',
      message: 'Weekly re-authentication required. Please log in again.'
    });
  }
};

// Apply to MCP routes
app.get('/mcp/sse', {
  sse: true,
  preHandler: requireFreshAuth
}, mcpSseHandler);
```

### Anti-Patterns to Avoid

- **Storing tokens in browser localStorage/sessionStorage:** Vulnerable to XSS attacks. Always use HTTP-only cookies with server-side sessions.
- **Using 'plain' PKCE method:** Always use S256 (SHA-256). Plain method exposes verifier in authorization request.
- **Skipping state parameter validation:** Opens CSRF vulnerabilities. Always generate, store, and validate state.
- **Trusting email domain instead of hd claim:** Email can be spoofed. Always validate the hd claim in ID token.
- **Long-lived access tokens without refresh rotation:** User requirement specifies weekly re-auth, which avoids refresh token complexity.
- **Accepting 'none' algorithm in JWT validation:** Always enforce expected algorithms (RS256 for Google).

## Don't Hand-Roll

Problems that look simple but have existing solutions:

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| PKCE code generation | Custom crypto.randomBytes + SHA-256 | `openid-client` generators | Handles code verifier length requirements (43-128 chars), base64url encoding, S256 hashing correctly |
| OAuth discovery | Hardcoded Google endpoints | `Issuer.discover()` | Auto-discovers endpoints, handles Google's endpoint changes, validates issuer metadata |
| JWT validation | Custom JWT parsing/verification | `openid-client` ID token validation | Validates signature, issuer, audience, expiration, nonce - easy to miss critical checks |
| Session management | Custom session storage | `@fastify/session` | Handles session ID generation, storage abstraction, cookie security, CSRF tokens |
| SSE connection handling | Manual EventSource protocol | `@fastify/sse` | Handles SSE protocol details, reconnection, message formatting, connection lifecycle |
| OAuth state generation | `Math.random().toString()` | `generators.state()` | Cryptographically secure random generation, correct entropy |

**Key insight:** OAuth security is subtle - missing a single validation (hd claim, state, PKCE) can compromise the entire flow. Using certified libraries reduces attack surface dramatically.

## Common Pitfalls

### Pitfall 1: PKCE Downgrade Attack

**What goes wrong:** Server accepts token exchange without code_challenge when PKCE not enforced, allowing attacker to strip PKCE parameters.

**Why it happens:** Authorization server supports PKCE but doesn't require it for all clients. Attacker intercepts authorization request and removes `code_challenge` parameters.

**How to avoid:**
- Configure Google OAuth client to require PKCE (enabled by default for public clients in 2026)
- Always validate that if `code_verifier` is present in token request, `code_challenge` was in authorization request
- Use openid-client which enforces PKCE by default

**Warning signs:**
- Token exchange succeeds without code_verifier
- Authorization requests work without code_challenge
- Logs show authorization requests without PKCE parameters

### Pitfall 2: hd Claim Validation Failure

**What goes wrong:** User with non-company.com email receives access token, bypassing domain restriction.

**Why it happens:** Developer validates `hd` parameter in authorization request or checks email domain instead of validating `hd` claim in ID token. The `hd` parameter is just a UI hint - not security.

**How to avoid:**
```typescript
// WRONG: Trusting hd parameter or email domain
const email = tokenSet.claims().email;
if (!email.endsWith('@company.com')) {
  throw new Error('Invalid domain'); // Can be bypassed
}

// CORRECT: Validate hd claim in ID token
const claims = tokenSet.claims();
if (claims.hd !== 'company.com') {
  throw new Error('Invalid domain'); // Cryptographically secure
}
```

**Warning signs:**
- Users with personal Google accounts can authenticate
- Only email validation exists, no hd claim check
- Authorization URL includes hd parameter but callback doesn't validate claim

### Pitfall 3: State/CSRF Validation Missing

**What goes wrong:** Attacker initiates OAuth flow with victim's session, exchanges stolen code for tokens in victim's session.

**Why it happens:** Developer doesn't generate/validate state parameter, allowing cross-site request forgery.

**How to avoid:**
- Always generate cryptographically random state: `generators.state()`
- Store in session before redirect
- Validate exact match on callback
- openid-client validates automatically if state provided

**Warning signs:**
- OAuth callback doesn't check state parameter
- State is predictable (sequential numbers, timestamps)
- Same state reused across multiple authorization requests

### Pitfall 4: Token Storage in Browser

**What goes wrong:** XSS attack steals access tokens from localStorage, attacker impersonates user.

**Why it happens:** Developer stores tokens client-side for "convenience" or following SPA patterns without BFF.

**How to avoid:**
- Always use Backend-for-Frontend pattern for OAuth flows
- Store tokens server-side in sessions
- Use HTTP-only, secure, SameSite=strict cookies
- Never expose tokens to JavaScript

**Warning signs:**
- Tokens visible in browser DevTools
- Token stored in localStorage/sessionStorage
- API calls include Authorization header from client-side code

### Pitfall 5: Redirect URI Validation Weakness

**What goes wrong:** Attacker registers similar redirect URI, intercepts authorization code.

**Why it happens:** Wildcard or loose matching on redirect URIs in Google Cloud Console.

**How to avoid:**
- Register exact redirect URIs in Google Cloud Console
- Use HTTPS for all redirect URIs (except localhost development)
- Never use wildcards or pattern matching
- Google enforces exact string matching (except localhost ports)

**Warning signs:**
- Redirect URI uses wildcards or patterns
- Multiple similar redirect URIs registered
- HTTP redirect URIs in production

### Pitfall 6: JWT Algorithm Confusion

**What goes wrong:** Attacker changes JWT algorithm from RS256 to HS256, signs token with public key as secret.

**Why it happens:** JWT library accepts any algorithm in token header without validation.

**How to avoid:**
```typescript
// Always specify expected algorithms
const claims = tokenSet.claims();
// openid-client validates algorithm automatically

// If manually validating JWTs:
import jwt from 'jsonwebtoken';
jwt.verify(token, publicKey, {
  algorithms: ['RS256'], // Explicitly allow only RS256
  issuer: 'https://accounts.google.com',
  audience: CLIENT_ID
});
```

**Warning signs:**
- No algorithm validation in JWT verification
- Accepts 'none' algorithm
- HS256 accepted when expecting RS256

### Pitfall 7: Session Fixation

**What goes wrong:** Attacker sets victim's session ID before authentication, gains access after victim logs in.

**Why it happens:** Session ID not regenerated after authentication.

**How to avoid:**
```typescript
app.post('/auth/callback', async (request, reply) => {
  const tokenSet = await client.callback(...);

  // Regenerate session ID after authentication
  await request.session.regenerate();

  request.session.set('access_token', tokenSet.access_token);
  // ... store other session data
});
```

**Warning signs:**
- Session ID remains same before/after login
- No session regeneration in authentication flow

## Code Examples

Verified patterns from official sources:

### Complete OAuth PKCE Flow

```typescript
// Source: openid-client + Google OAuth documentation
// https://github.com/panva/openid-client
// https://developers.google.com/identity/openid-connect/openid-connect

import { Issuer, generators } from 'openid-client';
import Fastify from 'fastify';
import fastifySession from '@fastify/session';

const app = Fastify();

// Session setup
await app.register(fastifySession, {
  secret: process.env.SESSION_SECRET,
  cookie: {
    secure: true,
    httpOnly: true,
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
});

// Discover Google's configuration
const googleIssuer = await Issuer.discover('https://accounts.google.com');

const oauthClient = new googleIssuer.Client({
  client_id: process.env.GOOGLE_CLIENT_ID,
  client_secret: process.env.GOOGLE_CLIENT_SECRET,
  redirect_uris: ['https://gateway.company.com/auth/callback'],
  response_types: ['code']
});

// Step 1: Initiate OAuth flow
app.get('/auth/login', async (request, reply) => {
  // Generate PKCE parameters
  const code_verifier = generators.codeVerifier();
  const code_challenge = generators.codeChallenge(code_verifier);
  const state = generators.state();

  // Store for callback validation
  request.session.set('code_verifier', code_verifier);
  request.session.set('state', state);
  request.session.set('nonce', generators.nonce());

  // Build authorization URL
  const authUrl = oauthClient.authorizationUrl({
    scope: 'openid email profile',
    code_challenge,
    code_challenge_method: 'S256',
    state,
    nonce: request.session.get('nonce'),
    hd: 'company.com' // Domain hint (UI optimization)
  });

  return reply.redirect(authUrl);
});

// Step 2: Handle OAuth callback
app.get('/auth/callback', async (request, reply) => {
  try {
    const params = oauthClient.callbackParams(request.raw);

    // Retrieve stored PKCE parameters
    const code_verifier = request.session.get('code_verifier');
    const state = request.session.get('state');
    const nonce = request.session.get('nonce');

    // Exchange code for tokens (validates PKCE, state, nonce automatically)
    const tokenSet = await oauthClient.callback(
      'https://gateway.company.com/auth/callback',
      params,
      { code_verifier, state, nonce }
    );

    // Validate hd claim (CRITICAL for domain restriction)
    const claims = tokenSet.claims();
    if (claims.hd !== 'company.com') {
      throw new Error('Unauthorized domain');
    }

    // Regenerate session (prevent session fixation)
    await request.session.regenerate();

    // Store tokens and user info
    request.session.set('access_token', tokenSet.access_token);
    request.session.set('id_token', tokenSet.id_token);
    request.session.set('expires_at', tokenSet.expires_at * 1000);
    request.session.set('authenticated_at', Date.now());
    request.session.set('email', claims.email);
    request.session.set('hd', claims.hd);

    // Clear PKCE parameters
    request.session.delete('code_verifier');
    request.session.delete('state');
    request.session.delete('nonce');

    return reply.redirect('/');
  } catch (error) {
    console.error('OAuth callback error:', error);
    return reply.code(401).send({ error: 'Authentication failed' });
  }
});

// Step 3: Validate token freshness
const requireAuth = async (request, reply) => {
  const expiresAt = request.session.get('expires_at');
  const authenticatedAt = request.session.get('authenticated_at');

  // Check token expiration
  if (!expiresAt || Date.now() >= expiresAt) {
    return reply.code(401).send({
      error: 'token_expired',
      message: 'Access token expired. Please re-authenticate.'
    });
  }

  // Check 7-day re-authentication window
  const weekInMs = 7 * 24 * 60 * 60 * 1000;
  if (!authenticatedAt || Date.now() - authenticatedAt >= weekInMs) {
    return reply.code(401).send({
      error: 'reauthentication_required',
      message: 'Weekly re-authentication required.'
    });
  }
};
```

### MCP Server with SSE and Per-User OAuth

```typescript
// Source: MCP TypeScript SDK + Fastify SSE integration
// https://github.com/modelcontextprotocol/typescript-sdk

import { Server as McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import fastifySse from '@fastify/sse';

await app.register(fastifySse);

// Initialize MCP server
const mcpServer = new McpServer({
  name: 'mcp-gateway',
  version: '1.0.0'
});

// SSE endpoint for MCP connections
app.get('/mcp/sse', {
  sse: true,
  preHandler: requireAuth // Validate OAuth session
}, async (request, reply) => {
  // Retrieve user's OAuth context
  const userContext = {
    accessToken: request.session.get('access_token'),
    email: request.session.get('email'),
    sessionId: request.session.sessionId
  };

  // Create SSE transport
  const transport = new SSEServerTransport('/mcp/sse', reply.sse);

  // Connect MCP server with user context
  await mcpServer.connect(transport);

  // Store user context for this connection
  transport.on('message', (message) => {
    // Attach user context to all MCP requests
    message.userContext = userContext;
  });

  // Handle connection close
  transport.on('close', () => {
    console.log(`SSE connection closed for ${userContext.email}`);
  });
});

// MCP tool that uses user's OAuth token
mcpServer.setRequestHandler('tools/call', async (request, context) => {
  const { accessToken, email } = request.userContext;

  // Make API call with user's credentials
  const response = await fetch('https://www.googleapis.com/drive/v3/files', {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error('Token expired. Please re-authenticate.');
    }
    throw new Error(`API error: ${response.statusText}`);
  }

  return response.json();
});
```

### Session Store Configuration (Production)

```typescript
// Source: @fastify/session documentation
// https://github.com/fastify/session

import Redis from 'ioredis';
import RedisStore from 'connect-redis';

// Redis client for distributed sessions
const redisClient = new Redis({
  host: process.env.REDIS_HOST,
  port: parseInt(process.env.REDIS_PORT),
  password: process.env.REDIS_PASSWORD,
  db: 0,
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  }
});

// Session store
const sessionStore = new RedisStore({
  client: redisClient,
  prefix: 'sess:',
  ttl: 7 * 24 * 60 * 60 // 7 days in seconds
});

await app.register(fastifySession, {
  store: sessionStore,
  secret: process.env.SESSION_SECRET,
  cookie: {
    secure: true,
    httpOnly: true,
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    domain: 'company.com'
  },
  saveUninitialized: false,
  rolling: true // Extend session on activity
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| OAuth 2.0 implicit flow | OAuth 2.0/2.1 authorization code + PKCE | 2020-2026 | Implicit flow deprecated; PKCE mandatory for all clients in 2026 |
| Optional PKCE for public clients | PKCE required for all clients | OAuth 2.1 (2026) | No longer security "best practice" but baseline requirement |
| MCP SSE transport | MCP Streamable HTTP | March 2025 (v2025-03-26) | SSE deprecated but widely supported for backward compatibility |
| Long-lived tokens + refresh rotation | Short-lived tokens + re-auth | 2024-2026 | Simplifies distributed systems, reduces token compromise window |
| Client-side token storage | Backend-for-Frontend (BFF) pattern | 2022-2026 | Protects against XSS, token theft - now standard for SPAs |
| Password grant (ROPC) | Authorization code flow only | OAuth 2.1 | Resource Owner Password Credentials removed entirely |

**Deprecated/outdated:**
- **MCP SSE Transport (as of 2025-03-26):** Official spec recommends Streamable HTTP. However, Cursor and major MCP clients still support SSE. Use SSE for Phase 1 compatibility, plan migration to Streamable HTTP.
- **OAuth 2.0 implicit flow:** Removed in OAuth 2.1. Use authorization code + PKCE.
- **Plain PKCE method:** Use S256 only. Plain method exposes code verifier.
- **Trusting hd parameter instead of claim:** UI optimization only, not security control.
- **@modelcontextprotocol/sdk v2 (pre-alpha):** Stable v1.x recommended until Q1 2026.

## Open Questions

Things that couldn't be fully resolved:

1. **Cursor's exact MCP OAuth integration mechanism**
   - What we know: Cursor supports OAuth for MCP servers via metadata discovery and Dynamic Client Registration (DCR). Forum discussions show users successfully implementing OAuth flows with SSE connections.
   - What's unclear: Exact OAuth flow Cursor uses (does it handle browser redirects? how does it manage session cookies?). No official Cursor documentation found.
   - Recommendation: Test with Cursor's MCP configuration to validate OAuth flow. Assume standard OAuth authorization code flow with browser redirects. Monitor Cursor community forums for updates.

2. **SSE vs Streamable HTTP timeline for Cursor adoption**
   - What we know: MCP officially deprecated SSE in March 2025. Cursor's documentation and examples still show SSE support. Community reports successful SSE deployments.
   - What's unclear: When/if Cursor will deprecate SSE support. Whether both transports can run simultaneously.
   - Recommendation: Implement SSE for Phase 1 (proven compatibility). Design transport abstraction layer for future migration to Streamable HTTP. Test Streamable HTTP in Phase 2 or 3.

3. **Google OAuth token lifetime for Workspace accounts**
   - What we know: Google OAuth access tokens typically expire in 1 hour. ID tokens used for validation. Weekly re-auth requirement means tokens don't need to be refreshed.
   - What's unclear: Whether Workspace admin policies can enforce shorter token lifetimes. Exact expiration for company.com domain.
   - Recommendation: Implement token expiration checks based on `expires_in` from token response. Test with actual company.com account to verify expiration behavior. Add monitoring for unexpected token expirations.

4. **Session storage scaling for 20 users**
   - What we know: 20 users is small scale. In-memory sessions work, but ECS/Fargate task restarts lose sessions.
   - What's unclear: Whether session persistence is critical for Phase 1, or if re-authentication on restart is acceptable.
   - Recommendation: Start with in-memory sessions for simplicity. Add Redis session store if session persistence becomes requirement. Document re-auth requirement after server restarts.

5. **MCP protocol version compatibility**
   - What we know: MCP SDK v1.x is stable. Cursor supports MCP protocol. Multiple protocol versions may exist.
   - What's unclear: Which MCP protocol version Cursor uses. Whether version negotiation is needed.
   - Recommendation: Use MCP SDK v1.x (stable). Implement version logging in MCP initialize handler. Test with Cursor to verify protocol compatibility.

## Sources

### Primary (HIGH confidence)

- [Model Context Protocol - Build a Server](https://modelcontextprotocol.io/docs/develop/build-server) - Official MCP server implementation guide
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) - Official TypeScript SDK repository
- [Google OpenID Connect Documentation](https://developers.google.com/identity/openid-connect/openid-connect) - Official OAuth 2.0 + OIDC guide with hd claim validation
- [openid-client GitHub](https://github.com/panva/openid-client) - Official OpenID certified client library
- [Fastify SSE Plugin](https://github.com/fastify/sse) - Official Fastify SSE implementation

### Secondary (MEDIUM confidence)

- [MCP Protocol Transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports) - Transport layer specification (SSE deprecation noted)
- [Auth0 Token Storage Best Practices](https://auth0.com/docs/secure/security-guidance/data-security/token-storage) - BFF pattern guidance
- [OAuth 2.1 Features (2026)](https://rgutierrez2004.medium.com/oauth-2-1-features-you-cant-ignore-in-2026-a15f852cb723) - Current OAuth security standards
- [Cursor MCP Forum Discussions](https://forum.cursor.com/t/how-to-implement-a-mcp-server-with-auth-and-trigger-cursor-login/100433) - Community OAuth integration patterns
- [OAuth 2.0 Security Best Practices (RFC 9700)](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-security-topics-23) - IETF security guidelines

### Tertiary (LOW confidence)

- Various Medium articles and blog posts about PKCE implementation - Used for ecosystem understanding, not implementation details
- Stack Overflow discussions - Pattern validation only

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - All libraries are official or industry-standard with verified documentation
- Architecture: MEDIUM - BFF and PKCE patterns well-documented; MCP + OAuth integration less documented, requires testing
- Pitfalls: HIGH - PKCE and OAuth pitfalls extensively documented; MCP-specific issues require field validation

**Research date:** 2026-01-31
**Valid until:** 2026-02-28 (30 days - stable domain but MCP ecosystem evolving)

**Key uncertainties requiring validation:**
1. Cursor's exact OAuth flow mechanism (test in Phase 1)
2. SSE vs Streamable HTTP decision point (monitor Cursor updates)
3. Google Workspace token expiration for company.com domain (test with real accounts)
