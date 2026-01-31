/**
 * Session configuration for Fastify session plugin.
 * Weekly session expiration (7 days) per AUTH-04 requirement.
 *
 * Uses DynamoDB session store for persistence across server restarts.
 */

import { DynamoDBSessionStore } from '../storage/dynamodb-session-store.js';
import { SESSIONS_TABLE } from './aws.js';

function getEnvVar(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const WEEK_IN_MS = 7 * 24 * 60 * 60 * 1000;
const WEEK_IN_SECONDS = 7 * 24 * 60 * 60;

export const sessionConfig = {
  secret: getEnvVar('SESSION_SECRET'),
  cookie: {
    maxAge: WEEK_IN_MS,
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax' as const // Allows OAuth redirects while maintaining CSRF protection
  }
} as const;

/**
 * DynamoDB session store with KMS encryption.
 * Sessions persist across server restarts with 7-day TTL (AUTH-04).
 */
export const sessionStore = new DynamoDBSessionStore({
  tableName: SESSIONS_TABLE,
  ttlSeconds: WEEK_IN_SECONDS
});
