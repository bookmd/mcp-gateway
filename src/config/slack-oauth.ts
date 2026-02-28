/**
 * Slack OAuth configuration loaded from environment variables.
 */

function getEnvVar(name: string, defaultValue?: string): string {
  const value = process.env[name];
  if (!value) {
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    return '';
  }
  return value;
}

export const slackOAuthConfig = {
  clientId: getEnvVar('SLACK_CLIENT_ID'),
  clientSecret: getEnvVar('SLACK_CLIENT_SECRET'),
  redirectUri: getEnvVar('SLACK_REDIRECT_URI', 'https://mgw.ext.getvim.com/auth/slack/callback'),
  teamId: getEnvVar('SLACK_TEAM_ID'), // Optional: restrict to single workspace
  // Slack OAuth endpoints
  authorizationUrl: 'https://slack.com/oauth/v2/authorize',
  tokenUrl: 'https://slack.com/api/oauth.v2.access',
  // User token scopes (not bot scopes)
  userScopes: [
    'search:read',
    'channels:read',
    'channels:history',
    'groups:read',
    'groups:history',
    'im:read',
    'im:history',
    'mpim:read',
    'mpim:history',
    'users:read',
    'team:read'
  ]
} as const;

/**
 * Check if Slack OAuth is configured
 */
export function isSlackConfigured(): boolean {
  return !!(slackOAuthConfig.clientId && slackOAuthConfig.clientSecret);
}
