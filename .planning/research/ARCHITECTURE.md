# Architecture Patterns: MCP Gateway with OAuth

**Domain:** Centralized MCP Gateway with Multi-User OAuth Support
**Researched:** 2026-01-31
**Confidence:** MEDIUM-HIGH

## Recommended Architecture

MCP gateways follow a **stateful proxy pattern** that sits between AI clients (like Cursor) and MCP servers (Google Workspace APIs). The gateway acts as both an OAuth client (to Google) and an MCP server (to Cursor), managing authentication, session state, and request routing.

```
┌─────────────────────────────────────────────────────────────────┐
│                        AI Client (Cursor)                        │
│                    ┌──────────────────┐                          │
│                    │   MCP Client     │                          │
│                    │   (embedded)     │                          │
│                    └────────┬─────────┘                          │
└─────────────────────────────┼───────────────────────────────────┘
                              │ SSE/HTTP (Streamable HTTP)
                              │ JSON-RPC 2.0 messages
                              │
┌─────────────────────────────▼───────────────────────────────────┐
│                     MCP Gateway (AWS ECS)                        │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │              Transport Layer (SSE/HTTP)                     │ │
│  │  - Connection management                                   │ │
│  │  - Session lifecycle (Mcp-Session-Id headers)              │ │
│  │  - Keep-alive / reconnection                               │ │
│  └──────────────┬────────────────────────────────┬────────────┘ │
│                 │                                │               │
│  ┌──────────────▼─────────────────┐  ┌─────────▼────────────┐  │
│  │    Protocol Handler (MCP)      │  │  OAuth Flow Manager  │  │
│  │  - JSON-RPC 2.0 parsing        │  │  - PKCE flow         │  │
│  │  - Lifecycle management        │  │  - Token exchange    │  │
│  │  - Capability negotiation      │  │  - Refresh handling  │  │
│  └──────────────┬─────────────────┘  └─────────┬────────────┘  │
│                 │                                │               │
│  ┌──────────────▼─────────────────────────────┬─▼────────────┐  │
│  │         Request Router & Orchestrator       │              │  │
│  │  - User identification (session → user)     │              │  │
│  │  - Tool name → API mapping                  │              │  │
│  │  - Tool execution coordination              │              │  │
│  └──────────────┬─────────────────────────────┬▲────────────┘  │
│                 │                              ││               │
│  ┌──────────────▼──────────────┐  ┌───────────▼┴───────────┐  │
│  │     Token Store (DynamoDB)   │  │  API Adapters         │  │
│  │  - User → token mapping      │  │  - Gmail API          │  │
│  │  - Encrypted with KMS        │  │  - Drive API          │  │
│  │  - Refresh token rotation    │  │  - Calendar API       │  │
│  └──────────────────────────────┘  │  - Docs API           │  │
│                                     └───────────┬───────────┘  │
└─────────────────────────────────────────────────┼───────────────┘
                                                  │
                                                  │ Google OAuth 2.1
                                                  │ Bearer tokens
┌─────────────────────────────────────────────────▼───────────────┐
│                   Google Workspace APIs                          │
│  - OAuth 2.1 Authorization Server                               │
│  - Gmail, Drive, Calendar, Docs APIs                            │
└─────────────────────────────────────────────────────────────────┘
```

### Component Boundaries

| Component | Responsibility | Communicates With | State |
|-----------|---------------|-------------------|-------|
| **Transport Layer** | SSE connection management, keep-alive, session IDs | Protocol Handler, AI Client | Stateful (connections) |
| **Protocol Handler** | JSON-RPC 2.0 parsing, MCP lifecycle, capability negotiation | Transport Layer, Request Router | Stateless (protocol logic) |
| **OAuth Flow Manager** | PKCE authorization, token exchange, refresh logic | Request Router, Google OAuth, Token Store | Stateless (delegates to Token Store) |
| **Request Router** | Session → user mapping, tool routing, coordination | Protocol Handler, OAuth Manager, API Adapters, Token Store | Stateless (routing logic) |
| **Token Store** | Encrypted token persistence, refresh rotation | OAuth Manager, Request Router, DynamoDB, KMS | Stateful (token data) |
| **API Adapters** | Google API integration, request/response translation | Request Router, Google APIs | Stateless (API wrappers) |

