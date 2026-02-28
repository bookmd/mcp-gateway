/**
 * HubSpot API types for CRM objects
 */

export interface HubSpotTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix timestamp in milliseconds
  portalId?: string;
}

export interface HubSpotContact {
  id: string;
  properties: {
    firstname?: string;
    lastname?: string;
    email?: string;
    phone?: string;
    company?: string;
    jobtitle?: string;
    lifecyclestage?: string;
    hs_lead_status?: string;
    createdate?: string;
    lastmodifieddate?: string;
    [key: string]: string | undefined;
  };
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}

export interface HubSpotCompany {
  id: string;
  properties: {
    name?: string;
    domain?: string;
    industry?: string;
    phone?: string;
    city?: string;
    state?: string;
    country?: string;
    numberofemployees?: string;
    annualrevenue?: string;
    lifecyclestage?: string;
    createdate?: string;
    lastmodifieddate?: string;
    [key: string]: string | undefined;
  };
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}

export interface HubSpotDeal {
  id: string;
  properties: {
    dealname?: string;
    dealstage?: string;
    pipeline?: string;
    amount?: string;
    closedate?: string;
    hubspot_owner_id?: string;
    hs_priority?: string;
    createdate?: string;
    lastmodifieddate?: string;
    [key: string]: string | undefined;
  };
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}

export interface HubSpotOwner {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  userId?: number;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}

export interface HubSpotSearchRequest {
  filterGroups?: Array<{
    filters: Array<{
      propertyName: string;
      operator: 'EQ' | 'NEQ' | 'LT' | 'LTE' | 'GT' | 'GTE' | 'CONTAINS_TOKEN' | 'NOT_CONTAINS_TOKEN';
      value: string;
    }>;
  }>;
  sorts?: Array<{
    propertyName: string;
    direction: 'ASCENDING' | 'DESCENDING';
  }>;
  query?: string;
  limit?: number;
  after?: string;
  properties?: string[];
}

export interface HubSpotListResponse<T> {
  results: T[];
  paging?: {
    next?: {
      after: string;
    };
  };
}

export interface HubSpotError {
  status: string;
  message: string;
  correlationId: string;
  category: string;
}
