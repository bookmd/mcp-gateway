/**
 * Drive MCP tool handlers
 * Implements drive_search, drive_list, drive_get_content tools
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { UserContext } from '../auth/middleware.js';
import { getUserContextBySessionId } from '../routes/sse.js';
import { createDriveClient } from './client.js';
import { parseFileMetadata, getExportMimeType, isGoogleWorkspaceFile, isTextFile, isExcelFile } from './parsers.js';
import type { DriveSearchResult, DriveListResult, DriveGetResult, DriveXlsxResult, XlsxSheetData, DriveUploadResult, DriveCreateFolderResult, DriveMoveResult, DriveCopyResult, DriveRenameResult, DriveTrashResult, DriveDeleteResult, DriveShareResult, DrivePermissionsResult, DrivePermission } from './types.js';
import * as XLSX from 'xlsx';
import { Readable } from 'stream';

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

  // drive_get_xlsx - Read Excel file content
  server.registerTool('drive_get_xlsx', {
    description: 'Read Excel file (.xlsx, .xls) content and return as structured data (JSON or CSV)',
    inputSchema: {
      fileId: z.string().describe('File ID'),
      sheetName: z.string().optional().describe('Specific sheet name to read (default: all sheets)'),
      format: z.enum(['json', 'csv', 'raw']).optional().describe('Output format: json (with headers), csv, or raw (2D array). Default: json'),
      headerRow: z.boolean().optional().describe('Whether first row contains headers (default: true for json format)')
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
      const format = args.format || 'json';
      const headerRow = args.headerRow !== false; // Default true

      // First get file metadata
      const metaResponse = await drive.files.get({
        fileId: args.fileId as string,
        fields: 'id, name, mimeType, size, modifiedTime, webViewLink'
      });

      const file = metaResponse.data;
      const mimeType = file.mimeType || 'application/octet-stream';

      // Verify it's an Excel file
      if (!isExcelFile(mimeType)) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'invalid_file_type',
              code: 400,
              message: `File type ${mimeType} is not an Excel file. Use drive_get_content for text files or drive_get_xlsx for .xlsx/.xls files.`
            }, null, 2)
          }],
          isError: true
        };
      }

      // Download the file as binary
      const downloadResponse = await drive.files.get({
        fileId: args.fileId as string,
        alt: 'media'
      }, {
        responseType: 'arraybuffer'
      });

      // Parse the Excel file
      const workbook = XLSX.read(downloadResponse.data as ArrayBuffer, { type: 'array' });

      // Get sheet names to process
      let sheetNames = workbook.SheetNames;
      if (args.sheetName) {
        if (!sheetNames.includes(args.sheetName)) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                error: 'sheet_not_found',
                code: 404,
                message: `Sheet "${args.sheetName}" not found. Available sheets: ${sheetNames.join(', ')}`
              }, null, 2)
            }],
            isError: true
          };
        }
        sheetNames = [args.sheetName];
      }

      // Process each sheet
      const sheets: XlsxSheetData[] = sheetNames.map(name => {
        const worksheet = workbook.Sheets[name];
        let data: string[][] | Record<string, unknown>[];

        if (format === 'json' && headerRow) {
          // Convert to array of objects with headers as keys
          data = XLSX.utils.sheet_to_json(worksheet) as Record<string, unknown>[];
        } else if (format === 'csv') {
          // Convert to CSV string, then split into rows
          const csv = XLSX.utils.sheet_to_csv(worksheet);
          data = csv.split('\n').map(row => row.split(','));
        } else {
          // Raw 2D array
          data = XLSX.utils.sheet_to_json(worksheet, { header: 1 }) as string[][];
        }

        return { name, data };
      });

      const result: DriveXlsxResult = {
        file: parseFileMetadata(file),
        sheets,
        format
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

  // drive_upload - Upload a file to Drive
  server.registerTool('drive_upload', {
    description: 'Upload a file to Google Drive (max 10MB base64, ~7.5MB actual file)',
    inputSchema: {
      name: z.string().describe('File name'),
      content: z.string().describe('File content as base64 encoded string'),
      mimeType: z.string().describe('MIME type of the file'),
      folderId: z.string().optional().describe('Parent folder ID (default: root)')
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
      // Check size limit (10MB base64)
      if (args.content.length > 10 * 1024 * 1024) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'file_too_large',
              code: 400,
              message: 'File too large. Maximum size is 10MB base64 (~7.5MB actual file).'
            }, null, 2)
          }],
          isError: true
        };
      }

      const drive = createDriveClient(userContext);

      const fileMetadata: any = {
        name: args.name
      };
      if (args.folderId) {
        fileMetadata.parents = [args.folderId];
      }

      const media = {
        mimeType: args.mimeType,
        body: Readable.from(Buffer.from(args.content, 'base64'))
      };

      const response = await drive.files.create({
        requestBody: fileMetadata,
        media,
        fields: 'id, name, mimeType, size, webViewLink, webContentLink'
      });

      const result: DriveUploadResult = {
        id: response.data.id || '',
        name: response.data.name || args.name,
        mimeType: response.data.mimeType || args.mimeType,
        size: response.data.size || '0',
        webViewLink: response.data.webViewLink || '',
        webContentLink: response.data.webContentLink || undefined
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

  // drive_create_folder - Create a new folder
  server.registerTool('drive_create_folder', {
    description: 'Create a new folder in Google Drive',
    inputSchema: {
      name: z.string().describe('Folder name'),
      parentId: z.string().optional().describe('Parent folder ID (default: root)')
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

      const fileMetadata: any = {
        name: args.name,
        mimeType: 'application/vnd.google-apps.folder'
      };
      if (args.parentId) {
        fileMetadata.parents = [args.parentId];
      }

      const response = await drive.files.create({
        requestBody: fileMetadata,
        fields: 'id, name, webViewLink'
      });

      const result: DriveCreateFolderResult = {
        id: response.data.id || '',
        name: response.data.name || args.name,
        webViewLink: response.data.webViewLink || ''
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

  // drive_move - Move a file to a different folder
  server.registerTool('drive_move', {
    description: 'Move a file to a different folder',
    inputSchema: {
      fileId: z.string().describe('File ID to move'),
      newParentId: z.string().describe('Destination folder ID'),
      removeFromCurrent: z.boolean().optional().describe('Remove from current parent (default: true)')
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

      // Get current parents
      const file = await drive.files.get({
        fileId: args.fileId,
        fields: 'parents'
      });

      const previousParents = (file.data.parents || []).join(',');
      const removeFromCurrent = args.removeFromCurrent !== false;

      const response = await drive.files.update({
        fileId: args.fileId,
        addParents: args.newParentId,
        removeParents: removeFromCurrent ? previousParents : undefined,
        fields: 'id, name, parents'
      });

      const result: DriveMoveResult = {
        id: response.data.id || args.fileId,
        name: response.data.name || '',
        parents: response.data.parents || [args.newParentId]
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

  // drive_copy - Copy a file
  server.registerTool('drive_copy', {
    description: 'Create a copy of a file',
    inputSchema: {
      fileId: z.string().describe('File ID to copy'),
      name: z.string().optional().describe('Name for the copy (default: "Copy of [original]")'),
      folderId: z.string().optional().describe('Destination folder ID (default: same as original)')
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

      const requestBody: any = {};
      if (args.name) requestBody.name = args.name;
      if (args.folderId) requestBody.parents = [args.folderId];

      const response = await drive.files.copy({
        fileId: args.fileId,
        requestBody,
        fields: 'id, name, mimeType, webViewLink'
      });

      const result: DriveCopyResult = {
        id: response.data.id || '',
        name: response.data.name || '',
        mimeType: response.data.mimeType || '',
        webViewLink: response.data.webViewLink || ''
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

  // drive_rename - Rename a file
  server.registerTool('drive_rename', {
    description: 'Rename a file or folder',
    inputSchema: {
      fileId: z.string().describe('File ID to rename'),
      name: z.string().describe('New name')
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

      const response = await drive.files.update({
        fileId: args.fileId,
        requestBody: {
          name: args.name
        },
        fields: 'id, name'
      });

      const result: DriveRenameResult = {
        id: response.data.id || args.fileId,
        name: response.data.name || args.name
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

  // drive_trash - Move a file to trash (reversible)
  server.registerTool('drive_trash', {
    description: 'Move a file to trash (can be restored with drive_restore)',
    inputSchema: {
      fileId: z.string().describe('File ID to trash')
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

      const response = await drive.files.update({
        fileId: args.fileId,
        requestBody: {
          trashed: true
        },
        fields: 'id, name, trashed'
      });

      const result: DriveTrashResult = {
        id: response.data.id || args.fileId,
        name: response.data.name || '',
        trashed: response.data.trashed || true
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

  // drive_restore - Restore a file from trash
  server.registerTool('drive_restore', {
    description: 'Restore a file from trash',
    inputSchema: {
      fileId: z.string().describe('File ID to restore')
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

      const response = await drive.files.update({
        fileId: args.fileId,
        requestBody: {
          trashed: false
        },
        fields: 'id, name, trashed'
      });

      const result: DriveTrashResult = {
        id: response.data.id || args.fileId,
        name: response.data.name || '',
        trashed: response.data.trashed || false
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

  // drive_delete_permanently - Permanently delete a file (irreversible)
  server.registerTool('drive_delete_permanently', {
    description: 'Permanently delete a file (IRREVERSIBLE - cannot be recovered)',
    inputSchema: {
      fileId: z.string().describe('File ID to permanently delete')
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

      await drive.files.delete({
        fileId: args.fileId
      });

      const result: DriveDeleteResult = {
        id: args.fileId,
        deleted: true
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

  // drive_share - Share a file with a user or group
  server.registerTool('drive_share', {
    description: 'Share a file with a user, group, or make it public',
    inputSchema: {
      fileId: z.string().describe('File ID to share'),
      email: z.string().describe('Email address to share with'),
      role: z.enum(['reader', 'commenter', 'writer']).describe('Permission level'),
      sendNotification: z.boolean().optional().describe('Send email notification (default: true)')
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

      const response = await drive.permissions.create({
        fileId: args.fileId,
        sendNotificationEmail: args.sendNotification !== false,
        requestBody: {
          type: 'user',
          role: args.role,
          emailAddress: args.email
        },
        fields: 'id, type, role, emailAddress, displayName'
      });

      const result: DriveShareResult = {
        fileId: args.fileId,
        permission: {
          id: response.data.id || '',
          type: (response.data.type as DrivePermission['type']) || 'user',
          role: (response.data.role as DrivePermission['role']) || args.role,
          emailAddress: response.data.emailAddress || args.email,
          displayName: response.data.displayName || undefined
        }
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

  // drive_get_permissions - List who has access to a file
  server.registerTool('drive_get_permissions', {
    description: 'List all permissions (who has access) for a file',
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

      const response = await drive.permissions.list({
        fileId: args.fileId,
        fields: 'permissions(id, type, role, emailAddress, displayName, domain)'
      });

      const permissions: DrivePermission[] = (response.data.permissions || []).map(p => ({
        id: p.id || '',
        type: (p.type as DrivePermission['type']) || 'user',
        role: (p.role as DrivePermission['role']) || 'reader',
        emailAddress: p.emailAddress || undefined,
        displayName: p.displayName || undefined,
        domain: p.domain || undefined
      }));

      const result: DrivePermissionsResult = {
        fileId: args.fileId,
        permissions
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

  console.log('[MCP] Drive handlers registered: drive_search, drive_list, drive_get_content, drive_get_xlsx, drive_upload, drive_create_folder, drive_move, drive_copy, drive_rename, drive_trash, drive_restore, drive_delete_permanently, drive_share, drive_get_permissions');
}
