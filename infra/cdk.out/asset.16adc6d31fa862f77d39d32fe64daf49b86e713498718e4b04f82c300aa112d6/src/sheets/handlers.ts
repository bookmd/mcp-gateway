/**
 * Sheets MCP tool handlers
 * Implements sheets_get_values, sheets_get_metadata tools
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { UserContext } from '../auth/middleware.js';
import { getUserContextBySessionId } from '../routes/sse.js';
import { createSheetsClient } from './client.js';
import { parseValueRange, parseSpreadsheetMetadata } from './parsers.js';
import type { SheetsGetValuesResult, SheetsGetMetadataResult } from './types.js';

/**
 * Extract user context from MCP extra parameter using session ID
 */
function getUserContext(extra: any): UserContext | null {
  const sessionId = extra?.sessionId;
  if (!sessionId) return null;
  return getUserContextBySessionId(sessionId) || null;
}

/**
 * Handle Sheets API errors and return appropriate MCP response
 */
function handleSheetsError(error: any): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  const code = error.code || error.response?.status || 500;
  const message = error.message || 'Unknown Sheets API error';

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
    // Check if rate limit or quota (60 reads/min per user limit)
    if (message.includes('rate') || message.includes('quota') || message.includes('limit')) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: 'rate_limited',
            code: 403,
            message: 'Sheets API rate limit exceeded (60 reads/min per user). Please wait and try again.'
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
          message: 'Sheets access not authorized. Please re-authenticate at /auth/login to grant Sheets permissions.'
        }, null, 2)
      }],
      isError: true
    };
  }

  // Spreadsheet not found
  if (code === 404) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'spreadsheet_not_found',
          code: 404,
          message: 'Spreadsheet not found or you do not have permission to access it.'
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
        error: 'sheets_api_error',
        code: code,
        message: message
      }, null, 2)
    }],
    isError: true
  };
}

/**
 * Register Sheets tools with MCP server
 */
export function registerSheetsHandlers(server: McpServer): void {
  // sheets_get_values - Read cell values from a Google Sheet range
  server.registerTool('sheets_get_values', {
    description: 'Read cell values from a Google Sheet range using A1 notation (e.g., "Sheet1!A1:D10")',
    inputSchema: {
      spreadsheetId: z.string().describe('Spreadsheet ID (from URL)'),
      range: z.string().describe('Range in A1 notation (e.g., "Sheet1!A1:D10" or "A1:D10" for first sheet)')
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
      const sheets = createSheetsClient(userContext);

      // Fetch values from range
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: args.spreadsheetId as string,
        range: args.range as string
      });

      // Parse and normalize the value range
      const data = parseValueRange(response.data);

      // Build result
      const result: SheetsGetValuesResult = {
        data
      };

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error) {
      return handleSheetsError(error);
    }
  });

  // sheets_get_metadata - Get spreadsheet metadata including sheet names
  server.registerTool('sheets_get_metadata', {
    description: 'Get spreadsheet metadata including sheet names and dimensions',
    inputSchema: {
      spreadsheetId: z.string().describe('Spreadsheet ID (from URL)')
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
      const sheets = createSheetsClient(userContext);

      // Fetch spreadsheet metadata (without grid data for efficiency)
      const response = await sheets.spreadsheets.get({
        spreadsheetId: args.spreadsheetId as string,
        includeGridData: false
      });

      // Parse metadata
      const metadata = parseSpreadsheetMetadata(response.data);

      // Build result
      const result: SheetsGetMetadataResult = {
        metadata
      };

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error) {
      return handleSheetsError(error);
    }
  });

  console.log('[MCP] Sheets handlers registered: sheets_get_values, sheets_get_metadata');
}
