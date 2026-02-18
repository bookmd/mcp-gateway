import 'dotenv/config';

import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifySession from '@fastify/session';
import { sessionConfig, sessionStore } from './config/session.js';
import { oauthRoutes } from './routes/oauth.js';
import { mcpOAuthRoutes } from './routes/mcp-oauth.js';
import { sseRoutes, getActiveTransports } from './routes/sse.js';
import { requireAuth } from './auth/middleware.js';
import { initMcpServer } from './mcp/server.js';
import { registerMcpHandlers } from './mcp/handlers.js';

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info'
  },
  // Increase timeouts for long-lived SSE connections
  connectionTimeout: 300000, // 5 minutes (instead of 0, which might cause issues)
  keepAliveTimeout: 300000, // 5 minutes
});

// Add content type parser that doesn't consume the body for MCP message endpoint
// The MCP SDK's handlePostMessage needs access to raw request body
app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  // Store raw body for potential use
  (req as any).rawBody = body;
  try {
    const json = JSON.parse(body as string);
    done(null, json);
  } catch (err) {
    done(err as Error, undefined);
  }
});

// Add form data parser for OAuth token endpoint
app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (req, body, done) => {
  try {
    const params = new URLSearchParams(body as string);
    const obj: Record<string, string> = {};
    for (const [key, value] of params) {
      obj[key] = value;
    }
    done(null, obj);
  } catch (err) {
    done(err as Error, undefined);
  }
});

await app.register(fastifyCookie);
await app.register(fastifySession, {
  secret: sessionConfig.secret,
  cookie: sessionConfig.cookie,
  store: sessionStore,
  saveUninitialized: false
});

// Initialize MCP server and register handlers
const mcpServer = initMcpServer();
registerMcpHandlers(mcpServer);

await app.register(oauthRoutes);
await app.register(mcpOAuthRoutes);
await app.register(sseRoutes);

app.get('/health', async (request, reply) => {
  return {
    status: 'ok',
    timestamp: new Date().toISOString()
  };
});

app.get('/protected', { preHandler: requireAuth }, async (request, reply) => {
  return {
    message: 'You are authenticated',
    email: request.userContext?.email,
    sessionId: request.userContext?.sessionId
  };
});

try {
  await app.listen({ port: PORT, host: HOST });
  console.log(`Server listening on http://${HOST}:${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// Graceful shutdown on SIGTERM (ECS sends this before SIGKILL)
process.on('SIGTERM', async () => {
  app.log.info('SIGTERM received, starting graceful shutdown');

  // Stop accepting new connections
  await app.close();
  app.log.info('Fastify server closed, no new connections accepted');

  // Close all active MCP connections
  const activeTransports = getActiveTransports();
  app.log.info(`Closing ${activeTransports.size} active MCP connections`);
  for (const [sessionId, transport] of activeTransports) {
    try {
      app.log.info(`Closing MCP connection: ${sessionId}`);
      await transport.close();
    } catch (error) {
      app.log.error({ error }, `Error closing MCP connection ${sessionId}`);
    }
  }

  app.log.info('Graceful shutdown complete, exiting');
  process.exit(0);
});

// Handle uncaught errors (production safety)
process.on('uncaughtException', (error) => {
  app.log.fatal({ error }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  app.log.fatal({ reason }, 'Unhandled promise rejection');
  process.exit(1);
});
