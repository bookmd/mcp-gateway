# Google OAuth Token Refresh - Research Document

## Current System Context

### OAuth Flow
The MCP Gateway uses OpenID Connect (via `openid-client` library) for Google OAuth authentication:

1. User initiates OAuth via `/auth/login` or MCP client connection
2. Gateway redirects to Google OAuth with PKCE
3. Google returns authorization code after user consent
4. Gateway exchanges code for tokens using `openid-client`
5. Tokens stored in DynamoDB (sessions) or session cookies

### Token Storage

**Browser Sessions:**
- Stored in: DynamoDB with KMS encryption
- Location: `src/storage/dynamodb-session-store.ts`
- Contains: `access_token`, `id_token`, `expires_at`, `email`
- TTL: 7 days

**MCP Bearer Tokens:**
- Stored in: DynamoDB (plaintext)
- Location: `src/storage/token-store.ts`
- Contains: `googleAccessToken`, `email`, `expiresAt`
- TTL: 7 days

### Token Usage in Google API Calls

All Google API clients (Gmail, Calendar, Drive, Docs, Sheets) follow this pattern:

```typescript
// src/gmail/client.ts (example)
export function createGmailClient(userContext: UserContext): gmail_v1.Gmail {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  oauth2Client.setCredentials({
    access_token: userContext.accessToken  // Only access token, no refresh token!
  });

  return google.gmail({ version: 'v1', auth: oauth2Client });
}
```

### Current Token Request

```typescript
// src/auth/oauth-client.ts
export function createAuthUrl(): AuthUrlParams {
  const authUrl = client.authorizationUrl({
    scope: 'openid email profile https://www.googleapis.com/auth/gmail.readonly ...',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    nonce,
    hd: oauthConfig.allowedDomain
    // NOTE: Missing access_type: 'offline' - no refresh token requested!
  });
}
```

### Token Callback Handling

```typescript
// src/auth/oauth-client.ts
export async function handleCallback(
  params: URLSearchParams,
  stored: { codeVerifier: string; state: string; nonce: string }
): Promise<CallbackResult> {
  const tokenSet = await client.callback(
    oauthConfig.redirectUri,
    Object.fromEntries(params),
    { code_verifier: stored.codeVerifier, state: stored.state, nonce: stored.nonce }
  );

  const claims = tokenSet.claims();

  return {
    accessToken: tokenSet.access_token!,
    idToken: tokenSet.id_token!,
    expiresAt: tokenSet.expires_at! * 1000,
    email: claims.email as string,
    hd: claims.hd as string
    // NOTE: tokenSet.refresh_token exists but is not extracted or stored!
  };
}
```

## The Problem

### Issue: Access Tokens Expire After 1 Hour

**Timeline:**
- **Hour 0:** User authenticates, receives Google access token
  - Token stored in DynamoDB/session
  - `expiresAt` timestamp stored but never checked
  
- **Hour 1:** Google access token expires
  - Gateway still has expired token in storage
  - No refresh token available to get a new token
  
- **User action:** Try to use MCP tool (e.g., `gmail_list`)
  
- **What happens:**
  1. Middleware retrieves stored (expired) access token
  2. Creates Google API client with expired token
  3. Makes request to Google API
  4. **Google returns 401 Unauthorized**
  5. Error propagates to user: "Failed to fetch Gmail messages"
  
- **User experience:** Must manually re-authenticate at `/auth/login`

### Current Middleware Logic

```typescript
// src/auth/middleware.ts (lines 74-81)
if (expiresAt && Date.now() >= expiresAt) {
  return reply.code(401).send({
    error: 'token_expired',
    message: 'Access token expired. Please re-authenticate at /auth/login'
  });
}
```

**Problem:** This checks session cookie expiry, not whether Google's access token is expired. Even if this check passes, the Google API call will fail with 401.

### Missing Pieces

1. **No refresh token requested:** `access_type: 'offline'` not included in auth URL
2. **No refresh token stored:** Even if returned, not extracted from `tokenSet`
3. **No refresh logic:** No code to detect expiry and refresh tokens
4. **No refresh token in API calls:** Google clients don't have refresh tokens to auto-refresh

## Research Questions

### 1. openid-client Library

**Question:** How does `openid-client` handle refresh tokens with Google OAuth?

