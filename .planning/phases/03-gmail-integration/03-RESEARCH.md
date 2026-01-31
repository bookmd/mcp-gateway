# Phase 3: Gmail Integration - Research

**Researched:** 2026-01-31
**Domain:** Gmail API with Node.js googleapis client
**Confidence:** HIGH

## Summary

Gmail integration requires the official `googleapis` Node.js client library (v15.0.0+) which provides complete Gmail API v1 access through the `google.gmail()` interface. The standard approach uses OAuth2Client from the same package to handle authentication with access tokens stored in the existing session infrastructure.

Key requirements: Add `https://www.googleapis.com/auth/gmail.readonly` scope to OAuth flow, create OAuth2Client instances with stored access tokens per request, and implement MCP tools for search/list/get operations. The Gmail API returns messages in a complex MIME structure requiring recursive parsing for multipart messages and base64url decoding for body content.

**Primary recommendation:** Use googleapis package with OAuth2Client, implement three MCP tools (gmail_search, gmail_list, gmail_get), and use gmail-api-parse-message npm package for message body parsing to avoid hand-rolling MIME/base64url handling.

## Standard Stack

The established libraries/tools for Gmail API integration in Node.js:

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| googleapis | 15.0.0+ | Google APIs Node.js client | Official Google library with OAuth2, auto-refresh, complete Gmail API v1 coverage |
| google-auth-library | (included) | OAuth2Client for auth | Bundled with googleapis, handles token refresh automatically |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| gmail-api-parse-message | 2.1.2+ | Parse Gmail API message responses | Essential - handles complex MIME structures, base64url decoding, attachment extraction |
| @types/gmail-api-v2-nodejs | latest | TypeScript definitions | If googleapis types incomplete (verify first) |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| googleapis | node-gmail-api (unofficial) | Unofficial wrapper adds abstraction but lacks Google support, outdated |
| Message parsing library | Hand-rolled parser | MIME structure complexity (multipart recursion, base64url) not worth custom code |
| gmail.readonly scope | mail.google.com scope | Full access scope too permissive for read-only requirements |

**Installation:**
```bash
npm install googleapis gmail-api-parse-message
```

## Architecture Patterns

### Recommended Project Structure
```
src/
├── gmail/
│   ├── client.ts        # OAuth2Client factory from UserContext
│   ├── handlers.ts      # MCP tool handlers (gmail_search, gmail_list, gmail_get)
│   ├── parsers.ts       # Message body parsing with gmail-api-parse-message
│   └── types.ts         # Gmail response TypeScript interfaces
└── mcp/
    └── handlers.ts      # Register Gmail tools here
```

### Pattern 1: OAuth2Client Per Request
**What:** Create OAuth2Client instance for each MCP tool invocation using user's access token from UserContext
**When to use:** Every Gmail API call (required for user-specific authentication)
**Example:**
```typescript
// Source: https://googleapis.dev/nodejs/googleapis/latest/
import { google } from 'googleapis';

// In MCP tool handler
const userContext = (extra?.transport as any)?.userContext as UserContext;

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

oauth2Client.setCredentials({
  access_token: userContext.accessToken
});

const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
```

### Pattern 2: MCP Tool with Pagination Support
**What:** Return Gmail messages with cursor-based pagination following MCP spec
**When to use:** gmail_list and gmail_search tools (can return large result sets)
**Example:**
```typescript
// Source: https://modelcontextprotocol.io/specification/2025-03-26/server/utilities/pagination
server.registerTool('gmail_search', {
  description: 'Search Gmail messages with query',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Gmail search query (e.g., from:user@example.com)' },
      maxResults: { type: 'number', default: 10, maximum: 50 },
      pageToken: { type: 'string', description: 'Pagination token from previous response' }
    },
    required: ['query']
  }
}, async (args, extra) => {
  const response = await gmail.users.messages.list({
    userId: 'me',
    q: args.query,
    maxResults: args.maxResults || 10,
    pageToken: args.pageToken
  });

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        messages: response.data.messages,
        nextCursor: response.data.nextPageToken, // MCP pagination
        resultSizeEstimate: response.data.resultSizeEstimate
      }, null, 2)
    }],
    // MCP pagination at tool level - include nextCursor in text response
    // MCP spec supports pagination at list operations level, not tool call level
  };
});
```

