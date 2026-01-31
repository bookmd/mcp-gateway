import 'dotenv/config';

import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifySession from '@fastify/session';
import { sessionConfig } from './config/session.js';
import { oauthRoutes } from './routes/oauth.js';
import { sseRoutes } from './routes/sse.js';
import { requireAuth } from './auth/middleware.js';
import { initMcpServer } from './mcp/server.js';
import { registerMcpHandlers } from './mcp/handlers.js';

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info'
  }
});

await app.register(fastifyCookie);
await app.register(fastifySession, {
  secret: sessionConfig.secret,
  cookie: sessionConfig.cookie,
  saveUninitialized: false
});

// Initialize MCP server and register handlers
const mcpServer = initMcpServer();
registerMcpHandlers(mcpServer);

await app.register(oauthRoutes);
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
