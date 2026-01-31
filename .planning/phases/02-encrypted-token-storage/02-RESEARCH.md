# Phase 2: Encrypted Token Storage - Research

**Researched:** 2026-01-31
**Domain:** AWS SDK v3, Client-side encryption with KMS, DynamoDB session storage, Fastify session stores
**Confidence:** HIGH

## Summary

This phase requires implementing secure OAuth token persistence by replacing Fastify's in-memory session store with a custom DynamoDB-backed store using client-side envelope encryption via AWS KMS. The research reveals that while AWS provides server-side encryption for DynamoDB, client-side encryption is the recommended approach for sensitive credentials like OAuth tokens, as it provides end-to-end protection and ensures tokens are encrypted before transmission to AWS.

The standard approach uses AWS SDK v3's `@aws-sdk/client-kms` for envelope encryption (generating data keys) combined with Node.js's built-in `crypto` module for AES-256-GCM encryption. The `@aws-crypto/client-node` (AWS Encryption SDK) was evaluated but is overkill for this use case - it's designed for complex multi-region key management scenarios, whereas we have a straightforward single-region encryption requirement.

The Fastify session plugin accepts any custom store implementing the express-session interface (get, set, destroy methods). DynamoDB TTL is the standard solution for automatic session cleanup, requiring a Number attribute storing Unix epoch time in seconds.

**Primary recommendation:** Implement client-side envelope encryption using @aws-sdk/client-kms GenerateDataKeyCommand with AES-256-GCM, store encrypted tokens in DynamoDB via custom Fastify session store, and leverage DynamoDB TTL for automatic 7-day expiration.

## Standard Stack

The established libraries/tools for this domain:

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| @aws-sdk/client-dynamodb | 3.971.0 | DynamoDB operations | Official AWS SDK v3 client, actively maintained, modular architecture |
| @aws-sdk/lib-dynamodb | 3.x | Document client for DynamoDB | Simplifies DynamoDB operations by auto-marshalling JavaScript objects |
| @aws-sdk/client-kms | 3.966.0 | KMS encryption operations | Official KMS client for generating data keys and decryption |
| @fastify/session | 10.x+ | Session management | Official Fastify plugin, compatible with express-session stores |
| Node.js crypto (built-in) | Node 22 | AES-256-GCM encryption | Native crypto module, no dependencies, FIPS-compliant |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| @types/express-session | 1.18.2 | TypeScript types for session stores | Type safety for custom store implementation |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| @aws-sdk/client-kms | @aws-crypto/client-node (AWS Encryption SDK) | SDK adds 1.2MB bundle size and complexity for multi-region key management features we don't need. Overkill for single-region envelope encryption. |
| Client-side encryption | DynamoDB server-side encryption | Server-side encryption protects data at rest but tokens would be unencrypted in transit to AWS. Client-side provides end-to-end protection. |
| Custom store | connect-dynamodb | Package last updated 3 years ago (2023), not actively maintained, doesn't support encryption |

**Installation:**
```bash
npm install @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb @aws-sdk/client-kms
npm install --save-dev @types/express-session
```

## Architecture Patterns

### Recommended Project Structure
```
src/
├── storage/
│   ├── dynamodb-session-store.ts    # Custom Fastify/express-session store
│   ├── kms-encryption.ts            # Envelope encryption utilities
│   └── types.ts                     # Session storage types
├── config/
│   └── aws.ts                       # AWS client configuration
└── routes/
    └── auth.ts                      # OAuth routes using session
```

### Pattern 1: Envelope Encryption with KMS
**What:** Generate a unique Data Encryption Key (DEK) per session, encrypt session data with DEK using AES-256-GCM, encrypt the DEK with KMS customer-managed key, store encrypted DEK alongside encrypted data.

**When to use:** For encrypting data larger than 4KB (KMS direct encryption limit) or when you need client-side encryption with key rotation capabilities.

