export interface UserContext {
  accessToken: string;
  email: string;
  sessionId: string;
}

// Extended session type for MCP connections
export interface McpSession {
  userContext: UserContext;
  connectedAt: number;
}
