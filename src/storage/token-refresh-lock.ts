/**
 * DynamoDB advisory lock implementation for distributed token refresh coordination.
 * 
 * Prevents race conditions when multiple concurrent requests try to refresh the same token.
 * Uses DynamoDB conditional writes for atomic lock acquisition.
 * 
 * Research findings:
 * - googleapis OAuth2Client has NO built-in mutex
 * - Must implement distributed lock using DynamoDB conditional writes
 * - Use attribute_not_exists() condition for atomic lock acquisition
 * - Locks have TTL to prevent deadlocks from crashed processes
 */

import { DynamoDBClient, PutItemCommand, DeleteItemCommand } from '@aws-sdk/client-dynamodb';
import { SESSIONS_TABLE } from '../config/aws.js';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const dynamodb = new DynamoDBClient({ region: AWS_REGION });

// Lock expires after 30 seconds to prevent deadlocks
const LOCK_TTL_SECONDS = 30;

/**
 * Acquire distributed lock for token refresh using DynamoDB conditional write.
 * 
 * Uses attribute_not_exists() condition to ensure only one process can acquire the lock.
 * This is an atomic operation provided by DynamoDB.
 * 
 * @param sessionId - Session ID to lock for refresh
 * @returns true if lock acquired, false if already held by another process
 */
export async function acquireRefreshLock(sessionId: string): Promise<boolean> {
  const lockKey = `REFRESH_LOCK#${sessionId}`;
  const expiresAt = Math.floor(Date.now() / 1000) + LOCK_TTL_SECONDS;
  
  try {
    await dynamodb.send(new PutItemCommand({
      TableName: SESSIONS_TABLE,
      Item: {
        sessionId: { S: lockKey },
        lockedAt: { N: String(Date.now()) },
        expiresAt: { N: String(expiresAt) },
        ttl: { N: String(expiresAt) }
      },
      // Atomic lock acquisition - only succeeds if lock doesn't exist
      ConditionExpression: 'attribute_not_exists(sessionId)'
    }));
    
    console.log(`[RefreshLock] Acquired lock for session ${sessionId}`);
    return true;  // Lock acquired
  } catch (err: any) {
    if (err.name === 'ConditionalCheckFailedException') {
      console.log(`[RefreshLock] Lock already held for session ${sessionId}`);
      return false;  // Lock already held by another process
    }
    // Unexpected error - log and re-throw
    console.error(`[RefreshLock] Error acquiring lock for session ${sessionId}:`, err);
    throw err;
  }
}

/**
 * Release the refresh lock.
 * 
 * Should be called in a finally block to ensure lock is always released,
 * even if token refresh fails.
 * 
 * @param sessionId - Session ID to release lock for
 */
export async function releaseRefreshLock(sessionId: string): Promise<void> {
  const lockKey = `REFRESH_LOCK#${sessionId}`;
  
  try {
    await dynamodb.send(new DeleteItemCommand({
      TableName: SESSIONS_TABLE,
      Key: { sessionId: { S: lockKey } }
    }));
    
    console.log(`[RefreshLock] Released lock for session ${sessionId}`);
  } catch (error) {
    console.error(`[RefreshLock] Error releasing lock for session ${sessionId}:`, error);
    // Don't throw - lock will expire via TTL anyway
  }
}

/**
 * Wait and retry to acquire lock.
 * Useful when multiple concurrent requests detect expired token.
 * 
 * @param sessionId - Session ID to lock
 * @param maxRetries - Maximum number of retry attempts (default: 5)
 * @param delayMs - Delay between retries in milliseconds (default: 200ms)
 * @returns true if lock acquired, false if max retries exceeded
 */
export async function acquireRefreshLockWithRetry(
  sessionId: string,
  maxRetries: number = 5,
  delayMs: number = 200
): Promise<boolean> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const acquired = await acquireRefreshLock(sessionId);
    
    if (acquired) {
      return true;
    }
    
    // Lock held by another process - wait and retry
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  
  console.warn(`[RefreshLock] Failed to acquire lock for session ${sessionId} after ${maxRetries} attempts`);
  return false;
}
