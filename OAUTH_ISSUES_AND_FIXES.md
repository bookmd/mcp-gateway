# OAuth Issues and Fixes

## Date: February 3, 2026

## Issues Reported

### 1. Browser Tab Stuck on Google Login Page
**Symptom:** After clicking a Google account, the browser stays on `accounts.google.com` and doesn't navigate to the success page.

**Root Cause:** The `redirect_uri` sent to Google OAuth might not be properly registered in Google Cloud Console.

**Solution:**
1. Go to [Google Cloud Console - Credentials](https://console.cloud.google.com/apis/credentials)
2. Find your OAuth 2.0 Client ID
3. Click Edit
4. Under "Authorized redirect URIs", ensure this is listed:
   - ✅ `https://vim-mcp-gateway.com/auth/callback`

### 2. Success Page Doesn't Auto-Close After Authentication
**Symptom:** After successful authentication, the browser tab remains open showing "You can safely close this tab" message.

**Root Cause:** Browsers prevent JavaScript from closing tabs that weren't opened by JavaScript (security feature).

**Solution:** Improved UX in commit `e574983`:
- Attempts `window.close()` after redirect (works in some browsers)
- Shows clearer message: "✓ You can close this tab now"
- If auto-close fails, updates page with prominent "Close This Tab" button
- Users understand they can manually close the tab

## Current OAuth Flow

### For MCP Clients (Cursor)

```
1. Cursor initiates OAuth
   → GET /oauth/authorize
   → Parameters: response_type=code, client_id, code_challenge, redirect_uri=cursor://...

2. Gateway redirects to Google
   → redirect_uri = https://vim-mcp-gateway.com/auth/callback (NOT cursor://)
   → This is the key: Google MUST redirect to gateway first

3. User authenticates with Google
   → Chooses account
   → Consents to permissions

4. Google redirects back to gateway
   → GET /auth/callback?code=...&state=...

5. Gateway exchanges code with Google
   → Gets access_token + refresh_token
   → Creates authorization code for Cursor

6. Gateway shows success page (mcp-success.html)
   → Displays "✓ Authentication Successful!"
   → Auto-redirects to cursor://anysphere.cursor-mcp/oauth/callback?code=...&state=...
   → Attempts to auto-close tab

7. Cursor receives callback
   → Exchanges authorization code for access token
   → Gateway returns access_token + refresh_token
   → ✅ Connected!
```

## Configuration Required

### Environment Variables
```bash
GOOGLE_CLIENT_ID="your-client-id"
GOOGLE_CLIENT_SECRET="your-client-secret"
GOOGLE_REDIRECT_URI="https://vim-mcp-gateway.com/auth/callback"
ALLOWED_DOMAIN="getvim.com"
```

### Google Cloud Console
**Authorized redirect URIs:**
- `https://vim-mcp-gateway.com/auth/callback`

**Scopes:**
- `openid`
- `email`
- `profile`
- `https://www.googleapis.com/auth/gmail.readonly`
- `https://www.googleapis.com/auth/calendar.readonly`
- `https://www.googleapis.com/auth/drive.readonly`
- `https://www.googleapis.com/auth/documents.readonly`
- `https://www.googleapis.com/auth/spreadsheets.readonly`

## Testing

### Test the full flow:
1. Remove existing MCP server from Cursor
2. Re-add with MCP config:
   ```json
   {
     "mcpServers": {
       "user-mcp-gateway": {
         "type": "sse",
         "url": "https://vim-mcp-gateway.com/mcp/sse"
       }
     }
   }
   ```
3. Restart Cursor
4. Browser should open automatically
5. Sign in with Google
6. **NEW:** Page should show success and either auto-close or show "Close This Tab" button
7. Return to Cursor
8. Verify MCP tools are available

## Next Steps

### If Browser Still Stuck on Google Page:
1. **Check Google Cloud Console** - Verify redirect URI is registered
2. **Check logs** - Look for `[OAuth] Google returned error: ...`
3. **Check network tab** - See if redirect to `/auth/callback` is happening
4. **Try incognito** - Rule out cookie/cache issues

### If Success Page Doesn't Show:
1. Check if files are in Docker image: `src/views/mcp-success.html`
2. Check logs for file read errors
3. Verify `__dirname` path resolution in compiled dist

### If Still Need Re-login After Working:
This is the **token refresh** issue - see `TOKEN_REFRESH_RESEARCH.md` and `TOKEN_REFRESH_IMPLEMENTATION.md`

## Files Modified

- `src/views/mcp-success.html` - Improved UX with auto-close attempt and clearer messaging

## Files That Need Token Refresh (Still TODO)

All the token refresh implementation files are created but need to be committed and deployed:
- `src/google/oauth-client-factory.ts` - Auto-refresh OAuth2Client factory
- `src/storage/token-refresh-lock.ts` - Distributed locks
- `src/storage/token-updater.ts` - Token persistence
- `src/auth/oauth-errors.ts` - Revoked token handling
- Modified: All API clients (gmail, calendar, drive, docs, sheets)
- Modified: `src/auth/oauth-client.ts` - Request refresh tokens
- Modified: `src/storage/token-store.ts` - Encrypted token storage

## Architecture Insight

The key difference between your setup and `ragid-local`:

**Your MCP Gateway (OAuth 2.1):**
- Standard OAuth 2.1 with PKCE and authorization code flow
- Google → Gateway → Cursor (two-step redirect)
- Gateway acts as OAuth authorization server for Cursor
- Cursor is the OAuth client

**Ragid-local (Supabase Auth):**
- Uses Supabase's built-in authentication
- Creates session cookies for MCP connections
- No OAuth 2.1 authorization code flow
- Browser session-based authentication

Both patterns are valid, but they solve different problems:
- **OAuth 2.1**: Best for desktop apps (Cursor, VS Code) that can handle custom protocols
- **Supabase/Session**: Best for browser-based clients that can maintain cookies
