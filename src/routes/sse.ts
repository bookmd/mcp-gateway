import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { getMcpServer } from '../mcp/server.js';
import { requireAuth, UserContext } from '../auth/middleware.js';
import { randomUUID } from 'crypto';

// Session timeout: 30 minutes of inactivity
const SESSION_TTL_MS = 30 * 60 * 1000;

// Track active connections for debugging
const activeConnections = new Map<string, { email: string; connectedAt: number }>();

// Track transports by sessionId for message routing
const activeTransports = new Map<string, SSEServerTransport>();

// Track user context by MCP sessionId for handler access
const sessionUserContexts = new Map<string, UserContext>();

// Track last activity time per session for TTL cleanup
const sessionLastActivity = new Map<string, number>();

// Cleanup stale sessions periodically (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  let cleanedCount = 0;
  for (const [sessionId, lastActivity] of sessionLastActivity) {
    if (now - lastActivity > SESSION_TTL_MS) {
      console.log(`[MCP] Cleaning up stale session: ${sessionId} (inactive for ${Math.round((now - lastActivity) / 1000)}s)`);
      activeTransports.delete(sessionId);
      sessionUserContexts.delete(sessionId);
      sessionLastActivity.delete(sessionId);
      cleanedCount++;
    }
  }
  if (cleanedCount > 0) {
    console.log(`[MCP] Cleaned up ${cleanedCount} stale sessions`);
  }
}, 5 * 60 * 1000);

/**
 * Update session activity timestamp
 */
function touchSession(sessionId: string): void {
  sessionLastActivity.set(sessionId, Date.now());
}

/**
 * Get active MCP transports for graceful shutdown
 * Used by server.ts to close all connections during SIGTERM
 */
export function getActiveTransports(): Map<string, SSEServerTransport> {
  return activeTransports;
}

/**
 * Get user context by MCP session ID
 * Used by MCP handlers to access authenticated user's credentials
 */
export function getUserContextBySessionId(sessionId: string): UserContext | undefined {
  return sessionUserContexts.get(sessionId);
}

