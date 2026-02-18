/**
 * Token refresh middleware - ensures access tokens are valid and refreshes them if needed
 * 
 * This middleware:
 * 1. Checks if the access token is expired or expiring soon (< 5 minutes)
 * 2. Uses the refresh token to get a new access token
 * 3. Updates storage and the user context
 * 4. Allows the request to proceed with fresh tokens
 */

import { google } from 'googleapis';
import { updateUserTokens, updateUserContextTokens } from '../storage/token-updater.js';
import type { UserContext } from './middleware.js';

const REFRESH_THRESHOLD_MS = 5 * 60 * 1000; // Refresh if expiring in < 5 minutes

/**
 * Checks if access token needs refresh and refreshes it if needed.
 * 
 * @param userContext - User context with access token, refresh token, and expiry
 * @returns true if token was refreshed, false if no refresh needed
 */
export async function ensureTokenFreshness(userContext: UserContext): Promise<boolean> {
  const { accessToken, refreshToken, expiresAt, sessionId } = userContext;

  // If no expiry or no refresh token, can't refresh
  if (!expiresAt || !refreshToken) {
    return false;
  }

  const now = Date.now();
  const timeUntilExpiry = expiresAt - now;

  // Token is valid and not expiring soon
  if (timeUntilExpiry > REFRESH_THRESHOLD_MS) {
    return false;
  }

  // Token expired or expiring soon - refresh it!
  const minutesUntilExpiry = Math.floor(timeUntilExpiry / 60000);
  console.log(`[TokenRefresh] Refreshing token: expiresIn=${minutesUntilExpiry}min, session=${sessionId}`);

  try {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );

    oauth2Client.setCredentials({
      access_token: accessToken,
      refresh_token: refreshToken,
      expiry_date: expiresAt
    });

    // Refresh the token
    const { credentials } = await oauth2Client.refreshAccessToken();

    if (!credentials.access_token) {
      console.error('[TokenRefresh] Refresh succeeded but no access_token in response');
      return false;
    }

    const newAccessToken = credentials.access_token;
    const newRefreshToken = credentials.refresh_token || refreshToken; // Google may return new refresh token
    const newExpiresAt = credentials.expiry_date || (now + 3600000); // Default to 1 hour if not provided

    console.log(`[TokenRefresh] Token refreshed successfully, newExpiresAt=${new Date(newExpiresAt).toISOString()}`);

    // Update storage (with distributed lock)
    await updateUserTokens(
      sessionId,
      newAccessToken,
      newRefreshToken,
      newExpiresAt
    );

    // Update in-memory context
    updateUserContextTokens(userContext, newAccessToken, newRefreshToken, newExpiresAt);

    return true;
  } catch (error: any) {
    if (error.message && error.message.includes('invalid_grant')) {
      console.error('[TokenRefresh] Refresh token revoked or invalid - user must re-authenticate');
      // Don't throw - let the middleware return 401
      return false;
    }

    console.error('[TokenRefresh] Failed to refresh token:', error);
    return false;
  }
}
