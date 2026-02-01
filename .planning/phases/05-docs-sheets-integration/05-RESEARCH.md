# Phase 5: Docs/Sheets Integration - Research

**Researched:** 2026-02-01
**Domain:** Google Docs and Sheets APIs with Node.js (googleapis package)
**Confidence:** HIGH

## Summary

This phase adds structured content reading for Google Docs and Google Sheets through their dedicated APIs, going beyond the basic Drive export functionality already implemented in Phase 4. The Google Docs API provides structured document content with formatting metadata, while the Sheets API enables precise cell-level data access with ranges and metadata.

Both APIs are exposed through the existing `googleapis@171.0.0` package already in use for Gmail, Calendar, and Drive. The implementation follows the established pattern: `types/client/parsers/handlers` module structure with per-user OAuth2Client instantiation. Key differences from Drive: Docs/Sheets require their own OAuth scopes (documents.readonly and spreadsheets.readonly) separate from drive.readonly, and they return deeply structured content that requires careful parsing.

Rate limits are generous for read operations: Docs API allows 3000 reads/min per project (300 per user), Sheets API allows 300 reads/min per project (60 per user). Both return structured JSON requiring recursive traversal (Docs for paragraphs/tables, Sheets for ranges/values).

**Primary recommendation:** Use dedicated Docs/Sheets APIs via googleapis package with readonly scopes, following the Gmail/Calendar/Drive module pattern. Add scopes to oauth-client.ts, create parallel module structures (docs/ and sheets/ directories), and implement parsers to flatten complex API responses into MCP-friendly formats.

## Standard Stack

The established libraries/tools for this domain:

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| googleapis | 171.0.0 | Google Docs/Sheets API client | Official Google Node.js client, already in project for Gmail/Calendar/Drive |
| zod | 4.3.6 | MCP tool input schema validation | Already used across all MCP handlers |
| @modelcontextprotocol/sdk | 1.25.3 | MCP server implementation | Project standard for tool registration |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| google-auth-library | Included in googleapis | OAuth2 client creation | Used implicitly through googleapis pattern |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| googleapis | google-spreadsheet (wrapper) | Simpler API but extra dependency; googleapis already present and consistent with existing modules |
| googleapis | @googleapis/docs & @googleapis/sheets | Smaller bundles but separate versioning; googleapis provides unified API surface |
| Direct REST API | googleapis | Would need manual auth handling, type safety, error handling; googleapis provides all this |

**Installation:**
```bash
# Already installed - no new dependencies needed
# googleapis@171.0.0 includes docs and sheets APIs
```

## Architecture Patterns

### Recommended Project Structure
```
src/
├── docs/                # Google Docs API module
│   ├── types.ts        # DocsDocument, DocsContent, DocsGetResult interfaces
│   ├── client.ts       # createDocsClient(userContext) factory
│   ├── parsers.ts      # parseDocument, extractText, parseStructuralElement
│   └── handlers.ts     # registerDocsHandlers(server) - docs_get_content tool
├── sheets/             # Google Sheets API module
│   ├── types.ts        # SheetsData, SheetsRange, SheetsGetResult interfaces
│   ├── client.ts       # createSheetsClient(userContext) factory
│   ├── parsers.ts      # parseValueRange, parseSpreadsheetMetadata
│   └── handlers.ts     # registerSheetsHandlers(server) - sheets_get_values, sheets_get_metadata tools
└── auth/
    └── oauth-client.ts # UPDATE: Add documents.readonly & spreadsheets.readonly scopes
```

### Pattern 1: Per-User API Client Factory
**What:** Create authenticated API clients on-demand per request using user's access token
**When to use:** Every MCP tool handler that needs API access
**Example:**
```typescript
// Source: Existing drive/client.ts pattern
import { google, docs_v1 } from 'googleapis';
import type { UserContext } from '../auth/middleware.js';

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
```

