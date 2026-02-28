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
  // Standard HubSpot OAuth endpoints (for Project Apps)
  authorizationUrl: 'https://app.hubspot.com/oauth/authorize',
  tokenUrl: 'https://api.hubapi.com/oauth/v3/token',
  // Scopes must match what's configured in the HubSpot app (requiredScopes only)
  // Optional scopes like crm.objects.owners.read must be requested via optional_scope param
  scopes: [
    'oauth',
    'crm.objects.contacts.read',
    'crm.objects.companies.read',
    'crm.objects.deals.read',
    'crm.objects.tickets.read'
  ],
  optionalScopes: [
    'crm.objects.owners.read'
  ]
} as const;

/**
 * Check if HubSpot OAuth is configured
 */
export function isHubSpotConfigured(): boolean {
  return !!(hubspotOAuthConfig.clientId && hubspotOAuthConfig.clientSecret);
}
