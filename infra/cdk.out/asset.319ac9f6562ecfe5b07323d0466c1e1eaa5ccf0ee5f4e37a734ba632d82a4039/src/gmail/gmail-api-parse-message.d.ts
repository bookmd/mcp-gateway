/**
 * Type declarations for gmail-api-parse-message
 * Library doesn't include TypeScript definitions
 */
declare module 'gmail-api-parse-message' {
  interface ParsedAttachment {
    filename?: string;
    mimeType?: string;
    size?: number;
    attachmentId?: string;
  }

  interface ParsedMessage {
    textPlain?: string;
    textHtml?: string;
    attachments?: ParsedAttachment[];
  }

  function parseMessage(message: any): ParsedMessage;
  export default parseMessage;
}