### Pattern 2: Structured Content Parsing
**What:** Convert complex nested API responses to flat, MCP-friendly structures
**When to use:** Docs paragraphs/tables, Sheets ranges with metadata
**Example:**
```typescript
// Source: https://developers.google.com/workspace/docs/api/samples/extract-text
import type { docs_v1 } from 'googleapis';

export function extractText(doc: docs_v1.Schema$Document): string {
  const texts: string[] = [];

  // Traverse tabs (documents can have multiple tabs)
  for (const tab of doc.tabs || []) {
    if (tab.documentTab?.body?.content) {
      for (const element of tab.documentTab.body.content) {
        texts.push(extractElementText(element));
      }
    }
  }

  return texts.join('');
}

function extractElementText(element: docs_v1.Schema$StructuralElement): string {
  if (element.paragraph) {
    return extractParagraphText(element.paragraph);
  } else if (element.table) {
    return extractTableText(element.table);
  }
  return '';
}

function extractParagraphText(paragraph: docs_v1.Schema$Paragraph): string {
  const texts: string[] = [];
  for (const elem of paragraph.elements || []) {
    if (elem.textRun?.content) {
      texts.push(elem.textRun.content);
    }
  }
  return texts.join('');
}
```

### Pattern 3: Centralized Error Handling
**What:** Consistent error response format across all MCP tools
**When to use:** Every API call that could fail
**Example:**
```typescript
// Source: Existing drive/handlers.ts pattern
function handleDocsError(error: any): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  const code = error.code || error.response?.status || 500;
  const message = error.message || 'Unknown Docs API error';

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
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'insufficient_scope',
          code: 403,
          message: 'Docs access not authorized. Please re-authenticate at /auth/login to grant Docs permissions.'
        }, null, 2)
      }],
      isError: true
    };
  }

  // ... 404, rate limit, generic error handling
}
```

### Pattern 4: Zod Schema Validation for MCP Tools
**What:** Define input schemas for MCP tools using Zod for runtime validation
**When to use:** Every tool registration
**Example:**
```typescript
// Source: Existing calendar/handlers.ts pattern
import { z } from 'zod';

server.registerTool('docs_get_content', {
  description: 'Read structured content from a Google Doc including text, formatting, and document structure',
  inputSchema: {
    documentId: z.string().describe('Document ID (from Drive or Docs URL)'),
    includeFormatting: z.boolean().optional().describe('Include text formatting metadata (default: false)')
  }
}, async (args: any, extra: any) => {
  // Handler implementation
});
```

### Anti-Patterns to Avoid
- **Using Drive export for structured content:** Drive's files.export returns plain text/CSV, losing formatting and structure. Use dedicated Docs/Sheets APIs for structured access.
- **Single OAuth2Client instance:** Don't reuse auth clients across users. Each request needs per-user credentials from userContext.
- **Ignoring nested structures:** Docs has tabs→body→elements, Sheets has multiple sheets with ranges. Must traverse recursively.
- **Assuming Drive scope grants Docs/Sheets access:** These are separate APIs requiring their own scopes (documents.readonly, spreadsheets.readonly) even though files are in Drive.

## Don't Hand-Roll

Problems that look simple but have existing solutions:

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Extracting text from Docs | Custom paragraph walker | Recursive traversal of tabs→body→content→paragraphs | Docs support tables, nested lists, TOCs; custom solution misses edge cases |
| Parsing Sheets ranges | String splitting A1 notation | spreadsheets.values.get with range parameter | API handles merged cells, empty rows/cols, multiple sheets correctly |
| OAuth scope management | Manual scope strings | OAuth scopes in auth/oauth-client.ts | Centralized scope definition ensures consistency across auth flow |
| Rate limit handling | Manual request counting | Exponential backoff on 429 responses | Google recommends backoff algorithm: min(((2^n)+random_ms), max_backoff) |
| Document formatting | Parsing style JSON manually | Use TextRun.textStyle fields from API | API provides complete style info: bold, italic, fontSize, foregroundColor, link, etc. |

**Key insight:** Google's Docs/Sheets APIs return deeply nested JSON structures that require careful traversal. The complexity comes from supporting rich features (tabs, tables, nested lists, merged cells, formulas). Don't simplify prematurely—the API structure reflects real document complexity.

## Common Pitfalls

### Pitfall 1: Missing Required OAuth Scopes
**What goes wrong:** 403 "insufficient_scope" errors when calling Docs/Sheets APIs despite having drive.readonly
**Why it happens:** Docs and Sheets are separate APIs from Drive. Drive scope only grants access to file metadata and Drive-level operations (list, search, basic export), not structured content through Docs/Sheets APIs.
**How to avoid:** Add both scopes to auth/oauth-client.ts:
- `https://www.googleapis.com/auth/documents.readonly` for Docs API
- `https://www.googleapis.com/auth/spreadsheets.readonly` for Sheets API
**Warning signs:** Tool works in Drive (file metadata visible) but fails when accessing document content with 403 error mentioning "insufficient permissions" or "scope"

