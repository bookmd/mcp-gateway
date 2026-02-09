import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { UserContext } from '../auth/middleware.js';
import { getUserContextBySessionId } from '../routes/sse.js';
import { registerGmailHandlers } from '../gmail/handlers.js';
import { registerCalendarHandlers } from '../calendar/handlers.js';
import { registerDriveHandlers } from '../drive/handlers.js';
import { registerDocsHandlers } from '../docs/handlers.js';
import { registerSheetsHandlers } from '../sheets/handlers.js';

/**
 * Register MCP tool handlers with user context support
 */
export function registerMcpHandlers(server: McpServer): void {
  // Register 'whoami' tool - returns authenticated user info
  server.registerTool('whoami', {
    description: 'Returns information about the currently authenticated user'
  }, async (extra) => {
    console.log('[MCP] whoami called, extra keys:', Object.keys(extra || {}));
    console.log('[MCP] whoami sessionId:', extra?.sessionId);

    // Extract user context using session ID from extra
    const sessionId = extra?.sessionId;
    const userContext = sessionId ? getUserContextBySessionId(sessionId) : undefined;
    console.log('[MCP] whoami userContext email:', userContext?.email);

    if (!userContext) {
      return {
        content: [
          {
            type: 'text',
            text: 'Error: No user context available. This should not happen - connection must be authenticated.'
          }
        ],
        isError: true
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              email: userContext.email,
              sessionId: userContext.sessionId,
              authenticated: true
            },
            null,
            2
          )
        }
      ]
    };
  });

  // Register 'test_auth' tool - verifies OAuth credentials are available
  server.registerTool('test_auth', {
    description: 'Verifies OAuth credentials are available and returns access token info'
  }, async (extra) => {
    // Extract user context using session ID from extra
    const sessionId = extra?.sessionId;
    const userContext = sessionId ? getUserContextBySessionId(sessionId) : undefined;

    if (!userContext) {
      return {
        content: [
          {
            type: 'text',
            text: 'Error: No user context available. This should not happen - connection must be authenticated.'
          }
        ],
        isError: true
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              email: userContext.email,
              hasAccessToken: !!userContext.accessToken,
              accessTokenPrefix: userContext.accessToken
                ? `${userContext.accessToken.substring(0, 20)}...`
                : null,
              message: 'OAuth credentials available - ready for Google API calls'
            },
            null,
            2
          )
        }
      ]
    };
  });

  // Register Gmail tools
  registerGmailHandlers(server);

  // Register Calendar tools
  registerCalendarHandlers(server);

  // Register Drive tools
  registerDriveHandlers(server);

  // Register Docs tools
  registerDocsHandlers(server);

  // Register Sheets tools
  registerSheetsHandlers(server);

  console.log('[MCP] Handlers registered: whoami, test_auth, gmail_search, gmail_list, gmail_get, calendar_list_events, calendar_get_event, drive_search, drive_list, drive_get_content, docs_get_content, sheets_get_values, sheets_get_metadata');
}