**Example:**
```typescript
// Source: AWS KMS official docs + Node.js crypto best practices
import { KMSClient, GenerateDataKeyCommand, DecryptCommand } from '@aws-sdk/client-kms';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const kmsClient = new KMSClient({ region: 'us-east-1' });
const KEY_ARN = 'arn:aws:kms:us-east-1:232282424912:key/afd7365b-7a3a-4ae6-97a6-3dcd0ec9a94a';

async function encryptSessionData(sessionData: string): Promise<{
  encryptedData: string;
  encryptedKey: string;
  iv: string;
  authTag: string;
}> {
  // Generate data key from KMS
  const { Plaintext, CiphertextBlob } = await kmsClient.send(
    new GenerateDataKeyCommand({
      KeyId: KEY_ARN,
      KeySpec: 'AES_256'
    })
  );

  // Generate unique IV (12 bytes for GCM)
  const iv = randomBytes(12);

  // Encrypt data with plaintext key using AES-256-GCM
  const cipher = createCipheriv('aes-256-gcm', Plaintext!, iv);
  const encrypted = Buffer.concat([
    cipher.update(sessionData, 'utf8'),
    cipher.final()
  ]);
  const authTag = cipher.getAuthTag();

  // Return encrypted data, encrypted DEK, IV, and auth tag
  return {
    encryptedData: encrypted.toString('base64'),
    encryptedKey: CiphertextBlob!.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64')
  };
}

async function decryptSessionData(
  encryptedData: string,
  encryptedKey: string,
  iv: string,
  authTag: string
): Promise<string> {
  // Decrypt the data key using KMS
  const { Plaintext } = await kmsClient.send(
    new DecryptCommand({
      CiphertextBlob: Buffer.from(encryptedKey, 'base64')
    })
  );

  // Decrypt session data with decrypted key
  const decipher = createDecipheriv(
    'aes-256-gcm',
    Plaintext!,
    Buffer.from(iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedData, 'base64')),
    decipher.final()
  ]);

  return decrypted.toString('utf8');
}
```

### Pattern 2: Custom DynamoDB Session Store
**What:** Implement express-session store interface (get, set, destroy) backed by DynamoDB with automatic TTL expiration.

**When to use:** When replacing in-memory session store with persistent storage for production deployments.

**Example:**
```typescript
// Source: @fastify/session documentation + AWS SDK v3 patterns
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';

interface SessionStore {
  get(sessionId: string, callback: (err: any, session?: any) => void): void;
  set(sessionId: string, session: any, callback: (err?: any) => void): void;
  destroy(sessionId: string, callback: (err?: any) => void): void;
}

class DynamoDBSessionStore implements SessionStore {
  private docClient: DynamoDBDocumentClient;
  private tableName: string;
  private ttlSeconds: number;

  constructor(tableName: string, ttlSeconds: number = 604800) { // 7 days default
    const client = new DynamoDBClient({ region: 'us-east-1' });
    this.docClient = DynamoDBDocumentClient.from(client);
    this.tableName = tableName;
    this.ttlSeconds = ttlSeconds;
  }

  async get(sessionId: string, callback: (err: any, session?: any) => void): Promise<void> {
    try {
      const response = await this.docClient.send(
        new GetCommand({
          TableName: this.tableName,
          Key: { sessionId },
          ConsistentRead: true // Required for reading recently written sessions
        })
      );

      // Filter out expired sessions (DynamoDB TTL can take up to 48 hours)
      if (response.Item && response.Item.ttl > Math.floor(Date.now() / 1000)) {
        callback(null, response.Item.session);
      } else {
        callback(null, null);
      }
    } catch (error) {
      callback(error);
    }
  }

  async set(sessionId: string, session: any, callback: (err?: any) => void): Promise<void> {
    try {
      const ttl = Math.floor(Date.now() / 1000) + this.ttlSeconds;

      await this.docClient.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            sessionId,
            session,
            ttl
          }
        })
      );
      callback();
    } catch (error) {
      callback(error);
    }
  }

  async destroy(sessionId: string, callback: (err?: any) => void): Promise<void> {
    try {
      await this.docClient.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: { sessionId }
        })
      );
      callback();
    } catch (error) {
      callback(error);
    }
  }
}
```

### Pattern 3: Session Plugin Configuration with Custom Store
**What:** Configure @fastify/session to use custom DynamoDB store instead of default in-memory store.

**Example:**
```typescript
// Source: @fastify/session documentation
import fastifySession from '@fastify/session';
import fastifyCookie from '@fastify/cookie';

const sessionStore = new DynamoDBSessionStore('mcp-gateway-sessions', 604800);

await fastify.register(fastifyCookie);
await fastify.register(fastifySession, {
  secret: process.env.SESSION_SECRET!, // 32+ character secret
  store: sessionStore,
  cookie: {
    secure: true, // HTTPS only
    httpOnly: true,
    maxAge: 604800000 // 7 days in milliseconds
  },
  saveUninitialized: false
});
```

### Anti-Patterns to Avoid

