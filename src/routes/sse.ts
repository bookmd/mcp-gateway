import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
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
  // GET /mcp/sse - SSE endpoint for MCP connections (authenticated)
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
