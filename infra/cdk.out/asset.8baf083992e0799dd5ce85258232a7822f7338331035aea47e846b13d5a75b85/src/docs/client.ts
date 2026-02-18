/**
 * Docs API client factory
 * Creates per-user authenticated Docs clients
 */
import { google, docs_v1 } from 'googleapis';
import type { UserContext } from '../auth/middleware.js';
import { createRefreshableOAuth2Client } from '../google/oauth-client-factory.js';
import { updateUserTokens, updateUserContextTokens } from '../storage/token-updater.js';

/**
 * Create Docs API client with user's access token
 * Follows pattern from Gmail/Calendar/Drive clients
 */
export function createDocsClient(userContext: UserContext): docs_v1.Docs {
  const oauth2Client = createRefreshableOAuth2Client(
    userContext.accessToken,
    userContext.refreshToken,
    userContext.expiresAt || Date.now() + 3600000,
    {
      updateTokens: async (accessToken, refreshToken, expiryDate) => {
        await updateUserTokens(
          userContext.sessionId,
          accessToken,
          refreshToken,
          expiryDate
        );
        updateUserContextTokens(userContext, accessToken, refreshToken, expiryDate);
      }
    }
  );

  return google.docs({ version: 'v1', auth: oauth2Client });
}
