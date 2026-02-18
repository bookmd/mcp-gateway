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

// ============================================
// Write Operation Types
// ============================================

/** Calendar list item (for calendar_list_calendars) */
export interface CalendarListItem {
  id: string;
  summary: string;
  description?: string;
  primary?: boolean;
  accessRole: 'owner' | 'writer' | 'reader' | 'freeBusyReader';
  backgroundColor?: string;
  timeZone?: string;
}

/** Result from calendar_list_calendars */
export interface CalendarListCalendarsResult {
  calendars: CalendarListItem[];
}

/** Input for creating/updating calendar events */
export interface CalendarEventInput {
  calendarId?: string; // defaults to 'primary'
  summary: string;
  start: { dateTime: string; timeZone?: string } | { date: string };
  end: { dateTime: string; timeZone?: string } | { date: string };
  description?: string;
  location?: string;
  attendees?: Array<{ email: string; optional?: boolean }>;
  reminders?: {
    useDefault: boolean;
    overrides?: Array<{ method: 'email' | 'popup'; minutes: number }>;
  };
}

/** Input for updating calendar events (all fields optional except eventId) */
export interface CalendarEventUpdateInput {
  eventId: string;
  calendarId?: string;
  summary?: string;
  start?: { dateTime: string; timeZone?: string } | { date: string };
  end?: { dateTime: string; timeZone?: string } | { date: string };
  description?: string;
  location?: string;
  attendees?: Array<{ email: string; optional?: boolean }>;
}

/** Result from create/update event */
export interface CalendarEventResult {
  event: CalendarEvent;
}

/** Result from delete event */
export interface CalendarDeleteResult {
  success: boolean;
  eventId: string;
}

/** Input for RSVP */
export interface CalendarRsvpInput {
  eventId: string;
  calendarId?: string;
  response: 'accepted' | 'declined' | 'tentative';
}

/** Input for finding free time */
export interface CalendarFreeBusyInput {
  attendees: string[]; // email addresses
  durationMinutes: number;
  timeMin: string; // ISO 8601
  timeMax: string; // ISO 8601
}

/** Busy time slot */
export interface FreeBusySlot {
  start: string;
  end: string;
}

/** Free time slot found */
export interface FreeTimeSlot {
  start: string;
  end: string;
  durationMinutes: number;
}

/** Result from find_free_time */
export interface CalendarFreeBusyResult {
  freeSlots: FreeTimeSlot[];
  busySlots: Record<string, FreeBusySlot[]>; // keyed by attendee email
}
