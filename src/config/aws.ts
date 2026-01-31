/**
 * AWS client configuration for KMS and DynamoDB.
 * Clients are created once at module scope to avoid per-request instantiation overhead.
 *
 * Uses AWS SDK default credential chain (environment variables, IAM role, etc.)
 */

import { KMSClient } from '@aws-sdk/client-kms';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

// AWS region configuration
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

// KMS key ARN - can be overridden via environment variable for different environments
export const KMS_KEY_ARN = process.env.KMS_KEY_ARN ||
  'arn:aws:kms:us-east-1:232282424912:key/afd7365b-7a3a-4ae6-97a6-3dcd0ec9a94a';

// DynamoDB table name - can be overridden via environment variable
export const SESSIONS_TABLE = process.env.SESSIONS_TABLE || 'mcp-gateway-sessions';

// KMS client for envelope encryption
export const kmsClient = new KMSClient({ region: AWS_REGION });

// DynamoDB client with document client wrapper for easier item operations
const dynamoClient = new DynamoDBClient({ region: AWS_REGION });
export const docClient = DynamoDBDocumentClient.from(dynamoClient, {
  marshallOptions: {
    removeUndefinedValues: true,
  },
});
