/**
 * Token store for Bearer token authentication.
 * Allows Cursor/MCP clients to authenticate without cookies.
 *
 * After browser OAuth, user gets a token to use in Cursor config.
 * 
 * Tokens are encrypted at rest using KMS envelope encryption (same as sessions).
 */

import crypto from 'crypto';
import { DynamoDBClient, PutItemCommand, GetItemCommand, DeleteItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { SESSIONS_TABLE } from '../config/aws.js';
import { encryptSessionData, decryptSessionData } from './kms-encryption.js';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const dynamodb = new DynamoDBClient({ region: AWS_REGION });

interface TokenSession {
  accessToken: string;
  refreshToken?: string;
  email: string;
  sessionId: string;
  expiresAt: number;  // Google token expiry (ms since epoch)
  // HubSpot tokens (optional)
  hubspotAccessToken?: string;
  hubspotRefreshToken?: string;
  hubspotTokenExpiresAt?: number;
  hubspotPortalId?: string;
  hubspotConnectedAt?: number;
}

/**
 * Create an access token for a user session.
 * Token is stored in DynamoDB with TTL and KMS encryption.
 *
 * @param accessToken - Google access token
 * @param refreshToken - Google refresh token
 * @param email - User email
 * @param sessionId - User session ID
 * @param googleTokenExpiresAt - Google token expiry (ms since epoch), defaults to 1 hour from now
 * @param ttlSeconds - Bearer token TTL in seconds, defaults to 1 week
 */
export async function createAccessToken(
  accessToken: string,
  refreshToken: string | undefined,
  email: string,
  sessionId: string,
  googleTokenExpiresAt?: number,
  ttlSeconds: number = 7 * 24 * 60 * 60 // 1 week default
): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex');
  const bearerTokenExpiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;

  // Default Google token expiry to 1 hour from now if not provided
  const googleExpiry = googleTokenExpiresAt || (Date.now() + 60 * 60 * 1000);

  // Encrypt sensitive token data using KMS envelope encryption
  // Store Google token expiry inside encrypted data so it can be updated on refresh
  const tokenData = JSON.stringify({
    googleAccessToken: accessToken,
    googleRefreshToken: refreshToken,
    googleTokenExpiresAt: googleExpiry  // Store Google token expiry in encrypted data
  });

  const encrypted = await encryptSessionData(tokenData);

  await dynamodb.send(new PutItemCommand({
    TableName: SESSIONS_TABLE,
    Item: {
      sessionId: { S: `TOKEN#${token}` },
      encryptedData: { S: encrypted.encryptedData },
      encryptedKey: { S: encrypted.encryptedKey },
      iv: { S: encrypted.iv },
      authTag: { S: encrypted.authTag },
      email: { S: email },
      userSessionId: { S: sessionId },
      expiresAt: { N: String(bearerTokenExpiresAt) },  // This is Bearer token TTL (1 week)
      ttl: { N: String(bearerTokenExpiresAt) }
    }
  }));

  return token;
}

/**
 * Get session data by access token.
 * Returns null if token is invalid or expired (Bearer token TTL).
 */
export async function getSessionByToken(token: string): Promise<TokenSession | null> {
  try {
    const result = await dynamodb.send(new GetItemCommand({
      TableName: SESSIONS_TABLE,
      Key: {
        sessionId: { S: `TOKEN#${token}` }
      }
    }));

    if (!result.Item) {
      return null;
    }

    // Check Bearer token TTL (1 week)
    const bearerTokenExpiresAt = parseInt(result.Item.expiresAt?.N || '0', 10);
    if (Date.now() / 1000 > bearerTokenExpiresAt) {
      // Bearer token expired (1 week TTL), clean it up
      await deleteToken(token);
      return null;
    }

    // Decrypt the token data
    const decryptedJson = await decryptSessionData(
      result.Item.encryptedData?.S || '',
      result.Item.encryptedKey?.S || '',
      result.Item.iv?.S || '',
      result.Item.authTag?.S || ''
    );

    const tokenData = JSON.parse(decryptedJson);

    // Get Google token expiry from encrypted data
    // Fall back to Bearer TTL for backwards compatibility with old tokens
    const googleTokenExpiresAt = tokenData.googleTokenExpiresAt || (bearerTokenExpiresAt * 1000);

    return {
      accessToken: tokenData.googleAccessToken || '',
      refreshToken: tokenData.googleRefreshToken,
      email: result.Item.email?.S || '',
      sessionId: result.Item.userSessionId?.S || '',
      expiresAt: googleTokenExpiresAt,  // This is now Google token expiry (for refresh checks)
      // HubSpot tokens
      hubspotAccessToken: tokenData.hubspotAccessToken,
      hubspotRefreshToken: tokenData.hubspotRefreshToken,
      hubspotTokenExpiresAt: tokenData.hubspotTokenExpiresAt,
      hubspotPortalId: tokenData.hubspotPortalId,
      hubspotConnectedAt: tokenData.hubspotConnectedAt,
    };
  } catch (error) {
    console.error('Error getting token session:', error);
    return null;
  }
}

