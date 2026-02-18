/**
 * Drive API client factory
 * Creates per-user authenticated Drive clients
 */
import { google, drive_v3 } from 'googleapis';
import type { UserContext } from '../auth/middleware.js';
import { createRefreshableOAuth2Client } from '../google/oauth-client-factory.js';
import { updateUserTokens, updateUserContextTokens } from '../storage/token-updater.js';

/**
 * Create Drive API client with user's access token
 * Follows pattern from Gmail/Calendar clients
 */
export function createDriveClient(userContext: UserContext): drive_v3.Drive {
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

  return google.drive({ version: 'v3', auth: oauth2Client });
}
