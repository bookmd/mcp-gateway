/**
 * Docs MCP tool handlers
 * Implements docs_get_content tool
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { UserContext } from '../auth/middleware.js';
import { getUserContextBySessionId } from '../routes/sse.js';
import { createDocsClient } from './client.js';
import { parseDocument } from './parsers.js';
import type { DocsGetResult } from './types.js';

/**
 * Extract user context from MCP extra parameter using session ID
 */
function getUserContext(extra: any): UserContext | null {
  const sessionId = extra?.sessionId;
  if (!sessionId) return null;
  return getUserContextBySessionId(sessionId) || null;
}

/**
 * Handle Docs API errors and return appropriate MCP response
 */
function handleDocsError(error: any): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  const code = error.code || error.response?.status || 500;
  const message = error.message || 'Unknown Docs API error';

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
            message: 'Docs API rate limit exceeded. Please wait and try again.'
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
          message: 'Docs access not authorized. Please re-authenticate at /auth/login to grant Docs permissions.'
        }, null, 2)
      }],
      isError: true
    };
  }

  // Document not found
  if (code === 404) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'document_not_found',
          code: 404,
          message: 'Document not found or you do not have permission to access it.'
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
        error: 'docs_api_error',
        code: code,
        message: message
      }, null, 2)
    }],
    isError: true
  };
}

/**
 * Register Docs tools with MCP server
 */
export function registerDocsHandlers(server: McpServer): void {
  // docs_get_content - Read text content from a Google Doc
  server.registerTool('docs_get_content', {
    description: 'Read text content from a Google Doc including content from all document tabs',
    inputSchema: {
      documentId: z.string().describe('Document ID (from URL or Drive)')
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
      const docs = createDocsClient(userContext);

      // Fetch document with includeTabsContent parameter
      const response = await docs.documents.get({
        documentId: args.documentId as string,
        includeTabsContent: true
      });

      const doc = response.data;

      // Parse document content
      const content = parseDocument(doc);

      // Build result with document info and content
      const result: DocsGetResult = {
        document: {
          id: doc.documentId || args.documentId,
          title: doc.title || 'Untitled Document',
          documentId: doc.documentId || args.documentId
        },
        content
      };

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error) {
      return handleDocsError(error);
    }
  });

  console.log('[MCP] Docs handlers registered: docs_get_content');
}