### Pattern 3: Message Body Parsing
**What:** Use gmail-api-parse-message to extract text/html from complex MIME structures
**When to use:** gmail_get tool when returning full message content
**Example:**
```typescript
// Source: https://www.npmjs.com/package/gmail-api-parse-message
import parseMessage from 'gmail-api-parse-message';

// Fetch message with format=full to get parsed payload
const message = await gmail.users.messages.get({
  userId: 'me',
  id: messageId,
  format: 'full'
});

// Parse the complex MIME structure
const parsed = parseMessage(message.data);

// parsed.textPlain - plain text body
// parsed.textHtml - HTML body
// parsed.headers - key-value header map
// parsed.inline - inline attachments
// parsed.attachments - file attachments
```

### Pattern 4: Error Handling with Exponential Backoff
**What:** Implement retry logic for Gmail API rate limits (429, 403 errors)
**When to use:** All Gmail API calls (rate limits are per-user and per-project)
**Example:**
```typescript
// Source: https://developers.google.com/workspace/gmail/api/guides/handle-errors
async function withRetry<T>(
  operation: () => Promise<T>,
  maxRetries = 3
): Promise<T> {
  let lastError: Error;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error: any) {
      lastError = error;

      // Check for rate limit errors
      if (error.code === 429 || error.code === 403) {
        const backoffMs = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        continue;
      }

      // Check for token expiration
      if (error.code === 401) {
        return {
          content: [{
            type: 'text',
            text: 'Error: Access token expired. Please re-authenticate at /auth/login'
          }],
          isError: true
        } as any;
      }

      throw error; // Other errors fail immediately
    }
  }

  throw lastError!;
}
```

### Anti-Patterns to Avoid
- **Creating global Gmail client:** Each user needs their own OAuth2Client with their access token - don't share clients
- **Storing refresh tokens:** Architecture uses weekly re-auth (AUTH-04) - access tokens stored in session, no refresh token rotation needed
- **Using format=raw for message parsing:** Raw returns base64url encoded RFC 2822 string - format=full provides parsed payload which is easier to work with
- **Standard base64 decoding:** Gmail uses base64url (RFC 4648) - must replace `-` with `+` and `_` with `/` before decoding

## Don't Hand-Roll

Problems that look simple but have existing solutions:

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Message body parsing | Recursive MIME parser | gmail-api-parse-message | Handles multipart/alternative, multipart/mixed, nested parts, base64url decoding, attachment extraction |
| Base64url decoding | Custom decoder | Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64') | URL-safe base64 (RFC 4648) requires character substitution before decoding |
| HTML to plain text | Regex stripping | Existing parsed.textPlain from library | Emails often include both - use plain text part instead of parsing HTML |
| Rate limit retry | Manual backoff | Existing exponential backoff pattern | Gmail has complex rate limits (per-user 15k/min, per-project 1.2M/min) - established pattern handles both |
| OAuth token refresh | Manual refresh logic | OAuth2Client auto-refresh | googleapis automatically refreshes access tokens using refresh token if provided and `tokens` event fires |

**Key insight:** Gmail API MIME message structure varies significantly (simple text, HTML-only, multipart/alternative, multipart/mixed with attachments, nested parts). Recursive parsing required for nested multipart structures - too complex to maintain custom parser.

## Common Pitfalls

