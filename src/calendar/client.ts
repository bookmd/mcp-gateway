/**
 * Calendar API client factory
 * Creates per-user authenticated Calendar clients using access tokens from UserContext
 */
import { google, calendar_v3 } from 'googleapis';
import type { UserContext } from '../auth/middleware.js';

/**
 * Create an authenticated Calendar API client for a specific user
 *
 * @param userContext - User context containing OAuth access token
 * @returns Authenticated Calendar API client instance
 *
 * @example
 * const calendar = createCalendarClient(userContext);
 * const events = await calendar.events.list({ calendarId: 'primary' });
 */
export function createCalendarClient(userContext: UserContext): calendar_v3.Calendar {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  oauth2Client.setCredentials({
    access_token: userContext.accessToken
  });

  return google.calendar({ version: 'v3', auth: oauth2Client });
}
