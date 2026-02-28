/**
 * HubSpot API client factory
 */

import { hubspotOAuthConfig } from '../config/hubspot-oauth.js';
import type { HubSpotTokens } from './types.js';

const HUBSPOT_API_BASE = 'https://api.hubapi.com';

export interface HubSpotClient {
  get: <T>(endpoint: string, params?: Record<string, string>) => Promise<T>;
  post: <T>(endpoint: string, body: unknown) => Promise<T>;
}

/**
 * Create a HubSpot API client with the given access token
 */
export function createHubSpotClient(accessToken: string): HubSpotClient {
  const makeRequest = async <T>(
    method: 'GET' | 'POST',
    endpoint: string,
    options?: { params?: Record<string, string>; body?: unknown }
  ): Promise<T> => {
    let url = `${HUBSPOT_API_BASE}${endpoint}`;

    if (options?.params) {
      const searchParams = new URLSearchParams(options.params);
      url += `?${searchParams.toString()}`;
    }

    const response = await fetch(url, {
      method,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: options?.body ? JSON.stringify(options.body) : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage: string;
      try {
        const errorJson = JSON.parse(errorText);
        errorMessage = errorJson.message || errorText;
      } catch {
        errorMessage = errorText;
      }
      throw new Error(`HubSpot API error (${response.status}): ${errorMessage}`);
    }

    return response.json() as Promise<T>;
  };

  return {
    get: <T>(endpoint: string, params?: Record<string, string>) =>
      makeRequest<T>('GET', endpoint, { params }),
    post: <T>(endpoint: string, body: unknown) =>
      makeRequest<T>('POST', endpoint, { body }),
  };
}

/**
 * Exchange authorization code for tokens
 */
export async function exchangeCodeForTokens(code: string, redirectUri: string): Promise<HubSpotTokens> {
  const response = await fetch(hubspotOAuthConfig.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: hubspotOAuthConfig.clientId,
      client_secret: hubspotOAuthConfig.clientSecret,
      redirect_uri: redirectUri,
      code,
    }).toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HubSpot token exchange failed: ${errorText}`);
  }

  const data = await response.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    hub_id?: number;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in * 1000),
    portalId: data.hub_id?.toString(),
  };
}

/**
 * Refresh an expired access token
 */
export async function refreshHubSpotToken(refreshToken: string): Promise<HubSpotTokens> {
  const response = await fetch(hubspotOAuthConfig.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: hubspotOAuthConfig.clientId,
      client_secret: hubspotOAuthConfig.clientSecret,
      refresh_token: refreshToken,
    }).toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HubSpot token refresh failed: ${errorText}`);
  }

  const data = await response.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    hub_id?: number;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in * 1000),
    portalId: data.hub_id?.toString(),
  };
}

/**
 * Get token info (to verify token and get portal ID)
 */
export async function getTokenInfo(accessToken: string): Promise<{ hub_id: number; user_id: number; user: string }> {
  const response = await fetch(`${HUBSPOT_API_BASE}/oauth/v3/access-tokens/${accessToken}`, {
    method: 'GET',
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HubSpot token info failed: ${errorText}`);
  }

  return response.json();
}