### Pitfall 1: Missing Gmail Scope in OAuth Flow
**What goes wrong:** Gmail API calls fail with 403 "Insufficient Permission" despite valid authentication
**Why it happens:** OAuth scope `https://www.googleapis.com/auth/gmail.readonly` not included in initial authorization flow in src/auth/oauth-client.ts
**How to avoid:** Update createAuthUrl() scope parameter from `'openid email profile'` to `'openid email profile https://www.googleapis.com/auth/gmail.readonly'`
**Warning signs:** test_auth tool shows access token but Gmail tools return 403 errors

### Pitfall 2: Gmail API Rate Limit Confusion
**What goes wrong:** Tool calls fail with "User-rate limit exceeded" (429) or "rateLimitExceeded" (403) even after waiting
**Why it happens:** Two simultaneous limits apply - per-user (15,000 quota units/min) AND per-project (1,200,000 quota units/min). Message retrieval costs 5 units, sending costs 100 units.
**How to avoid:** Implement exponential backoff starting at 1 second. Don't assume 200 response means success - mail sending has delayed rate limit responses.
**Warning signs:** 429 errors appearing minutes after operation, or persistent 403 with reason "rateLimitExceeded"

### Pitfall 3: Base64url vs Base64 Encoding
**What goes wrong:** Message body content garbled or fails to decode with "Invalid character" errors
**Why it happens:** Gmail API uses base64url (RFC 4648) with `-` and `_` instead of standard base64 `+` and `/`. Node.js Buffer.from() expects standard base64.
**How to avoid:** Always replace characters before decoding: `Buffer.from(body.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64')`. Or use gmail-api-parse-message which handles this automatically.
**Warning signs:** Decoded text shows random characters, decoding throws errors

### Pitfall 4: Assuming Simple Message Structure
**What goes wrong:** Message parsing works for some emails but fails for others (multipart messages, attachments, inline images)
**Why it happens:** Simple text emails have `payload.body.data`, but multipart emails have `payload.parts[]` with recursive nesting. HTML+text emails have multipart/alternative. Attachments add multipart/mixed.
**How to avoid:** Use gmail-api-parse-message library or implement recursive function to traverse `parts[]` array checking `mimeType` at each level
**Warning signs:** Some emails parse correctly, others return empty body or missing content

### Pitfall 5: Token Expiration in Long-Running Operations
**What goes wrong:** First Gmail API call succeeds, subsequent calls within same MCP session fail with 401
**Why it happens:** Access tokens expire (typically 1 hour). Current architecture stores access token in session but doesn't store refresh token (weekly re-auth policy).
**How to avoid:** Check UserContext.accessToken expiry before Gmail calls. When 401 occurs, return error directing user to re-authenticate. Document that Gmail tools may fail mid-session if token expires.
**Warning signs:** Intermittent 401 errors, tools work immediately after login but fail later

### Pitfall 6: Pagination Page Size Assumptions
**What goes wrong:** Code expects fixed page size (e.g., always 100 results), breaks when Gmail returns fewer
**Why it happens:** Gmail API page size is server-determined and varies. maxResults is a maximum, not guaranteed count. Last page typically has fewer results.
**How to avoid:** Never assume `messages.length === maxResults`. Check for `nextPageToken` presence to determine if more pages exist, not result count.
**Warning signs:** Pagination stops early, "missing" messages, off-by-one errors in result counts

## Code Examples

Verified patterns from official sources:

### Creating Gmail Client from UserContext
```typescript
// Source: https://googleapis.dev/nodejs/googleapis/latest/gmail/classes/Gmail.html
import { google } from 'googleapis';
import type { UserContext } from '../auth/middleware.js';

export function createGmailClient(userContext: UserContext) {
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
```

### Searching Messages with Query
```typescript
// Source: https://developers.google.com/workspace/gmail/api/guides/filtering
const response = await gmail.users.messages.list({
  userId: 'me',
  q: 'from:notifications@github.com is:unread',
  maxResults: 20,
  pageToken: previousPageToken // optional, for pagination
});

// Response structure:
// {
//   messages: [{ id: string, threadId: string }],
//   nextPageToken: string | undefined,
//   resultSizeEstimate: number
// }
```

