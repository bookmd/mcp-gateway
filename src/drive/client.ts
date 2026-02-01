/**
 * Drive API client factory
 * Creates per-user authenticated Drive clients
 */
import { google, drive_v3 } from 'googleapis';
import type { UserContext } from '../auth/middleware.js';

/**
 * Create Drive API client with user's access token
 * Follows pattern from Gmail/Calendar clients
 */
export function createDriveClient(userContext: UserContext): drive_v3.Drive {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  oauth2Client.setCredentials({
    access_token: userContext.accessToken
  });

  return google.drive({ version: 'v3', auth: oauth2Client });
}
