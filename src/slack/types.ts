/**
 * Slack API types
 */

export interface SlackTokens {
  accessToken: string;
  teamId: string;
  teamName: string;
  userId: string;
  // Note: User tokens don't expire and don't have refresh tokens
}

export interface SlackUser {
  id: string;
  name: string;
  real_name?: string;
  profile?: {
    email?: string;
    display_name?: string;
    image_72?: string;
  };
  is_admin?: boolean;
  is_bot?: boolean;
  deleted?: boolean;
}

export interface SlackChannel {
  id: string;
  name: string;
  is_channel?: boolean;
  is_group?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
  is_archived?: boolean;
  is_member?: boolean;
  num_members?: number;
  topic?: { value: string };
  purpose?: { value: string };
}

export interface SlackMessage {
  type: string;
  ts: string;
  user?: string;
  text: string;
  channel?: string;
  permalink?: string;
  username?: string;
  attachments?: Array<{
    text?: string;
    fallback?: string;
  }>;
}

export interface SlackSearchResult {
  messages: {
    matches: SlackMessage[];
    total: number;
    pagination: {
      total_count: number;
      page: number;
      per_page: number;
      page_count: number;
    };
  };
}

export interface SlackConversationsHistoryResponse {
  ok: boolean;
  messages: SlackMessage[];
  has_more: boolean;
  response_metadata?: {
    next_cursor?: string;
  };
}

export interface SlackConversationsListResponse {
  ok: boolean;
  channels: SlackChannel[];
  response_metadata?: {
    next_cursor?: string;
  };
}

export interface SlackUsersListResponse {
  ok: boolean;
  members: SlackUser[];
  response_metadata?: {
    next_cursor?: string;
  };
}

export interface SlackApiError {
  ok: false;
  error: string;
}
