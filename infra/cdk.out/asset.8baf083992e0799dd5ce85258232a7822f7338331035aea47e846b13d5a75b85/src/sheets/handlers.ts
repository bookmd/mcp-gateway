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
import type { SheetsGetValuesResult, SheetsGetMetadataResult, SheetsUpdateResult, SheetsAppendResult, SheetsClearResult, SheetsCreateResult, SheetsAddSheetResult, SheetsDeleteSheetResult, SheetsBatchUpdateResult } from './types.js';

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

  // sheets_update_values - Write values to a range
  server.registerTool('sheets_update_values', {
    description: 'Write values to cells in a Google Sheet range',
    inputSchema: {
      spreadsheetId: z.string().describe('Spreadsheet ID (from URL)'),
      range: z.string().describe('Range in A1 notation (e.g., "Sheet1!A1:D10")'),
      values: z.array(z.array(z.any())).describe('2D array of values to write'),
      valueInputOption: z.enum(['RAW', 'USER_ENTERED']).optional().describe('How to interpret input (default: USER_ENTERED)')
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

      const response = await sheets.spreadsheets.values.update({
        spreadsheetId: args.spreadsheetId,
        range: args.range,
        valueInputOption: args.valueInputOption || 'USER_ENTERED',
        requestBody: {
          values: args.values
        }
      });

      const result: SheetsUpdateResult = {
        spreadsheetId: response.data.spreadsheetId || args.spreadsheetId,
        updatedRange: response.data.updatedRange || args.range,
        updatedRows: response.data.updatedRows || 0,
        updatedColumns: response.data.updatedColumns || 0,
        updatedCells: response.data.updatedCells || 0
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

  // sheets_append_row - Append rows to a sheet
  server.registerTool('sheets_append_row', {
    description: 'Append rows to the end of a table in a Google Sheet',
    inputSchema: {
      spreadsheetId: z.string().describe('Spreadsheet ID (from URL)'),
      range: z.string().describe('Range to append to (e.g., "Sheet1!A:Z" or "Sheet1")'),
      values: z.array(z.array(z.any())).describe('2D array of rows to append'),
      valueInputOption: z.enum(['RAW', 'USER_ENTERED']).optional().describe('How to interpret input (default: USER_ENTERED)')
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

      const response = await sheets.spreadsheets.values.append({
        spreadsheetId: args.spreadsheetId,
        range: args.range,
        valueInputOption: args.valueInputOption || 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: {
          values: args.values
        }
      });

      const updates = response.data.updates || {};
      const result: SheetsAppendResult = {
        spreadsheetId: response.data.spreadsheetId || args.spreadsheetId,
        tableRange: response.data.tableRange || '',
        updatedRange: updates.updatedRange || '',
        updatedRows: updates.updatedRows || 0,
        updatedColumns: updates.updatedColumns || 0,
        updatedCells: updates.updatedCells || 0
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

  // sheets_clear_range - Clear values from a range
  server.registerTool('sheets_clear_range', {
    description: 'Clear all values from a range in a Google Sheet (keeps formatting)',
    inputSchema: {
      spreadsheetId: z.string().describe('Spreadsheet ID (from URL)'),
      range: z.string().describe('Range to clear in A1 notation')
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

      const response = await sheets.spreadsheets.values.clear({
        spreadsheetId: args.spreadsheetId,
        range: args.range
      });

      const result: SheetsClearResult = {
        spreadsheetId: response.data.spreadsheetId || args.spreadsheetId,
        clearedRange: response.data.clearedRange || args.range
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

  // sheets_create - Create a new spreadsheet
  server.registerTool('sheets_create', {
    description: 'Create a new Google Spreadsheet',
    inputSchema: {
      title: z.string().describe('Spreadsheet title'),
      sheets: z.array(z.object({
        title: z.string().describe('Sheet name'),
        rowCount: z.number().optional().describe('Number of rows (default: 1000)'),
        columnCount: z.number().optional().describe('Number of columns (default: 26)')
      })).optional().describe('Initial sheets to create')
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

      const requestBody: any = {
        properties: {
          title: args.title
        }
      };

      if (args.sheets && args.sheets.length > 0) {
        requestBody.sheets = args.sheets.map((sheet: any, index: number) => ({
          properties: {
            title: sheet.title,
            index,
            gridProperties: {
              rowCount: sheet.rowCount || 1000,
              columnCount: sheet.columnCount || 26
            }
          }
        }));
      }

      const response = await sheets.spreadsheets.create({
        requestBody
      });

      const result: SheetsCreateResult = {
        spreadsheetId: response.data.spreadsheetId || '',
        spreadsheetUrl: response.data.spreadsheetUrl || '',
        title: response.data.properties?.title || args.title,
        sheets: (response.data.sheets || []).map(s => ({
          sheetId: s.properties?.sheetId || 0,
          title: s.properties?.title || ''
        }))
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

  // sheets_add_sheet - Add a new sheet/tab to existing spreadsheet
  server.registerTool('sheets_add_sheet', {
    description: 'Add a new sheet (tab) to an existing spreadsheet',
    inputSchema: {
      spreadsheetId: z.string().describe('Spreadsheet ID'),
      title: z.string().describe('New sheet name'),
      index: z.number().optional().describe('Position to insert (0-based, default: end)')
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

      const request: any = {
        addSheet: {
          properties: {
            title: args.title
          }
        }
      };

      if (args.index !== undefined) {
        request.addSheet.properties.index = args.index;
      }

      const response = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: args.spreadsheetId,
        requestBody: {
          requests: [request]
        }
      });

      const addedSheet = response.data.replies?.[0]?.addSheet?.properties;
      const result: SheetsAddSheetResult = {
        spreadsheetId: args.spreadsheetId,
        sheetId: addedSheet?.sheetId || 0,
        title: addedSheet?.title || args.title,
        index: addedSheet?.index || 0
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

  // sheets_delete_sheet - Delete a sheet/tab from spreadsheet
  server.registerTool('sheets_delete_sheet', {
    description: 'Delete a sheet (tab) from a spreadsheet',
    inputSchema: {
      spreadsheetId: z.string().describe('Spreadsheet ID'),
      sheetId: z.number().describe('Sheet ID to delete (from sheets_get_metadata)')
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

      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: args.spreadsheetId,
        requestBody: {
          requests: [{
            deleteSheet: {
              sheetId: args.sheetId
            }
          }]
        }
      });

      const result: SheetsDeleteSheetResult = {
        spreadsheetId: args.spreadsheetId,
        deletedSheetId: args.sheetId,
        success: true
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

  // sheets_batch_update - Execute multiple spreadsheet operations
  server.registerTool('sheets_batch_update', {
    description: 'Execute multiple spreadsheet operations in a single batch request',
    inputSchema: {
      spreadsheetId: z.string().describe('Spreadsheet ID'),
      requests: z.array(z.any()).describe('Array of request objects (see Google Sheets API docs)')
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

      const response = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: args.spreadsheetId,
        requestBody: {
          requests: args.requests
        }
      });

      const result: SheetsBatchUpdateResult = {
        spreadsheetId: response.data.spreadsheetId || args.spreadsheetId,
        replies: response.data.replies || []
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

  console.log('[MCP] Sheets handlers registered: sheets_get_values, sheets_get_metadata, sheets_update_values, sheets_append_row, sheets_clear_range, sheets_create, sheets_add_sheet, sheets_delete_sheet, sheets_batch_update');
}
