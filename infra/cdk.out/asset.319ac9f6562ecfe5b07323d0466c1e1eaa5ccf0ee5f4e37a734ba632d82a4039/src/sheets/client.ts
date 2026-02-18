/**
 * Sheets API client factory
 * Creates per-user authenticated Sheets clients
 */
import { google, sheets_v4 } from 'googleapis';
import type { UserContext } from '../auth/middleware.js';
import { createRefreshableOAuth2Client } from '../google/oauth-client-factory.js';
import { updateUserTokens, updateUserContextTokens } from '../storage/token-updater.js';

/**
 * Create Sheets API client with user's access token
 * Follows pattern from Gmail/Calendar/Drive/Docs clients
 */
export function createSheetsClient(userContext: UserContext): sheets_v4.Sheets {
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

  return google.sheets({ version: 'v4', auth: oauth2Client });
}