### Data Flow

**Initialization Flow (First-time User):**
```
1. Cursor → Gateway: Initialize request (tools/list)
2. Gateway → Cursor: 401 Unauthorized + WWW-Authenticate header
3. Gateway → Cursor: OAuth metadata (authorization_servers)
4. Cursor → User: Open browser for Google OAuth
5. User → Google: Authenticate + consent
6. Google → Gateway: Authorization code
7. Gateway → Google: Exchange code + PKCE verifier
8. Google → Gateway: Access token + Refresh token
9. Gateway → DynamoDB: Store encrypted tokens (KMS)
10. Gateway → Cursor: MCP tools list (success)
```

**Tool Execution Flow (Authenticated User):**
```
1. Cursor → Gateway: tools/call (session ID in header)
2. Gateway: Lookup user from session ID
3. Gateway → DynamoDB: Retrieve encrypted tokens
4. Gateway → KMS: Decrypt tokens
5. Gateway: Route tool to appropriate API adapter
6. Gateway → Google API: API request (Bearer token)
7. Google API → Gateway: API response
8. Gateway: Transform response to MCP content format
9. Gateway → Cursor: Tool result (JSON-RPC response)
```

**Token Refresh Flow (Expired Access Token):**
```
1. Gateway → Google API: Request with expired token
2. Google API → Gateway: 401 Unauthorized
3. Gateway → DynamoDB: Retrieve refresh token
4. Gateway → Google: Token refresh request
5. Google → Gateway: New access + refresh tokens
6. Gateway → DynamoDB: Store new tokens, rotate refresh
7. Gateway: Retry original API request
8. Gateway → Cursor: Tool result (transparent to client)
```

## Patterns to Follow

### Pattern 1: Stateful Gateway with Session Affinity
**What:** Gateway maintains session state via `Mcp-Session-Id` headers and maps sessions to user identities.

**When:** Multi-user scenarios where each session needs isolated authentication context.

**Why:** MCP Streamable HTTP requires stateful sessions. The gateway assigns session IDs during initialization and uses them to lookup user-specific tokens.

**Example:**
```typescript
// Session initialization (Protocol Handler)
app.post("/mcp", async (req, res) => {
  if (req.body.method === "initialize") {
    const sessionId = generateSecureId(); // Cryptographically random
    const session = {
      id: sessionId,
      userId: null, // Populated after OAuth
      createdAt: Date.now(),
      lastActivity: Date.now()
    };
    await sessionStore.set(sessionId, session);

    res.setHeader("Mcp-Session-Id", sessionId);
    res.json({
      jsonrpc: "2.0",
      id: req.body.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: {
          tools: { listChanged: false },
          resources: {}
        },
        serverInfo: { name: "mcp-gateway", version: "1.0.0" }
      }
    });
  }
});

// Subsequent requests include session ID
app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const session = await sessionStore.get(sessionId);

  if (!session) {
    return res.status(401).json({
      jsonrpc: "2.0",
      id: req.body.id,
      error: { code: -32001, message: "Invalid session" }
    });
  }

  // Update activity timestamp for session timeout
  session.lastActivity = Date.now();
  await sessionStore.set(sessionId, session);

  // Route request based on session's user context
  const userId = session.userId;
  // ... rest of request handling
});
```

### Pattern 2: OAuth 2.1 with PKCE and Resource Indicators
**What:** Implement RFC 8707 Resource Indicators and OAuth 2.1 PKCE flow for token audience binding.

**When:** Gateway acts as OAuth client to Google for user authentication.

**Why:** Prevents token theft and ensures tokens are bound to the specific resource (your gateway). MCP spec requires PKCE and resource parameters.

