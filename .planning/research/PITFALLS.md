# Domain Pitfalls: MCP Gateway with Google OAuth

**Domain:** MCP Gateway with Google Workspace APIs and OAuth
**Researched:** 2026-01-31
**Confidence:** MEDIUM-HIGH (verified with official docs and 2026 community sources)

## Critical Pitfalls

Mistakes that cause security breaches, rewrites, or production incidents.

### Pitfall 1: Insufficient Redirect URI Validation
**What goes wrong:** Attackers manipulate redirect URIs to steal authorization codes, leading to account takeover. In July 2025, malicious OAuth applications exploited this pattern to breach Allianz Life's Salesforce, exposing 1.1 million customer records.

**Why it happens:** Developers use wildcards, dynamic redirects, or client-side validation only. AWS deployments make this worse because ECS task URLs change, tempting developers to use patterns like `*.amazonaws.com`.

**Consequences:**
- Authorization codes redirected to attacker-controlled domains
- Complete account takeover (access to Gmail, Drive, Calendar, Docs)
- Regulatory violations (HIPAA, GDPR) if workspace contains PHI/PII
- Domain reputation damage if Google flags your OAuth app

**Prevention:**
- Whitelist exact redirect URIs in Google Cloud Console (no wildcards)
- Use a stable domain (e.g., `gateway.yourdomain.com`) pointed at ALB, not ECS task IPs
- Server-side validation: match received `redirect_uri` against whitelist before processing
- For development: separate OAuth client with localhost redirects, never reuse in production

**Detection:**
- Monitor redirect_uri parameters in OAuth initiation logs for unexpected values
- Google Cloud Console audit logs show redirect_uri configuration changes
- Spike in OAuth failures with redirect_uri_mismatch errors indicates probing

**Phase impact:** Must be addressed in Phase 1 (OAuth Implementation). Non-negotiable security requirement.

