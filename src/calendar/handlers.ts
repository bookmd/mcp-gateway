/**
 * Calendar MCP tool handlers
 * Implements calendar_list_events, calendar_get_event tools
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { UserContext } from '../auth/middleware.js';
import { getUserContextBySessionId } from '../routes/sse.js';
import { createCalendarClient } from './client.js';
import { parseEventSummary, parseFullEvent } from './parsers.js';
import type { CalendarListResult, CalendarGetResult } from './types.js';

/**
 * Extract user context from MCP extra parameter using session ID
 */
function getUserContext(extra: any): UserContext | null {
  const sessionId = extra?.sessionId;
  if (!sessionId) return null;
  return getUserContextBySessionId(sessionId) || null;
}

/**
 * Handle Calendar API errors and return appropriate MCP response
 */
function handleCalendarError(error: any): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  const code = error.code || error.response?.status || 500;
  const message = error.message || 'Unknown Calendar API error';

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

  // Insufficient permissions or rate limit
  if (code === 403) {
    // Check if rate limit or quota
    if (message.includes('rate') || message.includes('quota') || message.includes('limit')) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: 'rate_limited',
            code: 403,
            message: 'Calendar API rate limit exceeded. Please wait and try again.'
          }, null, 2)
        }],
        isError: true
      };
    }

    // Insufficient scope
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'insufficient_scope',
          code: 403,
          message: 'Calendar access not authorized. Please re-authenticate at /auth/login to grant Calendar permissions.'
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
        error: 'calendar_api_error',
        code: code,
        message: message
      }, null, 2)
    }],
    isError: true
  };
}

/**
 * Register Calendar tools with MCP server
 */
export function registerCalendarHandlers(server: McpServer): void {
  // calendar_list_events - List upcoming events within date range
  server.registerTool('calendar_list_events', {
    description: 'List upcoming calendar events within specified date range',
    inputSchema: {
      timeMin: z.string().optional().describe('Start datetime (ISO 8601, default: now)'),
      timeMax: z.string().optional().describe('End datetime (ISO 8601, default: 7 days from now)'),
      maxResults: z.number().min(1).max(50).optional().describe('Maximum results (1-50, default 10)'),
      pageToken: z.string().optional().describe('Pagination token from previous result')
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
      const calendar = createCalendarClient(userContext);
      const maxResults = Math.min(Math.max(args.maxResults || 10, 1), 50);

      // Calculate default time range (now to 7 days from now)
      const now = new Date();
      const sevenDaysFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      const timeMin = args.timeMin || now.toISOString();
      const timeMax = args.timeMax || sevenDaysFromNow.toISOString();

      // List events with singleEvents=true to expand recurring events
      const response = await calendar.events.list({
        calendarId: 'primary',
        timeMin,
        timeMax,
        maxResults,
        singleEvents: true,  // CRITICAL: Expand recurring events
        orderBy: 'startTime', // Required when singleEvents=true
        pageToken: args.pageToken as string | undefined
      });

      const events = (response.data.items || []).map(parseEventSummary);

      const result: CalendarListResult = {
        events,
        nextPageToken: response.data.nextPageToken || null
      };

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error) {
      return handleCalendarError(error);
    }
  });

  // calendar_get_event - Get full event details by ID
  server.registerTool('calendar_get_event', {
    description: 'Get full event details including attendees, location, and description',
    inputSchema: {
      eventId: z.string().describe('Calendar event ID (from list results)')
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
      const calendar = createCalendarClient(userContext);

      // Get full event details
      const response = await calendar.events.get({
        calendarId: 'primary',
        eventId: args.eventId as string
      });

      const event = parseFullEvent(response.data);

      const result: CalendarGetResult = { event };

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error) {
      return handleCalendarError(error);
    }
  });

  console.log('[MCP] Calendar handlers registered: calendar_list_events, calendar_get_event');
}