### Pitfall 2: Not Handling Tabs in Documents
**What goes wrong:** Only reading content from first tab, missing data in multi-tab documents
**Why it happens:** Google Docs supports multiple tabs (like Sheets). Content is nested under `doc.tabs[].documentTab.body.content`, not directly in `doc.body.content`
**How to avoid:** Always iterate through `doc.tabs` array and check both `documentTab` and child tabs
**Warning signs:** Some documents return incomplete content, users report "missing sections"

### Pitfall 3: Rate Limit Violations Without Backoff
**What goes wrong:** Burst of requests hits rate limit (429 errors), subsequent requests fail even though quota hasn't refilled
**Why it happens:** Per-minute quotas refill gradually. Without backoff, rapid retries consume the refill capacity before it accumulates
**How to avoid:** Implement exponential backoff: wait `min(((2^n) + random_ms), 32000)` ms on 429, incrementing n per retry
**Warning signs:** 429 errors appearing in logs, requests failing in batches, quota errors despite being under daily limit

### Pitfall 4: Assuming Sheets Data is Always 2D Array
**What goes wrong:** Code crashes on sparse data, merged cells, or empty ranges
**Why it happens:** ValueRange.values is array of arrays, but rows can have different lengths, trailing empty cells are omitted, and merged cells appear as empty
**How to avoid:** Check `result.data.values` existence, handle variable row lengths, normalize data by padding to max length
**Warning signs:** "Cannot read property of undefined" errors, data misalignment in parsed results

### Pitfall 5: Ignoring Export vs. API Content Differences
**What goes wrong:** Users expect consistent format between Drive export and Docs API, but get different representations
**Why it happens:** Drive files.export converts to plain text/CSV (lossy), Docs/Sheets APIs return structured content (lossless). Different tools for different needs.
**How to avoid:** Document the difference clearly in tool descriptions. Use Drive export for "quick text preview", Docs/Sheets APIs for "structured content with metadata"
**Warning signs:** User confusion about which tool to use, bug reports about "missing formatting" from export

### Pitfall 6: Not Handling Document Permission Errors
**What goes wrong:** 404 "File not found" errors when document exists but user lacks access
**Why it happens:** Google returns 404 for both "doesn't exist" and "exists but you can't access it" for privacy (prevents ID enumeration)
**How to avoid:** Return user-friendly message: "File not found or you do not have permission to access it"
**Warning signs:** Users report 404 for documents they "can see in Drive"

## Code Examples

Verified patterns from official sources:

### Reading Google Docs Content
```typescript
// Source: https://developers.google.com/workspace/docs/api/quickstart/nodejs
import { google } from 'googleapis';

async function getDocumentContent(auth: any, documentId: string) {
  const docs = google.docs({ version: 'v1', auth });

  const result = await docs.documents.get({
    documentId: documentId,
    // Important: Include tabs content (documents can have multiple tabs)
    includeTabsContent: true
  });

  return result.data; // Type: docs_v1.Schema$Document
}
```

### Reading Google Sheets Values
```typescript
// Source: https://developers.google.com/sheets/api/guides/values
import { GoogleAuth } from 'google-auth-library';
import { google } from 'googleapis';

async function getSheetValues(spreadsheetId: string, range: string) {
  const auth = new GoogleAuth({
    scopes: 'https://www.googleapis.com/auth/spreadsheets.readonly',
  });

  const service = google.sheets({ version: 'v4', auth });
  const result = await service.spreadsheets.values.get({
    spreadsheetId,
    range, // A1 notation: "Sheet1!A1:D5"
  });

  const numRows = result.data.values ? result.data.values.length : 0;
  return result.data; // Type: sheets_v4.Schema$ValueRange
}
```

### Getting Spreadsheet Metadata
```typescript
// Source: https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets/get
async function getSpreadsheetMetadata(spreadsheetId: string) {
  const sheets = google.sheets({ version: 'v4', auth });

  const result = await sheets.spreadsheets.get({
    spreadsheetId,
    // Don't include grid data (saves bandwidth for metadata-only queries)
    includeGridData: false
  });

  // result.data contains: spreadsheetId, properties, sheets[], namedRanges[], spreadsheetUrl
  return result.data;
}
```