**Example:**
```typescript
// OAuth initiation (OAuth Flow Manager)
async function initiateOAuth(sessionId: string) {
  const codeVerifier = generateCodeVerifier(); // Random 43-128 char string
  const codeChallenge = await sha256Base64Url(codeVerifier);

  // Store verifier for later exchange
  await stateStore.set(sessionId, {
    codeVerifier,
    sessionId,
    createdAt: Date.now()
  });

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", process.env.GOOGLE_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", process.env.OAUTH_REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/drive.readonly");
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("resource", "https://mcp.yourgateway.com"); // RFC 8807
  authUrl.searchParams.set("state", sessionId);

  return authUrl.toString();
}

// OAuth callback (OAuth Flow Manager)
async function handleOAuthCallback(code: string, state: string) {
  const stateData = await stateStore.get(state);
  if (!stateData) throw new Error("Invalid state");

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      code,
      code_verifier: stateData.codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: process.env.OAUTH_REDIRECT_URI,
      resource: "https://mcp.yourgateway.com" // RFC 8807
    })
  });

  const tokens = await tokenResponse.json();
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + (tokens.expires_in * 1000)
  };
}
```

### Pattern 3: Encrypted Token Storage with KMS
**What:** Store OAuth tokens in DynamoDB encrypted with AWS KMS customer-managed keys.

**When:** Multi-user gateway needs to persist tokens securely.

**Why:** Protects sensitive tokens at rest. KMS provides audit logging, key rotation, and access control policies.

**Example:**
```typescript
// Token Store component
import { DynamoDBClient, PutItemCommand, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { KMSClient, EncryptCommand, DecryptCommand } from "@aws-sdk/client-kms";

class TokenStore {
  private dynamodb: DynamoDBClient;
  private kms: KMSClient;
  private keyId: string;
  private tableName: string;

  constructor() {
    this.dynamodb = new DynamoDBClient({});
    this.kms = new KMSClient({});
    this.keyId = process.env.KMS_KEY_ID;
    this.tableName = process.env.TOKENS_TABLE_NAME;
  }

  async storeTokens(userId: string, tokens: TokenData): Promise<void> {
    // Encrypt tokens with KMS
    const encryptedAccess = await this.kms.send(new EncryptCommand({
      KeyId: this.keyId,
      Plaintext: Buffer.from(tokens.accessToken),
      EncryptionContext: { userId, tokenType: "access" }
    }));

    const encryptedRefresh = await this.kms.send(new EncryptCommand({
      KeyId: this.keyId,
      Plaintext: Buffer.from(tokens.refreshToken),
      EncryptionContext: { userId, tokenType: "refresh" }
    }));

    // Store encrypted tokens in DynamoDB
    await this.dynamodb.send(new PutItemCommand({
      TableName: this.tableName,
      Item: {
        userId: { S: userId },
        accessTokenEncrypted: { B: encryptedAccess.CiphertextBlob },
        refreshTokenEncrypted: { B: encryptedRefresh.CiphertextBlob },
        expiresAt: { N: tokens.expiresAt.toString() },
        updatedAt: { N: Date.now().toString() }
      }
    }));
  }

  async retrieveTokens(userId: string): Promise<TokenData | null> {
    const result = await this.dynamodb.send(new GetItemCommand({
      TableName: this.tableName,
      Key: { userId: { S: userId } }
    }));

    if (!result.Item) return null;

    // Decrypt tokens with KMS
    const decryptedAccess = await this.kms.send(new DecryptCommand({
      CiphertextBlob: result.Item.accessTokenEncrypted.B,
      EncryptionContext: { userId, tokenType: "access" }
    }));

    const decryptedRefresh = await this.kms.send(new DecryptCommand({
      CiphertextBlob: result.Item.refreshTokenEncrypted.B,
      EncryptionContext: { userId, tokenType: "refresh" }
    }));

    return {
      accessToken: decryptedAccess.Plaintext.toString(),
      refreshToken: decryptedRefresh.Plaintext.toString(),
      expiresAt: parseInt(result.Item.expiresAt.N)
    };
  }
}
```

### Pattern 4: Tool-to-API Mapping with Adapters
**What:** Create adapter layer that translates MCP tool calls to Google API requests.

