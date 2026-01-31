# Phase 4: Calendar + Drive Integration - Research

**Researched:** 2026-01-31
**Domain:** Google Calendar API & Google Drive API
**Confidence:** HIGH

## Summary

Google Calendar and Drive APIs are both part of the googleapis npm package (v171.0.0 already installed), following the same pattern established in Phase 3 for Gmail. Both APIs use identical authentication patterns (per-user OAuth2Client with access token), support TypeScript types out of the box (calendar_v3 and drive_v3 namespaces), and follow Google's standard REST API conventions.

Calendar API enables listing events with date ranges, retrieving full event details including attendees/location/description, and handles recurring events via the singleEvents parameter. Drive API supports file search by name/content using query syntax, folder hierarchy traversal, and both binary file downloads and Google Workspace document exports.

The implementation can directly mirror the Gmail module structure: types.ts for interfaces, client.ts for API client factory, parsers.ts for response transformation, and handlers.ts for MCP tool registration. No additional npm packages required beyond the existing googleapis installation.

**Primary recommendation:** Follow Phase 3 Gmail pattern exactly - create calendar/ and drive/ modules alongside gmail/, use identical client factory pattern, reuse error handling approach, and maintain 50-result limit for consistency.

## Standard Stack

The established libraries/tools for this domain:

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| googleapis | 171.0.0 | Google Calendar & Drive API client | Official Google library, already installed, includes TypeScript types for calendar_v3 and drive_v3 |
| zod | 4.3.6 | Runtime validation for MCP tool inputs | Already established in Phase 3 for Gmail tool validation |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| N/A | - | No additional libraries needed | Google APIs provide all necessary functionality |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| googleapis | @googleapis/calendar + @googleapis/drive | Separate packages for each API - unnecessary complexity when googleapis provides unified access to all Google APIs |
| Manual parsing | Helper libraries for Drive content | No mature libraries exist for Drive file parsing; googleapis handles encoding/streaming correctly |

**Installation:**
```bash
# No installation needed - googleapis already present
# Already installed in Phase 3:
# npm install googleapis@171.0.0 zod@4.3.6
```

## Architecture Patterns

### Recommended Project Structure
```
src/
├── calendar/              # Calendar API module
│   ├── types.ts          # CalendarEvent, CalendarEventSummary, CalendarListResult
│   ├── client.ts         # createCalendarClient(userContext)
│   ├── parsers.ts        # parseEventSummary, parseFullEvent
│   └── handlers.ts       # registerCalendarHandlers(server)
├── drive/                 # Drive API module
│   ├── types.ts          # DriveFile, DriveSearchResult, DriveFileContent
│   ├── client.ts         # createDriveClient(userContext)
│   ├── parsers.ts        # parseFileMetadata, parseFileContent
│   └── handlers.ts       # registerDriveHandlers(server)
└── mcp/
    └── handlers.ts        # Import and register all handlers
```

### Pattern 1: Per-User API Client Factory
**What:** Create calendar/drive clients on-demand per request using user's access token
**When to use:** Every MCP tool call that needs Calendar or Drive access
**Example:**
```typescript
// Source: Existing Gmail pattern in src/gmail/client.ts
import { google, calendar_v3, drive_v3 } from 'googleapis';
import type { UserContext } from '../auth/middleware.js';

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
```

### Pattern 2: Typed Response Interfaces
**What:** Define TypeScript interfaces that match MCP response format
**When to use:** All API responses - separates API schema from internal types
**Example:**
```typescript
// Source: Existing Gmail pattern in src/gmail/types.ts
// Calendar types
export interface CalendarEventSummary {
  id: string;
  summary: string;
  start: string;  // ISO 8601 datetime
  end: string;
  status: string; // confirmed, tentative, cancelled
  htmlLink: string;
}

export interface CalendarEvent extends CalendarEventSummary {
  description: string | null;
  location: string | null;
  attendees: CalendarAttendee[];
  organizer: CalendarOrganizer;
  recurringEventId?: string;
}

export interface CalendarAttendee {
  email: string;
  displayName?: string;
  responseStatus: 'needsAction' | 'declined' | 'tentative' | 'accepted';
  optional: boolean;
}

// Drive types
export interface DriveFileSummary {
  id: string;
  name: string;
  mimeType: string;
  size?: number;
  modifiedTime: string;
  webViewLink: string;
  parents?: string[];
}

export interface DriveFileContent extends DriveFileSummary {
  content: string | null;  // Text content for supported types
  exportFormat?: string;   // MIME type used for export
}
```

