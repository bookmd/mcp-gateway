/**
 * KMS envelope encryption for session data.
 * Uses AES-256-GCM with KMS-managed data encryption keys.
 *
 * Pattern: Envelope encryption
 * 1. Request a new data key from KMS (returns plaintext + encrypted versions)
 * 2. Encrypt data locally with plaintext key using AES-256-GCM
 * 3. Discard plaintext key, store encrypted key with data
 * 4. To decrypt: use KMS to decrypt the key, then decrypt data locally
 */

import * as crypto from 'crypto';
import { GenerateDataKeyCommand, DecryptCommand } from '@aws-sdk/client-kms';
import { kmsClient, KMS_KEY_ARN } from '../config/aws.js';
import type { EncryptionResult } from './types.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM standard IV length

/**
 * Encrypt session data using envelope encryption with KMS.
 *
 * @param sessionData - JSON string of session data to encrypt
 * @returns EncryptionResult with all components base64 encoded
 * @throws Error if KMS call fails or encryption fails
 */
export async function encryptSessionData(sessionData: string): Promise<EncryptionResult> {
  // Generate a unique data encryption key from KMS
  const generateKeyCommand = new GenerateDataKeyCommand({
    KeyId: KMS_KEY_ARN,
    KeySpec: 'AES_256',
  });

  let plaintextKey: Uint8Array;
  let encryptedKeyBuffer: Uint8Array;

  try {
    const keyResponse = await kmsClient.send(generateKeyCommand);

    if (!keyResponse.Plaintext || !keyResponse.CiphertextBlob) {
      throw new Error('KMS GenerateDataKey did not return expected key material');
    }

    plaintextKey = keyResponse.Plaintext;
    encryptedKeyBuffer = keyResponse.CiphertextBlob;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`Failed to generate data key from KMS: ${message}`);
  }

  // Generate random IV for AES-GCM (must be unique per encryption)
  const iv = crypto.randomBytes(IV_LENGTH);

  // Encrypt the session data with AES-256-GCM
  const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(plaintextKey), iv);
  const encrypted = Buffer.concat([
    cipher.update(sessionData, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Return all components as base64 strings for storage
  return {
    encryptedData: encrypted.toString('base64'),
    encryptedKey: Buffer.from(encryptedKeyBuffer).toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

/**
 * Decrypt session data using envelope decryption with KMS.
 *
 * @param encryptedData - Base64 encoded encrypted session data
 * @param encryptedKey - Base64 encoded KMS-encrypted data key
 * @param iv - Base64 encoded initialization vector
 * @param authTag - Base64 encoded GCM authentication tag
 * @returns Decrypted session data as string
 * @throws Error if KMS decryption fails or data integrity check fails
 */
export async function decryptSessionData(
  encryptedData: string,
  encryptedKey: string,
  iv: string,
  authTag: string
): Promise<string> {
  // Decrypt the data encryption key using KMS
  const decryptKeyCommand = new DecryptCommand({
    KeyId: KMS_KEY_ARN,
    CiphertextBlob: Buffer.from(encryptedKey, 'base64'),
  });

  let plaintextKey: Uint8Array;

  try {
    const decryptResponse = await kmsClient.send(decryptKeyCommand);

    if (!decryptResponse.Plaintext) {
      throw new Error('KMS Decrypt did not return plaintext key');
    }

    plaintextKey = decryptResponse.Plaintext;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`Failed to decrypt data key from KMS: ${message}`);
  }

  // Decrypt the session data with AES-256-GCM
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    Buffer.from(plaintextKey),
    Buffer.from(iv, 'base64')
  );

  // Set auth tag BEFORE decryption (GCM requirement)
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));

  try {
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encryptedData, 'base64')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch (error) {
    // Auth tag verification or decryption failure
    throw new Error('Session data decryption failed - data may be corrupted or tampered');
  }
}
