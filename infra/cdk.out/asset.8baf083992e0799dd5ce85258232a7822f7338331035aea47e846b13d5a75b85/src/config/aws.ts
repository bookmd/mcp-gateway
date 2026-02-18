/**
 * AWS client configuration for KMS and DynamoDB.
 * Clients are created once at module scope to avoid per-request instantiation overhead.
 *
 * In production (ECS Fargate), uses task role credentials automatically.
 * In local dev, can use AssumeRole if needed via environment variables.
 */

import { KMSClient } from '@aws-sdk/client-kms';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { fromTemporaryCredentials } from '@aws-sdk/credential-providers';

// AWS region configuration
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

// Vim IT Corp account
const VIM_ACCOUNT_ID = '232282424912';

// Only use AssumeRole if explicitly configured (for local dev)
const AWS_ROLE_ARN = process.env.AWS_ROLE_ARN;

// KMS key ARN - can be overridden via environment variable for different environments
export const KMS_KEY_ARN = process.env.KMS_KEY_ARN ||
  `arn:aws:kms:${AWS_REGION}:${VIM_ACCOUNT_ID}:key/afd7365b-7a3a-4ae6-97a6-3dcd0ec9a94a`;

// DynamoDB table name - can be overridden via environment variable
export const SESSIONS_TABLE = process.env.SESSIONS_TABLE || 
  process.env.DYNAMODB_TABLE_NAME || 
  'mcp-gateway-sessions';

// Create credential provider (uses AssumeRole if configured, otherwise default)
const getCredentials = () => {
  if (AWS_ROLE_ARN) {
    console.log(`[AWS] Using AssumeRole: ${AWS_ROLE_ARN}`);
    return fromTemporaryCredentials({
      params: {
        RoleArn: AWS_ROLE_ARN,
        RoleSessionName: 'mcp-gateway-session',
        DurationSeconds: 3600,
      },
      clientConfig: { region: AWS_REGION },
    });
  }
  // In production (ECS), use default credentials (task role)
  return undefined;
};

const credentials = getCredentials();

// KMS client for envelope encryption
export const kmsClient = new KMSClient({ 
  region: AWS_REGION,
  credentials,
});

// DynamoDB client
const dynamoClient = new DynamoDBClient({ 
  region: AWS_REGION,
  credentials,
});

export const docClient = DynamoDBDocumentClient.from(dynamoClient, {
  marshallOptions: {
    removeUndefinedValues: true,
  },
});
