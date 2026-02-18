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
import type { CalendarListResult, CalendarGetResult, CalendarListCalendarsResult, CalendarEventResult, CalendarDeleteResult, CalendarFreeBusyResult, FreeTimeSlot } from './types.js';

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

  // calendar_list_calendars - List user's calendars
  server.registerTool('calendar_list_calendars', {
    description: 'List all calendars the user has access to',
    inputSchema: {}
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

      const response = await calendar.calendarList.list();

      const calendars = (response.data.items || []).map(cal => ({
        id: cal.id || '',
        summary: cal.summary || 'Untitled',
        description: cal.description || undefined,
        primary: cal.primary || false,
        accessRole: cal.accessRole as 'owner' | 'writer' | 'reader' | 'freeBusyReader',
        backgroundColor: cal.backgroundColor || undefined,
        timeZone: cal.timeZone || undefined
      }));

      const result: CalendarListCalendarsResult = { calendars };

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

  // calendar_create_event - Create a new calendar event
  server.registerTool('calendar_create_event', {
    description: 'Create a new calendar event',
    inputSchema: {
      summary: z.string().describe('Event title'),
      start: z.object({
        dateTime: z.string().optional().describe('Start datetime (ISO 8601)'),
        date: z.string().optional().describe('Start date for all-day events (YYYY-MM-DD)'),
        timeZone: z.string().optional().describe('Timezone (e.g., America/New_York)')
      }).describe('Start time'),
      end: z.object({
        dateTime: z.string().optional().describe('End datetime (ISO 8601)'),
        date: z.string().optional().describe('End date for all-day events (YYYY-MM-DD)'),
        timeZone: z.string().optional().describe('Timezone')
      }).describe('End time'),
      calendarId: z.string().optional().describe('Calendar ID (default: primary)'),
      description: z.string().optional().describe('Event description'),
      location: z.string().optional().describe('Event location'),
      attendees: z.array(z.object({
        email: z.string().describe('Attendee email'),
        optional: z.boolean().optional().describe('Is attendance optional')
      })).optional().describe('List of attendees')
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
      const calendarId = args.calendarId || 'primary';

      const eventBody: any = {
        summary: args.summary,
        start: args.start,
        end: args.end
      };

      if (args.description) eventBody.description = args.description;
      if (args.location) eventBody.location = args.location;
      if (args.attendees) eventBody.attendees = args.attendees;

      const response = await calendar.events.insert({
        calendarId,
        requestBody: eventBody,
        sendUpdates: args.attendees ? 'all' : 'none'
      });

      const event = parseFullEvent(response.data);
      const result: CalendarEventResult = { event };

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

  // calendar_update_event - Update an existing calendar event
  server.registerTool('calendar_update_event', {
    description: 'Update an existing calendar event',
    inputSchema: {
      eventId: z.string().describe('Event ID to update'),
      calendarId: z.string().optional().describe('Calendar ID (default: primary)'),
      summary: z.string().optional().describe('New event title'),
      start: z.object({
        dateTime: z.string().optional(),
        date: z.string().optional(),
        timeZone: z.string().optional()
      }).optional().describe('New start time'),
      end: z.object({
        dateTime: z.string().optional(),
        date: z.string().optional(),
        timeZone: z.string().optional()
      }).optional().describe('New end time'),
      description: z.string().optional().describe('New description'),
      location: z.string().optional().describe('New location'),
      attendees: z.array(z.object({
        email: z.string(),
        optional: z.boolean().optional()
      })).optional().describe('Updated attendee list')
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
      const calendarId = args.calendarId || 'primary';

      // First get the existing event
      const existing = await calendar.events.get({
        calendarId,
        eventId: args.eventId
      });

      // Merge updates with existing event
      const eventBody: any = {
        ...existing.data
      };

      if (args.summary !== undefined) eventBody.summary = args.summary;
      if (args.start !== undefined) eventBody.start = args.start;
      if (args.end !== undefined) eventBody.end = args.end;
      if (args.description !== undefined) eventBody.description = args.description;
      if (args.location !== undefined) eventBody.location = args.location;
      if (args.attendees !== undefined) eventBody.attendees = args.attendees;

      const response = await calendar.events.update({
        calendarId,
        eventId: args.eventId,
        requestBody: eventBody,
        sendUpdates: 'all'
      });

      const event = parseFullEvent(response.data);
      const result: CalendarEventResult = { event };

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

  // calendar_delete_event - Delete a calendar event
  server.registerTool('calendar_delete_event', {
    description: 'Delete a calendar event',
    inputSchema: {
      eventId: z.string().describe('Event ID to delete'),
      calendarId: z.string().optional().describe('Calendar ID (default: primary)'),
      sendUpdates: z.enum(['all', 'externalOnly', 'none']).optional().describe('Who to notify (default: all)')
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
      const calendarId = args.calendarId || 'primary';

      await calendar.events.delete({
        calendarId,
        eventId: args.eventId,
        sendUpdates: args.sendUpdates || 'all'
      });

      const result: CalendarDeleteResult = {
        success: true,
        eventId: args.eventId
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

  // calendar_rsvp - Respond to a calendar invitation
  server.registerTool('calendar_rsvp', {
    description: 'Respond to a calendar event invitation (accept, decline, or tentative)',
    inputSchema: {
      eventId: z.string().describe('Event ID to respond to'),
      calendarId: z.string().optional().describe('Calendar ID (default: primary)'),
      response: z.enum(['accepted', 'declined', 'tentative']).describe('Your response')
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
      const calendarId = args.calendarId || 'primary';

      // Get the event first
      const existing = await calendar.events.get({
        calendarId,
        eventId: args.eventId
      });

      // Find self in attendees and update response
      const attendees = existing.data.attendees || [];
      const updatedAttendees = attendees.map(att => {
        if (att.self) {
          return { ...att, responseStatus: args.response };
        }
        return att;
      });

      // Update the event with new response
      const response = await calendar.events.patch({
        calendarId,
        eventId: args.eventId,
        requestBody: {
          attendees: updatedAttendees
        }
      });

      const event = parseFullEvent(response.data);
      const result: CalendarEventResult = { event };

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

  // calendar_find_free_time - Find available time slots
  server.registerTool('calendar_find_free_time', {
    description: 'Find available time slots when all specified attendees are free',
    inputSchema: {
      attendees: z.array(z.string()).describe('List of attendee email addresses'),
      durationMinutes: z.number().min(15).max(480).describe('Required meeting duration in minutes'),
      timeMin: z.string().describe('Start of search range (ISO 8601)'),
      timeMax: z.string().describe('End of search range (ISO 8601)')
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

      // Query free/busy information
      const response = await calendar.freebusy.query({
        requestBody: {
          timeMin: args.timeMin,
          timeMax: args.timeMax,
          items: args.attendees.map((email: string) => ({ id: email }))
        }
      });

      const calendars = response.data.calendars || {};
      const busySlots: Record<string, Array<{ start: string; end: string }>> = {};

      // Collect busy times for each attendee
      for (const email of args.attendees) {
        const calData = calendars[email];
        busySlots[email] = (calData?.busy || []).map(slot => ({
          start: slot.start || '',
          end: slot.end || ''
        }));
      }

      // Find free slots by merging all busy times and finding gaps
      const allBusyTimes: Array<{ start: Date; end: Date }> = [];
      for (const email of args.attendees) {
        for (const slot of busySlots[email]) {
          allBusyTimes.push({
            start: new Date(slot.start),
            end: new Date(slot.end)
          });
        }
      }

      // Sort by start time
      allBusyTimes.sort((a, b) => a.start.getTime() - b.start.getTime());

      // Merge overlapping busy times
      const mergedBusy: Array<{ start: Date; end: Date }> = [];
      for (const slot of allBusyTimes) {
        if (mergedBusy.length === 0) {
          mergedBusy.push(slot);
        } else {
          const last = mergedBusy[mergedBusy.length - 1];
          if (slot.start <= last.end) {
            last.end = new Date(Math.max(last.end.getTime(), slot.end.getTime()));
          } else {
            mergedBusy.push(slot);
          }
        }
      }

      // Find free slots
      const freeSlots: FreeTimeSlot[] = [];
      const rangeStart = new Date(args.timeMin);
      const rangeEnd = new Date(args.timeMax);
      const durationMs = args.durationMinutes * 60 * 1000;

      let currentStart = rangeStart;

      for (const busy of mergedBusy) {
        if (busy.start > currentStart) {
          const gapDuration = busy.start.getTime() - currentStart.getTime();
          if (gapDuration >= durationMs) {
            freeSlots.push({
              start: currentStart.toISOString(),
              end: busy.start.toISOString(),
              durationMinutes: Math.floor(gapDuration / 60000)
            });
          }
        }
        currentStart = new Date(Math.max(currentStart.getTime(), busy.end.getTime()));
      }

      // Check for free time after last busy slot
      if (currentStart < rangeEnd) {
        const gapDuration = rangeEnd.getTime() - currentStart.getTime();
        if (gapDuration >= durationMs) {
          freeSlots.push({
            start: currentStart.toISOString(),
            end: rangeEnd.toISOString(),
            durationMinutes: Math.floor(gapDuration / 60000)
          });
        }
      }

      const result: CalendarFreeBusyResult = {
        freeSlots,
        busySlots
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

  console.log('[MCP] Calendar handlers registered: calendar_list_events, calendar_get_event, calendar_list_calendars, calendar_create_event, calendar_update_event, calendar_delete_event, calendar_rsvp, calendar_find_free_time');
}