// Shared handler for Streamable HTTP POST requests
// Used by both /mcp and /mcp/sse endpoints
//
// IMPORTANT: This follows the MCP SDK pattern for stateful Streamable HTTP:
// 1. New transports are ONLY created for initialization requests
// 2. Existing transports are reused for follow-up requests with valid session IDs
// 3. Requests with invalid/missing session IDs that aren't initialize requests are rejected
async function handleStreamableHttpPost(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const userContext = request.userContext!;

    // Get session ID from request headers (if this is a follow-up request)
    const incomingSessionId = request.headers['mcp-session-id'] as string | undefined;

    let transport: StreamableHTTPServerTransport;
    let mcpSessionId: string;

    // Case 1: Existing session - reuse transport
    if (incomingSessionId && activeTransports.has(incomingSessionId)) {
      transport = activeTransports.get(incomingSessionId) as any;
      mcpSessionId = incomingSessionId;

      // Update session activity timestamp
      touchSession(mcpSessionId);

      const method = (request.body as any)?.method || 'unknown';
      console.log(`[MCP] Reusing session: ${incomingSessionId} (${userContext.email}) method: ${method}`);

      // Handle the request with existing transport - no reconnect needed
      try {
        await transport.handleRequest(request.raw, reply.raw, request.body);
        console.log(`[MCP] Request handled for session: ${mcpSessionId}`);
      } catch (error) {
        console.error(`[MCP] Error handling request:`, error);
        if (!reply.raw.headersSent) {
          reply.code(500).send({ error: 'Request handling failed' });
        }
      }
      return;
    }

    // Case 2: New session - must be an initialization request
    if (!isInitializeRequest(request.body)) {
      // Not an initialize request and no valid session - reject
      console.log(`[MCP] Rejecting non-initialize request without valid session (${userContext.email})`);
      console.log(`[MCP] Request body method: ${(request.body as any)?.method || 'unknown'}`);

      if (incomingSessionId) {
        // Client sent a session ID but it's not in our map (expired/lost)
        // Return 404 per MCP spec - client should reinitialize
        reply.raw.writeHead(404, { 'Content-Type': 'application/json' });
        reply.raw.end(JSON.stringify({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Session not found. Please reinitialize the connection.'
          },
          id: (request.body as any)?.id ?? null
        }));
      } else {
        // No session ID and not an initialize request - bad request
        reply.raw.writeHead(400, { 'Content-Type': 'application/json' });
        reply.raw.end(JSON.stringify({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: No valid session ID provided. Send an initialize request first.'
          },
          id: (request.body as any)?.id ?? null
        }));
      }
      return;
    }

    // Case 3: New initialization request - create transport
    const connectionId = `conn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    console.log(`[MCP] Creating new Streamable HTTP transport: ${connectionId} (${userContext.email})`);

    // Generate sessionId - will be set by onsessioninitialized callback
    mcpSessionId = randomUUID();

    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => mcpSessionId,
      // Use the onsessioninitialized callback to track transport AFTER session is initialized
      // This avoids race conditions
      onsessioninitialized: (sessionId: string) => {
        console.log(`[MCP] Session initialized: ${sessionId} (${userContext.email})`);
        activeTransports.set(sessionId, transport as any);
        sessionUserContexts.set(sessionId, userContext);
        touchSession(sessionId);
      }
    });

    // Attach user context to transport for MCP handlers
    (transport as any).userContext = userContext;

    // Track connection with user info
    activeConnections.set(connectionId, {
      email: userContext.email,
      connectedAt: Date.now()
    });

    // Connect MCP server to this NEW transport BEFORE handling the request
    const mcpServer = getMcpServer();
    try {
      await mcpServer.connect(transport);
      console.log(`[MCP] MCP server connected to transport: ${mcpSessionId}`);
    } catch (error) {
      console.error(`[MCP] Failed to connect MCP server to transport:`, error);
      activeConnections.delete(connectionId);
      if (!reply.raw.headersSent) {
        return reply.code(500).send({ error: 'Failed to initialize MCP connection' });
      }
      return;
    }

    // Set up disconnect handler for cleanup
    request.raw.on('close', () => {
      const duration = Date.now() - (activeConnections.get(connectionId)?.connectedAt || Date.now());
      console.log(`[MCP] Streamable HTTP connection closed: ${connectionId} (${userContext.email}) session: ${mcpSessionId} after ${Math.round(duration/1000)}s`);
      activeConnections.delete(connectionId);
      // Note: We don't delete the transport/session on HTTP close because
      // Streamable HTTP is request/response based - the session persists across requests
    });

    // Handle the initialization request
    try {
      await transport.handleRequest(request.raw, reply.raw, request.body);
      console.log(`[MCP] Initialize request handled, session: ${mcpSessionId}`);
    } catch (error) {
      console.error(`[MCP] Error handling initialize request:`, error);
      // Clean up on error
      activeTransports.delete(mcpSessionId);
      sessionUserContexts.delete(mcpSessionId);
      activeConnections.delete(connectionId);
      if (!reply.raw.headersSent) {
        reply.code(500).send({ error: 'Request handling failed' });
      }
    }
}

// Shared handler for SSE GET requests
// Used by both /mcp and /mcp/sse endpoints
async function handleSseGet(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const connectionId = `conn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const userContext = request.userContext!;

    console.log(`[MCP] Authenticated SSE connection: ${connectionId} (${userContext.email})`);

    // Create SSE transport - SDK will handle headers
    // NOTE: Do NOT write headers manually - SSEServerTransport does it in start()
    const transport = new SSEServerTransport('/mcp/message', reply.raw);

    // Attach user context to transport for MCP handlers
    (transport as any).userContext = userContext;

    // Get the SDK-generated sessionId and track the transport + user context
    const mcpSessionId = transport.sessionId;
    activeTransports.set(mcpSessionId, transport);
    sessionUserContexts.set(mcpSessionId, userContext);
    console.log(`[MCP] Transport sessionId: ${mcpSessionId}`);

    // Track connection with user info
    activeConnections.set(connectionId, {
      email: userContext.email,
      connectedAt: Date.now()
    });

    // Connect MCP server to this transport
    const mcpServer = getMcpServer();

    try {
      await mcpServer.connect(transport);
      console.log(`[MCP] Client connected: ${connectionId} (${userContext.email})`);
    } catch (error) {
      console.error(`[MCP] Connection error: ${connectionId}`, error);
      activeConnections.delete(connectionId);
      activeTransports.delete(mcpSessionId);
      sessionUserContexts.delete(mcpSessionId);
      if (!reply.raw.headersSent) {
        reply.raw.end();
      }
      return;
    }

    // SSE Keep-Alive: Send comment lines every 10 seconds
    // Very aggressive keepalive to prevent any proxy/load balancer timeouts
    const keepAliveInterval = setInterval(() => {
      try {
        if (reply.raw.writableEnded || reply.raw.destroyed) {
          clearInterval(keepAliveInterval);
          return;
        }
        // Send SSE comment (ignored by clients, keeps connection alive)
        reply.raw.write(': keep-alive\n\n');
        console.log(`[MCP] Keepalive sent for ${connectionId}`);
      } catch (error) {
        console.error(`[MCP] Keep-alive error for ${connectionId}:`, error);
        clearInterval(keepAliveInterval);
      }
    }, 10000); // 10 seconds

    // Handle disconnect
    request.raw.on('close', () => {
      const duration = Date.now() - (activeConnections.get(connectionId)?.connectedAt || Date.now());
      console.log(`[MCP] Client disconnected: ${connectionId} (${userContext.email}) after ${Math.round(duration/1000)}s`);
      clearInterval(keepAliveInterval);
      activeConnections.delete(connectionId);
      activeTransports.delete(mcpSessionId);
      sessionUserContexts.delete(mcpSessionId);
      transport.close?.();
    });

    // Keep connection alive - don't return/end reply
}

