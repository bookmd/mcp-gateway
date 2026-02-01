/**
 * Sheets API client factory
 * Creates per-user authenticated Sheets clients
 */
import { google, sheets_v4 } from 'googleapis';
import type { UserContext } from '../auth/middleware.js';

/**
 * Create Sheets API client with user's access token
 * Follows pattern from Gmail/Calendar/Drive/Docs clients
 */
export function createSheetsClient(userContext: UserContext): sheets_v4.Sheets {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  oauth2Client.setCredentials({
    access_token: userContext.accessToken
  });

  return google.sheets({ version: 'v4', auth: oauth2Client });
}
