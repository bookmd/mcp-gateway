/**
 * HubSpot MCP tool handlers
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getUserContextBySessionId } from '../routes/sse.js';
import { createHubSpotClient, refreshHubSpotToken } from './client.js';
import { updateHubSpotTokens, getSessionByToken } from '../storage/token-store.js';
import { isHubSpotConfigured } from '../config/hubspot-oauth.js';
import type {
  HubSpotContact,
  HubSpotCompany,
  HubSpotDeal,
  HubSpotOwner,
  HubSpotListResponse,
  HubSpotSearchRequest
} from './types.js';

// Helper to get HubSpot client with token refresh
async function getHubSpotClientForUser(sessionId: string): Promise<{
  client: ReturnType<typeof createHubSpotClient>;
  portalId?: string;
} | { error: string }> {
  const userContext = sessionId ? getUserContextBySessionId(sessionId) : undefined;

  if (!userContext) {
    return { error: 'No user context available' };
  }

  // Get the bearer token from user context
  const token = (userContext as any).bearerToken;
  if (!token) {
    return { error: 'HubSpot is not connected. Use the hubspot_connect tool to connect your HubSpot account.' };
  }

  const session = await getSessionByToken(token);
  if (!session) {
    return { error: 'Session not found' };
  }

  if (!session.hubspotAccessToken || !session.hubspotRefreshToken) {
    return {
      error: 'HubSpot is not connected. Use the hubspot_connect tool to get the connection URL, or visit: /auth/hubspot'
    };
  }

  // Check if token needs refresh (5 minute buffer)
  const now = Date.now();
  const expiresAt = session.hubspotTokenExpiresAt || 0;

  if (now >= expiresAt - 5 * 60 * 1000) {
    console.log('[HubSpot] Token expired or expiring soon, refreshing...');
    try {
      const newTokens = await refreshHubSpotToken(session.hubspotRefreshToken);
      await updateHubSpotTokens(
        token,
        newTokens.accessToken,
        newTokens.refreshToken,
        newTokens.expiresAt,
        newTokens.portalId
      );
      return {
        client: createHubSpotClient(newTokens.accessToken),
        portalId: newTokens.portalId || session.hubspotPortalId
      };
    } catch (error) {
      console.error('[HubSpot] Token refresh failed:', error);
      return {
        error: 'HubSpot token refresh failed. Please reconnect your HubSpot account at /auth/hubspot'
      };
    }
  }

  return {
    client: createHubSpotClient(session.hubspotAccessToken),
    portalId: session.hubspotPortalId
  };
}

// Format error response
function errorResponse(message: string) {
  return {
    content: [{ type: 'text' as const, text: `Error: ${message}` }],
    isError: true
  };
}

// Format success response
function successResponse(data: unknown) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify(data, null, 2)
    }]
  };
}

export function registerHubSpotHandlers(server: McpServer): void {
  if (!isHubSpotConfigured()) {
    console.log('[HubSpot] Handlers not registered - HubSpot not configured');
    return;
  }

  // ============================================================
  // Connection Management Tools
  // ============================================================

  server.registerTool('hubspot_status', {
    description: 'Check HubSpot connection status'
  }, async (extra: any) => {
    const sessionId = extra?.sessionId;
    const userContext = sessionId ? getUserContextBySessionId(sessionId) : undefined;

    if (!userContext) {
      return errorResponse('No user context available');
    }

    const token = (userContext as any).bearerToken;
    if (!token) {
      return successResponse({
        connected: false,
        message: 'Use hubspot_connect to get the connection URL'
      });
    }

    const session = await getSessionByToken(token);
    if (!session) {
      return successResponse({
        connected: false,
        message: 'Session not found'
      });
    }

    return successResponse({
      connected: !!session.hubspotAccessToken,
      portalId: session.hubspotPortalId || null,
      connectedAt: session.hubspotConnectedAt
        ? new Date(session.hubspotConnectedAt).toISOString()
        : null
    });
  });

  server.registerTool('hubspot_connect', {
    description: 'Get the URL to connect your HubSpot account'
  }, async (extra: any) => {
    return successResponse({
      message: 'To connect HubSpot, open this URL in your browser:',
      url: 'https://mgw.ext.getvim.com/auth/hubspot',
      note: 'You must include your Bearer token in the Authorization header when accessing this URL'
    });
  });

  // ============================================================
  // Contacts Tools
  // ============================================================

  server.registerTool('hubspot_list_contacts', {
    description: 'List contacts from HubSpot CRM',
    inputSchema: {
      limit: z.number().min(1).max(100).optional().describe('Number of contacts to return (1-100, default 10)'),
      after: z.string().optional().describe('Pagination cursor for next page'),
      properties: z.array(z.string()).optional().describe('Properties to include (default: firstname, lastname, email, phone, company)')
    }
  }, async (args: any, extra: any) => {
    const result = await getHubSpotClientForUser(extra?.sessionId);
    if ('error' in result) return errorResponse(result.error);

    const { client } = result;
    const { limit = 10, after, properties } = args;

    const defaultProps = ['firstname', 'lastname', 'email', 'phone', 'company', 'jobtitle', 'lifecyclestage'];
    const props = properties || defaultProps;

    try {
      const queryParams: Record<string, string> = {
        limit: String(limit),
        properties: props.join(',')
      };
      if (after) queryParams.after = after;

      const response = await client.get<HubSpotListResponse<HubSpotContact>>(
        '/crm/v3/objects/contacts',
        queryParams
      );

      return successResponse({
        contacts: response.results.map(c => ({
          id: c.id,
          ...c.properties
        })),
        paging: response.paging
      });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : 'Failed to list contacts');
    }
  });

  server.registerTool('hubspot_get_contact', {
    description: 'Get a specific contact by ID',
    inputSchema: {
      contactId: z.string().describe('The HubSpot contact ID'),
      properties: z.array(z.string()).optional().describe('Properties to include')
    }
  }, async (args: any, extra: any) => {
    const result = await getHubSpotClientForUser(extra?.sessionId);
    if ('error' in result) return errorResponse(result.error);

    const { client } = result;
    const { contactId, properties } = args;

    const defaultProps = ['firstname', 'lastname', 'email', 'phone', 'company', 'jobtitle', 'lifecyclestage', 'hs_lead_status', 'createdate', 'lastmodifieddate'];
    const props = properties || defaultProps;

    try {
      const contact = await client.get<HubSpotContact>(
        `/crm/v3/objects/contacts/${contactId}`,
        { properties: props.join(',') }
      );

      return successResponse({
        id: contact.id,
        ...contact.properties,
        createdAt: contact.createdAt,
        updatedAt: contact.updatedAt
      });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : 'Failed to get contact');
    }
  });

  server.registerTool('hubspot_search_contacts', {
    description: 'Search contacts by query or filters',
    inputSchema: {
      query: z.string().optional().describe('Search query (searches across default searchable properties)'),
      filters: z.array(z.object({
        propertyName: z.string(),
        operator: z.enum(['EQ', 'NEQ', 'LT', 'LTE', 'GT', 'GTE', 'CONTAINS_TOKEN', 'NOT_CONTAINS_TOKEN']),
        value: z.string()
      })).optional().describe('Filter conditions'),
      limit: z.number().min(1).max(100).optional().describe('Number of results (default 10)'),
      properties: z.array(z.string()).optional().describe('Properties to include')
    }
  }, async (args: any, extra: any) => {
    const result = await getHubSpotClientForUser(extra?.sessionId);
    if ('error' in result) return errorResponse(result.error);

    const { client } = result;
    const { query, filters, limit = 10, properties } = args;

    const defaultProps = ['firstname', 'lastname', 'email', 'phone', 'company'];

    try {
      const searchRequest: HubSpotSearchRequest = {
        limit,
        properties: properties || defaultProps
      };

      if (query) searchRequest.query = query;
      if (filters && filters.length > 0) {
        searchRequest.filterGroups = [{ filters }];
      }

      const response = await client.post<HubSpotListResponse<HubSpotContact>>(
        '/crm/v3/objects/contacts/search',
        searchRequest
      );

      return successResponse({
        contacts: response.results.map(c => ({
          id: c.id,
          ...c.properties
        })),
        total: response.results.length,
        paging: response.paging
      });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : 'Failed to search contacts');
    }
  });

  // ============================================================
  // Companies Tools
  // ============================================================

  server.registerTool('hubspot_list_companies', {
    description: 'List companies from HubSpot CRM',
    inputSchema: {
      limit: z.number().min(1).max(100).optional().describe('Number of companies to return (1-100, default 10)'),
      after: z.string().optional().describe('Pagination cursor for next page'),
      properties: z.array(z.string()).optional().describe('Properties to include')
    }
  }, async (args: any, extra: any) => {
    const result = await getHubSpotClientForUser(extra?.sessionId);
    if ('error' in result) return errorResponse(result.error);

    const { client } = result;
    const { limit = 10, after, properties } = args;

    const defaultProps = ['name', 'domain', 'industry', 'phone', 'city', 'state', 'country', 'numberofemployees'];

    try {
      const queryParams: Record<string, string> = {
        limit: String(limit),
        properties: (properties || defaultProps).join(',')
      };
      if (after) queryParams.after = after;

      const response = await client.get<HubSpotListResponse<HubSpotCompany>>(
        '/crm/v3/objects/companies',
        queryParams
      );

      return successResponse({
        companies: response.results.map(c => ({
          id: c.id,
          ...c.properties
        })),
        paging: response.paging
      });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : 'Failed to list companies');
    }
  });

  server.registerTool('hubspot_get_company', {
    description: 'Get a specific company by ID',
    inputSchema: {
      companyId: z.string().describe('The HubSpot company ID'),
      properties: z.array(z.string()).optional().describe('Properties to include')
    }
  }, async (args: any, extra: any) => {
    const result = await getHubSpotClientForUser(extra?.sessionId);
    if ('error' in result) return errorResponse(result.error);

    const { client } = result;
    const { companyId, properties } = args;

    const defaultProps = ['name', 'domain', 'industry', 'phone', 'city', 'state', 'country', 'numberofemployees', 'annualrevenue', 'lifecyclestage', 'createdate', 'lastmodifieddate'];

    try {
      const company = await client.get<HubSpotCompany>(
        `/crm/v3/objects/companies/${companyId}`,
        { properties: (properties || defaultProps).join(',') }
      );

      return successResponse({
        id: company.id,
        ...company.properties,
        createdAt: company.createdAt,
        updatedAt: company.updatedAt
      });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : 'Failed to get company');
    }
  });

  server.registerTool('hubspot_search_companies', {
    description: 'Search companies by query or filters',
    inputSchema: {
      query: z.string().optional().describe('Search query'),
      filters: z.array(z.object({
        propertyName: z.string(),
        operator: z.enum(['EQ', 'NEQ', 'LT', 'LTE', 'GT', 'GTE', 'CONTAINS_TOKEN', 'NOT_CONTAINS_TOKEN']),
        value: z.string()
      })).optional().describe('Filter conditions'),
      limit: z.number().min(1).max(100).optional().describe('Number of results (default 10)'),
      properties: z.array(z.string()).optional().describe('Properties to include')
    }
  }, async (args: any, extra: any) => {
    const result = await getHubSpotClientForUser(extra?.sessionId);
    if ('error' in result) return errorResponse(result.error);

    const { client } = result;
    const { query, filters, limit = 10, properties } = args;

    const defaultProps = ['name', 'domain', 'industry', 'numberofemployees'];

    try {
      const searchRequest: HubSpotSearchRequest = {
        limit,
        properties: properties || defaultProps
      };

      if (query) searchRequest.query = query;
      if (filters && filters.length > 0) {
        searchRequest.filterGroups = [{ filters }];
      }

      const response = await client.post<HubSpotListResponse<HubSpotCompany>>(
        '/crm/v3/objects/companies/search',
        searchRequest
      );

      return successResponse({
        companies: response.results.map(c => ({
          id: c.id,
          ...c.properties
        })),
        total: response.results.length,
        paging: response.paging
      });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : 'Failed to search companies');
    }
  });

  // ============================================================
  // Deals Tools
  // ============================================================

  server.registerTool('hubspot_list_deals', {
    description: 'List deals from HubSpot CRM',
    inputSchema: {
      limit: z.number().min(1).max(100).optional().describe('Number of deals to return (1-100, default 10)'),
      after: z.string().optional().describe('Pagination cursor for next page'),
      properties: z.array(z.string()).optional().describe('Properties to include')
    }
  }, async (args: any, extra: any) => {
    const result = await getHubSpotClientForUser(extra?.sessionId);
    if ('error' in result) return errorResponse(result.error);

    const { client } = result;
    const { limit = 10, after, properties } = args;

    const defaultProps = ['dealname', 'dealstage', 'pipeline', 'amount', 'closedate', 'hubspot_owner_id'];

    try {
      const queryParams: Record<string, string> = {
        limit: String(limit),
        properties: (properties || defaultProps).join(',')
      };
      if (after) queryParams.after = after;

      const response = await client.get<HubSpotListResponse<HubSpotDeal>>(
        '/crm/v3/objects/deals',
        queryParams
      );

      return successResponse({
        deals: response.results.map(d => ({
          id: d.id,
          ...d.properties
        })),
        paging: response.paging
      });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : 'Failed to list deals');
    }
  });

  server.registerTool('hubspot_get_deal', {
    description: 'Get a specific deal by ID',
    inputSchema: {
      dealId: z.string().describe('The HubSpot deal ID'),
      properties: z.array(z.string()).optional().describe('Properties to include')
    }
  }, async (args: any, extra: any) => {
    const result = await getHubSpotClientForUser(extra?.sessionId);
    if ('error' in result) return errorResponse(result.error);

    const { client } = result;
    const { dealId, properties } = args;

    const defaultProps = ['dealname', 'dealstage', 'pipeline', 'amount', 'closedate', 'hubspot_owner_id', 'hs_priority', 'createdate', 'lastmodifieddate'];

    try {
      const deal = await client.get<HubSpotDeal>(
        `/crm/v3/objects/deals/${dealId}`,
        { properties: (properties || defaultProps).join(',') }
      );

      return successResponse({
        id: deal.id,
        ...deal.properties,
        createdAt: deal.createdAt,
        updatedAt: deal.updatedAt
      });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : 'Failed to get deal');
    }
  });

  server.registerTool('hubspot_search_deals', {
    description: 'Search deals by query or filters',
    inputSchema: {
      query: z.string().optional().describe('Search query'),
      filters: z.array(z.object({
        propertyName: z.string(),
        operator: z.enum(['EQ', 'NEQ', 'LT', 'LTE', 'GT', 'GTE', 'CONTAINS_TOKEN', 'NOT_CONTAINS_TOKEN']),
        value: z.string()
      })).optional().describe('Filter conditions'),
      limit: z.number().min(1).max(100).optional().describe('Number of results (default 10)'),
      properties: z.array(z.string()).optional().describe('Properties to include')
    }
  }, async (args: any, extra: any) => {
    const result = await getHubSpotClientForUser(extra?.sessionId);
    if ('error' in result) return errorResponse(result.error);

    const { client } = result;
    const { query, filters, limit = 10, properties } = args;

    const defaultProps = ['dealname', 'dealstage', 'pipeline', 'amount', 'closedate'];

    try {
      const searchRequest: HubSpotSearchRequest = {
        limit,
        properties: properties || defaultProps
      };

      if (query) searchRequest.query = query;
      if (filters && filters.length > 0) {
        searchRequest.filterGroups = [{ filters }];
      }

      const response = await client.post<HubSpotListResponse<HubSpotDeal>>(
        '/crm/v3/objects/deals/search',
        searchRequest
      );

      return successResponse({
        deals: response.results.map(d => ({
          id: d.id,
          ...d.properties
        })),
        total: response.results.length,
        paging: response.paging
      });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : 'Failed to search deals');
    }
  });

  console.log('[HubSpot] Registered tools: hubspot_status, hubspot_connect, hubspot_list_contacts, hubspot_get_contact, hubspot_search_contacts, hubspot_list_companies, hubspot_get_company, hubspot_search_companies, hubspot_list_deals, hubspot_get_deal, hubspot_search_deals');
}
