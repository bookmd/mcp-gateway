/**
 * Calendar event parsing utilities
 * Converts Calendar API responses to our typed interfaces
 */
import type { calendar_v3 } from 'googleapis';
import type {
  CalendarEventSummary,
  CalendarEvent,
  CalendarAttendee
} from './types.js';

/**
 * Parse a calendar event into a summary (for list results)
 * Handles both all-day events (date) and timed events (dateTime)
 */
export function parseEventSummary(
  event: calendar_v3.Schema$Event
): CalendarEventSummary {
  return {
    id: event.id || '',
    summary: event.summary || '(No title)',
    start: event.start?.dateTime || event.start?.date || '',
    end: event.end?.dateTime || event.end?.date || '',
    status: event.status || 'confirmed',
    htmlLink: event.htmlLink || ''
  };
}

/**
 * Parse a calendar event into full content (for get operations)
 * Includes description, location, attendees, and organizer
 */
export function parseFullEvent(
  event: calendar_v3.Schema$Event
): CalendarEvent {
  // Get summary fields first
  const summary = parseEventSummary(event);

  // Map attendees array
  const attendees: CalendarAttendee[] = (event.attendees || []).map(att => ({
    email: att.email || '',
    displayName: att.displayName || undefined,
    responseStatus: (att.responseStatus as CalendarAttendee['responseStatus']) || 'needsAction',
    optional: att.optional || false
  }));

  return {
    ...summary,
    description: event.description || null,
    location: event.location || null,
    attendees,
    organizer: {
      email: event.organizer?.email || '',
      displayName: event.organizer?.displayName || undefined,
      self: event.organizer?.self || false
    },
    recurringEventId: event.recurringEventId || undefined
  };
}
