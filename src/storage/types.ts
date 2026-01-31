/**
 * TypeScript types for encrypted session storage.
 */

/**
 * Record stored in DynamoDB for an encrypted session.
 * Includes all components needed for envelope decryption.
 */
export interface EncryptedSessionRecord {
  /** Session identifier (partition key) */
  sessionId: string;
  /** AES-256-GCM encrypted session data (base64) */
  encryptedData: string;
  /** KMS-encrypted data encryption key (base64) */
  encryptedKey: string;
  /** Initialization vector for AES-GCM (base64) */
  iv: string;
  /** Authentication tag from AES-GCM (base64) */
  authTag: string;
  /** Unix timestamp for TTL-based expiration */
  ttl: number;
  /** Encryption schema version for future migrations */
  version: number;
}

/**
 * Configuration for the DynamoDB session store.
 */
export interface SessionStoreConfig {
  /** DynamoDB table name */
  tableName?: string;
  /** Session TTL in seconds (default: 604800 = 7 days) */
  ttlSeconds?: number;
  /** KMS key ARN for envelope encryption */
  kmsKeyArn?: string;
}

/**
 * Result of encrypting session data.
 * All binary data is base64 encoded for storage.
 */
export interface EncryptionResult {
  /** AES-256-GCM encrypted data (base64) */
  encryptedData: string;
  /** KMS-encrypted data encryption key (base64) */
  encryptedKey: string;
  /** Initialization vector (base64) */
  iv: string;
  /** GCM authentication tag (base64) */
  authTag: string;
}
