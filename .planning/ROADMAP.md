# Roadmap: MCP Gateway for Google Workspace

**Project:** MCP Gateway for Google Workspace
**Created:** 2026-01-31
**Depth:** Standard (6 phases)

## Overview

This roadmap delivers a centralized MCP gateway that gives Cursor users authenticated access to Google Workspace services through corporate accounts. The approach prioritizes security-first patterns (OAuth 2.1 with PKCE, encrypted token storage) before expanding API coverage. Phases derive from natural delivery boundaries: establish authentication, secure token persistence, incrementally add Google API integrations, and deploy to production AWS infrastructure.

## Phases

### Phase 1: OAuth + MCP Protocol

**Goal:** Users can authenticate with their Google Workspace accounts and establish secure MCP connections from Cursor.

**Dependencies:** None (foundation phase)

**Requirements:**
- AUTH-01: User can authenticate via Google OAuth 2.1 with PKCE from Cursor
- AUTH-02: Only @company.com domain accounts can authenticate (hd claim validation)
- AUTH-04: User must re-authenticate weekly (no long-lived refresh tokens)
- INFRA-01: MCP server uses SSE transport for Cursor connections
- INFRA-03: Each user's API calls use their own OAuth credentials

**Success Criteria:**
1. User can initiate OAuth flow from Cursor and complete authorization in browser
2. Only users with @company.com domain accounts receive access tokens (others rejected)
3. User receives "authentication required" error after 7 days without re-authenticating
4. Cursor establishes SSE connection with gateway and receives MCP initialize response
5. Gateway associates each user session with their individual OAuth credentials

**Plans:** 3 plans

Plans:
- [x] 01-01-PLAN.md — Project foundation + OAuth PKCE flow implementation
- [x] 01-02-PLAN.md — MCP server with SSE transport
- [x] 01-03-PLAN.md — OAuth-MCP integration + E2E verification

**Status:** Complete
**Completed:** 2026-01-31

---

### Phase 2: Encrypted Token Storage

**Goal:** OAuth tokens are stored securely in encrypted database before handling production user credentials.

**Dependencies:** Phase 1 (OAuth flow must work before persisting tokens)

**Requirements:**
- AUTH-03: OAuth tokens stored encrypted in DynamoDB with KMS

**Success Criteria:**
1. OAuth tokens encrypted with KMS customer-managed key before DynamoDB write
2. Gateway retrieves and decrypts stored tokens on subsequent user connections
3. User maintains authenticated session across gateway restarts (tokens persist)
4. Tokens automatically expire from DynamoDB after 7 days (TTL cleanup)

**Plans:** 2 plans

Plans:
- [x] 02-01-PLAN.md — KMS encryption module + DynamoDB session store
- [x] 02-02-PLAN.md — Fastify integration + E2E persistence verification

**Status:** Complete
**Completed:** 2026-01-31

---

### Phase 3: Gmail Integration

**Goal:** Users can search, list, and read their Gmail messages from Cursor.

**Dependencies:** Phase 2 (requires secure token storage for API authentication)

**Requirements:**
- GMAIL-01: User can search Gmail messages by query
- GMAIL-02: User can list messages from inbox/labels
- GMAIL-03: User can read full email content and metadata

**Success Criteria:**
1. User can search Gmail with natural language query and receive relevant messages
2. User can list messages from specific inbox or label with pagination
3. User can retrieve full email content including sender, subject, body, and metadata
4. Gateway handles token expiration and prompts re-authentication within weekly window

**Plans:** 3 plans

Plans:
- [x] 03-01-PLAN.md — Gmail OAuth scope + dependencies + types
- [x] 03-02-PLAN.md — Gmail client factory + message parser
- [x] 03-03-PLAN.md — Gmail MCP tools + E2E verification

**Status:** Complete
**Completed:** 2026-01-31

---

### Phase 4: Calendar + Drive Integration

**Goal:** Users can access their calendar events and Google Drive files from Cursor.

**Dependencies:** Phase 3 (validates API adapter pattern before expanding)

**Requirements:**
- CAL-01: User can list upcoming calendar events
- CAL-02: User can read event details (attendees, location, description)
- DRIVE-01: User can search files by name or content
- DRIVE-02: User can list files and folders
- DRIVE-03: User can read file content (text-based files)

**Success Criteria:**
1. User can list upcoming calendar events within specified date range
2. User can retrieve complete event details including attendees, location, and description
3. User can search Drive by file name or content and receive matching results
4. User can list files and folders with hierarchy information
5. User can read content from text-based files (Docs, TXT, code files)

**Plans:** 2 plans