### Pattern 3: Parser Functions for API Response Transformation
**What:** Convert Google API responses to internal typed interfaces
**When to use:** After every API call, before returning to MCP
**Example:**
```typescript
// Source: Existing Gmail pattern in src/gmail/parsers.ts
import type { calendar_v3, drive_v3 } from 'googleapis';

export function parseEventSummary(
  event: calendar_v3.Schema$Event
): CalendarEventSummary {
  return {
    id: event.id || '',
    summary: event.summary || '(No title)',
    start: event.start?.dateTime || event.start?.date || '',
    end: event.end?.dateTime || event.end?.date || '',
    status: event.status || 'confirmed',
    htmlLink: event.htmlLink || ''
  };
}

export function parseFullEvent(
  event: calendar_v3.Schema$Event
): CalendarEvent {
  const summary = parseEventSummary(event);

  const attendees = (event.attendees || []).map(att => ({
    email: att.email || '',
    displayName: att.displayName,
    responseStatus: att.responseStatus || 'needsAction',
    optional: att.optional || false
  }));

  return {
    ...summary,
    description: event.description || null,
    location: event.location || null,
    attendees,
    organizer: {
      email: event.organizer?.email || '',
      displayName: event.organizer?.displayName,
      self: event.organizer?.self || false
    },
    recurringEventId: event.recurringEventId
  };
}

export function parseFileMetadata(
  file: drive_v3.Schema$File
): DriveFileSummary {
  return {
    id: file.id || '',
    name: file.name || 'Untitled',
    mimeType: file.mimeType || 'application/octet-stream',
    size: file.size ? parseInt(file.size) : undefined,
    modifiedTime: file.modifiedTime || '',
    webViewLink: file.webViewLink || '',
    parents: file.parents
  };
}
```

### Pattern 4: MCP Tool Registration with Zod Schemas
**What:** Register MCP tools with Zod input validation, matching Gmail pattern
**When to use:** All MCP tools for Calendar and Drive
**Example:**
```typescript
// Source: Existing Gmail pattern in src/gmail/handlers.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function registerCalendarHandlers(server: McpServer): void {
  server.registerTool('calendar_list_events', {
    description: 'List upcoming calendar events within specified date range',
    inputSchema: {
      timeMin: z.string().optional().describe('Start datetime (ISO 8601, default: now)'),
      timeMax: z.string().optional().describe('End datetime (ISO 8601, default: 7 days from now)'),
      maxResults: z.number().min(1).max(50).optional().describe('Maximum results (1-50, default 10)'),
      pageToken: z.string().optional().describe('Pagination token from previous result')
    }
  }, async (args: any, extra: any) => {
    // Handler implementation
  });
}

export function registerDriveHandlers(server: McpServer): void {
  server.registerTool('drive_search', {
    description: 'Search Drive files by name or content using query syntax',
    inputSchema: {
      query: z.string().describe('Search query (e.g., "name contains \'report\'", "fullText contains \'quarterly\'")'),
      maxResults: z.number().min(1).max(50).optional().describe('Maximum results (1-50, default 10)'),
      pageToken: z.string().optional().describe('Pagination token from previous result')
    }
  }, async (args: any, extra: any) => {
    // Handler implementation
  });
}
```

### Pattern 5: Centralized Error Handling
**What:** Single error handler function that maps API errors to user-friendly messages
**When to use:** Wrap all API calls in try/catch, delegate to handler
**Example:**
```typescript
// Source: Existing Gmail pattern in src/gmail/handlers.ts
function handleCalendarError(error: any): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  const code = error.code || error.response?.status || 500;
  const message = error.message || 'Unknown Calendar API error';

  if (code === 401) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'token_expired',
          code: 401,
          message: 'Access token expired. Please re-authenticate at /auth/login'
        }, null, 2)
      }],
      isError: true
    };
  }

  if (code === 403) {
    // Check if rate limit or insufficient scope
    if (message.includes('rate') || message.includes('quota')) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: 'rate_limited',
            code: 403,
            message: 'Calendar API rate limit exceeded. Please wait and try again.'
          }, null, 2)
        }],
        isError: true
      };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'insufficient_scope',
          code: 403,
          message: 'Calendar access not authorized. Please re-authenticate at /auth/login'
        }, null, 2)
      }],
      isError: true
    };
  }

  // Generic error
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        error: 'calendar_api_error',
        code: code,
        message: message
      }, null, 2)
    }],
    isError: true
  };
}
```

