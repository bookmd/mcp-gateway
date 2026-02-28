# HubSpot OAuth Integration Design

## Overview

Add HubSpot per-user OAuth to the MCP gateway, allowing employees to access HubSpot CRM data alongside Google Workspace tools. Users authenticate with Google (existing flow), then optionally connect their HubSpot account with explicit consent.

## Requirements

- **Auth model:** Per-user OAuth (respects HubSpot role permissions)
- **Identity:** Google SSO → HubSpot (single Google login, explicit HubSpot consent)
- **Scope:** Read-only CRM access (contacts, companies, deals, tickets)
- **UX:** Google login first, then optional "Connect HubSpot" prompt with HubSpot branding

## User Flow

### First-Time Connection

1. User adds MCP server to Cursor: `mgw.ext.getvim.com/mcp`
2. 401 Unauthorized → Cursor shows "Login" button
3. Google OAuth consent screen → User signs in with @getvim.com
4. Success page with HubSpot prompt (includes HubSpot logo):
   - "Google Workspace connected! Want to also access HubSpot CRM?"
   - [Connect HubSpot] → HubSpot OAuth (auto-SSO via Google) → Done
   - [Skip for now] → Redirect to Cursor with Google tools only
5. User has Google tools (+ HubSpot tools if connected)

### Connecting HubSpot Later

- **MCP Tool:** `hubspot_connect` - returns auth URL to open in browser
- **Direct URL:** `https://mgw.ext.getvim.com/auth/hubspot`

### Disconnecting HubSpot

- **MCP Tool:** `hubspot_disconnect` - removes HubSpot tokens, keeps Google

## Architecture

### Approach: Separate Token Storage

Store HubSpot tokens independently from Google tokens in existing DynamoDB structure.

```
User Token Record:
├── google_access_token
├── google_refresh_token
├── google_token_expires_at
├── hubspot_access_token (nullable)
├── hubspot_refresh_token (nullable)
├── hubspot_token_expires_at (nullable)
├── hubspot_portal_id (nullable)
└── hubspot_connected_at (nullable)
```

### HubSpot OAuth Configuration

```typescript
// src/config/hubspot-oauth.ts
export const hubspotOAuthConfig = {
  clientId: process.env.HUBSPOT_CLIENT_ID,
  clientSecret: process.env.HUBSPOT_CLIENT_SECRET,
  redirectUri: 'https://mgw.ext.getvim.com/auth/hubspot/callback',
  authorizationUrl: 'https://app.hubspot.com/oauth/authorize',
  tokenUrl: 'https://api.hubapi.com/oauth/v3/token',
  scopes: [
    'crm.objects.contacts.read',
    'crm.objects.companies.read',
    'crm.objects.deals.read',
    'crm.objects.owners.read',
    'crm.schemas.contacts.read',
    'crm.schemas.companies.read',
    'crm.schemas.deals.read'
  ]
};
```

### Token Refresh Strategy

On each MCP request:
1. Check Google token expiry → refresh if needed
2. If HubSpot tool called:
   - Check if HubSpot connected
   - Check HubSpot token expiry → refresh if needed
   - If not connected → return helpful error with auth URL

HubSpot tokens refresh via:
```
POST https://api.hubapi.com/oauth/v3/token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token
&client_id={CLIENT_ID}
&client_secret={CLIENT_SECRET}
&refresh_token={REFRESH_TOKEN}
```

## New Files

| File | Purpose |
|------|---------|
| `src/config/hubspot-oauth.ts` | HubSpot OAuth configuration |
| `src/hubspot/client.ts` | HubSpot API client factory |
| `src/hubspot/handlers.ts` | MCP tool handlers for HubSpot |
| `src/hubspot/types.ts` | TypeScript types for HubSpot data |
| `src/routes/hubspot-oauth.ts` | HubSpot OAuth routes |
| `src/views/connect-hubspot.html` | Success page with HubSpot connect prompt |

## Modified Files

| File | Changes |
|------|---------|
| `src/server.ts` | Register HubSpot routes |
| `src/mcp/handlers.ts` | Register HubSpot tool handlers |
| `src/storage/token-store.ts` | Add HubSpot token storage/retrieval |
| `src/auth/middleware.ts` | Add HubSpot token to UserContext |
| `src/views/mcp-success.html` | Update to show HubSpot connect option |

## New Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/auth/hubspot` | GET | Initiate HubSpot OAuth |
| `/auth/hubspot/callback` | GET | Handle HubSpot OAuth callback |
| `/auth/hubspot/disconnect` | POST | Remove HubSpot tokens |

## MCP Tools

### Connection Management

| Tool | Description |
|------|-------------|
| `hubspot_connect` | Returns URL to connect HubSpot account |
| `hubspot_disconnect` | Disconnects HubSpot account |
| `hubspot_status` | Returns HubSpot connection status |

### CRM Read Tools

| Tool | Description |
|------|-------------|
| `hubspot_list_contacts` | List contacts with optional filters |
| `hubspot_get_contact` | Get contact by ID |
| `hubspot_search_contacts` | Search contacts by query |
| `hubspot_list_companies` | List companies with optional filters |
| `hubspot_get_company` | Get company by ID |
| `hubspot_search_companies` | Search companies by query |
| `hubspot_list_deals` | List deals with optional filters |
| `hubspot_get_deal` | Get deal by ID |
| `hubspot_search_deals` | Search deals by query |
| `hubspot_list_owners` | List HubSpot owners/users |

## Environment Variables

```bash
# New required variables
HUBSPOT_CLIENT_ID=your-hubspot-client-id
HUBSPOT_CLIENT_SECRET=your-hubspot-client-secret

# Optional (defaults shown)
HUBSPOT_REDIRECT_URI=https://mgw.ext.getvim.com/auth/hubspot/callback
```

## HubSpot App Setup

1. Create a HubSpot Developer account (if not exists)
2. Create a new Public App in HubSpot
3. Configure OAuth:
   - Redirect URL: `https://mgw.ext.getvim.com/auth/hubspot/callback`
   - Scopes: crm.objects.contacts.read, crm.objects.companies.read, crm.objects.deals.read, crm.objects.owners.read
4. Copy Client ID and Client Secret to environment variables

## Error Handling

When HubSpot tools are called without connection:
```json
{
  "content": [{
    "type": "text",
    "text": "HubSpot is not connected. Please connect your HubSpot account:\n\nhttps://mgw.ext.getvim.com/auth/hubspot\n\nOr use the hubspot_connect tool to get the connection URL."
  }],
  "isError": true
}
```

## Security Considerations

- HubSpot tokens encrypted at rest (same as Google tokens via KMS)
- Domain restriction applies (only @getvim.com users)
- Per-user tokens respect HubSpot role permissions
- Refresh tokens stored securely, access tokens short-lived

---
*Design approved: 2026-02-28*
