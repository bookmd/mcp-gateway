/**
 * Slides API client factory
 * Creates per-user authenticated Slides clients
 */
import { google, slides_v1 } from 'googleapis';
import type { UserContext } from '../auth/middleware.js';
import { createRefreshableOAuth2Client } from '../google/oauth-client-factory.js';
import { updateUserTokens, updateUserContextTokens } from '../storage/token-updater.js';

/**
 * Create Slides API client with user's access token
 */
export function createSlidesClient(userContext: UserContext): slides_v1.Slides {
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

  return google.slides({ version: 'v1', auth: oauth2Client });
}
