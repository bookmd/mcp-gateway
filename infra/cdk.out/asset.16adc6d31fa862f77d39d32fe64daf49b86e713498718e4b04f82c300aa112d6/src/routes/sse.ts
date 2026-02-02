import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { getMcpServer } from '../mcp/server.js';
import { requireAuth, UserContext } from '../auth/middleware.js';

// Track active connections for debugging
const activeConnections = new Map<string, { email: string; connectedAt: number }>();

// Track transports by sessionId for message routing
const activeTransports = new Map<string, SSEServerTransport>();

// Track user context by MCP sessionId for handler access
const sessionUserContexts = new Map<string, UserContext>();

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

export async function sseRoutes(app: FastifyInstance): Promise<void> {
  // POST /mcp/sse - Streamable HTTP endpoint for MCP connections (authenticated, preferred)
  // This handler manages stateful Streamable HTTP transport instances per session
  app.post('/mcp/sse', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userContext = request.userContext!;
    
    // Get session ID from request headers (if this is a follow-up request)
    const incomingSessionId = request.headers['mcp-session-id'] as string | undefined;
    
    let transport: StreamableHTTPServerTransport;
    let mcpSessionId: string;
    let isNewConnection = false;
    
    // Check if we have an existing transport for this session
    if (incomingSessionId && activeTransports.has(incomingSessionId)) {
      transport = activeTransports.get(incomingSessionId) as any;
      mcpSessionId = incomingSessionId;
      console.log(`[MCP] Reusing existing transport: ${incomingSessionId} (${userContext.email})`);
    } else {
      // Create new transport for first request
      const connectionId = `conn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      isNewConnection = true;
      
      console.log(`[MCP] Creating new Streamable HTTP transport: ${connectionId} (${userContext.email})`);
      
      // Generate our own sessionId and pass it to the transport
      const crypto = await import('crypto');
      mcpSessionId = crypto.randomUUID();
      
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => mcpSessionId
      });
      
      // Attach user context to transport for MCP handlers
      (transport as any).userContext = userContext;
      
      // Track the transport + user context with our generated sessionId
      activeTransports.set(mcpSessionId, transport as any);
      sessionUserContexts.set(mcpSessionId, userContext);
      console.log(`[MCP] New transport sessionId: ${mcpSessionId}`);
      
      // Track connection with user info
      activeConnections.set(connectionId, {
        email: userContext.email,
        connectedAt: Date.now()
      });
      
      // Connect MCP server to this NEW transport
      const mcpServer = getMcpServer();
      try {
        await mcpServer.connect(transport);
        console.log(`[MCP] MCP server connected to transport: ${mcpSessionId}`);
      } catch (error) {
        console.error(`[MCP] Failed to connect MCP server to transport:`, error);
        activeTransports.delete(mcpSessionId);
        sessionUserContexts.delete(mcpSessionId);
        activeConnections.delete(connectionId);
        if (!reply.raw.headersSent) {
          return reply.code(500).send({ error: 'Failed to initialize MCP connection' });
        }
        return;
      }
    }
    
    // Handle the HTTP request (works for both initial and follow-up requests)
    try {
      await transport.handleRequest(request.raw, reply.raw, request.body);
      console.log(`[MCP] Request handled for session: ${mcpSessionId}`);
    } catch (error) {
      console.error(`[MCP] Error handling request:`, error);
      // Clean up on error
      activeTransports.delete(mcpSessionId);
      sessionUserContexts.delete(mcpSessionId);
      // Find and delete connection by transport
      for (const [connId, info] of activeConnections) {
        if (info.email === userContext.email) {
          activeConnections.delete(connId);
          break;
        }
      }
      if (!reply.raw.headersSent) {
        reply.code(500).send({ error: 'Request handling failed' });
      }
    }
  });

  // GET /mcp/sse - SSE endpoint for MCP connections (authenticated, fallback)
  app.get('/mcp/sse', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const connectionId = `conn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const userContext = request.userContext!;

    console.log(`[MCP] Authenticated SSE connection: ${connectionId} (${userContext.email})`);

    // Create SSE transport - SDK will generate its own sessionId
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
      reply.raw.end();
      return;
    }

    // Handle disconnect
    request.raw.on('close', () => {
      console.log(`[MCP] Client disconnected: ${connectionId} (${userContext.email})`);
      activeConnections.delete(connectionId);
      activeTransports.delete(mcpSessionId);
      sessionUserContexts.delete(mcpSessionId);
      transport.close?.();
    });

    // Keep connection alive - don't return/end reply
  });

  // GET /mcp/status - Connection status (authenticated, for debugging)
  app.get('/mcp/status', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userContext = request.userContext!;
    return {
      currentUser: userContext.email,
      activeConnections: activeConnections.size,
      connections: Array.from(activeConnections.entries()).map(([id, info]) => ({
        id,
        ...info,
        duration: Date.now() - info.connectedAt
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
