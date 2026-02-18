/**
 * Gmail API response types for MCP tools
 */

/** Summary of a Gmail message (used in search/list results) */
export interface GmailMessageSummary {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  to: string;
  date: string;
  snippet: string;
  labelIds: string[];
}

/** Full Gmail message with body content (used in get result) */
export interface GmailMessage extends GmailMessageSummary {
  textBody: string | null;
  htmlBody: string | null;
  attachments: GmailAttachment[];
}

/** Attachment metadata (body content not included - too large) */
export interface GmailAttachment {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string;
}

/** Search/List result with pagination */
export interface GmailSearchResult {
  messages: GmailMessageSummary[];
  nextPageToken: string | null;
  resultSizeEstimate: number;
}

/** Full message result */
export interface GmailGetResult {
  message: GmailMessage;
}

/** Error response for Gmail tools */
export interface GmailErrorResult {
  error: string;
  code: number;
  message: string;
}
