/**
 * Slack API client factory
 */

import { slackOAuthConfig } from '../config/slack-oauth.js';
import type { SlackTokens } from './types.js';

const SLACK_API_BASE = 'https://slack.com/api';

export interface SlackClient {
  get: <T>(method: string, params?: Record<string, string>) => Promise<T>;
  post: <T>(method: string, body?: Record<string, unknown>) => Promise<T>;
}

/**
 * Create a Slack API client with the given access token
 */
export function createSlackClient(accessToken: string): SlackClient {
  const makeRequest = async <T>(
    httpMethod: 'GET' | 'POST',
    slackMethod: string,
    options?: { params?: Record<string, string>; body?: Record<string, unknown> }
  ): Promise<T> => {
    let url = `${SLACK_API_BASE}/${slackMethod}`;

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${accessToken}`,
    };

    let body: string | undefined;

    if (httpMethod === 'GET' && options?.params) {
      const searchParams = new URLSearchParams(options.params);
      url += `?${searchParams.toString()}`;
    } else if (httpMethod === 'POST' && options?.body) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
      body = JSON.stringify(options.body);
    }

    const response = await fetch(url, {
      method: httpMethod,
      headers,
      body,
    });

    const data = await response.json() as T & { ok: boolean; error?: string };

    if (!data.ok) {
      throw new Error(`Slack API error: ${data.error || 'Unknown error'}`);
    }

    return data;
  };

  return {
    get: <T>(method: string, params?: Record<string, string>) =>
      makeRequest<T>('GET', method, { params }),
    post: <T>(method: string, body?: Record<string, unknown>) =>
      makeRequest<T>('POST', method, { body }),
  };
}

/**
 * Exchange authorization code for user token
 */
export async function exchangeCodeForTokens(code: string, redirectUri: string): Promise<SlackTokens> {
  const response = await fetch(slackOAuthConfig.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: slackOAuthConfig.clientId,
      client_secret: slackOAuthConfig.clientSecret,
      code,
      redirect_uri: redirectUri,
    }).toString(),
  });

  const data = await response.json() as {
    ok: boolean;
    error?: string;
    authed_user?: {
      id: string;
      access_token: string;
    };
    team?: {
      id: string;
      name: string;
    };
  };

  if (!data.ok) {
    throw new Error(`Slack token exchange failed: ${data.error}`);
  }

  if (!data.authed_user?.access_token) {
    throw new Error('Slack token exchange failed: no user token received');
  }

  return {
    accessToken: data.authed_user.access_token,
    teamId: data.team?.id || '',
    teamName: data.team?.name || '',
    userId: data.authed_user.id,
  };
}
