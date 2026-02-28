/**
 * Slack MCP tool handlers
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getUserContextBySessionId } from '../routes/sse.js';
import { createSlackClient } from './client.js';
import { getSessionByToken } from '../storage/token-store.js';
import { isSlackConfigured } from '../config/slack-oauth.js';
import type {
  SlackSearchResult,
  SlackConversationsHistoryResponse,
  SlackConversationsListResponse,
  SlackUsersListResponse
} from './types.js';

// Helper to get Slack client for user
async function getSlackClientForUser(sessionId: string): Promise<{
  client: ReturnType<typeof createSlackClient>;
  teamId?: string;
  teamName?: string;
} | { error: string }> {
  const userContext = sessionId ? getUserContextBySessionId(sessionId) : undefined;

  if (!userContext) {
    return { error: 'No user context available' };
  }

  const token = (userContext as any).bearerToken;
  if (!token) {
    return { error: 'Slack is not connected. Use the slack_connect tool to connect your Slack account.' };
  }

  const session = await getSessionByToken(token);
  if (!session) {
    return { error: 'Session not found' };
  }

  if (!session.slackAccessToken) {
    return {
      error: 'Slack is not connected. Use the slack_connect tool to get the connection URL.'
    };
  }

  return {
    client: createSlackClient(session.slackAccessToken),
    teamId: session.slackTeamId,
    teamName: session.slackTeamName
  };
}

function errorResponse(message: string) {
  return {
    content: [{ type: 'text' as const, text: `Error: ${message}` }],
    isError: true
  };
}

function successResponse(data: unknown) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify(data, null, 2)
    }]
  };
}

export function registerSlackHandlers(server: McpServer): void {
  if (!isSlackConfigured()) {
    console.log('[Slack] Handlers not registered - Slack not configured');
    return;
  }

  // ============================================================
  // Connection Management Tools
  // ============================================================

  server.registerTool('slack_status', {
    description: 'Check Slack connection status'
  }, async (extra: any) => {
    const sessionId = extra?.sessionId;
    const userContext = sessionId ? getUserContextBySessionId(sessionId) : undefined;

    if (!userContext) {
      return errorResponse('No user context available');
    }

    const token = (userContext as any).bearerToken;
    if (!token) {
      return successResponse({
        connected: false,
        message: 'Use slack_connect to get the connection URL'
      });
    }

    const session = await getSessionByToken(token);
    if (!session) {
      return successResponse({
        connected: false,
        message: 'Session not found'
      });
    }

    return successResponse({
      connected: !!session.slackAccessToken,
      teamId: session.slackTeamId || null,
      teamName: session.slackTeamName || null,
      connectedAt: session.slackConnectedAt
        ? new Date(session.slackConnectedAt).toISOString()
        : null
    });
  });

  server.registerTool('slack_connect', {
    description: 'Get a URL to connect your Slack account. Open the returned URL in your browser to authorize Slack access.'
  }, async (extra: any) => {
    const sessionId = extra?.sessionId;
    const userContext = sessionId ? getUserContextBySessionId(sessionId) : undefined;

    if (!userContext) {
      return errorResponse('Authentication required');
    }

    const token = (userContext as any).bearerToken;
    if (!token) {
      return errorResponse('Bearer token not found. Please re-authenticate.');
    }

    const crypto = await import('crypto');
    const { DynamoDBClient, PutItemCommand } = await import('@aws-sdk/client-dynamodb');
    const { SESSIONS_TABLE } = await import('../config/aws.js');

    const dynamodb = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' });

    const connectToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = Math.floor(Date.now() / 1000) + 600; // 10 minutes

    await dynamodb.send(new PutItemCommand({
      TableName: SESSIONS_TABLE,
      Item: {
        sessionId: { S: `SLACK_CONNECT#${connectToken}` },
        bearerToken: { S: token },
        expiresAt: { N: String(expiresAt) },
        ttl: { N: String(expiresAt) }
      }
    }));

    const baseUrl = process.env.BASE_URL || 'https://mgw.ext.getvim.com';
    const connectUrl = `${baseUrl}/auth/slack?connect_token=${connectToken}`;

    return successResponse({
      message: 'Open this URL in your browser to connect Slack:',
      url: connectUrl,
      expiresIn: '10 minutes',
      note: 'This link is single-use and will expire in 10 minutes'
    });
  });

  // ============================================================
  // Search Tools
  // ============================================================

  server.registerTool('slack_search', {
    description: 'Search messages in Slack. Searches across all channels and DMs you have access to.',
    inputSchema: {
      query: z.string().describe('Search query string'),
      count: z.number().min(1).max(100).optional().describe('Number of results to return (1-100, default 20)'),
      page: z.number().min(1).optional().describe('Page number for pagination (default 1)')
    }
  }, async (args: any, extra: any) => {
    const result = await getSlackClientForUser(extra?.sessionId);
    if ('error' in result) return errorResponse(result.error);

    const { client, teamName } = result;
    const { query, count = 20, page = 1 } = args;

    try {
      const response = await client.get<SlackSearchResult>('search.messages', {
        query,
        count: String(count),
        page: String(page)
      });

      return successResponse({
        team: teamName,
        query,
        total: response.messages.total,
        page: response.messages.pagination.page,
        pageCount: response.messages.pagination.page_count,
        messages: response.messages.matches.map(m => ({
          text: m.text,
          user: m.user || m.username,
          channel: m.channel,
          timestamp: m.ts,
          permalink: m.permalink
        }))
      });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : 'Failed to search messages');
    }
  });

  // ============================================================
  // Channel Tools
  // ============================================================

  server.registerTool('slack_list_channels', {
    description: 'List Slack channels you have access to',
    inputSchema: {
      types: z.string().optional().describe('Comma-separated channel types: public_channel, private_channel, mpim, im (default: public_channel,private_channel)'),
      limit: z.number().min(1).max(1000).optional().describe('Maximum number of channels to return (default 100)'),
      cursor: z.string().optional().describe('Pagination cursor for next page')
    }
  }, async (args: any, extra: any) => {
    const result = await getSlackClientForUser(extra?.sessionId);
    if ('error' in result) return errorResponse(result.error);

    const { client, teamName } = result;
    const { types = 'public_channel,private_channel', limit = 100, cursor } = args;

    try {
      const params: Record<string, string> = {
        types,
        limit: String(limit),
        exclude_archived: 'true'
      };
      if (cursor) params.cursor = cursor;

      const response = await client.get<SlackConversationsListResponse>('conversations.list', params);

      return successResponse({
        team: teamName,
        channels: response.channels.map(c => ({
          id: c.id,
          name: c.name,
          isPrivate: c.is_private,
          isChannel: c.is_channel,
          isGroup: c.is_group,
          isMember: c.is_member,
          numMembers: c.num_members,
          topic: c.topic?.value,
          purpose: c.purpose?.value
        })),
        nextCursor: response.response_metadata?.next_cursor || null
      });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : 'Failed to list channels');
    }
  });

  server.registerTool('slack_channel_history', {
    description: 'Get recent messages from a Slack channel',
    inputSchema: {
      channel: z.string().describe('Channel ID (e.g., C1234567890)'),
      limit: z.number().min(1).max(1000).optional().describe('Number of messages to return (default 50)'),
      cursor: z.string().optional().describe('Pagination cursor for older messages')
    }
  }, async (args: any, extra: any) => {
    const result = await getSlackClientForUser(extra?.sessionId);
    if ('error' in result) return errorResponse(result.error);

    const { client } = result;
    const { channel, limit = 50, cursor } = args;

    try {
      const params: Record<string, string> = {
        channel,
        limit: String(limit)
      };
      if (cursor) params.cursor = cursor;

      const response = await client.get<SlackConversationsHistoryResponse>('conversations.history', params);

      return successResponse({
        channel,
        messages: response.messages.map(m => ({
          text: m.text,
          user: m.user,
          timestamp: m.ts,
          type: m.type
        })),
        hasMore: response.has_more,
        nextCursor: response.response_metadata?.next_cursor || null
      });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : 'Failed to get channel history');
    }
  });

  // ============================================================
  // Users Tools
  // ============================================================

  server.registerTool('slack_list_users', {
    description: 'List users in the Slack workspace',
    inputSchema: {
      limit: z.number().min(1).max(1000).optional().describe('Maximum number of users to return (default 100)'),
      cursor: z.string().optional().describe('Pagination cursor for next page')
    }
  }, async (args: any, extra: any) => {
    const result = await getSlackClientForUser(extra?.sessionId);
    if ('error' in result) return errorResponse(result.error);

    const { client, teamName } = result;
    const { limit = 100, cursor } = args;

    try {
      const params: Record<string, string> = {
        limit: String(limit)
      };
      if (cursor) params.cursor = cursor;

      const response = await client.get<SlackUsersListResponse>('users.list', params);

      return successResponse({
        team: teamName,
        users: response.members
          .filter(u => !u.deleted && !u.is_bot)
          .map(u => ({
            id: u.id,
            name: u.name,
            realName: u.real_name,
            displayName: u.profile?.display_name,
            email: u.profile?.email,
            isAdmin: u.is_admin
          })),
        nextCursor: response.response_metadata?.next_cursor || null
      });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : 'Failed to list users');
    }
  });

  console.log('[Slack] Registered tools: slack_status, slack_connect, slack_search, slack_list_channels, slack_channel_history, slack_list_users');
}
