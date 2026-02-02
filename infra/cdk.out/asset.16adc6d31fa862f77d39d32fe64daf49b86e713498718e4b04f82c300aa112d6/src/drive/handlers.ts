/**
 * Drive MCP tool handlers
 * Implements drive_search, drive_list, drive_get_content tools
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { UserContext } from '../auth/middleware.js';
import { getUserContextBySessionId } from '../routes/sse.js';
import { createDriveClient } from './client.js';
import { parseFileMetadata, getExportMimeType, isGoogleWorkspaceFile, isTextFile } from './parsers.js';
import type { DriveSearchResult, DriveListResult, DriveGetResult } from './types.js';

/**
 * Extract user context from MCP extra parameter using session ID
 */
function getUserContext(extra: any): UserContext | null {
  const sessionId = extra?.sessionId;
  if (!sessionId) return null;
  return getUserContextBySessionId(sessionId) || null;
}

/**
 * Handle Drive API errors and return appropriate MCP response
 */
function handleDriveError(error: any): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  const code = error.code || error.response?.status || 500;
  const message = error.message || 'Unknown Drive API error';

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
            message: 'Drive API rate limit exceeded. Please wait and try again.'
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
          message: 'Drive access not authorized. Please re-authenticate at /auth/login to grant Drive permissions.'
        }, null, 2)
      }],
      isError: true
    };
  }

  // File not found
  if (code === 404) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'file_not_found',
          code: 404,
          message: 'File not found or you do not have permission to access it.'
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
        error: 'drive_api_error',
        code: code,
        message: message
      }, null, 2)
    }],
    isError: true
  };
}

/**
 * Register Drive tools with MCP server
 */
export function registerDriveHandlers(server: McpServer): void {
  // drive_search - Search Drive files by name or content
  server.registerTool('drive_search', {
    description: 'Search Drive files by name or content using query syntax (e.g., "name contains \'report\'", "fullText contains \'quarterly\'")',
    inputSchema: {
      query: z.string().describe('Search query (name contains, fullText contains, mimeType, etc.)'),
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
      const drive = createDriveClient(userContext);
      const maxResults = Math.min(Math.max(args.maxResults || 10, 1), 50);

      // Build query: always exclude trashed files
      const fullQuery = `trashed=false and ${args.query}`;

      // Search files
      const response = await drive.files.list({
        q: fullQuery,
        fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime, webViewLink, parents)',
        pageSize: maxResults,
        pageToken: args.pageToken as string | undefined
      });

      const files = (response.data.files || []).map(parseFileMetadata);

      const result: DriveSearchResult = {
        files,
        nextPageToken: response.data.nextPageToken || null
      };

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error) {
      return handleDriveError(error);
    }
  });

  // drive_list - List files in a folder
  server.registerTool('drive_list', {
    description: 'List files in a folder (use \'root\' for My Drive root folder)',
    inputSchema: {
      folderId: z.string().optional().describe('Folder ID, default \'root\' for My Drive'),
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
      const drive = createDriveClient(userContext);
      const maxResults = Math.min(Math.max(args.maxResults || 10, 1), 50);
      const folderId = args.folderId || 'root';

      // Build query: folder parent and exclude trashed
      const query = `trashed=false and '${folderId}' in parents`;

      // List files
      const response = await drive.files.list({
        q: query,
        fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime, webViewLink, parents)',
        pageSize: maxResults,
        pageToken: args.pageToken as string | undefined
      });

      const files = (response.data.files || []).map(parseFileMetadata);

      const result: DriveListResult = {
        files,
        nextPageToken: response.data.nextPageToken || null
      };

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error) {
      return handleDriveError(error);
    }
  });

  // drive_get_content - Read file content
  server.registerTool('drive_get_content', {
    description: 'Read file content (text-based files only). Google Docs/Sheets are exported to plain text/CSV.',
    inputSchema: {
      fileId: z.string().describe('File ID')
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
      const drive = createDriveClient(userContext);

      // First get file metadata
      const metaResponse = await drive.files.get({
        fileId: args.fileId as string,
        fields: 'id, name, mimeType, size, modifiedTime, webViewLink'
      });

      const file = metaResponse.data;
      const mimeType = file.mimeType || 'application/octet-stream';

      let content: string | null = null;
      let exportFormat: string | undefined = undefined;

      // Check if Google Workspace file - use export
      if (isGoogleWorkspaceFile(mimeType)) {
        exportFormat = getExportMimeType(mimeType);

        const exportResponse = await drive.files.export({
          fileId: args.fileId as string,
          mimeType: exportFormat
        }, {
          responseType: 'stream'
        });

        // Collect stream chunks to Buffer
        const chunks: Buffer[] = [];
        for await (const chunk of exportResponse.data) {
          chunks.push(chunk);
        }
        content = Buffer.concat(chunks).toString('utf-8');
      } else if (isTextFile(mimeType)) {
        // Text file - download with alt=media
        const downloadResponse = await drive.files.get({
          fileId: args.fileId as string,
          alt: 'media'
        }, {
          responseType: 'stream'
        });

        // Collect stream chunks to Buffer
        const chunks: Buffer[] = [];
        for await (const chunk of downloadResponse.data) {
          chunks.push(chunk);
        }
        content = Buffer.concat(chunks).toString('utf-8');
      } else {
        // Binary file - not supported
        content = null;
      }

      // Build result with file metadata and content
      const result: DriveGetResult = {
        file: {
          ...parseFileMetadata(file),
          content,
          exportFormat
        }
      };

      // If content is null, add explanation
      if (content === null) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              ...result,
              message: `File type ${mimeType} is not text-based and cannot be read as plain text. Only text files and Google Workspace documents (Docs/Sheets/Slides) are supported.`
            }, null, 2)
          }]
        };
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error) {
      return handleDriveError(error);
    }
  });

  console.log('[MCP] Drive handlers registered: drive_search, drive_list, drive_get_content');
}
