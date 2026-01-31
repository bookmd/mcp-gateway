/**
 * MCP Gateway server with OAuth authentication.
 * Provides secure access to Google Workspace APIs via Model Context Protocol.
 */

// Load environment variables first
import 'dotenv/config';

import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifySession from '@fastify/session';
import { sessionConfig } from './config/session.js';

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info'
  }
});

// Register plugins
await app.register(fastifyCookie);
await app.register(fastifySession, {
  secret: sessionConfig.secret,
  cookie: sessionConfig.cookie,
  saveUninitialized: false // Don't create sessions until we need them
});

// Health check endpoint
app.get('/health', async (request, reply) => {
  return {
    status: 'ok',
    timestamp: new Date().toISOString()
  };
});

// Start server
try {
  await app.listen({ port: PORT, host: HOST });
  console.log(`Server listening on http://${HOST}:${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