/**
 * Delete a token (logout or cleanup).
 */
export async function deleteToken(token: string): Promise<void> {
  await dynamodb.send(new DeleteItemCommand({
    TableName: SESSIONS_TABLE,
    Key: {
      sessionId: { S: `TOKEN#${token}` }
    }
  }));
}

/**
 * Update the Google tokens stored in a Bearer token record.
 * Called after token refresh to persist the new access token.
 *
 * @param bearerToken - The Bearer token (lookup key)
 * @param accessToken - New Google access token
 * @param refreshToken - New Google refresh token (if issued)
 * @param googleTokenExpiresAt - New Google token expiry timestamp (ms since epoch)
 */
export async function updateBearerTokenRecord(
  bearerToken: string,
  accessToken: string,
  refreshToken?: string,
  googleTokenExpiresAt?: number
): Promise<void> {
  try {
    // Default to 1 hour from now if not provided
    const expiresAt = googleTokenExpiresAt || (Date.now() + 60 * 60 * 1000);

    // Encrypt the new token data using KMS envelope encryption
    // Include the Google token expiry so it's available on next read
    const tokenData = JSON.stringify({
      googleAccessToken: accessToken,
      googleRefreshToken: refreshToken,
      googleTokenExpiresAt: expiresAt
    });

    const encrypted = await encryptSessionData(tokenData);

    // Update the DynamoDB record with new encrypted token data
    await dynamodb.send(new UpdateItemCommand({
      TableName: SESSIONS_TABLE,
      Key: {
        sessionId: { S: `TOKEN#${bearerToken}` }
      },
      UpdateExpression: 'SET encryptedData = :ed, encryptedKey = :ek, iv = :iv, authTag = :at',
      ExpressionAttributeValues: {
        ':ed': { S: encrypted.encryptedData },
        ':ek': { S: encrypted.encryptedKey },
        ':iv': { S: encrypted.iv },
        ':at': { S: encrypted.authTag }
      }
    }));

    console.log(`[TokenStore] Updated Bearer token record with refreshed Google tokens, new expiry: ${new Date(expiresAt).toISOString()}`);
  } catch (error) {
    console.error('[TokenStore] Failed to update Bearer token record:', error);
    throw error;
  }
}

/**
 * Add HubSpot tokens to an existing Bearer token record.
 * Called after user completes HubSpot OAuth flow.
 */
export async function addHubSpotTokens(
  bearerToken: string,
  hubspotAccessToken: string,
  hubspotRefreshToken: string,
  hubspotTokenExpiresAt: number,
  hubspotPortalId?: string
): Promise<void> {
  try {
    // First, get the existing token data
    const existing = await getSessionByToken(bearerToken);
    if (!existing) {
      throw new Error('Bearer token not found');
    }

    // Merge HubSpot tokens with existing Google tokens
    const tokenData = JSON.stringify({
      googleAccessToken: existing.accessToken,
      googleRefreshToken: existing.refreshToken,
      googleTokenExpiresAt: existing.expiresAt,
      hubspotAccessToken,
      hubspotRefreshToken,
      hubspotTokenExpiresAt,
      hubspotPortalId,
      hubspotConnectedAt: Date.now(),
    });

    const encrypted = await encryptSessionData(tokenData);

    // Update the DynamoDB record
    await dynamodb.send(new UpdateItemCommand({
      TableName: SESSIONS_TABLE,
      Key: {
        sessionId: { S: `TOKEN#${bearerToken}` }
      },
      UpdateExpression: 'SET encryptedData = :ed, encryptedKey = :ek, iv = :iv, authTag = :at',
      ExpressionAttributeValues: {
        ':ed': { S: encrypted.encryptedData },
        ':ek': { S: encrypted.encryptedKey },
        ':iv': { S: encrypted.iv },
        ':at': { S: encrypted.authTag }
      }
    }));

    console.log(`[TokenStore] Added HubSpot tokens to Bearer token record, portal: ${hubspotPortalId}`);
  } catch (error) {
    console.error('[TokenStore] Failed to add HubSpot tokens:', error);
    throw error;
  }
}

