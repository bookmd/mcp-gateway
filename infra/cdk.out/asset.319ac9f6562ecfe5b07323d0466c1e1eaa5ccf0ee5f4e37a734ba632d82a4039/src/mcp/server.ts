import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// MCP Server instance
let mcpServer: McpServer;

export function getMcpServer(): McpServer {
  if (!mcpServer) {
    throw new Error('MCP server not initialized. Call initMcpServer() first.');
  }
  return mcpServer;
}

export function initMcpServer(): McpServer {
  mcpServer = new McpServer({
    name: 'mcp-gateway',
    version: '1.0.0'
  });

  // Log server initialization
  console.log('[MCP] Server initialized: mcp-gateway v1.0.0');

  return mcpServer;
}
