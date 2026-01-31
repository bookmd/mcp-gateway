---
phase: 03-gmail-integration
plan: 01
subsystem: auth
tags: [oauth, gmail, googleapis, typescript, gmail-api-parse-message]

# Dependency graph
requires:
  - phase: 01-oauth-mcp-protocol
    provides: OAuth flow with Google authentication
  - phase: 02-encrypted-token-storage
    provides: Encrypted token storage for OAuth credentials
provides:
  - Gmail API scope in OAuth flow (gmail.readonly)
  - googleapis client library installed and configured
  - Gmail TypeScript types for MCP tool responses
affects: [03-gmail-integration plan 02, 03-gmail-integration plan 03]

# Tech tracking
tech-stack:
  added: [googleapis@171.0.0, gmail-api-parse-message@2.1.2]
  patterns: [Gmail API types pattern for MCP tool responses]

key-files:
  created: [src/gmail/types.ts]
  modified: [src/auth/oauth-client.ts, src/mcp/handlers.ts, package.json]

key-decisions:
  - "Use full gmail.readonly scope instead of granular scopes for complete message access"
  - "Structure Gmail types with separate summary/full message interfaces for performance"
  - "Exclude attachment body content from types to avoid large responses"

patterns-established:
  - "Gmail message types: GmailMessageSummary for lists, GmailMessage for full content"
  - "Error responses use GmailErrorResult with code/message structure"
  - "Pagination support via nextPageToken in search results"

# Metrics
duration: 5min
completed: 2026-01-31
---

# Phase 03 Plan 01: Gmail Scope and Dependencies Summary

**OAuth flow expanded with gmail.readonly scope, googleapis@171 installed, TypeScript types defined for Gmail MCP tools**

## Performance

- **Duration:** 5 min
- **Started:** 2026-01-31T19:11:16Z
- **Completed:** 2026-01-31T19:16:29Z
- **Tasks:** 2
- **Files modified:** 4 created/modified

## Accomplishments
- Gmail API scope added to OAuth authorization URL
- googleapis@171.0.0 and gmail-api-parse-message@2.1.2 installed
- Complete TypeScript type definitions for Gmail MCP tool responses
- Fixed pre-existing TypeScript compilation errors in MCP handlers

## Task Commits

Each task was committed atomically:

1. **Task 1: Add Gmail Scope and Install Dependencies** - `d8923a4` (feat)
2. **Task 2: Create Gmail TypeScript Types** - `0dae495` (feat)

## Files Created/Modified
- `src/auth/oauth-client.ts` - Added gmail.readonly scope to OAuth authorization
- `package.json` - Added googleapis and gmail-api-parse-message dependencies
- `src/gmail/types.ts` - Complete TypeScript types for Gmail API responses (6 interfaces)
- `src/mcp/handlers.ts` - Fixed TypeScript errors blocking compilation

## Decisions Made

**1. Use full gmail.readonly scope**
- Rationale: Per RESEARCH.md, granular scopes (gmail.labels, gmail.metadata) don't provide access to full message content. gmail.readonly is required for complete message retrieval.

**2. Separate GmailMessageSummary and GmailMessage interfaces**
- Rationale: List/search operations don't need full body content. Separate types improve performance and make intent clear.

**3. Attachment metadata only, no body content**
- Rationale: Attachment bodies can be very large. Including metadata only prevents oversized MCP responses. Future attachment download tool can fetch bodies on demand.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fixed MCP handler TypeScript compilation errors**
- **Found during:** Task 1 (npm run build verification)
- **Issue:** MCP handlers had TypeScript errors preventing compilation:
  - inputSchema with plain JSON objects instead of Zod schemas or undefined
  - Callback signatures with unused `args` parameter for zero-parameter tools
  - Transport property access not typed in RequestHandlerExtra
- **Fix:**
  - Removed inputSchema from zero-parameter tools (whoami, test_auth)
  - Updated callback signatures to match SDK: `async (extra) =>` instead of `async (args, extra) =>`
  - Added type assertion for transport.userContext access: `((extra as any)?.transport as any)?.userContext`
- **Files modified:** src/mcp/handlers.ts
- **Verification:** npm run build completes without errors
- **Committed in:** d8923a4 (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Fix was necessary to unblock TypeScript compilation. No scope creep - corrected pre-existing type errors to match MCP SDK v1.25.3 API.

## Issues Encountered
- Pre-existing TypeScript errors in handlers.ts from MCP SDK type changes. Fixed by aligning with current SDK signatures.

## User Setup Required

**Existing users must re-authenticate to gain Gmail scope:**
- When existing users attempt MCP operations requiring Gmail, they'll receive OAuth errors
- The OAuth callback error handling will direct them to re-login
- New OAuth flow will request gmail.readonly scope automatically
- After re-authentication, Gmail tools will be accessible

No additional manual configuration required.

## Next Phase Readiness

**Ready for Phase 03 Plan 02 (Gmail MCP Tools):**
- OAuth scope configured for Gmail API access
- googleapis client library available for API calls
- TypeScript types defined for tool responses
- Access token available in user context for authenticated API requests

**No blockers identified.**

---
*Phase: 03-gmail-integration*
*Completed: 2026-01-31*