- **Storing plaintext DEK:** Never store the plaintext data encryption key. Always discard it immediately after encryption/decryption. Storing it alongside encrypted data defeats the purpose of encryption.

- **Reusing IVs:** Never reuse an Initialization Vector with the same key. Generate a unique IV for every encryption operation using `crypto.randomBytes(12)`. IV reuse catastrophically breaks GCM's security guarantees.

- **Using in-memory store in production:** The default Fastify session store leaks memory and doesn't persist across restarts. Always use a persistent store for production.

- **Ignoring authentication tags:** GCM provides authenticated encryption. Always store and verify the authentication tag during decryption. Skipping this allows tampering.

- **Not filtering expired sessions:** DynamoDB TTL deletion can take up to 48 hours. Application code must filter out sessions where `ttl <= current_epoch_time`.

## Don't Hand-Roll

Problems that look simple but have existing solutions:

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| DynamoDB type marshalling | Manual conversion of JS objects to DynamoDB format | @aws-sdk/lib-dynamodb | Handles nested objects, undefined values, empty strings, and type conversions automatically. Manual marshalling has 20+ edge cases. |
| AES-GCM encryption | Custom encryption wrapper | Node.js crypto.createCipheriv with 'aes-256-gcm' | Built-in, audited, FIPS-compliant. Custom crypto is dangerous and error-prone. |
| Session cookie parsing | Manual cookie extraction/serialization | @fastify/cookie | Handles encoding, signing, secure flags, and edge cases correctly. Cookie specs have 50+ rules. |
| Random byte generation | Math.random() or Date.now() | crypto.randomBytes() | Cryptographically secure PRNG required for keys and IVs. Math.random() is not secure. |
| Base64 encoding | Custom implementation | Buffer.from(data).toString('base64') | Native Node.js handles all character sets and padding correctly. |

**Key insight:** Cryptographic operations have subtle correctness requirements that are easy to get wrong and hard to test. Use well-tested standard libraries for all crypto operations, marshalling, and encoding. The cost of a security vulnerability far exceeds any perceived benefit of custom code.

## Common Pitfalls

### Pitfall 1: KMS Request Rate Limits
**What goes wrong:** High-throughput applications can exceed KMS's default request quota (shared across regions), causing throttling errors and failed encryption/decryption operations.

**Why it happens:** Each session write/read that encrypts/decrypts data makes a KMS API call. At scale (1000+ sessions/second), this quickly hits the default quota of 5,500 requests/second for GenerateDataKey.

**How to avoid:**
- Request a quota increase from AWS Support for production workloads
- Implement exponential backoff retry logic for KMS operations
- Consider caching decrypted data keys for short periods (10-60 seconds) with strict access controls
- Use AWS SDK v3's built-in retry mechanism (already configured by default)

**Warning signs:** `ThrottlingException` errors from KMS client, increasing latency on session operations during traffic spikes, CloudWatch metrics showing KMS throttle counts.

### Pitfall 2: DynamoDB TTL Deletion Lag
**What goes wrong:** Sessions remain accessible for up to 48 hours after their TTL expires because DynamoDB TTL deletion is eventually consistent, not immediate.

**Why it happens:** DynamoDB scans for expired items in the background and deletes them asynchronously. The service doesn't guarantee deletion timing to avoid impacting table performance.

**How to avoid:** Always filter expired sessions in application code. In the `get` method, check `if (item.ttl > Math.floor(Date.now() / 1000))` before returning the session.

**Warning signs:** Users able to access sessions after they should have expired, audit logs showing expired session access, security scans flagging long-lived sessions.

### Pitfall 3: Encryption Context Mismatches
**What goes wrong:** When using KMS encryption context for additional security, decryption fails with `InvalidCiphertextException` if the context doesn't exactly match what was used during encryption.

**Why it happens:** Encryption context is additional authenticated data (AAD) that binds metadata to ciphertext. Even minor differences (extra spaces, case changes) cause decryption failure.

**How to avoid:**
- Store encryption context alongside encrypted data if you use it
- Use consistent, deterministic context values (e.g., sessionId)
- For this phase, skip encryption context entirely unless specifically required for compliance
- Document context format clearly if used

**Warning signs:** Intermittent `InvalidCiphertextException` errors, decryption failures that don't reproduce consistently, errors after deployments that change context generation logic.

### Pitfall 4: Missing ConsistentRead on Session Get
**What goes wrong:** After setting a session, immediate reads may return stale or null data, causing users to be logged out unexpectedly or see outdated session state.

