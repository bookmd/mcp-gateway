# Slack Integration Design

## Overview

Add Slack query tools to the MCP gateway, allowing users to search messages, read channel history, and list channels/users from their Slack workspace.

## Requirements

- **Read-only operations**: Search messages, read channel history, list channels/users
- **User token OAuth**: Each user authenticates separately, tools operate on their behalf
- **Separate optional connection**: Like HubSpot, users trigger Slack connection manually via `slack_connect` tool
- **Single workspace**: Restrict to pre-configured workspace (via `SLACK_TEAM_ID`)
- **Existing Slack App**: Client ID/secret already available

## Architecture

```
src/slack/
  ├── client.ts      # Slack Web API wrapper
  ├── handlers.ts    # MCP tool registrations
  └── types.ts       # TypeScript interfaces

src/config/
  └── slack-oauth.ts # OAuth config from env vars

src/routes/
  └── slack-oauth.ts # OAuth routes: /auth/slack/*

src/storage/token-store.ts
  └── Add: slackAccessToken, slackTeamId, slackUserId, etc.
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `SLACK_CLIENT_ID` | Slack App client ID |
| `SLACK_CLIENT_SECRET` | Slack App client secret |
| `SLACK_TEAM_ID` | (Optional) Restrict to single workspace |

## OAuth Flow

1. User calls `slack_connect` MCP tool
2. Tool returns URL: `https://mgw.ext.getvim.com/auth/slack?connect_token=xxx`
3. User opens URL in browser
4. Redirects to Slack OAuth consent (user token flow)
5. Callback at `/auth/slack/callback` stores tokens in DynamoDB (KMS encrypted)
6. User can now use Slack tools

## MCP Tools

| Tool | Description |
|------|-------------|
| `slack_connect` | Get URL to connect Slack account |
| `slack_status` | Check Slack connection status |
| `slack_search` | Search messages across channels |
| `slack_channel_history` | Read recent messages from a channel |
| `slack_list_channels` | List available channels |
| `slack_list_users` | List workspace members |

## Slack OAuth Scopes (User Token)

- `search:read` - Search messages
- `channels:read` - List public channels
- `channels:history` - Read public channel history
- `groups:read` - List private channels user is in
- `groups:history` - Read private channel history
- `im:read` - List direct messages
- `im:history` - Read DM history
- `mpim:read` - List group DMs
- `mpim:history` - Read group DM history
- `users:read` - List users
- `team:read` - Get workspace info

## Token Storage

Extend `TokenSession` interface in `token-store.ts`:

```typescript
interface TokenSession {
  // ... existing fields ...

  // Slack tokens (optional)
  slackAccessToken?: string;
  slackTeamId?: string;
  slackTeamName?: string;
  slackUserId?: string;
  slackTokenExpiresAt?: number;
  slackConnectedAt?: number;
}
```

Note: Slack user tokens don't have refresh tokens - they're long-lived until revoked.

## Token Lifetime

- Slack user tokens are **long-lived** (no expiry, no refresh token)
- They remain valid until the user revokes access or the app is uninstalled
- No automatic refresh needed (unlike HubSpot)

## Implementation Approach

Follow the HubSpot integration pattern exactly for consistency.
