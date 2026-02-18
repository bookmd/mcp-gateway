/**
 * Gmail API client factory
 * Creates per-user authenticated Gmail clients using access tokens from UserContext
 */
import { google, gmail_v1 } from 'googleapis';
import type { UserContext } from '../auth/middleware.js';
import { createRefreshableOAuth2Client } from '../google/oauth-client-factory.js';
import { updateUserTokens, updateUserContextTokens } from '../storage/token-updater.js';

/**
 * Create an authenticated Gmail API client for a specific user
 *
 * @param userContext - User context containing OAuth access token and refresh token
 * @returns Authenticated Gmail API client instance
 *
 * @example
 * const gmail = createGmailClient(userContext);
 * const messages = await gmail.users.messages.list({ userId: 'me' });
 */
export function createGmailClient(userContext: UserContext): gmail_v1.Gmail {
  const oauth2Client = createRefreshableOAuth2Client(
    userContext.accessToken,
    userContext.refreshToken,
    userContext.expiresAt || Date.now() + 3600000,
    {
      updateTokens: async (accessToken, refreshToken, expiryDate) => {
        // Update tokens in storage (with distributed lock)
        await updateUserTokens(
          userContext.sessionId,
          accessToken,
          refreshToken,
          expiryDate
        );
        
        // Update tokens in memory (for current request)
        updateUserContextTokens(userContext, accessToken, refreshToken, expiryDate);
      }
    }
  );

  return google.gmail({ version: 'v1', auth: oauth2Client });
}
