/**
 * Gmail MCP tool handlers
 * Implements gmail_search, gmail_list, gmail_get tools
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { UserContext } from '../auth/middleware.js';
import { createGmailClient } from './client.js';
import { parseMessageSummary, parseFullMessage } from './parsers.js';
import type { GmailSearchResult, GmailGetResult } from './types.js';

/**
 * Extract user context from MCP extra parameter
 */
function getUserContext(extra: any): UserContext | null {
  return (extra?.transport as any)?.userContext as UserContext | null;
}

/**
 * Handle Gmail API errors and return appropriate MCP response
 */
function handleGmailError(error: any): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  const code = error.code || error.response?.status || 500;
  const message = error.message || 'Unknown Gmail API error';

  // Token expiration - direct user to re-authenticate
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

  // Insufficient permissions - need to re-authenticate with Gmail scope
  if (code === 403 && message.includes('insufficient')) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'insufficient_scope',
          code: 403,
          message: 'Gmail access not authorized. Please re-authenticate at /auth/login to grant Gmail permissions.'
        }, null, 2)
      }],
      isError: true
    };
  }

  // Rate limit - suggest retry
  if (code === 429 || (code === 403 && message.includes('rate'))) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'rate_limited',
          code: code,
          message: 'Gmail API rate limit exceeded. Please wait a moment and try again.'
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
        error: 'gmail_api_error',
        code: code,
        message: message
      }, null, 2)
    }],
    isError: true
  };
}

/**
 * Register Gmail tools with MCP server
 */
export function registerGmailHandlers(server: McpServer): void {
  // gmail_search - Search messages by query
  server.registerTool('gmail_search', {
    description: 'Search Gmail messages using Gmail search syntax (e.g., "from:user@example.com", "subject:meeting", "is:unread")',
    inputSchema: {
      query: z.string().describe('Gmail search query (supports Gmail search operators)'),
      maxResults: z.number().min(1).max(50).optional().describe('Maximum number of results (1-50, default 10)'),
      pageToken: z.string().optional().describe('Pagination token from previous search result')
    }
  }, async (args: any, extra: any) => {
    const userContext = getUserContext(extra);
    if (!userContext) {
      return {
        content: [{ type: 'text', text: 'Error: No user context. Please authenticate.' }],
        isError: true
      };
    }

    try {
      const gmail = createGmailClient(userContext);
      const maxResults = Math.min(Math.max(args.maxResults || 10, 1), 50);

      // Search for message IDs
      const listResponse = await gmail.users.messages.list({
        userId: 'me',
        q: args.query as string,
        maxResults,
        pageToken: args.pageToken as string | undefined
      });

      const messageIds = listResponse.data.messages || [];

      // Fetch metadata for each message (batch with format=metadata for efficiency)
      const messages = await Promise.all(
        messageIds.map(async (msg) => {
          const detail = await gmail.users.messages.get({
            userId: 'me',
            id: msg.id!,
            format: 'metadata',
            metadataHeaders: ['From', 'To', 'Subject', 'Date']
          });
          return parseMessageSummary(detail.data);
        })
      );

      const result: GmailSearchResult = {
        messages,
        nextPageToken: listResponse.data.nextPageToken || null,
        resultSizeEstimate: listResponse.data.resultSizeEstimate || 0
      };

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error) {
      return handleGmailError(error);
    }
  });

  // gmail_list - List messages from inbox or specific label
  server.registerTool('gmail_list', {
    description: 'List Gmail messages from inbox or specific labels',
    inputSchema: {
      labelIds: z.array(z.string()).optional().describe('Label IDs to filter by (e.g., ["INBOX"], ["UNREAD"], ["STARRED"]). Default is INBOX.'),
      maxResults: z.number().min(1).max(50).optional().describe('Maximum number of results (1-50, default 10)'),
      pageToken: z.string().optional().describe('Pagination token from previous list result')
    }
  }, async (args: any, extra: any) => {
    const userContext = getUserContext(extra);
    if (!userContext) {
      return {
        content: [{ type: 'text', text: 'Error: No user context. Please authenticate.' }],
        isError: true
      };
    }

    try {
      const gmail = createGmailClient(userContext);
      const maxResults = Math.min(Math.max(args.maxResults || 10, 1), 50);
      const labelIds = (args.labelIds as string[] | undefined) || ['INBOX'];

      // List message IDs by label
      const listResponse = await gmail.users.messages.list({
        userId: 'me',
        labelIds,
        maxResults,
        pageToken: args.pageToken as string | undefined
      });

      const messageIds = listResponse.data.messages || [];

      // Fetch metadata for each message
      const messages = await Promise.all(
        messageIds.map(async (msg) => {
          const detail = await gmail.users.messages.get({
            userId: 'me',
            id: msg.id!,
            format: 'metadata',
            metadataHeaders: ['From', 'To', 'Subject', 'Date']
          });
          return parseMessageSummary(detail.data);
        })
      );

      const result: GmailSearchResult = {
        messages,
        nextPageToken: listResponse.data.nextPageToken || null,
        resultSizeEstimate: listResponse.data.resultSizeEstimate || 0
      };

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error) {
      return handleGmailError(error);
    }
  });

  // gmail_get - Get full message content by ID
  server.registerTool('gmail_get', {
    description: 'Get full email content including body and attachment metadata by message ID',
    inputSchema: {
      messageId: z.string().describe('Gmail message ID (from search or list results)')
    }
  }, async (args: any, extra: any) => {
    const userContext = getUserContext(extra);
    if (!userContext) {
      return {
        content: [{ type: 'text', text: 'Error: No user context. Please authenticate.' }],
        isError: true
      };
    }

    try {
      const gmail = createGmailClient(userContext);

      // Get full message with body
      const response = await gmail.users.messages.get({
        userId: 'me',
        id: args.messageId as string,
        format: 'full'
      });

      const message = parseFullMessage(response.data);

      const result: GmailGetResult = { message };

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error) {
      return handleGmailError(error);
    }
  });

  console.log('[MCP] Gmail handlers registered: gmail_search, gmail_list, gmail_get');
}
