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
import type { DocsGetResult, DocsCreateResult, DocsInsertResult, DocsAppendResult, DocsReplaceResult } from './types.js';

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

  // docs_create - Create a new Google Doc
  server.registerTool('docs_create', {
    description: 'Create a new Google Doc',
    inputSchema: {
      title: z.string().describe('Document title'),
      content: z.string().optional().describe('Initial text content to add')
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

      // Create the document
      const createResponse = await docs.documents.create({
        requestBody: {
          title: args.title
        }
      });

      const documentId = createResponse.data.documentId || '';

      // If content provided, insert it
      if (args.content && documentId) {
        await docs.documents.batchUpdate({
          documentId,
          requestBody: {
            requests: [{
              insertText: {
                location: { index: 1 },
                text: args.content
              }
            }]
          }
        });
      }

      const result: DocsCreateResult = {
        documentId,
        title: createResponse.data.title || args.title,
        documentUrl: `https://docs.google.com/document/d/${documentId}/edit`
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

  // docs_insert_text - Insert text at a specific position
  server.registerTool('docs_insert_text', {
    description: 'Insert text at a specific position in a Google Doc',
    inputSchema: {
      documentId: z.string().describe('Document ID'),
      text: z.string().describe('Text to insert'),
      index: z.number().min(1).describe('Position to insert at (1-based index)')
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

      await docs.documents.batchUpdate({
        documentId: args.documentId,
        requestBody: {
          requests: [{
            insertText: {
              location: { index: args.index },
              text: args.text
            }
          }]
        }
      });

      const result: DocsInsertResult = {
        documentId: args.documentId,
        insertedAt: args.index,
        textLength: args.text.length
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

  // docs_append_text - Append text to the end of a document
  server.registerTool('docs_append_text', {
    description: 'Append text to the end of a Google Doc',
    inputSchema: {
      documentId: z.string().describe('Document ID'),
      text: z.string().describe('Text to append')
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

      // First get the document to find the end index
      const docResponse = await docs.documents.get({
        documentId: args.documentId
      });

      // Get the end index from the body content
      const body = docResponse.data.body;
      let endIndex = 1;
      if (body?.content) {
        const lastElement = body.content[body.content.length - 1];
        endIndex = lastElement?.endIndex ? lastElement.endIndex - 1 : 1;
      }

      // Insert at the end
      await docs.documents.batchUpdate({
        documentId: args.documentId,
        requestBody: {
          requests: [{
            insertText: {
              location: { index: endIndex },
              text: args.text
            }
          }]
        }
      });

      const result: DocsAppendResult = {
        documentId: args.documentId,
        appendedAt: endIndex,
        textLength: args.text.length
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

  // docs_replace_text - Find and replace text in a document
  server.registerTool('docs_replace_text', {
    description: 'Find and replace text in a Google Doc',
    inputSchema: {
      documentId: z.string().describe('Document ID'),
      find: z.string().describe('Text to find'),
      replace: z.string().describe('Text to replace with'),
      matchCase: z.boolean().optional().describe('Case-sensitive matching (default: false)')
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

      const response = await docs.documents.batchUpdate({
        documentId: args.documentId,
        requestBody: {
          requests: [{
            replaceAllText: {
              containsText: {
                text: args.find,
                matchCase: args.matchCase || false
              },
              replaceText: args.replace
            }
          }]
        }
      });

      const replaceResult = response.data.replies?.[0]?.replaceAllText;
      const result: DocsReplaceResult = {
        documentId: args.documentId,
        occurrencesReplaced: replaceResult?.occurrencesChanged || 0
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

  console.log('[MCP] Docs handlers registered: docs_get_content, docs_create, docs_insert_text, docs_append_text, docs_replace_text');
}
