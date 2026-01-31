---
phase: 02-encrypted-token-storage
plan: 01
subsystem: storage
tags: [kms, dynamodb, encryption, aes-gcm, session-store]

# Dependency graph
requires:
  - phase: 01-oauth-mcp-protocol
    provides: Session management with @fastify/session, OAuth credentials in session
provides:
  - KMS envelope encryption module (AES-256-GCM with per-session data keys)
  - DynamoDB session store implementing express-session interface
  - AWS client configuration (KMS, DynamoDB)
  - TypeScript types for encrypted session records
affects: [02-02-PLAN, session-integration, aws-deployment]

# Tech tracking
tech-stack:
  added: [@aws-sdk/client-kms, @aws-sdk/client-dynamodb, @aws-sdk/lib-dynamodb, @types/express-session]
  patterns: [envelope-encryption, callback-to-async-adapter]

key-files:
  created:
    - src/config/aws.ts
    - src/storage/types.ts
    - src/storage/kms-encryption.ts
    - src/storage/dynamodb-session-store.ts
  modified:
    - package.json
    - package-lock.json

key-decisions:
  - "Module-scope AWS clients to avoid per-request instantiation overhead"
  - "Encryption version field for future schema migrations"
  - "Application-level TTL check to handle DynamoDB TTL deletion delay (up to 48h)"
  - "ConsistentRead: true for session reads to prevent stale data after writes"
  - "console.warn for session errors instead of console.error (expected for expired sessions)"

patterns-established:
  - "Envelope encryption: GenerateDataKey for DEK, AES-256-GCM for data encryption"
  - "Callback-to-async adapter: public callback methods wrapping private async implementations"
  - "Base64 encoding for all binary data in DynamoDB storage"

# Metrics
duration: 4min
completed: 2026-01-31
---

# Phase 2 Plan 1: Encrypted Token Storage - Storage Layer

**KMS envelope encryption with AES-256-GCM and DynamoDB session store implementing express-session interface for Fastify integration**

## Performance

- **Duration:** 4 minutes (238 seconds)
- **Started:** 2026-01-31T18:18:18Z
- **Completed:** 2026-01-31T18:22:16Z
- **Tasks:** 3/3
- **Files created:** 4
- **Files modified:** 2

## Accomplishments

- AWS SDK dependencies installed (client-kms, client-dynamodb, lib-dynamodb)
- KMS envelope encryption module with unique data encryption key per session
- DynamoDB session store with encrypted storage and application-level TTL filtering
- TypeScript types for encrypted session records with version field for migrations

## Task Commits

Each task was committed atomically:

1. **Task 1: AWS Configuration and Dependencies** - `245aa6e` (feat)
2. **Task 2: KMS Envelope Encryption Module** - `4527b5c` (feat)
3. **Task 3: DynamoDB Session Store** - `a5f0981` (feat)

## Files Created/Modified

- `src/config/aws.ts` - AWS client configuration (KMS, DynamoDB) with env var overrides
- `src/storage/types.ts` - EncryptedSessionRecord, SessionStoreConfig, EncryptionResult interfaces
- `src/storage/kms-encryption.ts` - encryptSessionData/decryptSessionData using KMS + AES-256-GCM
- `src/storage/dynamodb-session-store.ts` - DynamoDBSessionStore class with get/set/destroy methods
- `package.json` - Added AWS SDK dependencies
- `package-lock.json` - Dependency lockfile updates

## Decisions Made

1. **Module-scope clients** - AWS clients created once at module scope to avoid per-request instantiation overhead (KMS, DynamoDB best practice)
2. **Encryption version field** - Added `version: 1` to records for future encryption scheme migrations without breaking existing sessions
3. **Application-level TTL check** - Check `ttl > now` in code because DynamoDB TTL has up to 48-hour deletion delay
4. **ConsistentRead: true** - Prevent stale session reads after session updates (important for auth state consistency)
5. **console.warn for errors** - Use warn level instead of error for session retrieval failures (expired sessions are expected behavior)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fixed ESM crypto import**
- **Found during:** Task 2 (KMS Envelope Encryption Module)
- **Issue:** `import crypto from 'crypto'` fails in ESM modules with "has no default export" error
- **Fix:** Changed to `import * as crypto from 'crypto'` for ESM compatibility
- **Files modified:** src/storage/kms-encryption.ts
- **Verification:** TypeScript compilation succeeds
- **Committed in:** `4527b5c` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Minor syntax fix for ESM compatibility. No scope creep.

## Issues Encountered

- **Pre-existing TypeScript errors in handlers.ts** - The MCP handlers file from Phase 1 has TypeScript errors with `registerTool` inputSchema type (expects Zod AnySchema). Not blocking for this plan as new files compile correctly. Should be addressed in future maintenance.

## User Setup Required

**AWS resources must be provisioned before integration in Plan 02-02:**

1. **DynamoDB Table:**
   - Table name: `mcp-gateway-sessions` (or set `SESSIONS_TABLE` env var)
   - Partition key: `sessionId` (String)
   - TTL attribute: `ttl`

2. **KMS Key:**
   - Key ARN configured in code: `arn:aws:kms:us-east-1:232282424912:key/afd7365b-7a3a-4ae6-97a6-3dcd0ec9a94a`
   - Or override with `KMS_KEY_ARN` env var

3. **AWS Credentials:**
   - Ensure AWS credentials available via default credential chain (env vars, IAM role, etc.)

## Next Phase Readiness

**Ready for Plan 02-02 integration:**
- All storage layer modules complete and TypeScript-valid
- DynamoDBSessionStore implements express-session interface (compatible with @fastify/session)
- Envelope encryption pattern ensures unique DEK per session

**What Plan 02-02 will do:**
- Wire DynamoDBSessionStore into Fastify session configuration
- Replace in-memory session store with encrypted DynamoDB storage
- Complete AUTH-03 requirement (encrypted token storage)

---
*Phase: 02-encrypted-token-storage*
*Plan: 01*
*Completed: 2026-01-31*
