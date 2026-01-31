/**
 * Gmail message parsing utilities
 * Converts Gmail API responses to our typed interfaces
 */
import parseMessage from 'gmail-api-parse-message';
import type { gmail_v1 } from 'googleapis';
import type {
  GmailMessageSummary,
  GmailMessage,
  GmailAttachment
} from './types.js';

/**
 * Extract a header value from Gmail message headers
 */
function getHeader(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string
): string {
  return headers?.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || '';
}

/**
 * Parse a Gmail message into a summary (for list/search results)
 * Uses headers only - no body content
 */
export function parseMessageSummary(
  message: gmail_v1.Schema$Message
): GmailMessageSummary {
  const headers = message.payload?.headers;

  return {
    id: message.id || '',
    threadId: message.threadId || '',
    subject: getHeader(headers, 'Subject'),
    from: getHeader(headers, 'From'),
    to: getHeader(headers, 'To'),
    date: getHeader(headers, 'Date'),
    snippet: message.snippet || '',
    labelIds: message.labelIds || []
  };
}

/**
 * Parse a Gmail message into full content (for get operations)
 * Uses gmail-api-parse-message library for body extraction
 */
export function parseFullMessage(
  message: gmail_v1.Schema$Message
): GmailMessage {
  // Get summary fields first
  const summary = parseMessageSummary(message);

  // Use library to parse complex MIME structure
  // This handles multipart/alternative, multipart/mixed, base64url decoding
  const parsed = parseMessage(message);

  // Extract attachments metadata (not content - too large)
  const attachments: GmailAttachment[] = (parsed.attachments || []).map(att => ({
    filename: att.filename || 'unnamed',
    mimeType: att.mimeType || 'application/octet-stream',
    size: att.size || 0,
    attachmentId: att.attachmentId || ''
  }));

  return {
    ...summary,
    textBody: parsed.textPlain || null,
    htmlBody: parsed.textHtml || null,
    attachments
  };
}