**Sources:**
- [OAuth 2.0 Common Security Flaws | APIsec](https://www.apisec.ai/blog/oauth-2-0-common-security-flaws)
- [Common Security Issues in OAuth 2.0 | HackerOne](https://www.hackerone.com/blog/common-security-issues-implementing-oauth-20-and-how-mitigate-them)

---

### Pitfall 2: Missing or Broken PKCE Implementation
**What goes wrong:** Authorization codes intercepted in transit can be exchanged for access tokens. Without PKCE (Proof Key for Code Exchange), there's no way to prove the client that initiated the flow is the one exchanging the code.

**Why it happens:** OAuth 2.0 originally didn't require PKCE. Developers following old tutorials or using outdated libraries skip it. OAuth 2.1 (standardized Jan 2025) makes PKCE mandatory, but migration is incomplete.

**Consequences:**
- Authorization code interception attacks succeed
- Mobile/desktop clients particularly vulnerable (can't keep client secret)
- Fails security audits for 2026 compliance standards

**Prevention:**
- Use OAuth 2.1-compliant libraries (google-auth-library >=9.0 for Node.js)
- Generate cryptographically random `code_verifier` (43-128 chars, URL-safe)
- Send SHA256 hash as `code_challenge` with `code_challenge_method=S256`
- Verify code_verifier matches on token exchange server-side
- Never use `code_challenge_method=plain` (defeats the purpose)

**Detection:**
- Check OAuth logs: every authorization request should include `code_challenge`
- Every token exchange should include `code_verifier`
- Missing either = vulnerable flow

**Phase impact:** Phase 1 (OAuth Implementation). Blocking issue for Cursor integration.

**Sources:**
- [OAuth 2.0 Security Best Practices (RFC 9700)](https://datatracker.ietf.org/doc/rfc9700/)
- [OAuth Best Practices | WorkOS](https://workos.com/blog/oauth-best-practices)

---

### Pitfall 3: State Parameter CSRF Vulnerability
**What goes wrong:** Attackers trick users into authorizing attacker's account with victim's credentials (CSRF attack). User thinks they're logging into their own account but authorizes access to attacker's Gmail/Drive.

**Why it happens:** Missing state parameter, reusing state across sessions, or not validating state on callback. SSE-based MCP servers make this worse—each SSE connection needs isolated state.

**Consequences:**
- Attacker gains access to victim's Google Workspace data
- Victim unknowingly performs actions on attacker's behalf
- Cross-user data leakage in multi-tenant gateway

**Prevention:**
- Generate cryptographically random state (32+ bytes) per OAuth flow
- Store state server-side tied to session (DynamoDB: `sessionId -> {state, userId, timestamp}`)
- Validate state on callback matches stored value, then immediately delete
- Expire state after 10 minutes (Google auth flows shouldn't take longer)
- For SSE: bind state to SSE connection ID to prevent cross-connection attacks

**Detection:**
- Failed state validation = potential CSRF attempt, log with IP/user-agent
- Multiple failed validations from same IP = block temporarily
- State reuse detected = security incident (investigate compromised session store)

**Phase impact:** Phase 1 (OAuth Implementation). Must implement before multi-user support.

**Sources:**
- [OAuth 2.0 authentication vulnerabilities | PortSwigger](https://portswigger.net/web-security/oauth)
- [Common OAuth2 implementation mistakes | MojoAuth](https://mojoauth.com/ciam-qna/oauth2-implementation-mistakes-security-vulnerabilities)

---

### Pitfall 4: Insecure Token Storage (Plaintext in DynamoDB)
**What goes wrong:** Refresh tokens stored in plaintext get exfiltrated via DynamoDB backup, CloudTrail logs, or compromised credentials. Single breach exposes all user tokens permanently.

**Consequences:**
- Attacker gains persistent access to all users' Google Workspace data
- Breach persists until users manually revoke (most never will)
- Compliance violations: GDPR Art. 32 requires encryption of personal data
- Google may suspend your OAuth app if notified of plaintext token storage

**Prevention:**
- **Client-side encryption before DynamoDB write:**
  ```typescript
  // Encrypt refresh token before storing
  const encryptedToken = await kmsClient.encrypt({
    KeyId: 'alias/mcp-gateway-tokens',
    Plaintext: Buffer.from(refreshToken)
  });
  await dynamodb.put({
    TableName: 'Tokens',
    Item: { userId, encryptedToken: encryptedToken.CiphertextBlob }
  });
  ```
- Use AWS KMS customer-managed key (CMK), not AWS-owned key
- Rotate KMS key annually, update CMK policies to prevent developer access in production
- Enable DynamoDB point-in-time recovery with encrypted backups
- Never log decrypted tokens (scrub from CloudWatch, structured logs)

**Detection:**
- IAM Access Analyzer: flag DynamoDB access without KMS decrypt permissions
- CloudWatch metric: KMS decrypt calls should match token read operations
- Zero KMS decrypt calls while tokens being read = plaintext storage

**Phase impact:** Phase 2 (Token Storage). Must be correct from day one; fixing post-launch requires user re-auth.

**Sources:**
- [Storing sensitive information in DynamoDB | AWS re:Post](https://repost.aws/questions/QU5L8z_geET8awMAlz9iFiug/storing-sensitive-information-in-dynamodb)
- [How DynamoDB uses AWS KMS](https://docs.aws.amazon.com/kms/latest/developerguide/services-dynamodb.html)
- [Refresh Token Security | Auth0](https://auth0.com/blog/refresh-tokens-what-are-they-and-when-to-use-them/)

---

### Pitfall 5: Google OAuth Domain Takeover Vulnerability
**What goes wrong:** Google OAuth doesn't protect against domain ownership changes. If your organization domain lapses or is sold, new owners can recreate email addresses and access your OAuth-connected apps.

**Why it happens:** Google OAuth identifies users by email, not immutable IDs. Domain purchase = email ownership = OAuth access.

**Consequences:**
- Former employees regain access by repurchasing lapsed domain
- Acquired companies' domains reassigned to new owners who inherit OAuth access
- SaaS products using "Sign in with Google" vulnerable to this attack vector

**Prevention:**
- **Check domain ownership on every token refresh:**
  ```typescript
  // Verify domain hasn't changed ownership
  const userInfo = await oauth2Client.verifyIdToken({ idToken });
  const currentDomain = userInfo.payload.hd; // hosted domain
  if (currentDomain !== EXPECTED_WORKSPACE_DOMAIN) {
    await revokeAllTokens(userId);
    throw new Error('Domain ownership changed');
  }
  ```
- Store expected workspace domain (`hd` claim) with initial OAuth grant
- For domain-restricted app: validate `hd` claim matches on every request
- Monitor Google Workspace admin console for domain verification changes
- Implement manual re-authentication flow if domain verification status changes

**Detection:**
- Track `hd` claim changes in ID tokens (should never change for legitimate users)
- Alert on domain verification status changes in Google Workspace admin audit logs
- Monitor for sudden increases in OAuth grants from same domain after ownership transfer

**Phase impact:** Phase 1 (OAuth Implementation). Must validate `hd` claim from the start.

**Sources:**
- [Google OAuth is Broken (Sort Of) | Truffle Security](https://trufflesecurity.com/blog/google-oauth-is-broken-sort-of)
- [Millions at Risk: Google's OAuth Flaw | Truffle Security](https://trufflesecurity.com/blog/millions-at-risk-due-to-google-s-oauth-flaw)

---

### Pitfall 6: Token Refresh Race Conditions in Concurrent Requests
**What goes wrong:** Multiple API requests trigger simultaneous token refreshes. First refresh invalidates the refresh token, subsequent refreshes fail with `invalid_grant`. All in-flight requests fail, user sees intermittent errors.

**Why it happens:** MCP gateway handles concurrent tool calls (read Gmail + check Calendar + search Drive). Each detects expired access token, all try to refresh. Google invalidates old refresh token on first successful refresh.

**Consequences:**
- 50%+ request failure rate during token expiration windows
- User confusion: "it works sometimes"
- Support burden: hard to reproduce, looks like infrastructure flakiness
- Degraded user experience, abandonment

**Prevention:**
- **Implement refresh token locking with Redis/DynamoDB:**
  ```typescript
  async function refreshWithLock(userId: string) {
    const lock = await acquireLock(`refresh:${userId}`, ttl: 10000);
    if (!lock.acquired) {
      // Another process is refreshing, wait for it
      await waitForRefresh(userId, timeout: 9000);
      return await getTokenFromCache(userId);
    }
    try {
      const newTokens = await oauth2Client.refreshToken(refreshToken);
      await saveTokens(userId, newTokens);
      return newTokens;
    } finally {
      await lock.release();
    }
  }
  ```
- Queue concurrent requests during refresh, replay after success
- Cache access tokens in-memory (Redis) with 55-min TTL (Google tokens live 60 min)
- Proactive refresh: background job refreshes tokens at 50-min mark, before expiry

**Detection:**
- CloudWatch metric: `invalid_grant` error spike
- Log correlation: multiple refresh attempts for same user within 1 second window
- User session logs: successful request followed by multiple failures

**Phase impact:** Phase 3 (Multi-user Support). Blocking issue for 20-user production deployment.

**Sources:**
- [OAuth token refresh race condition | GitHub Issue](https://github.com/moltbot/moltbot/issues/2036)
- [Handling concurrency with OAuth token refreshes | Nango](https://nango.dev/blog/concurrency-with-oauth-token-refreshes)

---

### Pitfall 7: Google Workspace API Rate Limit Cascades
**What goes wrong:** Single user triggers rate limit (e.g., 250 Gmail reads/sec). Gateway doesn't backoff properly, burns through quota. All users blocked for 60 seconds. Retry storm makes it worse.

**Why it happens:** Google Workspace has per-project AND per-user quotas. MCP agents make rapid API calls. Default retry logic (fixed intervals) amplifies rate limit errors.

**Consequences:**
- Service outage: all 20 users unable to use Gmail/Drive tools for minutes
- Quota exhaustion: daily quota consumed in hours
- Google throttling escalation: repeated violations = reduced quota or app suspension
- Poor UX: Cursor shows "tool failed" with no context

**Prevention:**
- **Implement exponential backoff with jitter:**
  ```typescript
  async function callGoogleAPI(request, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await googleAPI.execute(request);
      } catch (error) {
        if (error.status === 429) { // Rate limit
          const backoff = Math.min(1000 * (2 ** i), 32000); // Max 32s
          const jitter = Math.random() * 1000;
          await sleep(backoff + jitter);
          continue;
        }
        throw error;
      }
    }
    throw new Error('Max retries exceeded');
  }
  ```
- Parse `Retry-After` header from 429 responses, use that value
- Circuit breaker per API: after 5 consecutive 429s, fail fast for 60s
- User-level rate limiting: track per-user quota usage, soft-limit at 80%
- Monitor quota dashboard: alert at 70% daily quota consumption

**Detection:**
- CloudWatch metric: `googleapi_429_errors` per API method
- Quota dashboard (Google Cloud Console): approaching limits
- User reports: "stopped working for everyone at same time"

**Phase impact:** Phase 4 (API Integration). Must implement before load testing.

**Sources:**
- [Usage limits | Gmail API | Google Developers](https://developers.google.com/workspace/gmail/api/reference/quota)
- [Google Workspace Rate Limiting | CloudM](https://support.cloudm.io/hc/en-us/articles/9235927751836-Google-Workspace-Rate-Limiting-Proactive-Prevention-Handling)
- [View & edit quota limits | Google Workspace](https://developers.google.com/workspace/guides/view-edit-quota-limits)

---

### Pitfall 8: SSE Connection Exhaustion on ECS Fargate
**What goes wrong:** Each SSE connection holds open a TCP connection. Fargate tasks have default limit of 1024 file descriptors. 20 users with 5 Cursor windows each = 100 connections. Connection limit hit, new users see "connection refused".

**Why it happens:** SSE is stateful, long-lived. Cursor reconnects on network blips. Zombie connections linger after client crash. No connection pooling.

**Consequences:**
- Gateway becomes unresponsive to new connections
- Existing users experience intermittent disconnections
- AWS CloudWatch shows healthy tasks, but connections timing out
- Requires task restart to clear, causing brief outage

**Prevention:**
- **Configure connection limits and timeouts:**
  - Set SSE keepalive: send comment every 30 seconds, close if no response in 90s
  - Implement connection limit per user: max 10 SSE connections per userId
  - Close oldest connection when limit exceeded (FIFO eviction)
  - Fargate task ulimit: increase file descriptors to 4096 in task definition
  ```json
  "ulimits": [
    {
      "name": "nofile",
      "softLimit": 4096,
      "hardLimit": 8192
    }
  ]
  ```
- Connection tracking: Redis counter per user, decrement on disconnect
- Graceful degradation: return 503 when approaching 90% capacity

**Detection:**
- CloudWatch metric: `active_sse_connections` per task
- Alert: connections > 800 per task (80% of 1024 limit)
- ECS task health check failures correlate with connection spikes

**Phase impact:** Phase 3 (Multi-user Support). Load test reveals this before production.

**Sources:**
- [The Hidden Risks of SSE | Medium](https://medium.com/@2957607810/the-hidden-risks-of-sse-server-sent-events-what-developers-often-overlook-14221a4b3bfe)
- [Server-Sent Events Guide | Medium](https://medium.com/@moali314/server-sent-events-a-comprehensive-guide-e4b15d147576)

---

## Moderate Pitfalls

Mistakes that cause technical debt, delays, or operational pain.

### Pitfall 9: Secrets in ECS Environment Variables (Not Secrets Manager)
**What goes wrong:** OAuth client secrets, KMS key IDs stored as plaintext environment variables in ECS task definition. Task definition versioning in ECS exposes secrets in CloudTrail logs, ECS API describe-task-definition calls, and AWS console.

**Prevention:**
- Use ECS secrets parameter with Secrets Manager ARN:
  ```json
  "secrets": [
    {
      "name": "GOOGLE_CLIENT_SECRET",
      "valueFrom": "arn:aws:secretsmanager:us-east-1:123456789:secret:oauth-client"
    }
  ]
  ```
- Requires Fargate platform version 1.3.0+ for full secret injection
- Grant task execution role `secretsmanager:GetSecretValue` permission
- Rotate secrets via Secrets Manager, redeploy task (new task picks up new value)

**Detection:**
- IAM Access Analyzer: flag task definitions with sensitive env vars
- Manual audit: search task definitions for patterns like `CLIENT_SECRET`, `API_KEY`

**Phase impact:** Phase 2 (Token Storage). Fix before production deploy.

**Sources:**
- [Pass Secrets Manager secrets to ECS | AWS Docs](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/secrets-envvar-secrets-manager.html)
- [Secrets in AWS ECS Fargate | Xebia](https://xebia.com/blog/secrets-in-aws-ecs-fargate/)

---

### Pitfall 10: Missing Observability for OAuth Flows
**What goes wrong:** OAuth failures manifest as "login doesn't work" tickets. No correlation between user report, OAuth state, token refresh attempt, Google API error. Debugging takes hours per incident.

**Prevention:**
- Structured logging with correlation IDs:
  ```typescript
  logger.info('OAuth flow initiated', {
    correlationId,
    userId,
    state,
    scopes: requestedScopes,
    redirectUri
  });
  logger.info('Token refresh attempt', { correlationId, userId, tokenAge });
  logger.error('Token refresh failed', { correlationId, userId, error: err.message });
  ```
- OpenTelemetry tracing: span per OAuth flow (initiate -> callback -> token exchange)
- CloudWatch Insights queries: filter by `correlationId` or `userId` to trace full flow
- Metrics: OAuth success rate, token refresh latency, failure reasons

**Detection:**
- Missing correlation = debugging takes 10x longer
- Plaintext token in logs = security incident (scrub and rotate)

**Phase impact:** Phase 1 (OAuth Implementation). Add logging from the start; retrofit is painful.

**Sources:**
- [OpenTelemetry Tracing | Curity](https://curity.io/resources/learn/opentelemetry-tracing/)
- [Observability in Distributed Systems | Medium](https://medium.com/@jothiprakash888/observability-in-distributed-systems-logs-metrics-and-tracing-d34631170305)

---

### Pitfall 11: Custom OAuth Implementation Instead of Libraries
**What goes wrong:** Developer writes OAuth flow from scratch to "understand how it works" or "avoid dependencies". Subtle bugs (nonce reuse, timing attacks, improper state validation) create security vulnerabilities.

**Prevention:**
- Use `google-auth-library` (official Google OAuth client for Node.js)
- Library handles: PKCE, state generation, token refresh, scope validation
- Security updates via `npm update`, not manual patching
- Google recommends libraries: "Given the security implications of getting the implementation correct, we strongly encourage you to use OAuth 2.0 libraries"

**Detection:**
- Code review: OAuth flow in application code instead of library calls
- Security audit: manual token validation logic = red flag

**Phase impact:** Phase 1 (OAuth Implementation). Use library from day one; refactor later is high risk.

**Sources:**
- [Using OAuth 2.0 to Access Google APIs | Google Developers](https://developers.google.com/identity/protocols/oauth2)
- [OAuth 2.0 Common Security Flaws | APIsec](https://www.apisec.ai/blog/oauth-2-0-common-security-flaws)

---

### Pitfall 12: Ignoring Google Session Control Policies
**What goes wrong:** Organization enables Google Workspace session control (e.g., max session duration 8 hours). Refresh tokens stop working after 8 hours with `invalid_grant` error. Gateway doesn't detect this, user sees "authentication expired" with no re-auth flow.

**Prevention:**
- Handle `invalid_grant` errors: trigger re-authentication flow
- Graceful degradation: show user-friendly message "Please re-authenticate" with OAuth link
- Check session control settings in Google Workspace admin console
- Document: "If your workspace has session limits, users re-auth every X hours"

**Detection:**
- Spike in `invalid_grant` errors at regular intervals (e.g., every 8 hours)
- User reports: "stops working at the same time every day"

**Phase impact:** Phase 3 (Multi-user Support). Impacts enterprises with strict policies.

**Sources:**
- [Using OAuth 2.0 to Access Google APIs | Google Developers](https://developers.google.com/identity/protocols/oauth2)
- [Troubleshoot authentication issues | Google Workspace](https://developers.google.com/workspace/docs/api/troubleshoot-authentication-authorization)

---

### Pitfall 13: Insufficient Scope Validation
**What goes wrong:** Gateway requests broad scopes initially (e.g., `https://www.googleapis.com/auth/gmail.modify`). User authorizes once. Attacker compromises gateway, gains full Gmail access (read, send, delete).

**Prevention:**
- Principle of least privilege: request minimal scopes
  - Read Gmail: `gmail.readonly` not `gmail.modify`
  - Read Drive: `drive.readonly` not `drive` (full access)
- Incremental authorization: request additional scopes only when needed
- Scope validation at resource server: verify token has required scope before API call
- Audit: review granted scopes in Google account permissions page

**Detection:**
- Google Admin Console: review OAuth app scope requests
- User complaints: "why does this need full Gmail access?"

**Phase impact:** Phase 4 (API Integration). Define minimal scopes upfront; changing later requires user re-auth.

**Sources:**
- [OAuth 2.0 Common Security Flaws | APIsec](https://www.apisec.ai/blog/oauth-2-0-common-security-flaws)
- [Restricted scope verification | Google Developers](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)

---

### Pitfall 14: No Token Revocation on Logout/Offboarding
**What goes wrong:** User clicks "logout" in Cursor. Gateway clears local session. Refresh token remains in DynamoDB. Attacker with DB access uses token for persistent access.

**Prevention:**
- Revoke tokens on logout:
  ```typescript
  async function logout(userId: string) {
    const tokens = await getTokens(userId);
    await oauth2Client.revokeToken(tokens.refreshToken);
    await deleteTokens(userId);
  }
  ```
- Revoke on offboarding: admin endpoint to revoke all tokens for departed user
- Token TTL: DynamoDB TTL attribute = auto-delete tokens after 90 days of inactivity
- Google console: users can view/revoke via google.com/permissions

**Detection:**
- Audit: tokens in DB for inactive users (>90 days no API calls)
- Compliance: GDPR right to erasure requires token deletion

**Phase impact:** Phase 3 (Multi-user Support). Required for SOC 2, GDPR compliance.

**Sources:**
- [Refresh Token Rotation | Auth0](https://auth0.com/docs/secure/tokens/refresh-tokens/refresh-token-rotation)
- [OAuth best practices | WorkOS](https://workos.com/blog/oauth-best-practices)

---

## Minor Pitfalls

Mistakes that cause annoyance but are fixable.

### Pitfall 15: MCP Server Logs Writing to stdout (Breaks JSON-RPC)
**What goes wrong:** Debugging logs written to `console.log()` intermix with JSON-RPC messages on stdout. Cursor can't parse responses, shows "MCP server error".

**Prevention:**
- For STDIO transport: write logs to stderr (`console.error()`) or file
- For SSE transport: logs can go to stdout (SSE uses separate HTTP stream)
- Structured logging to CloudWatch: use `winston` or `pino` with CloudWatch transport

**Detection:**
- Cursor error: "Failed to parse MCP response"
- MCP server logs contain JSON-RPC messages intermixed with debug output

**Phase impact:** Phase 1 (MCP Server Setup). Easy to fix, but breaks everything if wrong.

**Sources:**
- [MCP Server Best Practices | CData](https://www.cdata.com/blog/mcp-server-best-practices-2026)
- [Why Your MCP Server Sucks | DEV Community](https://dev.to/aman_kumar_bdd40f1b711c15/why-your-mcp-server-sucks-and-how-to-fix-it-4dkn)

---

### Pitfall 16: No Health Checks for OAuth State
**What goes wrong:** Gateway appears healthy (HTTP 200 on `/health`). OAuth flow broken (invalid client secret, Google API down). Users discover during login attempt.

**Prevention:**
- Enhanced health check:
  ```typescript
  app.get('/health', async (req, res) => {
    const checks = {
      dynamodb: await checkDynamoDB(),
      kms: await checkKMS(),
      googleOAuth: await checkGoogleOAuthConfig(),
      secretsManager: await checkSecretsManager()
    };
    const healthy = Object.values(checks).every(c => c.ok);
    res.status(healthy ? 200 : 503).json(checks);
  });
  ```
- Periodic synthetic test: background job attempts OAuth flow end-to-end (test user)

**Detection:**
- ECS health checks pass, but users report OAuth failures
- Synthetic test failures alert before user impact

**Phase impact:** Phase 5 (Production Readiness). Nice-to-have before launch, critical for on-call.

**Sources:**
- [MCP Server Best Practices | CData](https://www.cdata.com/blog/mcp-server-best-practices-2026)

---

### Pitfall 17: Google OAuth App Verification Status Ignored
**What goes wrong:** OAuth consent screen shows "This app isn't verified". Users hesitate, support tickets increase. Some organizations block unverified apps.

**Prevention:**
- Submit for Google OAuth verification before production launch
- Verification requirements:
  - Privacy policy URL
  - Terms of service URL
  - Domain verification (prove you own the domain)
  - Justification for sensitive/restricted scopes
- Process takes 2-4 weeks, plan accordingly

**Detection:**
- User reports: "Google says this app isn't verified"
- High OAuth abandonment rate (users cancel consent screen)

**Phase impact:** Phase 5 (Production Readiness). Start verification early, blocks launch if missed.

**Sources:**
- [Configure OAuth consent screen | Google Developers](https://developers.google.com/workspace/guides/configure-oauth-consent)
- [Troubleshoot authentication issues | Google Workspace](https://developers.google.com/workspace/docs/api/troubleshoot-authentication-authorization)

---

### Pitfall 18: No Retry Logic for Transient Google API Failures
**What goes wrong:** Google API returns 500 (server error) or 503 (unavailable). Gateway fails request immediately. User sees "tool failed" in Cursor.

**Prevention:**
- Retry 5xx errors with exponential backoff (max 3 retries)
- Don't retry 4xx errors (client errors, won't succeed)
- Circuit breaker: after 10 consecutive failures, fail fast for 60s

**Detection:**
- Spike in 5xx errors from Google APIs
- Users report intermittent failures ("works if I try again")

**Phase impact:** Phase 4 (API Integration). Improves reliability, but not blocking.

**Sources:**
- [Google Workspace Rate Limiting | CloudM](https://support.cloudm.io/hc/en-us/articles/9235927751836-Google-Workspace-Rate-Limiting-Proactive-Prevention-Handling)

---

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|-------------|---------------|------------|
| Phase 1: OAuth Setup | Redirect URI wildcards, missing PKCE, no state validation | Use official library, whitelist exact URIs, validate state server-side |
| Phase 2: Token Storage | Plaintext tokens in DynamoDB, secrets in env vars | Client-side KMS encryption, Secrets Manager integration |
| Phase 3: Multi-user | Token refresh race conditions, connection exhaustion | Redis locking, SSE connection limits, keepalive tuning |
| Phase 4: API Integration | Rate limit cascades, insufficient scope validation | Exponential backoff, circuit breakers, minimal scopes |
| Phase 5: Production Launch | Missing OAuth verification, no observability | Submit verification early, OpenTelemetry tracing, CloudWatch dashboards |

---

## MCP-Specific Security Concerns

### Command Injection via MCP Tools
**Context:** MCP servers expose tools that execute commands. If tool parameters aren't sanitized, attackers inject shell commands.

**Example:** Gmail search tool with unsanitized query (VULNERABLE PATTERN):
```typescript
// VULNERABLE - Never do this
const query = params.searchQuery;
// Using shell commands with user input = command injection risk
```

**Prevention:**
- Never construct shell commands with user input
- Use Google API client libraries (parameterized, not shell commands)
- Validate tool parameters against schema before execution
- Use library methods that don't involve shell execution

**Sources:**
- [MCP Security Survival Guide | Towards Data Science](https://towardsdatascience.com/the-mcp-security-survival-guide-best-practices-pitfalls-and-real-world-lessons/)
- [MCP Servers: Security Nightmare | Equixly](https://equixly.com/blog/2025/03/29/mcp-server-new-security-nightmare/)

---

### Cursor MCP Authentication Patterns
**Context:** Cursor connects to MCP servers via SSE. Authentication must work with Cursor's client flow.

**Pitfall:** Cursor sends credentials in HTTP headers for SSE. If using OAuth, must handle token passing.

**Pattern:**
- Cursor config: `"headers": { "Authorization": "Bearer ${env:MCP_TOKEN}" }`
- Gateway validates bearer token on SSE connection establishment
- Token = OAuth access token (short-lived) or gateway session token

**Phase impact:** Phase 3 (Cursor Integration). Test with real Cursor client early.

**Sources:**
- [Cursor MCP Docs](https://cursor.com/docs/context/mcp)
- [Integrating Google OAuth for MCP SSE | Cursor Forum](https://forum.cursor.com/t/integrating-google-oauth-for-mcp-sse-connections-in-cursor/49189)

---

## Confidence Assessment

**Overall Confidence:** MEDIUM-HIGH

| Area | Confidence | Reason |
|------|------------|--------|
| OAuth Security | HIGH | Verified with RFC 9700, Google official docs, 2026 security incidents |
| MCP Patterns | MEDIUM | Based on 2026 community sources, official MCP docs |
| AWS Infrastructure | HIGH | Official AWS docs for ECS, DynamoDB, KMS |
| Google API Limits | HIGH | Official Google Workspace API documentation |

**Areas of Uncertainty:**
- Cursor-specific SSE authentication flow (documentation limited, forum-based)
- Production MCP gateway case studies (emerging pattern, few public post-mortems)

---

## Critical Path for Roadmap

**Must address in Phase 1 (Foundation):**
1. Redirect URI validation (Pitfall 1)
2. PKCE implementation (Pitfall 2)
3. State parameter CSRF protection (Pitfall 3)
4. Domain ownership validation (Pitfall 5)

**Must address in Phase 2 (Security Hardening):**
5. Token encryption with KMS (Pitfall 4)
6. Secrets Manager integration (Pitfall 9)

**Must address before multi-user (Phase 3):**
7. Token refresh locking (Pitfall 6)
8. SSE connection management (Pitfall 8)

**Must address before production (Phase 5):**
9. Rate limit handling (Pitfall 7)
10. OAuth app verification (Pitfall 17)
11. Observability (Pitfall 10)

---

## Sources

### Security Best Practices
- [OAuth 2.0 Common Security Flaws | APIsec](https://www.apisec.ai/blog/oauth-2-0-common-security-flaws)
- [OAuth 2.0 authentication vulnerabilities | PortSwigger](https://portswigger.net/web-security/oauth)
- [Common Security Issues in OAuth 2.0 | HackerOne](https://www.hackerone.com/blog/common-security-issues-implementing-oauth-20-and-how-mitigate-them)
- [RFC 9700 - OAuth 2.0 Security Best Practices](https://datatracker.ietf.org/doc/rfc9700/)
- [OAuth best practices | WorkOS](https://workos.com/blog/oauth-best-practices)

### Google OAuth Specifics
- [Using OAuth 2.0 to Access Google APIs | Google Developers](https://developers.google.com/identity/protocols/oauth2)
- [Google OAuth is Broken (Sort Of) | Truffle Security](https://trufflesecurity.com/blog/google-oauth-is-broken-sort-of)
- [Millions at Risk: Google's OAuth Flaw | Truffle Security](https://trufflesecurity.com/blog/millions-at-risk-due-to-google-s-oauth-flaw)
- [Control which apps access Google Workspace | Google Support](https://support.google.com/a/answer/7281227?hl=en)
- [Troubleshoot authentication issues | Google Workspace](https://developers.google.com/workspace/docs/api/troubleshoot-authentication-authorization)

### Token Management
- [Refresh Token Rotation | Auth0](https://auth0.com/docs/secure/tokens/refresh-tokens/refresh-token-rotation)
- [Refresh Token Security | Auth0](https://auth0.com/blog/refresh-tokens-what-are-they-and-when-to-use-them/)
- [OAuth token refresh race condition | GitHub](https://github.com/moltbot/moltbot/issues/2036)
- [Handling concurrency with OAuth refreshes | Nango](https://nango.dev/blog/concurrency-with-oauth-token-refreshes)

### MCP Security
- [MCP Security Survival Guide | Towards Data Science](https://towardsdatascience.com/the-mcp-security-survival-guide-best-practices-pitfalls-and-real-world-lessons/)
- [MCP Servers: Security Nightmare | Equixly](https://equixly.com/blog/2025/03/29/mcp-server-new-security-nightmare/)
- [MCP Server Best Practices | CData](https://www.cdata.com/blog/mcp-server-best-practices-2026)
- [Why Your MCP Server Sucks | DEV Community](https://dev.to/aman_kumar_bdd40f1b711c15/why-your-mcp-server-sucks-and-how-to-fix-it-4dkn)
- [Model Context Protocol Security | Red Hat](https://www.redhat.com/en/blog/model-context-protocol-mcp-understanding-security-risks-and-controls)

### SSE & Infrastructure
- [The Hidden Risks of SSE | Medium](https://medium.com/@2957607810/the-hidden-risks-of-sse-server-sent-events-what-developers-often-overlook-14221a4b3bfe)
- [Server-Sent Events Guide | Medium](https://medium.com/@moali314/server-sent-events-a-comprehensive-guide-e4b15d147576)
- [Pass Secrets Manager secrets to ECS | AWS Docs](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/secrets-envvar-secrets-manager.html)
- [Secrets in AWS ECS Fargate | Xebia](https://xebia.com/blog/secrets-in-aws-ecs-fargate/)
- [Storing sensitive info in DynamoDB | AWS re:Post](https://repost.aws/questions/QU5L8z_geET8awMAlz9iFiug/storing-sensitive-information-in-dynamodb)

### API Rate Limits
- [Usage limits | Gmail API | Google Developers](https://developers.google.com/workspace/gmail/api/reference/quota)
- [Google Workspace Rate Limiting | CloudM](https://support.cloudm.io/hc/en-us/articles/9235927751836-Google-Workspace-Rate-Limiting-Proactive-Prevention-Handling)
- [View & edit quota limits | Google Workspace](https://developers.google.com/workspace/guides/view-edit-quota-limits)

### Observability
- [OpenTelemetry Tracing | Curity](https://curity.io/resources/learn/opentelemetry-tracing/)
- [Observability in Distributed Systems | Medium](https://medium.com/@jothiprakash888/observability-in-distributed-systems-logs-metrics-and-tracing-d34631170305)

### Cursor Integration
- [Model Context Protocol | Cursor Docs](https://cursor.com/docs/context/mcp)
- [Integrating Google OAuth for MCP SSE | Cursor Forum](https://forum.cursor.com/t/integrating-google-oauth-for-mcp-sse-connections-in-cursor/49189)
- [How to implement MCP server with auth | Cursor Forum](https://forum.cursor.com/t/how-to-implement-a-mcp-server-with-auth-and-trigger-cursor-login/100433)
