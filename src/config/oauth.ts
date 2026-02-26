/**
 * OAuth configuration loaded from environment variables.
 * Validates required variables on module load to fail fast.
 */

function getEnvVar(name: string, defaultValue?: string): string {
  const value = process.env[name];
  if (!value) {
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const oauthConfig = {
  clientId: getEnvVar('GOOGLE_CLIENT_ID'),
  clientSecret: getEnvVar('GOOGLE_CLIENT_SECRET'),
  redirectUri: getEnvVar('GOOGLE_REDIRECT_URI', 'https://mgw.ext.getvim.com/auth/callback'),
  allowedDomain: getEnvVar('ALLOWED_DOMAIN', 'getvim.com')
} as const;
