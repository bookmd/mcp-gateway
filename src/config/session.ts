/**
 * Session configuration for Fastify session plugin.
 * Weekly session expiration (7 days) per AUTH-04 requirement.
 */

function getEnvVar(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const WEEK_IN_MS = 7 * 24 * 60 * 60 * 1000;

export const sessionConfig = {
  secret: getEnvVar('SESSION_SECRET'),
  cookie: {
    maxAge: WEEK_IN_MS,
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax' as const // Allows OAuth redirects while maintaining CSRF protection
  }
} as const;