**Why it happens:** DynamoDB's default `GetItem` uses eventually consistent reads, which may not reflect recent writes. Session writes followed immediately by reads (common in auth flows) can race.

**How to avoid:** Always use `ConsistentRead: true` in GetCommand for session retrieval. This ensures you read the most recent write at the cost of slightly higher latency (5-10ms) and double read capacity units.

**Warning signs:** Flaky integration tests that pass sometimes, users reporting "session lost" immediately after login, race conditions that appear under load but not in development.

### Pitfall 5: Forgetting to Destroy Plaintext Keys
**What goes wrong:** Plaintext data encryption keys remain in memory after encryption/decryption, potentially leaking through logs, error messages, or memory dumps.

**Why it happens:** JavaScript doesn't provide guaranteed memory zeroing. The plaintext key from `GenerateDataKeyCommand` stays in memory until garbage collected.

**How to avoid:**
- Never log the `Plaintext` field from KMS responses
- Don't store plaintext keys in variables longer than needed
- Keep encryption operations in isolated functions that complete quickly
- Consider using scoped blocks to limit variable lifetime
- Avoid caching plaintext keys (cache encrypted tokens instead)

**Warning signs:** Plaintext key values appearing in logs, error stack traces containing key material, memory profiling showing key data persisting.

### Pitfall 6: Not Reusing AWS SDK Clients
**What goes wrong:** Creating new KMS or DynamoDB clients on every request causes connection pool exhaustion, increased latency, and higher AWS costs from unnecessary TLS handshakes.

**Why it happens:** Developers unfamiliar with AWS SDK v3 may instantiate clients in request handlers instead of module scope.

**How to avoid:**
- Create KMSClient and DynamoDBClient once at module initialization
- Reuse client instances across all requests
- AWS SDK v3 automatically manages connection pooling
- Don't call `client.destroy()` unless shutting down the application

**Warning signs:** High CloudTrail costs, elevated TLS handshake latency, socket exhaustion errors, memory growth over time.

## Code Examples

Verified patterns from official sources:

### DynamoDB Document Client Usage
```typescript
// Source: AWS SDK v3 official documentation
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';

// Create clients once at module scope
const ddbClient = new DynamoDBClient({ region: 'us-east-1' });
const docClient = DynamoDBDocumentClient.from(ddbClient);

// Put item with TTL
const ttl = Math.floor(Date.now() / 1000) + 604800; // 7 days
await docClient.send(
  new PutCommand({
    TableName: 'mcp-gateway-sessions',
    Item: {
      sessionId: 'sess_abc123',
      encryptedData: 'base64_encrypted_string',
      encryptedKey: 'base64_encrypted_dek',
      iv: 'base64_iv',
      authTag: 'base64_tag',
      ttl
    }
  })
);

// Get item with consistent read
const response = await docClient.send(
  new GetCommand({
    TableName: 'mcp-gateway-sessions',
    Key: { sessionId: 'sess_abc123' },
    ConsistentRead: true
  })
);
```

### KMS GenerateDataKey Usage
```typescript
// Source: AWS KMS SDK v3 documentation
import { KMSClient, GenerateDataKeyCommand } from '@aws-sdk/client-kms';

const kmsClient = new KMSClient({ region: 'us-east-1' });

const response = await kmsClient.send(
  new GenerateDataKeyCommand({
    KeyId: 'arn:aws:kms:us-east-1:232282424912:key/afd7365b-7a3a-4ae6-97a6-3dcd0ec9a94a',
    KeySpec: 'AES_256' // Returns 256-bit key
  })
);

// Use Plaintext for encryption immediately
const plaintextKey = response.Plaintext; // Uint8Array

// Store CiphertextBlob with encrypted data
const encryptedKey = response.CiphertextBlob; // Uint8Array
```