### Anti-Patterns to Avoid
- **Global API clients:** Never create shared calendar/drive clients - always per-user per-request (follows Phase 3 decision 03-02)
- **Hand-rolling MIME parsing:** For Drive file content, use googleapis streaming and Buffer handling, not custom parsers
- **Ignoring pagination:** Calendar/Drive APIs return paginated results - always include nextPageToken in responses
- **Unlimited maxResults:** Cap at 50 like Gmail to prevent oversized MCP responses (follows Phase 3 decision 03-03)

## Don't Hand-Roll

Problems that look simple but have existing solutions:

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Recurring event expansion | Custom recurrence logic | Calendar API singleEvents=true parameter | Handles complex RRULE parsing, exceptions, timezone conversions automatically |
| Drive folder traversal | Recursive folder walking | Drive API query with 'parents' operator | Single query returns all files in folder, avoids N+1 queries |
| Google Docs content extraction | HTML scraping or custom parser | Drive API files.export with MIME type | Official export handles document structure, formatting, embedded content |
| Binary vs text file handling | Manual encoding detection | googleapis responseType: 'stream' | Library handles encoding correctly, prevents UTF-8 corruption of binary files |
| Date range filtering | Client-side filtering after fetch | Calendar API timeMin/timeMax parameters | Server-side filtering reduces bandwidth, respects pagination correctly |

**Key insight:** Google APIs are mature with comprehensive server-side capabilities. Client-side workarounds for filtering, parsing, or format conversion typically indicate missing API parameters or incorrect usage patterns.

## Common Pitfalls

### Pitfall 1: Recurring Events Return Unexpected Results
**What goes wrong:** calendar.events.list() returns single recurring event definition instead of individual occurrences, breaking "list upcoming events" functionality
**Why it happens:** Default behavior returns the recurring event template (with RRULE), not expanded instances
**How to avoid:** Always set singleEvents=true when listing events: `calendar.events.list({ calendarId: 'primary', singleEvents: true, orderBy: 'startTime' })`
**Warning signs:** Events with recurrence field present, start times far in past, missing expected occurrences

### Pitfall 2: Drive Search Misses Expected Files
**What goes wrong:** Search query returns incomplete results or excludes files user can see in Drive UI
**Why it happens:** Default files.list() includes trashed files, query syntax requires exact escaping, 'contains' operator only does prefix matching for names
**How to avoid:** Always add trashed=false to query: `q: "trashed=false and name contains 'report'"`. Use fullText for content search, name contains for prefix matching. Escape special characters with backslash.
**Warning signs:** Trashed files in results, searches by partial name failing, special characters (quotes, backslashes) breaking queries

### Pitfall 3: Drive File Content Returns Garbled Binary
**What goes wrong:** Downloaded files have corrupted content, especially PDFs and images
**Why it happens:** googleapis defaults to UTF-8 string encoding, corrupting binary data. Must explicitly request stream/buffer response.
**How to avoid:** Use responseType: 'stream' option: `drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' })` or specify encoding: null for Buffer response
**Warning signs:** Text files work but PDFs/images corrupted, file size changes after download, encoding errors in logs

### Pitfall 4: Google Docs Export Fails with 404
**What goes wrong:** files.get with alt=media returns 404 for Google Docs/Sheets/Slides
**Why it happens:** Google Workspace documents don't have blob storage - must use files.export instead of files.get
**How to avoid:** Check mimeType - if starts with 'application/vnd.google-apps.', use files.export with target MIME type (e.g., 'text/plain', 'text/csv'). Use files.get with alt=media only for blob files.
**Warning signs:** 404 errors on Docs/Sheets, "file not found" for documents visible in UI, mimeType includes 'google-apps'

### Pitfall 5: Rate Limit 403 Despite Low Request Volume
**What goes wrong:** API returns "Calendar usage limits exceeded" even with < 100 requests/day
**Why it happens:** Calendar API has per-user quotas (25K/100s/user) AND undocumented calendar-specific limits. Sync operations can hit hidden thresholds.
**How to avoid:** Implement exponential backoff on 403 responses (start with 1s, double up to 32s). Use pagination to reduce per-request result size. Avoid parallel requests to same calendar.
**Warning signs:** "Calendar usage limits exceeded" message, 403 errors during list operations, errors on calendar transfers

