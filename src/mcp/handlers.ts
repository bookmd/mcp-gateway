import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { UserContext } from '../auth/middleware.js';

/**
 * Register MCP tool handlers with user context support
 */
export function registerMcpHandlers(server: McpServer): void {
  // Register 'whoami' tool - returns authenticated user info
  server.registerTool('whoami', {
    description: 'Returns information about the currently authenticated user',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  }, async (args, extra) => {
    // Extract user context from transport
    const userContext = (extra?.transport as any)?.userContext as UserContext | undefined;

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
    description: 'Verifies OAuth credentials are available and returns access token info',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  }, async (args, extra) => {
    // Extract user context from transport
    const userContext = (extra?.transport as any)?.userContext as UserContext | undefined;

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

  console.log('[MCP] Handlers registered: whoami, test_auth');
}