Plans:
- [x] 04-01-PLAN.md — OAuth scopes + Calendar module + MCP tools
- [x] 04-02-PLAN.md — Drive module + MCP tools + E2E verification

**Status:** Complete
**Completed:** 2026-02-01

---

### Phase 5: Docs/Sheets Integration

**Goal:** Users can read structured content from Google Docs and Sheets from Cursor.

**Dependencies:** Phase 4 (completes core API coverage)

**Requirements:**
- DOCS-01: User can read Google Docs content
- SHEETS-01: User can read Google Sheets data

**Success Criteria:**
1. User can retrieve formatted text content from Google Docs documents
2. User can read spreadsheet data with cell values, ranges, and sheet metadata
3. Gateway handles API-specific formatting and returns structured content

**Plans:** 2 plans

Plans:
- [x] 05-01-PLAN.md — OAuth scopes + Docs module + MCP tool
- [x] 05-02-PLAN.md — Sheets module + MCP tools

**Status:** Complete
**Completed:** 2026-02-01

---

### Phase 6: AWS Deployment

**Goal:** Gateway runs on production AWS infrastructure with ECS/Fargate.

**Dependencies:** Phase 5 (all features complete before production deployment)

**Requirements:**
- INFRA-02: Gateway deployed on AWS ECS/Fargate

**Success Criteria:**
1. Gateway runs as containerized service on ECS Fargate cluster
2. Application Load Balancer routes HTTPS traffic to Fargate tasks
3. Gateway scales automatically based on connection load
4. Users connect to production domain without localhost or port configuration
5. Health check endpoint enables automatic task restart on failures

**Status:** Pending

---

## Progress

| Phase | Requirements | Status | Completion |
|-------|--------------|--------|------------|
| 1 - OAuth + MCP Protocol | AUTH-01, AUTH-02, AUTH-04, INFRA-01, INFRA-03 | Complete | 100% |
| 2 - Encrypted Token Storage | AUTH-03 | Complete | 100% |
| 3 - Gmail Integration | GMAIL-01, GMAIL-02, GMAIL-03 | Complete | 100% |
| 4 - Calendar + Drive | CAL-01, CAL-02, DRIVE-01, DRIVE-02, DRIVE-03 | Complete | 100% |
| 5 - Docs/Sheets | DOCS-01, SHEETS-01 | Complete | 100% |
| 6 - AWS Deployment | INFRA-02 | Pending | 0% |

**Overall Progress:** 16/17 requirements complete (94%)

---

## Coverage Validation

**Total v1 Requirements:** 17
**Mapped to Phases:** 17
**Unmapped:** 0

| Requirement | Phase | Category |
|-------------|-------|----------|
| AUTH-01 | Phase 1 | Authentication |
| AUTH-02 | Phase 1 | Authentication |
| AUTH-03 | Phase 2 | Authentication |
| AUTH-04 | Phase 1 | Authentication |
| GMAIL-01 | Phase 3 | Gmail |
| GMAIL-02 | Phase 3 | Gmail |
| GMAIL-03 | Phase 3 | Gmail |
| CAL-01 | Phase 4 | Calendar |
| CAL-02 | Phase 4 | Calendar |
| DRIVE-01 | Phase 4 | Drive |
| DRIVE-02 | Phase 4 | Drive |
| DRIVE-03 | Phase 4 | Drive |
| DOCS-01 | Phase 5 | Docs/Sheets |
| SHEETS-01 | Phase 5 | Docs/Sheets |
| INFRA-01 | Phase 1 | Infrastructure |
| INFRA-02 | Phase 6 | Infrastructure |
| INFRA-03 | Phase 1 | Infrastructure |

---

## Notes

**Weekly Re-Authentication:** AUTH-04 specifies weekly re-authentication instead of automatic token refresh. This simplifies architecture by eliminating refresh token rotation and distributed locking complexity while maintaining reasonable security posture.

**Phase Ordering Rationale:** Security-first approach establishes OAuth patterns (Phase 1) and encrypted storage (Phase 2) before handling production credentials. API integrations build incrementally (Gmail first as highest priority, then Calendar/Drive, finally Docs/Sheets) to validate adapter pattern. AWS deployment deferred until all features complete to avoid managing production infrastructure during active development.

**Research Context:** Research identified critical security patterns (PKCE, redirect URI validation, encrypted storage) that must be correct from Phase 1. Multi-user infrastructure and rate limiting deferred to v2 since initial 20-user deployment with weekly re-auth has lower concurrency risk.

---

*Last updated: 2026-02-01 — Phase 5 complete*
