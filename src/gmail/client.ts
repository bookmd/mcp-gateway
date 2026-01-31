/**
 * Gmail API client factory
 * Creates per-user authenticated Gmail clients using access tokens from UserContext
 */
import { google, gmail_v1 } from 'googleapis';
import type { UserContext } from '../auth/middleware.js';

/**
 * Create an authenticated Gmail API client for a specific user
 *
 * @param userContext - User context containing OAuth access token
 * @returns Authenticated Gmail API client instance
 *
 * @example
 * const gmail = createGmailClient(userContext);
 * const messages = await gmail.users.messages.list({ userId: 'me' });
 */
export function createGmailClient(userContext: UserContext): gmail_v1.Gmail {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  oauth2Client.setCredentials({
    access_token: userContext.accessToken
  });

  return google.gmail({ version: 'v1', auth: oauth2Client });
}
