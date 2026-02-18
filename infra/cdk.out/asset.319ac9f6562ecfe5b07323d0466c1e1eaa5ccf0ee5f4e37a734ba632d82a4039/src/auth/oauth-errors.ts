/**
 * OAuth error handling utilities.
 * 
 * Handles errors from Google OAuth, particularly revoked or invalid refresh tokens.
 */

import { DynamoDBClient, DeleteItemCommand } from '@aws-sdk/client-dynamodb';
import { SESSIONS_TABLE } from '../config/aws.js';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const dynamodb = new DynamoDBClient({ region: AWS_REGION });

/**
 * Check if error is from a revoked or invalid refresh token.
 * 
 * Google returns 'invalid_grant' error when:
 * - Refresh token has been revoked by user
 * - Refresh token has expired
 * - Refresh token is invalid
 * 
 * @param error - Error object from OAuth or API call
 * @returns true if error indicates revoked/invalid refresh token
 */
export function isRevokedTokenError(error: any): boolean {
  if (!error) return false;
  
  const message = error.message || error.error || '';
  const errorCode = error.code || error.error || '';
  
  return (
    message.includes('invalid_grant') ||
    message.includes('Token has been expired or revoked') ||
    errorCode === 'invalid_grant'
  );
}

/**
 * Clear user session and tokens after refresh token revocation.
 * 
 * This removes both:
 * - Browser session (if exists)
 * - Bearer tokens associated with the session
 * 
 * User must re-authenticate to obtain new tokens.
 * 
 * @param sessionId - Session ID to clear
 */
export async function clearRevokedSession(sessionId: string): Promise<void> {
  try {
    console.log(`[OAuth] Clearing revoked session: ${sessionId}`);
    
    // Delete the session
    await dynamodb.send(new DeleteItemCommand({
      TableName: SESSIONS_TABLE,
      Key: { sessionId: { S: sessionId } }
    }));
    
    // Note: Bearer tokens (TOKEN#xxx) with userSessionId will remain until they expire via TTL
    // They will fail auth check when getSessionByToken tries to decrypt invalid tokens
    
    console.log(`[OAuth] Session ${sessionId} cleared due to revoked refresh token`);
  } catch (error) {
    console.error(`[OAuth] Failed to clear revoked session ${sessionId}:`, error);
    throw error;
  }
}

/**
 * Create error response for revoked token.
 * 
 * Returns a standardized error object to send to clients
 * when their refresh token has been revoked.
 */
export function createRevokedTokenResponse() {
  return {
    error: 'refresh_token_revoked',
    error_description: 'Your access has been revoked. Please re-authenticate.',
    reauth_url: '/auth/login'
  };
}