### Pitfall 6: Event Attendees Missing or Incomplete
**What goes wrong:** event.attendees array is empty despite event having attendees
**Why it happens:** Service accounts need domain-wide delegation to see attendee lists. Personal calendars shared with service account may hide attendee details based on sharing settings.
**How to avoid:** Use user OAuth (not service account) for reading event details. Check event sharing settings. Organizer field is always visible, but attendees array requires appropriate permissions.
**Warning signs:** Empty attendees array, organizer present but no other attendees, privacy settings blocking access

## Code Examples

Verified patterns from official sources:

### Calendar - List Upcoming Events
```typescript
// Source: https://developers.google.com/workspace/calendar/api/quickstart/nodejs
const calendar = createCalendarClient(userContext);

const response = await calendar.events.list({
  calendarId: 'primary',
  timeMin: new Date().toISOString(),
  timeMax: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  maxResults: 10,
  singleEvents: true,  // CRITICAL: Expand recurring events
  orderBy: 'startTime', // Required when singleEvents=true
  pageToken: args.pageToken
});

const events = (response.data.items || []).map(parseEventSummary);
return {
  events,
  nextPageToken: response.data.nextPageToken || null
};
```

### Calendar - Get Event Details
```typescript
// Source: https://developers.google.com/workspace/calendar/api/v3/reference/events
const calendar = createCalendarClient(userContext);

const response = await calendar.events.get({
  calendarId: 'primary',
  eventId: args.eventId
});

const event = parseFullEvent(response.data);
// event includes: description, location, attendees, organizer
```

### Drive - Search Files
```typescript
// Source: https://developers.google.com/workspace/drive/api/guides/search-files
const drive = createDriveClient(userContext);

// Query syntax: field operator value
// Available: name, fullText, mimeType, parents, trashed
const response = await drive.files.list({
  q: `trashed=false and ${args.query}`,
  fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime, webViewLink, parents)',
  pageSize: Math.min(args.maxResults || 10, 50),
  pageToken: args.pageToken
});

const files = (response.data.files || []).map(parseFileMetadata);
return {
  files,
  nextPageToken: response.data.nextPageToken || null
};
```

### Drive - List Files in Folder
```typescript
// Source: https://developers.google.com/workspace/drive/api/guides/search-files
const drive = createDriveClient(userContext);

const response = await drive.files.list({
  q: `trashed=false and '${folderId}' in parents`,
  fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime, webViewLink)',
  pageSize: 50,
  pageToken: args.pageToken
});
```

