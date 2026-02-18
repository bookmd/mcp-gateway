/**
 * Calendar API client factory
 * Creates per-user authenticated Calendar clients using access tokens from UserContext
 */
import { google, calendar_v3 } from 'googleapis';
import type { UserContext } from '../auth/middleware.js';
import { createRefreshableOAuth2Client } from '../google/oauth-client-factory.js';
import { updateUserTokens, updateUserContextTokens } from '../storage/token-updater.js';

/**
 * Create an authenticated Calendar API client for a specific user
 *
 * @param userContext - User context containing OAuth access token and refresh token
 * @returns Authenticated Calendar API client instance
 *
 * @example
 * const calendar = createCalendarClient(userContext);
 * const events = await calendar.events.list({ calendarId: 'primary' });
 */
export function createCalendarClient(userContext: UserContext): calendar_v3.Calendar {
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

  return google.calendar({ version: 'v3', auth: oauth2Client });
}