**When:** Gateway exposes multiple Google APIs as unified MCP tools.

**Why:** Separates MCP protocol concerns from API-specific logic. Each adapter handles one API's quirks.

**Example:**
```typescript
// API Adapter interface
interface APIAdapter {
  toolNames(): string[];
  executeTool(toolName: string, args: unknown, token: string): Promise<ToolResult>;
}

// Gmail adapter
class GmailAdapter implements APIAdapter {
  toolNames() {
    return ["gmail_list_messages", "gmail_read_message", "gmail_search"];
  }

  async executeTool(toolName: string, args: any, token: string): Promise<ToolResult> {
    switch (toolName) {
      case "gmail_list_messages":
        const response = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${args.limit || 10}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const data = await response.json();
        return {
          content: [{
            type: "text",
            text: JSON.stringify(data.messages, null, 2)
          }]
        };

      case "gmail_read_message":
        const msgResponse = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${args.messageId}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const message = await msgResponse.json();
        return {
          content: [{
            type: "text",
            text: `Subject: ${message.payload.headers.find(h => h.name === "Subject").value}\n\n${message.snippet}`
          }]
        };

      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }
}

// Request Router uses adapters
class RequestRouter {
  private adapters: Map<string, APIAdapter>;

  constructor() {
    this.adapters = new Map();
    const gmailAdapter = new GmailAdapter();
    gmailAdapter.toolNames().forEach(name => {
      this.adapters.set(name, gmailAdapter);
    });
    // Register other adapters (Drive, Calendar, Docs)
  }

  async routeToolCall(toolName: string, args: unknown, userId: string): Promise<ToolResult> {
    const adapter = this.adapters.get(toolName);
    if (!adapter) throw new Error(`No adapter for tool: ${toolName}`);

    const tokens = await tokenStore.retrieveTokens(userId);
    if (!tokens) throw new Error("User not authenticated");

    // Check if token expired, refresh if needed
    if (Date.now() >= tokens.expiresAt) {
      const newTokens = await oauthManager.refreshTokens(tokens.refreshToken);
      await tokenStore.storeTokens(userId, newTokens);
      tokens.accessToken = newTokens.accessToken;
    }

    return adapter.executeTool(toolName, args, tokens.accessToken);
  }
}
```

### Pattern 5: SSE Keep-Alive and Connection Management
**What:** Implement SSE keep-alive events to prevent connection timeout through proxies/load balancers.

**When:** Using Streamable HTTP transport with SSE for server-to-client messages.

**Why:** AWS ELB and other proxies may close idle connections. Keep-alive events maintain the connection even when no MCP messages are being sent.

**Example:**
```typescript
// Transport Layer - SSE connection manager
class SSEConnectionManager {
  private connections: Map<string, Response>;
  private keepAliveInterval = 30_000; // 30 seconds

  async handleSSEConnection(sessionId: string, res: Response) {
    // Set SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // Disable nginx buffering

    this.connections.set(sessionId, res);

    // Start keep-alive interval
    const keepAlive = setInterval(() => {
      if (res.writableEnded) {
        clearInterval(keepAlive);
        this.connections.delete(sessionId);
        return;
      }

      // Send keep-alive comment (ignored by MCP clients)
      res.write(": keep-alive\n\n");
    }, this.keepAliveInterval);

    // Clean up on connection close
    res.on("close", () => {
      clearInterval(keepAlive);
      this.connections.delete(sessionId);
    });
  }

  sendEvent(sessionId: string, event: MCPMessage) {
    const res = this.connections.get(sessionId);
    if (!res) throw new Error("Connection not found");

    // Send SSE event
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
}
```

## Anti-Patterns to Avoid

### Anti-Pattern 1: Token Passthrough
**What:** Forwarding the OAuth token from one API to another without validation.

**Why bad:** Creates confused deputy vulnerabilities. If the gateway accepts tokens intended for Google and forwards them elsewhere, or accepts tokens from other services, attackers can abuse the gateway as a proxy.

