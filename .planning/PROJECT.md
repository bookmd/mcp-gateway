# MCP Gateway for Google Workspace

## What This Is

A centralized MCP gateway that gives Cursor users authenticated access to Google Workspace services (Gmail, Drive, Calendar, Docs/Sheets) through their corporate Google accounts. Deployed on AWS, users connect via SSE with OAuth — no local server installation needed.

## Core Value

Team members can interact with their Google Workspace data directly from Cursor without leaving their IDE or managing local credentials.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] User can authenticate via Google OAuth from Cursor
- [ ] Only @company.com domain accounts can authenticate
- [ ] OAuth tokens stored securely in encrypted database
- [ ] Tokens auto-refresh without user re-authentication
- [ ] User can query and search Gmail messages
- [ ] User can read email content and attachments
- [ ] User can send emails and replies
- [ ] User can search and list Google Drive files
- [ ] User can read document/spreadsheet content
- [ ] User can query calendar events
- [ ] User can create/update calendar events
- [ ] MCP server exposes tools via SSE transport
- [ ] Gateway deployed on AWS ECS/Fargate
- [ ] Each user's requests use their own credentials

### Out of Scope

- Local/desktop MCP server installation — this is a remote gateway
- Non-Google Workspace accounts — domain-restricted by design
- Google Meet integration — complex, not core to productivity tools
- Admin/audit features — small team doesn't need oversight tooling yet
- Multi-tenant/SaaS — single company deployment

## Context

**Environment:**
- Company uses Google Workspace with corporate accounts (@company.com)
- Team uses Cursor as their primary IDE
- ~20 users, all on macOS
- IT-managed deployment (users don't self-install)

**Architecture model:**
- Similar to Skip's MCP gateway (SSE + OAuth pattern)
- Single remote server, multiple authenticated users
- Each user's Google API calls use their own OAuth tokens

**Security considerations:**
- OAuth tokens are sensitive — encryption at rest required
- Domain restriction prevents unauthorized access
- Refresh tokens enable long-lived sessions without password re-entry

## Constraints

- **Cloud Provider**: AWS — existing credentials and familiarity
- **Transport**: SSE — required for Cursor MCP integration with OAuth
- **Runtime**: TypeScript/Node — team preference, good MCP ecosystem
- **Auth**: Google OAuth only — Workspace login = identity
- **Deployment**: ECS/Fargate — managed containers, straightforward ops

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Remote gateway vs local servers | Simpler deployment, centralized management, no per-machine setup | — Pending |
| DynamoDB + KMS for tokens | Secure, serverless, scales with team, encryption built-in | — Pending |
| Domain restriction at OAuth level | Simplest access control, leverages Google Workspace org | — Pending |
| SSE transport | Required for Cursor OAuth flow, matches Skip pattern | — Pending |

---
*Last updated: 2025-01-31 after initialization*
