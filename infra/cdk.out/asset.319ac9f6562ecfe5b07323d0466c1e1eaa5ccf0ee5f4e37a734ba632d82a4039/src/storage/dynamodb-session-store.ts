/**
 * DynamoDB session store implementing express-session interface.
 * Uses KMS envelope encryption for session data at rest.
 *
 * Fastify's @fastify/session uses the same store interface as express-session.
 */

import { GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, SESSIONS_TABLE } from '../config/aws.js';
import { encryptSessionData, decryptSessionData } from './kms-encryption.js';
import type { SessionStoreConfig, EncryptedSessionRecord } from './types.js';

// Encryption schema version - increment when changing encryption approach
const ENCRYPTION_VERSION = 1;

// Default TTL: 7 days in seconds (matches AUTH-04 weekly re-authentication)
const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * DynamoDB-backed session store with KMS encryption.
 *
 * Implements the express-session Store interface with callback-based methods.
 * Sessions are encrypted at rest using envelope encryption (unique key per session).
 *
 * TTL is checked in application code as well as DynamoDB's TTL mechanism
 * to handle the up-to-48-hour deletion delay in DynamoDB TTL.
 */
export class DynamoDBSessionStore {
  private tableName: string;
  private ttlSeconds: number;

  constructor(config: SessionStoreConfig = {}) {
    this.tableName = config.tableName || SESSIONS_TABLE;
    this.ttlSeconds = config.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  }

  /**
   * Retrieve a session by ID.
   *
   * @param sessionId - Session identifier
   * @param callback - Called with (error, session) - session is null if not found/expired
   */
  get(sessionId: string, callback: (err: any, session?: any) => void): void {
    this.getAsync(sessionId)
      .then((session) => callback(null, session))
      .catch((err) => callback(err));
  }

  /**
   * Store a session.
   *
   * @param sessionId - Session identifier
   * @param session - Session data object
   * @param callback - Called with (error) - null on success
   */
  set(sessionId: string, session: any, callback: (err?: any) => void): void {
    this.setAsync(sessionId, session)
      .then(() => callback())
      .catch((err) => callback(err));
  }

  /**
   * Delete a session.
   *
   * @param sessionId - Session identifier
   * @param callback - Called with (error) - null on success (including if not found)
   */
  destroy(sessionId: string, callback: (err?: any) => void): void {
    this.destroyAsync(sessionId)
      .then(() => callback())
      .catch((err) => callback(err));
  }

  /**
   * Internal async implementation of get.
   */
  private async getAsync(sessionId: string): Promise<any | null> {
    const command = new GetCommand({
      TableName: this.tableName,
      Key: { sessionId },
      ConsistentRead: true, // Avoid stale reads after session updates
    });

    try {
      const result = await docClient.send(command);
      const record = result.Item as EncryptedSessionRecord | undefined;

      if (!record) {
        // Session not found
        return null;
      }

      // Check TTL in application code (DynamoDB TTL has up to 48h delay)
      const now = Math.floor(Date.now() / 1000);
      if (record.ttl <= now) {
        // Session expired, treat as not found
        console.warn(`[SessionStore] Session ${sessionId} expired (TTL: ${record.ttl}, now: ${now})`);
        return null;
      }

      // Decrypt the session data
      const decryptedJson = await decryptSessionData(
        record.encryptedData,
        record.encryptedKey,
        record.iv,
        record.authTag
      );

      return JSON.parse(decryptedJson);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.warn(`[SessionStore] Failed to retrieve session ${sessionId}: ${message}`);
      throw error;
    }
  }

  /**
   * Internal async implementation of set.
   */
  private async setAsync(sessionId: string, session: any): Promise<void> {
    // Serialize session to JSON
    const sessionJson = JSON.stringify(session);

    // Encrypt the session data
    const encrypted = await encryptSessionData(sessionJson);

    // Calculate TTL
    const ttl = Math.floor(Date.now() / 1000) + this.ttlSeconds;

    // Build the record
    const record: EncryptedSessionRecord = {
      sessionId,
      encryptedData: encrypted.encryptedData,
      encryptedKey: encrypted.encryptedKey,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      ttl,
      version: ENCRYPTION_VERSION,
    };

    const command = new PutCommand({
      TableName: this.tableName,
      Item: record,
    });

    try {
      await docClient.send(command);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.warn(`[SessionStore] Failed to store session ${sessionId}: ${message}`);
      throw error;
    }
  }

  /**
   * Internal async implementation of destroy.
   */
  private async destroyAsync(sessionId: string): Promise<void> {
    const command = new DeleteCommand({
      TableName: this.tableName,
      Key: { sessionId },
    });

    try {
      await docClient.send(command);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.warn(`[SessionStore] Failed to delete session ${sessionId}: ${message}`);
      throw error;
    }
  }
}
