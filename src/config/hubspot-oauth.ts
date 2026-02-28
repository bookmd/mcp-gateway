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
  authorizationUrl: 'https://app.hubspot.com/oauth/authorize',
  tokenUrl: 'https://api.hubapi.com/oauth/v3/token',
  scopes: [
    'crm.objects.contacts.read',
    'crm.objects.companies.read',
    'crm.objects.deals.read',
    'crm.objects.owners.read',
    'crm.schemas.contacts.read',
    'crm.schemas.companies.read',
    'crm.schemas.deals.read'
  ]
} as const;

/**
 * Check if HubSpot OAuth is configured
 */
export function isHubSpotConfigured(): boolean {
  return !!(hubspotOAuthConfig.clientId && hubspotOAuthConfig.clientSecret);
}
