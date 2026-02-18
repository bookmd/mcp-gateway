/**
 * OAuth2Client factory with automatic token refresh and persistence.
 * 
 * Creates OAuth2Client instances that:
 * - Load both access + refresh tokens from storage
 * - Configure automatic refresh with eagerRefreshThresholdMillis
 * - Listen for token updates via 'tokens' event
 * - Persist updated tokens back to storage
 * 
 * Research findings:
 * - OAuth2Client extends EventEmitter and emits 'tokens' event on refresh
 * - eagerRefreshThresholdMillis triggers proactive refresh before expiry
 * - getRequestHeaders() automatically refreshes if needed
 */

import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';

export interface TokenPersister {
  updateTokens(accessToken: string, refreshToken?: string, expiryDate?: number): Promise<void>;
}

/**
 * Creates OAuth2Client with automatic refresh and token persistence.
 * 
 * The client will:
 * 1. Auto-refresh tokens when they expire or are about to expire
 * 2. Emit 'tokens' event when refresh occurs
 * 3. Call the persister to save updated tokens to storage
 * 
 * @param accessToken - Current Google access token
 * @param refreshToken - Google refresh token (required for auto-refresh)
 * @param expiresAt - Unix timestamp (ms) when access token expires
 * @param persister - Interface to persist updated tokens to storage
 * @returns Configured OAuth2Client ready for use
 */
export function createRefreshableOAuth2Client(
  accessToken: string,
  refreshToken: string | undefined,
  expiresAt: number,
  persister: TokenPersister
): OAuth2Client {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  // Set credentials with refresh token
  oauth2Client.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken,
    expiry_date: expiresAt
  });

  // Configure eager refresh (refresh 5 minutes before expiry)
  // This prevents tokens from expiring mid-request
  oauth2Client.eagerRefreshThresholdMillis = 5 * 60 * 1000;

  // Listen for token updates (fires when tokens are auto-refreshed)
  // Research confirmed: this is the correct API for google-auth-library
  oauth2Client.on('tokens', async (tokens) => {
    try {
      console.log('[OAuth] Tokens refreshed, persisting to storage');
      await persister.updateTokens(
        tokens.access_token!,
        tokens.refresh_token ?? undefined,
        tokens.expiry_date ?? undefined
      );
    } catch (error: any) {
      // Check if refresh token was revoked
      if (error.message && error.message.includes('invalid_grant')) {
        console.error('[OAuth] Refresh token revoked or invalid - user must re-authenticate');
        // Token persister should handle cleanup
      } else {
        console.error('[OAuth] Failed to persist refreshed tokens:', error);
      }
      // Don't throw - allow the API call to proceed with refreshed tokens
      // The next request will try to persist again
    }
  });

  return oauth2Client;
}
