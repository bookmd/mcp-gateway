# Requirements: MCP Gateway for Google Workspace

**Defined:** 2025-01-31
**Core Value:** Team members can interact with their Google Workspace data directly from Cursor without leaving their IDE or managing local credentials.

## v1 Requirements

### Authentication

- [x] **AUTH-01**: User can authenticate via Google OAuth 2.1 with PKCE from Cursor
- [x] **AUTH-02**: Only @company.com domain accounts can authenticate (hd claim validation)
- [x] **AUTH-03**: OAuth tokens stored encrypted in DynamoDB with KMS
- [x] **AUTH-04**: User must re-authenticate weekly (no long-lived refresh tokens)

### Gmail

- [x] **GMAIL-01**: User can search Gmail messages by query
- [x] **GMAIL-02**: User can list messages from inbox/labels
- [x] **GMAIL-03**: User can read full email content and metadata

### Calendar

- [ ] **CAL-01**: User can list upcoming calendar events
- [ ] **CAL-02**: User can read event details (attendees, location, description)

### Drive

- [ ] **DRIVE-01**: User can search files by name or content
- [ ] **DRIVE-02**: User can list files and folders
- [ ] **DRIVE-03**: User can read file content (text-based files)

### Docs/Sheets

- [ ] **DOCS-01**: User can read Google Docs content
- [ ] **SHEETS-01**: User can read Google Sheets data

### Infrastructure

- [x] **INFRA-01**: MCP server uses SSE transport for Cursor connections
- [ ] **INFRA-02**: Gateway deployed on AWS ECS/Fargate
- [x] **INFRA-03**: Each user's API calls use their own OAuth credentials

## v2 Requirements

### Gmail (Write Operations)

- **GMAIL-04**: User can send emails
- **GMAIL-05**: User can manage labels
- **GMAIL-06**: User can handle attachments

### Calendar (Write Operations)

- **CAL-03**: User can create calendar events
- **CAL-04**: User can update/delete events
- **CAL-05**: User can check availability

### Drive (Write Operations)

- **DRIVE-04**: User can upload files
- **DRIVE-05**: User can create folders
- **DRIVE-06**: User can share files

### Docs/Sheets (Write Operations)

- **DOCS-02**: User can edit Google Docs
- **SHEETS-02**: User can edit Google Sheets

### Infrastructure (Production Hardening)

- **INFRA-04**: Health check endpoint for ECS auto-scaling
- **INFRA-05**: Structured JSON logging to CloudWatch
- **INFRA-06**: Per-user rate limiting
- **INFRA-07**: CloudWatch dashboards and alarms
- **INFRA-08**: Audit trail for API calls

## Out of Scope

| Feature | Reason |
|---------|--------|
| Automatic token refresh | Weekly re-auth preferred for security |
| Google Meet integration | Complex, not core to productivity tools |
| Local/desktop MCP server | This is a centralized remote gateway |
| Non-Workspace accounts | Domain-restricted by design |
| Multi-tenant/SaaS | Single company deployment |
| Admin/audit dashboard | Small team doesn't need oversight tooling yet |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| AUTH-01 | Phase 1 | Complete |
| AUTH-02 | Phase 1 | Complete |
| AUTH-03 | Phase 2 | Complete |
| AUTH-04 | Phase 1 | Complete |
| GMAIL-01 | Phase 3 | Complete |
| GMAIL-02 | Phase 3 | Complete |
| GMAIL-03 | Phase 3 | Complete |
| CAL-01 | Phase 4 | Pending |
| CAL-02 | Phase 4 | Pending |
| DRIVE-01 | Phase 4 | Pending |
| DRIVE-02 | Phase 4 | Pending |
| DRIVE-03 | Phase 4 | Pending |
| DOCS-01 | Phase 5 | Pending |
| SHEETS-01 | Phase 5 | Pending |
| INFRA-01 | Phase 1 | Complete |
| INFRA-02 | Phase 6 | Pending |
| INFRA-03 | Phase 1 | Complete |

**Coverage:**
- v1 requirements: 17 total
- Mapped to phases: 17
- Unmapped: 0 ✓

---
*Requirements defined: 2025-01-31*
*Last updated: 2026-01-31 after Phase 3 completion*
