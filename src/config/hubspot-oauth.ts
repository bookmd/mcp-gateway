/**
 * HubSpot OAuth configuration loaded from environment variables.
 */

function getEnvVar(name: string, defaultValue?: string): string {
  const value = process.env[name];
  if (!value) {
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    // HubSpot is optional - don't throw, just return empty
    return '';
  }
  return value;
}

export const hubspotOAuthConfig = {
  clientId: getEnvVar('HUBSPOT_CLIENT_ID'),
  clientSecret: getEnvVar('HUBSPOT_CLIENT_SECRET'),
  redirectUri: getEnvVar('HUBSPOT_REDIRECT_URI', 'https://mgw.ext.getvim.com/auth/hubspot/callback'),
  // MCP Auth App uses mcp.hubspot.com endpoints
  authorizationUrl: 'https://mcp.hubspot.com/oauth/authorize/user',
  tokenUrl: 'https://mcp.hubspot.com/oauth/v3/token',
  // MCP Auth Apps don't require specific scopes in the URL - scopes are configured in the app
  scopes: [] as string[]
} as const;

/**
 * Check if HubSpot OAuth is configured
 */
export function isHubSpotConfigured(): boolean {
  return !!(hubspotOAuthConfig.clientId && hubspotOAuthConfig.clientSecret);
}