### Extracting Text from Document with Nested Tables
```typescript
// Source: https://developers.google.com/workspace/docs/api/samples/extract-text
function extractAllText(doc: docs_v1.Schema$Document): string {
  const texts: string[] = [];

  // Documents have tabs (like sheets)
  for (const tab of doc.tabs || []) {
    if (tab.documentTab?.body?.content) {
      for (const element of tab.documentTab.body.content) {
        texts.push(extractElementText(element));
      }
    }
  }

  return texts.join('');
}

function extractElementText(element: docs_v1.Schema$StructuralElement): string {
  if (element.paragraph) {
    // Paragraph elements contain text runs
    return (element.paragraph.elements || [])
      .map(e => e.textRun?.content || '')
      .join('');
  } else if (element.table) {
    // Tables have rows with cells, cells have content (recursive)
    const tableTexts: string[] = [];
    for (const row of element.table.tableRows || []) {
      for (const cell of row.tableCells || []) {
        for (const cellElement of cell.content || []) {
          tableTexts.push(extractElementText(cellElement));
        }
      }
    }
    return tableTexts.join(' ');
  }
  return '';
}
```

### ValueRange Structure and Handling
```typescript
// Source: https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets.values
interface ValueRange {
  range: string;           // Actual range returned (may differ from request)
  majorDimension: 'ROWS' | 'COLUMNS';  // How data is organized
  values: any[][];         // 2D array of cell values
}

function parseSheetData(result: sheets_v4.Schema$ValueRange) {
  const range = result.range || 'Unknown';
  const values = result.values || [];

  if (values.length === 0) {
    return { range, rows: [], isEmpty: true };
  }

  // Note: Empty trailing rows/cols are omitted
  // Rows can have different lengths (sparse data)
  const maxCols = Math.max(...values.map(row => row.length));

  // Normalize rows to same length (pad with null)
  const normalizedRows = values.map(row => {
    const padded = [...row];
    while (padded.length < maxCols) padded.push(null);
    return padded;
  });

  return { range, rows: normalizedRows, isEmpty: false };
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Drive files.export | Docs/Sheets dedicated APIs | Always available (separate APIs) | Export loses structure/formatting; APIs provide rich content |
| googleapis v105 in quickstarts | googleapis v171.0.0 in project | Package evolves continuously | Newer versions have better TypeScript types, bug fixes |
| @google-cloud/local-auth | OpenID Connect (openid-client) | Project architecture choice | Local-auth is for CLI tools; OpenID for web apps with user sessions |
| Single-tab documents | Multi-tab document support | Docs API added tabs recently | Must iterate tabs array, not assume single body |
| drive.readonly only | documents.readonly + spreadsheets.readonly | Separate APIs require separate scopes | Need explicit scopes even though files are in Drive |

**Deprecated/outdated:**
- **Drive export as primary content access:** Still works but lossy. Use for preview/fallback only, not primary content source
- **Assuming single document body:** Old Docs had single body, now uses tabs array. Code checking `doc.body.content` directly will miss content in tabs
- **Manual OAuth flows with @google-cloud/local-auth:** This is for CLI/desktop apps. Web apps should use OAuth2 flows with proper redirect URIs and session management (already implemented in this project)

## Open Questions

Things that couldn't be fully resolved:

1. **Drive scope relationship clarity**
   - What we know: Drive scopes grant file metadata access and export capabilities. Docs/Sheets APIs require their own scopes for structured content access
   - What's unclear: Can drive.readonly be used with files.export for Docs/Sheets, or does export also require Docs/Sheets scopes? Documentation suggests export works with Drive scope, structured API access needs dedicated scopes
   - Recommendation: Use Drive scope for export (already implemented), add Docs/Sheets scopes for new structured APIs. Test both paths to confirm scope requirements

2. **Optimal batching strategy for multiple documents**
   - What we know: Both APIs support batch requests. Docs allows 600 writes/min (read limits are 3000/min), Sheets allows batch operations counting as single request toward quota
   - What's unclear: Does googleapis support batch requests for read operations? Official docs show batch for writes, but read batching isn't clearly documented
   - Recommendation: Start with individual requests (within quota limits). If performance becomes issue, investigate googleapis batch support or parallel requests with concurrency control

3. **Formatting metadata completeness**
   - What we know: TextRun.textStyle contains bold, italic, fontSize, foregroundColor, backgroundColor, link, etc. Full schema in API reference
   - What's unclear: How complete is formatting preservation? Are there edge cases (custom fonts, advanced formatting) that aren't captured?
   - Recommendation: For Phase 5, extract basic text and structure. Document known limitations in tool descriptions. Consider adding formatting parameter for future enhancement

4. **Error handling for partial read failures**
   - What we know: 429 errors should use exponential backoff. 403 means insufficient scope. 404 means not found or no access
   - What's unclear: If reading multi-tab document and one tab fails (corrupted, permission boundary?), does whole request fail or partial data returned?
   - Recommendation: Wrap tab/element traversal in try-catch, collect errors, return partial data with error annotations rather than failing completely

## Sources

### Primary (HIGH confidence)
- [Google Docs API Reference](https://developers.google.com/docs/api/reference/rest) - API methods and resources
- [Google Sheets API Reference](https://developers.google.com/sheets/api/reference/rest) - API methods and resources
- [Google Docs Node.js Quickstart](https://developers.google.com/docs/api/quickstart/nodejs) - Official Node.js setup and authentication
- [Google Sheets Node.js Quickstart](https://developers.google.com/sheets/api/quickstart/nodejs) - Official Node.js setup
- [Document Structure Guide](https://developers.google.com/workspace/docs/api/concepts/structure) - Tabs, paragraphs, tables, structural elements
- [Extract Text Sample](https://developers.google.com/workspace/docs/api/samples/extract-text) - Official text extraction pattern
- [Sheets Values Guide](https://developers.google.com/sheets/api/guides/values) - Reading cell data with spreadsheets.values.get
- [ValueRange Reference](https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets.values) - ValueRange structure and fields
- [Spreadsheet Resource Reference](https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets) - Spreadsheet metadata structure
- [OAuth Scopes for Google APIs](https://developers.google.com/identity/protocols/oauth2/scopes) - Official scope definitions
- [Google Docs API Best Practices](https://developers.google.com/workspace/docs/api/how-tos/best-practices) - WriteControl, tabs handling, editing backwards
- [Sheets API Usage Limits](https://developers.google.com/workspace/sheets/api/limits) - Rate limits: 300 reads/min per project
- [Docs API Usage Limits](https://developers.google.com/workspace/docs/api/limits) - Rate limits: 3000 reads/min per project
- [Choose Sheets API Scopes](https://developers.google.com/workspace/sheets/api/scopes) - Sheets vs Drive scope relationship
- [Drive API Scopes Guide](https://developers.google.com/workspace/drive/api/guides/api-specific-auth) - Scope independence between APIs
- [Output Document as JSON Sample](https://developers.google.com/workspace/docs/api/samples/output-json) - Document.get method usage

### Secondary (MEDIUM confidence)
- [MoldStud: Google Sheets API Best Practices](https://moldstud.com/articles/p-mastering-google-sheets-api-best-practices-common-pitfalls) - Common pitfalls, authentication issues (80% failures), rate limiting patterns
- [googleapis npm package](https://www.npmjs.com/package/googleapis) - Package version 171.0.0 (latest)
- [@googleapis/sheets npm](https://www.npmjs.com/package/@googleapis/sheets) - Alternative package v12.0.0
- [@googleapis/docs npm](https://www.npmjs.com/package/@googleapis/docs) - Alternative package v9.0.0
- [Node.js Google Spreadsheet Wrapper](https://github.com/theoephraim/node-google-spreadsheet) - Alternative wrapper library (not using, but validates patterns)

### Tertiary (LOW confidence)
- WebSearch results for best practices and common mistakes - General patterns validated against official docs
- Community tutorials on TypeScript usage - Patterns confirmed with official quickstarts

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - googleapis@171.0.0 already in use, official Google package, confirmed via package.json
- Architecture: HIGH - Pattern established in existing calendar/drive/gmail modules, directly applicable
- Pitfalls: HIGH - Verified through official documentation (scope requirements, rate limits, tabs structure, ValueRange handling)
- Code examples: HIGH - All examples from official Google documentation or existing project code

**Research date:** 2026-02-01
**Valid until:** 2026-03-01 (30 days - APIs are stable, but quota limits and best practices may evolve)

**Notes:**
- No CONTEXT.md constraints - full discretion on implementation approach
- Prior phases established OAuth, session management, module patterns - reuse completely
- Drive module already handles Google Workspace files via export - this phase adds structured APIs
- No new npm dependencies needed - googleapis@171.0.0 includes everything required