/**
 * Update HubSpot tokens in an existing Bearer token record.
 * Called after HubSpot token refresh.
 */
export async function updateHubSpotTokens(
  bearerToken: string,
  hubspotAccessToken: string,
  hubspotRefreshToken: string,
  hubspotTokenExpiresAt: number,
  hubspotPortalId?: string
): Promise<void> {
  try {
    // Get existing token data
    const existing = await getSessionByToken(bearerToken);
    if (!existing) {
      throw new Error('Bearer token not found');
    }

    // Update HubSpot tokens while preserving Google tokens
    const tokenData = JSON.stringify({
      googleAccessToken: existing.accessToken,
      googleRefreshToken: existing.refreshToken,
      googleTokenExpiresAt: existing.expiresAt,
      hubspotAccessToken,
      hubspotRefreshToken,
      hubspotTokenExpiresAt,
      hubspotPortalId: hubspotPortalId || existing.hubspotPortalId,
      hubspotConnectedAt: existing.hubspotConnectedAt,
    });

    const encrypted = await encryptSessionData(tokenData);

    await dynamodb.send(new UpdateItemCommand({
      TableName: SESSIONS_TABLE,
      Key: {
        sessionId: { S: `TOKEN#${bearerToken}` }
      },
      UpdateExpression: 'SET encryptedData = :ed, encryptedKey = :ek, iv = :iv, authTag = :at',
      ExpressionAttributeValues: {
        ':ed': { S: encrypted.encryptedData },
        ':ek': { S: encrypted.encryptedKey },
        ':iv': { S: encrypted.iv },
        ':at': { S: encrypted.authTag }
      }
    }));

    console.log(`[TokenStore] Updated HubSpot tokens, new expiry: ${new Date(hubspotTokenExpiresAt).toISOString()}`);
  } catch (error) {
    console.error('[TokenStore] Failed to update HubSpot tokens:', error);
    throw error;
  }
}

/**
 * Remove HubSpot tokens from a Bearer token record.
 * Called when user disconnects HubSpot.
 */
export async function removeHubSpotTokens(bearerToken: string): Promise<void> {
  try {
    // Get existing token data
    const existing = await getSessionByToken(bearerToken);
    if (!existing) {
      throw new Error('Bearer token not found');
    }

    // Remove HubSpot tokens, keep only Google tokens
    const tokenData = JSON.stringify({
      googleAccessToken: existing.accessToken,
      googleRefreshToken: existing.refreshToken,
      googleTokenExpiresAt: existing.expiresAt,
      // HubSpot fields intentionally omitted
    });

    const encrypted = await encryptSessionData(tokenData);

    await dynamodb.send(new UpdateItemCommand({
      TableName: SESSIONS_TABLE,
      Key: {
        sessionId: { S: `TOKEN#${bearerToken}` }
      },
      UpdateExpression: 'SET encryptedData = :ed, encryptedKey = :ek, iv = :iv, authTag = :at',
      ExpressionAttributeValues: {
        ':ed': { S: encrypted.encryptedData },
        ':ek': { S: encrypted.encryptedKey },
        ':iv': { S: encrypted.iv },
        ':at': { S: encrypted.authTag }
      }
    }));

    console.log(`[TokenStore] Removed HubSpot tokens from Bearer token record`);
  } catch (error) {
    console.error('[TokenStore] Failed to remove HubSpot tokens:', error);
    throw error;
  }
}