**Consequences:** Security breach, unauthorized access to user data, violation of OAuth security model.

**Instead:**
- Validate that tokens are specifically issued for your gateway (audience claim)
- Never forward tokens between different APIs
- Act as OAuth client to each service independently
- Use the `resource` parameter (RFC 8807) to bind tokens to your gateway

### Anti-Pattern 2: Storing Plaintext Tokens
**What:** Storing OAuth tokens in DynamoDB without encryption.

**Why bad:** If database is compromised (misconfigured IAM, insider threat, backup leak), all user tokens are exposed.

**Consequences:** Mass account compromise, data breach, regulatory violations.

**Instead:**
- Always encrypt tokens with KMS before storage
- Use customer-managed KMS keys (not AWS-managed) for full control
- Include encryption context for additional security
- Implement key rotation policies

### Anti-Pattern 3: Shared Sessions Across Users
**What:** Using a single OAuth token or shared session for multiple users.

**Why bad:** Breaks multi-tenancy, violates privacy, causes permission issues.

**Consequences:** User A can access User B's data, audit trails are meaningless, GDPR violations.

**Instead:**
- Each session must map to a unique user
- Each user must have their own OAuth tokens
- Implement strict session isolation
- Validate user identity on every request

### Anti-Pattern 4: Synchronous Token Refresh Blocking Requests
**What:** Blocking the entire gateway while refreshing a single user's token.

**Why bad:** One expired token causes all concurrent requests to queue, degrading performance.

**Consequences:** High latency, poor user experience, potential timeouts.

**Instead:**
- Use per-user locks for token refresh (not global lock)
- Implement retry logic with exponential backoff
- Consider proactive token refresh before expiration
- Allow concurrent requests for different users

### Anti-Pattern 5: Ignoring OAuth Scope Changes
**What:** Requesting all Google scopes upfront, or never requesting additional scopes.

**Why bad:** Either over-requests permissions (privacy concern) or under-requests (tools fail at runtime).

**Consequences:** Poor user trust, failed tool executions, security audit failures.

**Instead:**
- Follow principle of least privilege
- Request minimum scopes initially
- Implement step-up authorization (RFC 8707 insufficient_scope flow)
- Handle 403 errors by requesting additional scopes
- Store scope grants per user

## Scalability Considerations

| Concern | At 100 users | At 10K users | At 1M users |
|---------|--------------|--------------|-------------|
| **Session Storage** | In-memory Redis (single instance) | Redis Cluster with persistence | ElastiCache Redis with read replicas |
| **Token Storage** | DynamoDB on-demand with default read/write | DynamoDB with provisioned capacity, DAX cache | DynamoDB global tables, multiple DAX clusters per region |
| **Connection Management** | Single ECS task (2 vCPU, 4GB) | Auto-scaling ECS tasks (5-20 tasks) | Multi-region ECS deployment with global accelerator |
| **OAuth Rate Limits** | No special handling | Per-user rate limiting, token caching | Distributed rate limiter (Redis), aggressive caching, batch operations |
| **API Adapters** | Serial API calls per request | Parallel API calls with Promise.all() | Worker pool pattern, request queuing, circuit breakers |
| **Monitoring** | CloudWatch basic metrics | Custom metrics, structured logging, alarms | Distributed tracing (X-Ray), APM tools, anomaly detection |

### Horizontal Scaling Pattern

Gateway is stateless except for active SSE connections. Scale horizontally by:

1. **Load balancer with sticky sessions:** ALB routes based on `Mcp-Session-Id` header to maintain connection affinity
2. **Shared session store:** Redis Cluster stores session metadata (session → user mapping)
3. **Shared token store:** DynamoDB stores encrypted tokens (accessible by all gateway instances)
4. **Independent instances:** Each ECS task handles subset of connections

