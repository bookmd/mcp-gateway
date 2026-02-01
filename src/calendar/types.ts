/**
 * Calendar API response types for MCP tools
 */

/** Summary of a calendar event (used in list results) */
export interface CalendarEventSummary {
  id: string;
  summary: string;
  start: string; // ISO 8601 datetime or date
  end: string;   // ISO 8601 datetime or date
  status: string; // confirmed, tentative, cancelled
  htmlLink: string;
}

/** Full calendar event with details (used in get result) */
export interface CalendarEvent extends CalendarEventSummary {
  description: string | null;
  location: string | null;
  attendees: CalendarAttendee[];
  organizer: CalendarOrganizer;
  recurringEventId?: string;
}

/** Calendar event attendee */
export interface CalendarAttendee {
  email: string;
  displayName?: string;
  responseStatus: 'needsAction' | 'declined' | 'tentative' | 'accepted';
  optional: boolean;
}

/** Calendar event organizer */
export interface CalendarOrganizer {
  email: string;
  displayName?: string;
  self: boolean;
}

/** List events result with pagination */
export interface CalendarListResult {
  events: CalendarEventSummary[];
  nextPageToken: string | null;
}

/** Get event result */
export interface CalendarGetResult {
  event: CalendarEvent;
}

/** Error response for Calendar tools */
export interface CalendarErrorResult {
  error: string;
  code: number;
  message: string;
}
