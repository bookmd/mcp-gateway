/**
 * Docs API client factory
 * Creates per-user authenticated Docs clients
 */
import { google, docs_v1 } from 'googleapis';
import type { UserContext } from '../auth/middleware.js';

/**
 * Create Docs API client with user's access token
 * Follows pattern from Gmail/Calendar/Drive clients
 */
export function createDocsClient(userContext: UserContext): docs_v1.Docs {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  oauth2Client.setCredentials({
    access_token: userContext.accessToken
  });

  return google.docs({ version: 'v1', auth: oauth2Client });
}