export async function sseRoutes(app: FastifyInstance): Promise<void> {
  // ============================================================
  // /mcp routes - Primary endpoint (clean URL for Cursor/clients)
  // ============================================================

  // POST /mcp - Streamable HTTP endpoint (primary)
  app.post('/mcp', { preHandler: requireAuth }, handleStreamableHttpPost);

  // GET /mcp - SSE endpoint for server-initiated messages (primary)
  app.get('/mcp', { preHandler: requireAuth }, handleSseGet);

  // ============================================================
  // /mcp/sse routes - Legacy endpoint (backwards compatibility)
  // ============================================================

  // POST /mcp/sse - Streamable HTTP endpoint (legacy)
  app.post('/mcp/sse', { preHandler: requireAuth }, handleStreamableHttpPost);

  // GET /mcp/sse - SSE endpoint (legacy)
  app.get('/mcp/sse', { preHandler: requireAuth }, handleSseGet);

  // GET /mcp/status - Connection status (authenticated, for debugging)
  app.get('/mcp/status', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userContext = request.userContext!;
    const now = Date.now();
    return {
      currentUser: userContext.email,
      activeConnections: activeConnections.size,
      activeSessions: activeTransports.size,
      sessionTtlMs: SESSION_TTL_MS,
      connections: Array.from(activeConnections.entries()).map(([id, info]) => ({
        id,
        ...info,
        duration: now - info.connectedAt
      })),
      sessions: Array.from(sessionUserContexts.entries()).map(([sessionId, ctx]) => ({
        sessionId: sessionId.substring(0, 8) + '...',
        email: ctx.email,
        lastActivity: sessionLastActivity.get(sessionId),
        idleMs: now - (sessionLastActivity.get(sessionId) || now),
        ttlRemainingMs: SESSION_TTL_MS - (now - (sessionLastActivity.get(sessionId) || now))
      }))
    };
  });

  // POST /mcp/message - Message endpoint for SSE transport
  // The SSE transport directs clients to POST messages here
  app.post('/mcp/message', async (request: FastifyRequest, reply: FastifyReply) => {
    // Parse the session ID from query
    const sessionId = (request.query as any)?.sessionId;

    if (!sessionId) {
      reply.raw.writeHead(400, { 'Content-Type': 'application/json' });
      reply.raw.end(JSON.stringify({
        error: 'bad_request',
        message: 'Missing sessionId parameter'
      }));
      return;
    }

    // Find the transport for this session
    const transport = activeTransports.get(sessionId);

    if (!transport) {
      reply.raw.writeHead(404, { 'Content-Type': 'application/json' });
      reply.raw.end(JSON.stringify({
        error: 'session_not_found',
        message: 'No active SSE connection for this sessionId. Connect to /mcp/sse first.'
      }));
      return;
    }

    // Route the message to the transport
    // Pass the already-parsed body to avoid stream encoding issues with Fastify
    try {
      await transport.handlePostMessage(request.raw, reply.raw, request.body);
    } catch (error) {
      console.error('[MCP] Error handling message:', error);
      // Don't send error response - transport already handled it
    }
  });
}