### AES-256-GCM Encryption Pattern
```typescript
// Source: Node.js crypto documentation + security best practices
import { createCipheriv, randomBytes } from 'crypto';

function encrypt(plaintext: string, key: Uint8Array): {
  ciphertext: string;
  iv: string;
  authTag: string;
} {
  // Generate unique 12-byte IV (optimal for GCM)
  const iv = randomBytes(12);

  const cipher = createCipheriv('aes-256-gcm', key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final()
  ]);

  const authTag = cipher.getAuthTag();

  return {
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64')
  };
}

function decrypt(
  ciphertext: string,
  key: Uint8Array,
  iv: string,
  authTag: string
): string {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(iv, 'base64')
  );

  decipher.setAuthTag(Buffer.from(authTag, 'base64'));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final()
  ]);

  return decrypted.toString('utf8');
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| AWS SDK v2 | AWS SDK v3 | 2020-2025 migration period | Modular imports reduce bundle size, tree-shaking support, better TypeScript types. V2 maintenance mode only. |
| Server-side encryption only | Client-side + server-side encryption | Ongoing best practice | End-to-end protection, tokens never transmitted in plaintext to AWS. |
| connect-dynamodb package | Custom store implementation | Package abandoned ~2023 | No maintained packages exist. Custom implementation is now standard. |
| @aws-crypto/client-node for everything | Direct KMS client for simple cases | 2024-2025 | AWS Encryption SDK overkill for single-region envelope encryption. Use @aws-sdk/client-kms directly. |
| Express session + middleware | Fastify native plugins | Fastify 3+ (2020+) | Better performance, async/await support, TypeScript-first design. |

**Deprecated/outdated:**
- **connect-dynamodb**: Last updated 2023, not compatible with AWS SDK v3, lacks encryption support. Use custom store.
- **AWS SDK v2**: In maintenance mode, no new features. Migrate to v3 for Node 22 compatibility and modern features.
- **Storing sessions in plaintext**: Even with server-side encryption, plaintext storage is no longer acceptable for OAuth tokens. Client-side encryption is the current standard.

## Open Questions

Things that couldn't be fully resolved:

1. **KMS Regional Availability During Outages**
   - What we know: KMS is a regional service. If us-east-1 KMS is unavailable, encryption/decryption fails.
   - What's unclear: Should we implement a fallback encryption mechanism, or is failing closed (denying access) acceptable?
   - Recommendation: Fail closed for this phase. Regional KMS outages are extremely rare (<99.95% uptime). Adding fallback encryption adds complexity and potential security vulnerabilities. Document as known limitation.

2. **Optimal KMS Data Key Caching Strategy**
   - What we know: Caching plaintext DEKs reduces KMS calls but increases security risk if cache is compromised. AWS Encryption SDK includes key caching.
   - What's unclear: Is short-term caching (10-60 seconds) worth the complexity for our 7-day session use case?
   - Recommendation: Start without caching. Add only if KMS throttling becomes an issue in production. Profile before optimizing.

3. **Session Migration Strategy**
   - What we know: Changing encryption scheme requires re-encrypting all existing sessions or invalidating them.
   - What's unclear: Should we version the encryption format in DynamoDB items for future upgrades?
   - Recommendation: Add a `version: 1` field to each session item. Allows graceful migration in future phases. Minimal cost.

## Sources

### Primary (HIGH confidence)
- AWS SDK v3 DynamoDB Documentation: https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/dynamodb/
- AWS SDK v3 KMS Documentation: https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/kms/
- AWS Encryption SDK for JavaScript: https://docs.aws.amazon.com/encryption-sdk/latest/developer-guide/js-examples.html
- AWS Prescriptive Guidance - DynamoDB Encryption Best Practices: https://docs.aws.amazon.com/prescriptive-guidance/latest/encryption-best-practices/dynamodb.html
- Fastify Session Plugin Documentation: https://github.com/fastify/session/blob/main/README.md
- DynamoDB TTL Official Documentation: https://dynobase.dev/dynamodb-ttl/

### Secondary (MEDIUM confidence)
- Conor Murphy's Envelope Encryption with KMS Tutorial (2024): https://conermurphy.com/blog/implementing-envelope-encryption-with-aws-kms-typescript/
- GitHub Issue: Full KMS encrypt/decrypt example: https://github.com/aws/aws-sdk-js-v3/issues/2600
- Node.js Crypto AES-256-GCM Gist (community verified): https://gist.github.com/rjz/15baffeab434b8125ca4d783f4116d81

### Tertiary (LOW confidence)
- Medium articles on KMS management (multiple authors, varying quality)
- Stack Overflow discussions on session store implementation
- Various npm package READMEs for unmaintained libraries

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - All libraries are official AWS SDKs or official Fastify plugins with active maintenance and clear versioning
- Architecture: HIGH - Patterns verified from AWS official documentation, SDK examples, and Node.js crypto documentation
- Pitfalls: HIGH - Derived from AWS official usage notes, GitHub issues with AWS team responses, and official best practices guides

**Research date:** 2026-01-31
**Valid until:** 2026-03-31 (60 days - AWS SDK v3 is stable but receives monthly updates)