**Need to verify:**
- Does `tokenSet.refresh_token` exist after calling `client.callback()`?
- What parameters are needed in `authorizationUrl()` to request refresh tokens?
- Does `openid-client` have a built-in method to refresh tokens?
- Example: Is there a `client.refresh(refresh_token)` method?

**Reference:** [openid-client GitHub](https://github.com/panva/openid-client)

### 2. Google OAuth 2.0 Refresh Token Behavior

**Question:** When does Google provide refresh tokens?

**Need to verify:**
- Is `access_type: 'offline'` sufficient, or is `prompt: 'consent'` also required?
- Does Google return a refresh token on every authorization code exchange?
- First-time consent vs. subsequent logins - do both get refresh tokens?
- Do refresh tokens expire, or are they valid indefinitely (until revoked)?

**Reference:** [Google OAuth 2.0 Documentation](https://developers.google.com/identity/protocols/oauth2)

### 3. googleapis Library Auto-Refresh

**Question:** Does `google.auth.OAuth2` automatically refresh tokens?

**Need to verify:**
```typescript
oauth2Client.setCredentials({
  access_token: 'expired_token',
  refresh_token: 'valid_refresh_token',
  expiry_date: 1234567890000  // Past timestamp
});

// Does this API call automatically refresh the token?
const result = await gmail.users.messages.list({ userId: 'me' });
```

**Expected behavior:** If expiry_date is past, OAuth2 client should:
1. Detect token is expired
2. Use refresh_token to get new access_token
3. Update credentials internally
4. Make the API call with new token
5. Return success (transparent to caller)

**Need to verify:** Is this automatic, or do we need to manually call `oauth2Client.refreshAccessToken()`?

**Reference:** [googleapis OAuth2Client](https://github.com/googleapis/google-auth-library-nodejs)

### 4. Token Refresh Error Handling

**Question:** What errors can occur during token refresh?

**Potential failures:**
- Refresh token revoked by user in Google account settings
- Refresh token expired (do they expire?)
- Network failure during refresh request
- Google rate limiting token refresh
- Invalid refresh token

**Need to verify:** What error codes/exceptions are thrown and how to handle them?

### 5. Race Conditions

**Question:** What happens if multiple requests try to refresh simultaneously?

**Scenario:**
- Token expired at 1:00:00
- User makes 3 simultaneous API calls at 1:00:01
- All 3 detect expired token and try to refresh

**Need to verify:**
- Does `googleapis` OAuth2Client handle this internally with a lock?
- Do we need to implement a mutex/lock in our middleware?
- Is it safe to have duplicate refresh requests?

### 6. Token Storage Security

**Question:** Should refresh tokens be encrypted separately?

**Current state:**
- Browser sessions: Encrypted with KMS envelope encryption
- Bearer tokens: Stored plaintext in DynamoDB

**Need to verify:**
- Are refresh tokens more sensitive than access tokens?
- Should they be stored in a separate table?
- What are best practices for refresh token storage?

## Success Criteria

After research, we should know:

1. ✅ Exact parameters needed to request refresh tokens from Google
2. ✅ How to extract refresh tokens from `openid-client` tokenSet
3. ✅ Whether `googleapis` OAuth2Client auto-refreshes (and how)
4. ✅ What error handling is needed for refresh failures
5. ✅ Whether we need to implement locking for race conditions
6. ✅ Security best practices for storing refresh tokens

## Related Files

- `src/auth/oauth-client.ts` - OAuth flow with openid-client
- `src/auth/middleware.ts` - Token validation and extraction
- `src/storage/token-store.ts` - Bearer token storage
- `src/storage/dynamodb-session-store.ts` - Session storage
- `src/gmail/client.ts` - Google API client creation (example)
- `src/calendar/client.ts` - Google API client creation
- `src/drive/client.ts` - Google API client creation
- `src/docs/client.ts` - Google API client creation
- `src/sheets/client.ts` - Google API client creation
- `src/routes/oauth.ts` - OAuth callback handler
- `src/routes/mcp-oauth.ts` - MCP OAuth flow

## Next Steps

1. Research the 6 questions above
2. Find working code examples of refresh token implementation
3. Update the implementation plan based on findings
4. Proceed with implementation
