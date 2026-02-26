import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { getMcpServer } from '../mcp/server.js';
import { requireAuth, UserContext } from '../auth/middleware.js';
import { randomUUID } from 'crypto';

// ============================================================
// RELIABILITY CONSTANTS
// ============================================================

// Session timeout: 30 minutes of inactivity
const SESSION_TTL_MS = 30 * 60 * 1000;

// Keep-alive interval: 5 seconds (aggressive to prevent any proxy/LB timeout)
// ALB timeout is 300s, Cloudflare is 100s, so 5s gives us huge safety margin
const KEEPALIVE_INTERVAL_MS = 5000;

// Connection health tracking
interface ConnectionInfo {
  email: string;
  connectedAt: number;
  lastKeepaliveAt: number;
  keepaliveCount: number;
  type: 'sse' | 'streamable-http';
}

// SSE connection tracking with health metrics
interface SseConnectionInfo extends ConnectionInfo {
  type: 'sse';
  connectionHealthy: boolean;
}

// ============================================================
// CONNECTION TRACKING
// ============================================================

// Track active connections for debugging and health monitoring
const activeConnections = new Map<string, ConnectionInfo>();

// Track SSE connections separately for health monitoring
const activeSseConnections = new Map<string, SseConnectionInfo>();

// Track transports by sessionId for message routing
const activeTransports = new Map<string, SSEServerTransport>();

// Track user context by MCP sessionId for handler access
const sessionUserContexts = new Map<string, UserContext>();

// Track last activity time per session for TTL cleanup
const sessionLastActivity = new Map<string, number>();

// ============================================================
// METRICS (for observability)
// ============================================================

interface ConnectionMetrics {
  totalConnections: number;
  totalDisconnections: number;
  totalKeepalivesSent: number;
  totalKeepaliveErrors: number;
  longestConnectionMs: number;
  averageConnectionMs: number;
  connectionDurations: number[]; // Last 100 connection durations
}

const metrics: ConnectionMetrics = {
  totalConnections: 0,
  totalDisconnections: 0,
  totalKeepalivesSent: 0,
  totalKeepaliveErrors: 0,
  longestConnectionMs: 0,
  averageConnectionMs: 0,
  connectionDurations: []
};

/**
 * Record a connection duration for metrics
 */
function recordConnectionDuration(durationMs: number): void {
  metrics.connectionDurations.push(durationMs);
  // Keep only last 100
  if (metrics.connectionDurations.length > 100) {
    metrics.connectionDurations.shift();
  }
  // Update metrics
  if (durationMs > metrics.longestConnectionMs) {
    metrics.longestConnectionMs = durationMs;
  }
  if (metrics.connectionDurations.length > 0) {
    metrics.averageConnectionMs = metrics.connectionDurations.reduce((a, b) => a + b, 0) / metrics.connectionDurations.length;
  }
}

/**
 * Get current metrics snapshot
 */
export function getConnectionMetrics(): ConnectionMetrics & { activeSseConnections: number; activeHttpSessions: number } {
  return {
    ...metrics,
    activeSseConnections: activeSseConnections.size,
    activeHttpSessions: activeTransports.size
  };
}

/**
 * Get SSE health metrics for CloudWatch
 */