```typescript
// Example: Session affinity with ALB
// ALB Target Group Stickiness: enabled, cookie name: "AWSALB"
// All requests with same Mcp-Session-Id go to same ECS task

// Each gateway instance is stateless for request handling
app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];

  // Fetch session from shared Redis (not local memory)
  const session = await redisCluster.get(`session:${sessionId}`);

  // Fetch tokens from shared DynamoDB (not local cache)
  const tokens = await tokenStore.retrieveTokens(session.userId);

  // Process request (stateless logic)
  const result = await requestRouter.route(req.body, tokens);
  res.json(result);
});
```

## Build Order Recommendations

Based on component dependencies, implement in this order:

### Phase 1: Core MCP Protocol (No OAuth)
**Goal:** Handle MCP protocol lifecycle and echo tool calls

1. Transport Layer (HTTP/SSE server)
2. Protocol Handler (JSON-RPC 2.0 parsing)
3. Request Router (stub - echo responses)
4. Basic tool registry (hardcoded list)

**Why first:** Establishes MCP communication before adding OAuth complexity. Can test with Cursor immediately.

### Phase 2: OAuth Integration (Single User)
**Goal:** Add Google OAuth for one user (no multi-tenancy yet)

5. OAuth Flow Manager (PKCE flow)
6. Token Store (DynamoDB + KMS, single user)
7. Session → user mapping (hardcoded single user)

**Why second:** Proves OAuth works before scaling to multi-user.

### Phase 3: Multi-User Support
**Goal:** Support multiple concurrent users with session isolation

8. Session Store (Redis or DynamoDB)
9. Session → user mapping (dynamic lookup)
10. Per-user token isolation
11. OAuth state management (multiple parallel flows)

**Why third:** Builds on working OAuth to add multi-tenancy.

### Phase 4: Google API Integration
**Goal:** Real tool implementations calling Google APIs

12. API Adapters (Gmail, Drive, Calendar, Docs)
13. Token refresh logic
14. Error handling (401, 403, rate limits)
15. Tool → adapter routing

**Why fourth:** Requires OAuth tokens and multi-user infrastructure.

### Phase 5: Production Hardening
**Goal:** Observability, resilience, security

16. Logging and tracing (structured logs, X-Ray)
17. Rate limiting (per-user)
18. Circuit breakers (API failures)
19. Metrics and alarms
20. Security hardening (HTTPS, origin validation, session timeouts)

**Why last:** Builds on stable foundation, adds production requirements.

## Sources

**HIGH Confidence Sources:**
- [MCP Specification - Authorization](https://modelcontextprotocol.io/specification/draft/basic/authorization) - Official OAuth 2.1 requirements for MCP
- [MCP Specification - Transports](https://modelcontextprotocol.io/legacy/concepts/transports) - Official transport layer documentation
- [MCP Specification - Architecture Overview](https://modelcontextprotocol.io/docs/learn/architecture) - Official architecture patterns
- [AWS DynamoDB Encryption Best Practices](https://docs.aws.amazon.com/prescriptive-guidance/latest/encryption-best-practices/dynamodb.html) - Official AWS guidance

**MEDIUM Confidence Sources:**
- [IBM MCP Context Forge Architecture](https://ibm.github.io/mcp-context-forge/) - Production gateway reference implementation
- [WorkOS: How MCP Servers Work](https://workos.com/blog/how-mcp-servers-work) - Component architecture analysis
- [AIM Multiple: Centralizing AI Tool Access](https://research.aimultiple.com/mcp-gateway/) - Gateway patterns and multi-user support
- [Stytch: OAuth for MCP](https://stytch.com/blog/oauth-for-mcp-explained-with-a-real-world-example/) - OAuth integration patterns
- [Understanding SSE with Node.js](https://itsfuad.medium.com/understanding-server-sent-events-sse-with-node-js-3e881c533081) - SSE implementation patterns
- [Why SSE Beat WebSockets for Cloud Apps](https://medium.com/codetodeploy/why-server-sent-events-beat-websockets-for-95-of-real-time-cloud-applications-830eff5a1d7c) - SSE architecture considerations

**LOW Confidence Sources:**
- [MCP Gateways Guide](https://composio.dev/blog/mcp-gateways-guide) - Gateway concepts (content not fully accessible)
- Community discussions on MCP multi-user patterns (WebSearch results)
