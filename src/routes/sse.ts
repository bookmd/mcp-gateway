import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { getMcpServer } from '../mcp/server.js';

// Track active connections for debugging
const activeConnections = new Map<string, { email?: string; connectedAt: number }>();

export async function sseRoutes(app: FastifyInstance): Promise<void> {
  // GET /mcp/sse - SSE endpoint for MCP connections
  // Note: Authentication will be added in Plan 03
  app.get('/mcp/sse', async (request: FastifyRequest, reply: FastifyReply) => {
    const connectionId = `conn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    console.log(`[MCP] New SSE connection: ${connectionId}`);

    // Create SSE transport
    const transport = new SSEServerTransport('/mcp/message', reply.raw);

    // Track connection
    activeConnections.set(connectionId, {
      connectedAt: Date.now()
    });

    // Connect MCP server to this transport
    const mcpServer = getMcpServer();

    try {
      await mcpServer.connect(transport);
      console.log(`[MCP] Client connected: ${connectionId}`);
    } catch (error) {
      console.error(`[MCP] Connection error: ${connectionId}`, error);
      activeConnections.delete(connectionId);
      reply.raw.end();
      return;
    }

    // Handle disconnect
    request.raw.on('close', () => {
      console.log(`[MCP] Client disconnected: ${connectionId}`);
      activeConnections.delete(connectionId);
      transport.close?.();
    });

    // Keep connection alive - don't return/end reply
  });

  // GET /mcp/status - Connection status (for debugging)
  app.get('/mcp/status', async (request: FastifyRequest, reply: FastifyReply) => {
    return {
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
    // Parse the session ID from query or header
    const sessionId = (request.query as any)?.sessionId || request.headers['x-session-id'];

    if (!sessionId) {
      return reply.code(400).send({
        error: 'bad_request',
        message: 'Missing sessionId parameter'
      });
    }

    // Find the transport for this session
    // Note: In the current implementation, we need to track transports by sessionId
    // For now, return 501 as we need to enhance connection tracking
    return reply.code(501).send({
      error: 'not_implemented',
      message: 'POST message routing - will implement based on actual SDK transport flow'
    });
  });
}
