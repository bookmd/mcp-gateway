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
  expiresAt: number;
}

/**
 * Create an access token for a user session.
 * Token is stored in DynamoDB with TTL and KMS encryption.
 */
export async function createAccessToken(
  accessToken: string,
  refreshToken: string | undefined,
  email: string,
  sessionId: string,
  ttlSeconds: number = 7 * 24 * 60 * 60 // 1 week default
): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;

  // Encrypt sensitive token data using KMS envelope encryption
  const tokenData = JSON.stringify({
    googleAccessToken: accessToken,
    googleRefreshToken: refreshToken
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
      expiresAt: { N: String(expiresAt) },
      ttl: { N: String(expiresAt) }
    }
  }));

  return token;
}

/**
 * Get session data by access token.
 * Returns null if token is invalid or expired.
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

    const expiresAt = parseInt(result.Item.expiresAt?.N || '0', 10);
    if (Date.now() / 1000 > expiresAt) {
      // Token expired, clean it up
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

    return {
      accessToken: tokenData.googleAccessToken || '',
      refreshToken: tokenData.googleRefreshToken,
      email: result.Item.email?.S || '',
      sessionId: result.Item.userSessionId?.S || '',
      expiresAt: expiresAt * 1000
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
 * @param expiresAt - New expiry timestamp (ms since epoch)
 */
export async function updateBearerTokenRecord(
  bearerToken: string,
  accessToken: string,
  refreshToken?: string,
  expiresAt?: number
): Promise<void> {
  try {
    // Encrypt the new token data using KMS envelope encryption
    const tokenData = JSON.stringify({
      googleAccessToken: accessToken,
      googleRefreshToken: refreshToken
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

    console.log(`[TokenStore] Updated Bearer token record with refreshed Google tokens`);
  } catch (error) {
    console.error('[TokenStore] Failed to update Bearer token record:', error);
    throw error;
  }
}
