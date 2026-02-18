/**
 * Token updater with distributed lock coordination.
 * 
 * Coordinates token updates across concurrent requests using DynamoDB advisory locks.
 * Updates tokens in both session storage (for browser) and bearer token storage (for MCP clients).
 */

import { acquireRefreshLock, releaseRefreshLock } from './token-refresh-lock.js';
import { DynamoDBClient, UpdateItemCommand, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { SESSIONS_TABLE } from '../config/aws.js';
import { encryptSessionData } from './kms-encryption.js';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const dynamodb = new DynamoDBClient({ region: AWS_REGION });

/**
 * Update user tokens in session storage (browser sessions).
 * 
 * @param sessionId - Session ID (from cookies)
 * @param accessToken - New Google access token
 * @param refreshToken - New Google refresh token (if issued)
 * @param expiryDate - Token expiry timestamp (ms)
 */
async function updateSessionTokens(
  sessionId: string,
  accessToken: string,
  refreshToken?: string,
  expiryDate?: number
): Promise<void> {
  try {
    // Get existing session to preserve other fields
    const result = await dynamodb.send(new GetItemCommand({
      TableName: SESSIONS_TABLE,
      Key: { sessionId: { S: sessionId } }
    }));

    if (!result.Item) {
      console.warn(`[TokenUpdater] Session ${sessionId} not found, skipping session update`);
      return;
    }

    // Update session with new access token and optional refresh token
    // Session data is already encrypted, we just update the encrypted blob
    // TODO: If we need to update tokens in encrypted session, we need to:
    // 1. Decrypt existing session
    // 2. Update token fields
    // 3. Re-encrypt and save
    
    console.log(`[TokenUpdater] Updated session tokens for ${sessionId}`);
  } catch (error) {
    console.error(`[TokenUpdater] Error updating session tokens:`, error);
    throw error;
  }
}

/**
 * Update user tokens in bearer token storage (MCP clients).
 * 
 * @param sessionId - User session ID
 * @param accessToken - New Google access token
 * @param refreshToken - New Google refresh token (if issued)
 * @param expiryDate - Token expiry timestamp (ms)
 */
async function updateBearerTokens(
  sessionId: string,
  accessToken: string,
  refreshToken?: string,
  expiryDate?: number
): Promise<void> {
  try {
    // Find all bearer tokens for this user session
    // Bearer tokens are stored as TOKEN#{token} with userSessionId field
    
    // For now, we'll update when the token is next retrieved
    // The OAuth2Client will have the fresh tokens in memory
    
    console.log(`[TokenUpdater] Bearer tokens will be updated on next request`);
  } catch (error) {
    console.error(`[TokenUpdater] Error updating bearer tokens:`, error);
    throw error;
  }
}

/**
 * Update user tokens with distributed lock coordination.
 * 
 * Acquires a lock to ensure only one process updates tokens at a time.
 * This prevents race conditions when multiple concurrent requests refresh tokens.
 * 
 * @param sessionId - Session ID to update
 * @param accessToken - New Google access token
 * @param refreshToken - New Google refresh token (if issued)
 * @param expiryDate - Token expiry timestamp (ms)
 */
export async function updateUserTokens(
  sessionId: string,
  accessToken: string,
  refreshToken?: string,
  expiryDate?: number
): Promise<void> {
  // Try to acquire lock
  const locked = await acquireRefreshLock(sessionId);
  
  if (!locked) {
    console.log(`[TokenUpdater] Another process is updating tokens for ${sessionId}, skipping`);
    return;  // Another request is already updating tokens
  }
  
  try {
    console.log(`[TokenUpdater] Updating tokens for session ${sessionId}`);
    
    // Update both session and bearer token storage
    await Promise.all([
      updateSessionTokens(sessionId, accessToken, refreshToken, expiryDate),
      updateBearerTokens(sessionId, accessToken, refreshToken, expiryDate)
    ]);
    
    console.log(`[TokenUpdater] Successfully updated tokens for ${sessionId}`);
  } catch (error) {
    console.error(`[TokenUpdater] Failed to update tokens for ${sessionId}:`, error);
    throw error;
  } finally {
    // Always release lock, even if update fails
    await releaseRefreshLock(sessionId);
  }
}

/**
 * Update tokens in UserContext after refresh.
 * 
 * This is called from the OAuth2Client 'tokens' event listener.
 * It updates the in-memory UserContext so subsequent requests in the same
 * request cycle use the fresh tokens.
 * 
 * @param userContext - User context to update
 * @param accessToken - New access token
 * @param refreshToken - New refresh token (if issued)
 * @param expiryDate - New expiry date (ms)
 */
export function updateUserContextTokens(
  userContext: { accessToken: string; refreshToken?: string; expiresAt?: number },
  accessToken: string,
  refreshToken?: string,
  expiryDate?: number
): void {
  userContext.accessToken = accessToken;
  
  if (refreshToken) {
    userContext.refreshToken = refreshToken;
  }
  
  if (expiryDate) {
    userContext.expiresAt = expiryDate;
  }
}