export function getSseHealthMetrics(): { unhealthyConnections: number; staleConnections: number } {
  const now = Date.now();

  // Count unhealthy connections (marked as not healthy)
  const unhealthyConnections = Array.from(activeSseConnections.values())
    .filter(conn => !conn.connectionHealthy).length;

  // Count stale connections (no keepalive in last 30 seconds)
  const staleConnections = Array.from(activeSseConnections.values())
    .filter(conn => now - conn.lastKeepaliveAt > 30000).length;

  return { unhealthyConnections, staleConnections };
}

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
  const context = sessionUserContexts.get(sessionId);
  if (!context) {
    console.warn(`[MCP] getUserContextBySessionId: Session ${sessionId} not found. Active sessions: ${sessionUserContexts.size}`);
    // Log available session IDs (truncated for security)
    const sessionIds = Array.from(sessionUserContexts.keys()).map(id => id.substring(0, 8) + '...');
    console.warn(`[MCP] Available sessions: [${sessionIds.join(', ')}]`);
  }
  return context;
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
    const connectionId = `http-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    console.log(`[MCP/HTTP] Creating new Streamable HTTP transport: ${connectionId} (${userContext.email})`);

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
    const connectedAt = Date.now();
    activeConnections.set(connectionId, {
      email: userContext.email,
      connectedAt,
      lastKeepaliveAt: connectedAt,
      keepaliveCount: 0,
      type: 'streamable-http'
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
    const connectionId = `sse-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const userContext = request.userContext!;
    const connectedAt = Date.now();

    console.log(`[MCP/SSE] ══════════════════════════════════════════════════════`);
    console.log(`[MCP/SSE] NEW CONNECTION: ${connectionId}`);
    console.log(`[MCP/SSE] User: ${userContext.email}`);
    console.log(`[MCP/SSE] Time: ${new Date().toISOString()}`);
    console.log(`[MCP/SSE] ══════════════════════════════════════════════════════`);

    // Update metrics
    metrics.totalConnections++;

    // Create SSE transport - SDK will handle headers
    // NOTE: Do NOT write headers manually - SSEServerTransport does it in start()
    const transport = new SSEServerTransport('/mcp/message', reply.raw);

    // Attach user context to transport for MCP handlers
    (transport as any).userContext = userContext;

    // Get the SDK-generated sessionId and track the transport + user context
    const mcpSessionId = transport.sessionId;
    activeTransports.set(mcpSessionId, transport);
    sessionUserContexts.set(mcpSessionId, userContext);
    console.log(`[MCP/SSE] Session ID: ${mcpSessionId}`);

    // Track SSE connection with health info
    const sseConnInfo: SseConnectionInfo = {
      email: userContext.email,
      connectedAt,
      lastKeepaliveAt: connectedAt,
      keepaliveCount: 0,
      type: 'sse',
      connectionHealthy: true
    };
    activeSseConnections.set(connectionId, sseConnInfo);
    activeConnections.set(connectionId, sseConnInfo);

    // Connect MCP server to this transport
    const mcpServer = getMcpServer();

    try {
      await mcpServer.connect(transport);
      console.log(`[MCP/SSE] MCP server connected: ${connectionId} (${userContext.email})`);
    } catch (error) {
      console.error(`[MCP/SSE] Connection error: ${connectionId}`, error);
      activeSseConnections.delete(connectionId);
      activeConnections.delete(connectionId);
      activeTransports.delete(mcpSessionId);
      sessionUserContexts.delete(mcpSessionId);
      if (!reply.raw.headersSent) {
        reply.raw.end();
      }
      return;
    }

    // ============================================================
    // ENHANCED KEEP-ALIVE WITH HEALTH MONITORING
    // ============================================================
    let keepaliveFailures = 0;
    const MAX_KEEPALIVE_FAILURES = 3;

    const keepAliveInterval = setInterval(() => {
      const now = Date.now();
      const connectionDuration = now - connectedAt;

      try {
        // Check if connection is still writable
        if (reply.raw.writableEnded || reply.raw.destroyed) {
          console.log(`[MCP/SSE] Connection no longer writable: ${connectionId} (destroyed=${reply.raw.destroyed}, ended=${reply.raw.writableEnded})`);
          clearInterval(keepAliveInterval);
          sseConnInfo.connectionHealthy = false;
          return;
        }

        // Check socket state
        const socket = reply.raw.socket;
        if (!socket || socket.destroyed || !socket.writable) {
          console.log(`[MCP/SSE] Socket unhealthy: ${connectionId} (socket=${!!socket}, destroyed=${socket?.destroyed}, writable=${socket?.writable})`);
          clearInterval(keepAliveInterval);
          sseConnInfo.connectionHealthy = false;
          return;
        }

        // Send SSE comment (ignored by clients, keeps connection alive)
        const keepaliveData = `: keepalive ${sseConnInfo.keepaliveCount + 1} t=${Math.round(connectionDuration/1000)}s\n\n`;
        const writeSuccess = reply.raw.write(keepaliveData);

        if (!writeSuccess) {
          // Write buffer is full - connection might be stalled
          keepaliveFailures++;
          console.warn(`[MCP/SSE] Write buffer full (attempt ${keepaliveFailures}/${MAX_KEEPALIVE_FAILURES}): ${connectionId}`);

          if (keepaliveFailures >= MAX_KEEPALIVE_FAILURES) {
            console.error(`[MCP/SSE] Too many keepalive failures, marking unhealthy: ${connectionId}`);
            sseConnInfo.connectionHealthy = false;
            clearInterval(keepAliveInterval);
            return;
          }
        } else {
          keepaliveFailures = 0; // Reset on success
        }

        // Update tracking
        sseConnInfo.keepaliveCount++;
        sseConnInfo.lastKeepaliveAt = now;
        metrics.totalKeepalivesSent++;

        // Log every 12th keepalive (every minute at 5s interval) to reduce noise
        if (sseConnInfo.keepaliveCount % 12 === 0) {
          console.log(`[MCP/SSE] Keepalive #${sseConnInfo.keepaliveCount} for ${connectionId} (${userContext.email}) - ${Math.round(connectionDuration/1000)}s connected`);
        }

      } catch (error) {
        metrics.totalKeepaliveErrors++;
        console.error(`[MCP/SSE] Keep-alive error for ${connectionId}:`, error);
        sseConnInfo.connectionHealthy = false;
        clearInterval(keepAliveInterval);
      }
    }, KEEPALIVE_INTERVAL_MS);

    // ============================================================
    // DISCONNECT HANDLER WITH METRICS
    // ============================================================
    request.raw.on('close', () => {
      const duration = Date.now() - connectedAt;
      const keepalivesSent = sseConnInfo.keepaliveCount;

      console.log(`[MCP/SSE] ──────────────────────────────────────────────────────`);
      console.log(`[MCP/SSE] DISCONNECTED: ${connectionId}`);
      console.log(`[MCP/SSE] User: ${userContext.email}`);
      console.log(`[MCP/SSE] Session: ${mcpSessionId}`);
      console.log(`[MCP/SSE] Duration: ${Math.round(duration/1000)}s`);
      console.log(`[MCP/SSE] Keepalives sent: ${keepalivesSent}`);
      console.log(`[MCP/SSE] Was healthy: ${sseConnInfo.connectionHealthy}`);
      console.log(`[MCP/SSE] ──────────────────────────────────────────────────────`);

      // Update metrics
      metrics.totalDisconnections++;
      recordConnectionDuration(duration);

      // Cleanup SSE-specific tracking only
      clearInterval(keepAliveInterval);
      activeSseConnections.delete(connectionId);
      activeConnections.delete(connectionId);

      // IMPORTANT: Do NOT delete activeTransports or sessionUserContexts here!
      // The session remains valid for Streamable HTTP requests even after SSE disconnects.
      // Clients may reconnect SSE while continuing to send POST requests with the same session ID.
      // Session cleanup is handled by the TTL cleanup interval (sessionLastActivity).
      //
      // Previous bug: Deleting the session here caused "Found 0 tools" errors because
      // Cursor would send POST requests with the old session ID after SSE reconnected,
      // but we had already deleted the session context.
      console.log(`[MCP/SSE] Session ${mcpSessionId} preserved for Streamable HTTP requests`);

      // Update last activity so TTL cleanup knows this session was recently active
      touchSession(mcpSessionId);

      transport.close?.();
    });

    // Handle errors on the underlying socket
    reply.raw.on('error', (error) => {
      console.error(`[MCP/SSE] Response error for ${connectionId}:`, error);
      sseConnInfo.connectionHealthy = false;
    });

    request.raw.on('error', (error) => {
      console.error(`[MCP/SSE] Request error for ${connectionId}:`, error);
      sseConnInfo.connectionHealthy = false;
    });

    // Keep connection alive - don't return/end reply
    console.log(`[MCP/SSE] Connection established, keepalive interval: ${KEEPALIVE_INTERVAL_MS}ms`);
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
      activeSseConnections: activeSseConnections.size,
      activeSessions: activeTransports.size,
      sessionTtlMs: SESSION_TTL_MS,
      keepaliveIntervalMs: KEEPALIVE_INTERVAL_MS,
      metrics: getConnectionMetrics(),
      sseConnections: Array.from(activeSseConnections.entries()).map(([id, info]) => ({
        id,
        email: info.email,
        connectedAt: info.connectedAt,
        durationMs: now - info.connectedAt,
        durationFormatted: `${Math.round((now - info.connectedAt)/1000)}s`,
        lastKeepaliveAt: info.lastKeepaliveAt,
        keepaliveCount: info.keepaliveCount,
        connectionHealthy: info.connectionHealthy,
        timeSinceLastKeepaliveMs: now - info.lastKeepaliveAt
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

  // GET /mcp/health - Public health check for connection reliability
  // Can be used by monitoring systems to verify SSE capability
  app.get('/mcp/health', async (request: FastifyRequest, reply: FastifyReply) => {
    const now = Date.now();
    const currentMetrics = getConnectionMetrics();

    // Check for unhealthy connections
    const unhealthyConnections = Array.from(activeSseConnections.values())
      .filter(conn => !conn.connectionHealthy).length;

    // Check for stale connections (no keepalive in last 30 seconds)
    const staleConnections = Array.from(activeSseConnections.values())
      .filter(conn => now - conn.lastKeepaliveAt > 30000).length;

    const healthy = unhealthyConnections === 0 && staleConnections === 0;

    return {
      status: healthy ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      activeSseConnections: currentMetrics.activeSseConnections,
      activeHttpSessions: currentMetrics.activeHttpSessions,
      unhealthyConnections,
      staleConnections,
      keepaliveIntervalMs: KEEPALIVE_INTERVAL_MS,
      metrics: {
        totalConnections: currentMetrics.totalConnections,
        totalDisconnections: currentMetrics.totalDisconnections,
        totalKeepalivesSent: currentMetrics.totalKeepalivesSent,
        totalKeepaliveErrors: currentMetrics.totalKeepaliveErrors,
        longestConnectionMs: currentMetrics.longestConnectionMs,
        averageConnectionMs: Math.round(currentMetrics.averageConnectionMs)
      }
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