### Getting Full Message with Metadata
```typescript
// Source: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get
const message = await gmail.users.messages.get({
  userId: 'me',
  id: messageId,
  format: 'full' // Returns parsed payload with headers and body parts
});

// Parse with library
import parseMessage from 'gmail-api-parse-message';
const parsed = parseMessage(message.data);

// Access parsed content:
// parsed.headers: { from: string, to: string, subject: string, date: string }
// parsed.textPlain: string - plain text body
// parsed.textHtml: string - HTML body
// parsed.attachments: Array<{ filename: string, mimeType: string, data: Buffer }>
```

### Listing Messages by Label
```typescript
// Source: https://developers.google.com/workspace/gmail/api/guides/list-messages
const response = await gmail.users.messages.list({
  userId: 'me',
  labelIds: ['INBOX', 'UNREAD'], // Must match ALL labels
  maxResults: 10
});

// Common label IDs: INBOX, SENT, DRAFT, SPAM, TRASH, UNREAD, STARRED, IMPORTANT
```

### Error Handling Pattern
```typescript
// Source: https://developers.google.com/workspace/gmail/api/guides/handle-errors
try {
  const response = await gmail.users.messages.list({ userId: 'me', q: query });
  return response.data;
} catch (error: any) {
  // Check error response structure
  if (error.response?.data?.error) {
    const { code, message, errors } = error.response.data.error;

    if (code === 401) {
      // Token expired - direct to re-auth
      return { error: 'token_expired', message: 'Please re-authenticate' };
    }

    if (code === 403 && errors?.[0]?.reason === 'userRateLimitExceeded') {
      // Rate limit - retry with backoff
      throw new RateLimitError('Rate limit exceeded', error);
    }

    if (code === 429) {
      // Too many requests - retry with backoff
      throw new RateLimitError('Too many requests', error);
    }
  }

  throw error; // Unexpected error
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| googleapis v1-v119 | googleapis v120+ | April 2024 | Breaking changes in auth flow - use OAuth2Client.setCredentials() directly, no more client.auth.getAccessToken() |
| format=raw for messages | format=full + parser | Ongoing best practice | Raw requires full RFC 2822 parsing, full provides structured payload that libraries can parse |
| Manual pagination (offset) | Cursor-based (pageToken) | Gmail API v1 spec | pageToken is opaque and stable, offset approach never supported |
| refresh_token in all cases | Access token only for 7-day sessions | Architecture decision (AUTH-04) | Simplifies token management, no refresh rotation needed |
| gmail.readonly for all read ops | Granular scopes (gmail.labels, gmail.metadata) | OAuth 2.0 granular scopes introduced | gmail.readonly still recommended for most use cases unless extreme permission restriction needed |

**Deprecated/outdated:**
- **node-gmail-api package**: Unofficial wrapper, last updated 2019, use googleapis instead
- **google-api-nodejs-client v1.x**: Deprecated, all users should migrate to v2+ (current v15)
- **Manual token refresh logic**: googleapis OAuth2Client handles refresh automatically via tokens event and auto-refresh
- **Batching > 50 requests**: Gmail API docs previously suggested batching but now warn against batches > 50 due to rate limiting

## Open Questions

Things that couldn't be fully resolved:

1. **MCP Tool Result Size Limits**
   - What we know: Gmail messages can be large (multiple MB with attachments). MCP tools return text content in response.
   - What's unclear: Does MCP SDK or SSE transport have size limits for tool responses? Should we truncate large messages?
   - Recommendation: Test with large message (5MB+) and monitor for transport issues. Consider adding truncation with "message too large" warning if needed.

2. **Pagination in MCP Tool Responses**
   - What we know: MCP spec supports pagination for resources/tools/prompts LIST operations, not tool call results. Gmail API supports pageToken pagination.
   - What's unclear: Best practice for returning paginated results from MCP tools - embed nextPageToken in text response or use different pattern?
   - Recommendation: Include pageToken as input parameter and nextCursor in JSON response text. Document that clients must make additional tool calls for subsequent pages.

3. **OAuth Scope Addition Without Breaking Existing Sessions**
   - What we know: Need to add gmail.readonly scope to OAuth flow. Existing authenticated users have sessions without this scope.
   - What's unclear: Will Gmail API calls with insufficient scope return clear error? Should we force re-authentication for existing users?
   - Recommendation: Gmail API will return 403 with "insufficient permissions" - error handling should direct users to /auth/login. Acceptable UX for one-time migration.

4. **gmail-api-parse-message TypeScript Support**
   - What we know: Library provides parsing functionality and is actively maintained (last update 2023)
   - What's unclear: Quality of TypeScript definitions, whether @types package needed or definitions built-in
   - Recommendation: Install and test, add @types/gmail-api-parse-message if TS errors occur, may need custom type declarations

## Sources

### Primary (HIGH confidence)
- [Gmail API Official Node.js Quickstart](https://developers.google.com/gmail/api/quickstart/nodejs) - Installation, setup, Gmail client creation
- [Gmail API OAuth Scopes](https://developers.google.com/workspace/gmail/api/auth/scopes) - Complete scope list, gmail.readonly definition
- [Gmail API List Messages Guide](https://developers.google.com/workspace/gmail/api/guides/list-messages) - Pagination patterns, maxResults limits, labelIds filtering
- [Gmail API Get Message Reference](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get) - Format options (full/raw/metadata), response structure
- [Gmail API Search/Filtering Guide](https://developers.google.com/workspace/gmail/api/guides/filtering) - Query syntax, search operators
- [Gmail API Error Handling](https://developers.google.com/workspace/gmail/api/guides/handle-errors) - Error codes, exponential backoff, retry strategy
- [Gmail API Quotas](https://developers.google.com/workspace/gmail/api/reference/quota) - Per-user and per-project rate limits, quota unit costs
- [googleapis npm package](https://www.npmjs.com/package/googleapis) - Version 15.0.0, official Google library
- [googleapis documentation](https://googleapis.dev/nodejs/googleapis/latest/gmail/classes/Gmail.html) - TypeScript interfaces, method signatures
- [MCP Pagination Spec](https://modelcontextprotocol.io/specification/2025-03-26/server/utilities/pagination) - Cursor-based pagination pattern, nextCursor response format

### Secondary (MEDIUM confidence)
- [gmail-api-parse-message npm](https://www.npmjs.com/package/gmail-api-parse-message) - Message parsing library (6 dependents, maintained through 2023)
- [GitHub googleapis/google-api-nodejs-client](https://github.com/googleapis/google-api-nodejs-client) - OAuth2Client patterns, setCredentials examples
- [OAuth2Client.setCredentials examples](https://www.tabnine.com/code/javascript/functions/google-auth-library/OAuth2Client/setCredentials) - Credentials object structure

### Tertiary (LOW confidence - WebSearch only)
- [Gmail API MIME types article](https://www.ehfeng.com/gmail-api-mime-types/) - Explains multipart structure complexity
- [Gmail API HTML/Plain Text handling](https://www.gmass.co/blog/gmail-api-html-plain-text-messages/) - Quirks of multipart/alternative emails
- [Gmail Search Operators 2026 Guide](https://kinsta.com/blog/gmail-search-operators/) - Search query examples and patterns

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - googleapis is official Google library with clear documentation, gmail-api-parse-message is standard in ecosystem
- Architecture: HIGH - OAuth2Client per-request pattern verified in official docs, MCP tool patterns match SDK examples
- Pitfalls: HIGH - All verified from official Google documentation or common GitHub issues, base64url encoding confirmed in RFC 4648
- Open questions: MEDIUM - MCP tool size limits and pagination patterns need testing, scope migration is standard OAuth issue

**Research date:** 2026-01-31
**Valid until:** 2026-03-02 (30 days - stable API, but check for googleapis library updates)