### Drive - Read Text File Content
```typescript
// Source: https://developers.google.com/workspace/drive/api/guides/manage-downloads
const drive = createDriveClient(userContext);

// First, get file metadata to check MIME type
const metaResponse = await drive.files.get({
  fileId: args.fileId,
  fields: 'id, name, mimeType'
});

const file = metaResponse.data;
let content: string;

// Google Workspace documents - export to text
if (file.mimeType?.startsWith('application/vnd.google-apps.')) {
  const exportMimeType = getExportMimeType(file.mimeType);
  const exportResponse = await drive.files.export({
    fileId: args.fileId,
    mimeType: exportMimeType
  }, {
    responseType: 'stream'
  });

  // Collect stream to string
  const chunks: Buffer[] = [];
  for await (const chunk of exportResponse.data) {
    chunks.push(chunk);
  }
  content = Buffer.concat(chunks).toString('utf-8');
} else {
  // Regular file - download with alt=media
  const downloadResponse = await drive.files.get({
    fileId: args.fileId,
    alt: 'media'
  }, {
    responseType: 'stream'
  });

  // Collect stream to string (only for text files!)
  const chunks: Buffer[] = [];
  for await (const chunk of downloadResponse.data) {
    chunks.push(chunk);
  }
  content = Buffer.concat(chunks).toString('utf-8');
}

// Helper: Map Google Workspace MIME types to export formats
function getExportMimeType(googleMimeType: string): string {
  const exportMap = {
    'application/vnd.google-apps.document': 'text/plain',
    'application/vnd.google-apps.spreadsheet': 'text/csv',
    'application/vnd.google-apps.presentation': 'text/plain'
  };
  return exportMap[googleMimeType] || 'text/plain';
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Drive API v2 parents field as array | Drive API v3 single parent only | September 2020 | Simplified folder hierarchy - use 'folderId' in parents query, not array |
| Manual sync token management | Sync tokens in API responses | Calendar v3 stable | Use nextSyncToken for incremental sync instead of manual tracking |
| @google-cloud/local-auth for desktop OAuth | Server-side OAuth2Client with token storage | Ongoing | Desktop library inappropriate for server apps - use OAuth2Client directly |
| Separate @googleapis/calendar and @googleapis/drive packages | Unified googleapis package | Ongoing | Single package simplifies version management, includes all Google APIs |

**Deprecated/outdated:**
- **Drive API v2:** Deprecated, use v3. Key change: files can only have one parent folder
- **Calendar API syncToken in query params:** Old sync implementations passed token incorrectly - use syncToken parameter explicitly
- **@google-cloud/local-auth:** Designed for desktop applications only - server apps should use OAuth2Client with database token storage (as implemented in Phase 2)

## Open Questions

Things that couldn't be fully resolved:

1. **Drive file size limits for MCP responses**
   - What we know: Gmail limits messages to 50 results (Phase 3 decision). Drive files.export has 10 MB limit per file.
   - What's unclear: Should we impose a content size limit (e.g., refuse to read >1MB files)? Or trust MCP transport to handle large responses?
   - Recommendation: Start with no size limit (besides Google's 10MB export limit), add limit if MCP responses become problematic. Document in tool description that large files may cause delays.

2. **Calendar recurring event instance limits**
   - What we know: singleEvents=true expands recurring events to individual instances. Calendar API enforces undocumented limits on expansion.
   - What's unclear: Exact limits for how far future instances are expanded, behavior when recurring series extends beyond expansion window.
   - Recommendation: Use standard timeMin/timeMax date range (default 7 days) to naturally limit expansion. Document that very long-running recurring events may require multiple queries with different date ranges.

3. **Drive shared drives (Team Drives) support**
   - What we know: Shared drives require different API parameters (supportsAllDrives=true, includeItemsFromAllDrives=true) and different permission model.
   - What's unclear: Whether users need shared drive access in Phase 4, or if personal "My Drive" is sufficient.
   - Recommendation: Start with "My Drive" only (no additional parameters). Add shared drive support in future phase if requested. Document limitation in tool descriptions.

## Sources

### Primary (HIGH confidence)
- Google Calendar API Node.js Quickstart - https://developers.google.com/workspace/calendar/api/quickstart/nodejs (Official, last updated 2025-12)
- Google Drive API Node.js Quickstart - https://developers.google.com/workspace/drive/api/quickstart/nodejs (Official, last updated 2025-12)
- Calendar API Error Handling Guide - https://developers.google.com/workspace/calendar/api/guides/errors (Official)
- Drive API Search Files Guide - https://developers.google.com/workspace/drive/api/guides/search-files (Official, last updated 2026-01-26)
- Drive API Download/Export Guide - https://developers.google.com/workspace/drive/api/guides/manage-downloads (Official)
- Drive Export MIME Types Reference - https://developers.google.com/workspace/drive/api/guides/ref-export-formats (Official, last updated 2025-12-11)
- Calendar API Events Reference - https://developers.google.com/workspace/calendar/api/v3/reference/events (Official)
- Drive API Files Reference - https://developers.google.com/workspace/drive/api/reference/rest/v3/files (Official)

### Secondary (MEDIUM confidence)
- googleapis npm package - https://www.npmjs.com/package/googleapis (Official package, verified v171.0.0)
- Google OAuth Scopes for Calendar - https://developers.google.com/workspace/calendar/api/auth (Official, last updated 2026-01-22)
- Google OAuth Scopes for Drive - https://developers.google.com/workspace/drive/api/guides/api-specific-auth (Official, last updated 2026-01-09)
- Calendar API Pagination Guide - https://developers.google.com/workspace/calendar/api/guides/pagination (Official)
- Drive API Search Query Reference - https://developers.google.com/workspace/drive/api/guides/ref-search-terms (Official, last updated 2026-01-26)
- Calendar API Recurring Events Guide - https://developers.google.com/workspace/calendar/api/guides/recurringevents (Official)

### Tertiary (LOW confidence)
- Various Medium tutorials on Calendar/Drive API integration (2024-2025) - Used for community patterns, verified against official docs
- GitHub issues on googleapis/google-api-nodejs-client - Used for known pitfalls (binary encoding, streaming), verified with official docs

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - googleapis package already installed, version confirmed in package.json, official Google library
- Architecture: HIGH - Pattern directly mirrors Phase 3 Gmail implementation, verified in codebase
- Pitfalls: HIGH - Documented in official error handling guides and verified in GitHub issues with official responses
- Code examples: HIGH - All examples sourced from official Google documentation or existing Gmail implementation

**Research date:** 2026-01-31
**Valid until:** 2026-03-02 (30 days - Google APIs are stable, no major changes expected)
