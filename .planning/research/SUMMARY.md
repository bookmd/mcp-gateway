# Project Research Summary

**Project:** MCP Gateway with Google OAuth
**Domain:** Centralized MCP Gateway with Multi-User OAuth Support
**Researched:** 2026-01-31
**Confidence:** HIGH

## Executive Summary

An MCP gateway with Google OAuth is a **stateful proxy service** that sits between AI clients (like Cursor) and Google Workspace APIs, managing authentication, session state, and request routing for multiple concurrent users. Expert implementations follow a clean separation pattern: transport layer for SSE connections, protocol handler for JSON-RPC 2.0, OAuth flow manager for PKCE/token exchange, encrypted token storage with AWS KMS, and API adapters that translate MCP tool calls to Google API requests. The architecture prioritizes security-first design with OAuth 2.1 compliance, encrypted token storage, and defense against the most common attack vectors (redirect URI manipulation, token theft, CSRF).

Based on research, the recommended approach is **Node.js 22 LTS + Fastify + Official MCP SDK** for the runtime, deployed on **AWS ECS Fargate with DynamoDB for token storage** and **KMS for encryption**. This stack prioritizes performance (Fastify is 3-5x faster than Express), type safety (TypeScript-first libraries), and production readiness (battle-tested, officially supported). The architecture should implement stateful sessions with session-to-user mapping, encrypted token storage from day one, and per-user token refresh locking to prevent race conditions. Start with OAuth and basic MCP protocol before adding Google API integrations.

The three critical risks are **OAuth security vulnerabilities** (redirect URI attacks, missing PKCE, CSRF), **token refresh race conditions** in concurrent multi-user scenarios, and **rate limit cascades** from Google Workspace APIs. Mitigation requires using official OAuth libraries (google-auth-library), implementing distributed locking for token refresh (Redis or DynamoDB conditions), and exponential backoff with circuit breakers for API calls. Security must be baked in from Phase 1—retrofitting authentication patterns after implementation is high-risk and forces user re-authentication.

## Key Findings

### Recommended Stack

The optimal stack balances performance, security, and developer experience for a multi-user production gateway. Node.js 22 LTS provides native .env support and active LTS through October 2027. Fastify outperforms Express by 3-5x (76k vs 15k req/sec) with superior TypeScript support and async handling. The official MCP TypeScript SDK handles protocol complexity including SSE transport and JSON-RPC 2.0 parsing. For AWS deployment, DynamoDB provides scalable token storage, KMS enables client-side encryption before persistence, and ECS Fargate simplifies container orchestration without managing EC2 instances.

**Core technologies:**
- **Node.js 22 LTS**: JavaScript runtime — Active LTS with native .env support, longest remaining support window
- **Fastify 5.x**: HTTP server — 3-5x faster than Express, native TypeScript, built-in validation/serialization
- **@modelcontextprotocol/sdk**: MCP protocol — Official SDK with SSE/Streamable HTTP transports, handles JSON-RPC 2.0
- **google-auth-library + googleapis**: OAuth and APIs — Official Google libraries for OAuth 2.1 PKCE flow and Workspace APIs
- **AWS DynamoDB + KMS**: Token storage — Encrypted at-rest storage with customer-managed keys, automatic TTL cleanup
- **Pino**: Structured logging — 5x faster than Winston, JSON logs ideal for CloudWatch, async with minimal overhead
- **Zod**: Runtime validation — TypeScript-first, required by MCP SDK, excellent type inference

**Key decision:** SSE transport is deprecated in MCP spec (replaced by Streamable HTTP as of 2025-03-26), but Cursor may still require SSE for compatibility. Verify Cursor's current requirements before finalizing—use MCP SDK's Streamable HTTP if supported, fall back to better-sse library only if necessary.

### Expected Features

MCP gateways with OAuth have well-defined expectations from both security standards (OAuth 2.1 specification) and operational requirements (AWS deployment patterns). Table stakes features reflect mandatory MCP protocol requirements, industry security standards, and basic DevOps practices. Differentiators come from advanced scope handling (Google's granular consent from Jan 2026), operational transparency (usage dashboards), and integration polish (Cursor-optimized setup).

**Must have (table stakes):**
- **OAuth 2.1 Authentication with PKCE** — MCP specification mandates this for HTTP transports, prevents authorization code interception
- **SSE Transport Support** — Required for Cursor remote connections, standard for network-based MCP clients
- **Token Validation & Audience Binding** — RFC 8707 resource indicators prevent confused deputy attacks, critical security requirement
- **Secure Credential Storage** — Production requirement: AWS Secrets Manager or equivalent, never plaintext environment variables
- **HTTPS/TLS Everywhere** — MCP OAuth spec requires all endpoints use HTTPS except localhost development
- **Domain Restriction** — IT-managed deployments require limiting access to organizational domain (e.g., @company.com only)
- **Basic Rate Limiting** — Prevents resource monopolization and runaway costs, standard in production gateways
- **Health Check Endpoint** — Required for AWS orchestration, enables auto-restart and zero-downtime deployments
- **Structured Logging** — JSON logs with request IDs and user context, essential for troubleshooting and security audits
- **Google Workspace Tool Coverage** — Users expect Gmail, Drive, Calendar, Docs as minimum (the "big 4" Workspace APIs)

**Should have (competitive):**
- **Automatic Token Refresh** — Gateway handles refresh token rotation transparently, users never see expired token errors
- **Granular Scope Control** — Google Jan 2026 feature: users approve/deny individual scopes, app degrades gracefully
- **Unified MCP Registry** — Single configuration point for all Workspace tools, simpler than managing individual servers
- **Audit Trail** — Complete record of API calls with user identity, timestamp, operation, result—required for regulated industries
- **Real-Time Usage Dashboard** — Shows token usage, API call metrics, rate limit status per user for transparency
- **Cursor-Optimized Integration** — One-click installation with pre-configured .mcp file, no terminal or JSON editing required

**Defer (v2+):**
- **Docs Tools** — Lower priority than Gmail/Calendar/Drive, documents accessible via Drive API initially
- **Multi-Account Support** — Single work account sufficient for IT-managed deployment, adds significant complexity
- **Workspace-Aware Tools** — Cross-API intelligence (e.g., find Drive files mentioned in Calendar events) requires all core APIs first
- **Client ID Metadata Documents (CIMD)** — Modern OAuth approach but pre-registration simpler for closed 20-user group
- **Workspace Admin Controls** — Central policy management for enterprise, not needed for pilot deployment

### Architecture Approach

The recommended architecture follows a **stateful gateway with session affinity** pattern, maintaining long-lived SSE connections while keeping business logic stateless. Components separate concerns: transport layer manages connections and keep-alive, protocol handler parses JSON-RPC 2.0, OAuth flow manager handles PKCE flows and token exchange, request router maps sessions to users and tools to APIs, token store manages encrypted persistence with KMS, and API adapters translate MCP tool calls to Google API requests. State lives in shared stores (Redis for sessions, DynamoDB for tokens) enabling horizontal scaling with ALB sticky sessions.

**Major components:**
1. **Transport Layer (SSE/HTTP)** — Manages SSE connections, implements keep-alive (30s intervals), handles session IDs via Mcp-Session-Id headers, tracks connection lifecycle
2. **OAuth Flow Manager** — Implements PKCE authorization flow, exchanges codes for tokens using google-auth-library, handles token refresh with distributed locking, validates domain ownership via hd claim
3. **Token Store (DynamoDB + KMS)** — Encrypts tokens client-side before DynamoDB write, decrypts on read with encryption context, implements TTL for automatic cleanup, supports refresh token rotation
4. **Request Router & API Adapters** — Maps session IDs to user IDs, routes tool calls to appropriate API adapters (Gmail, Drive, Calendar, Docs), coordinates token refresh before API calls, implements retry logic with exponential backoff
5. **Session Store (Redis/DynamoDB)** — Maintains session-to-user mapping, enables connection affinity for horizontal scaling, tracks session activity for timeout management

**Key patterns:**
- **Encrypted token storage with KMS**: Always encrypt refresh tokens before DynamoDB write using customer-managed keys, include encryption context for additional security
- **Token refresh with distributed locking**: Use Redis or DynamoDB conditional writes to prevent race conditions when multiple concurrent requests detect expired tokens
- **SSE keep-alive for connection stability**: Send comment events every 30 seconds to prevent proxy/load balancer timeouts, close zombie connections after 90s no response
- **Tool-to-API mapping with adapter pattern**: Each Google API gets dedicated adapter implementing consistent interface, separates MCP concerns from API-specific logic

### Critical Pitfalls

The research identified 18 distinct pitfalls across security, operations, and infrastructure categories. The top 5 represent existential risks that cause security breaches, production incidents, or architecture rewrites if not addressed correctly from the start.

1. **Insufficient Redirect URI Validation** — Attackers manipulate OAuth redirect URIs to steal authorization codes, leading to account takeover (Allianz breach July 2025 exposed 1.1M records). Prevention: whitelist exact URIs in Google Cloud Console with no wildcards, use stable domain pointed at ALB (not ECS task IPs), validate server-side against whitelist. Must address in Phase 1 (OAuth Implementation).

2. **Missing PKCE Implementation** — Authorization codes intercepted in transit can be exchanged for tokens without proof of client identity. OAuth 2.1 (standardized Jan 2025) makes PKCE mandatory. Prevention: use OAuth 2.1-compliant google-auth-library >=9.0, generate cryptographically random code_verifier (43-128 chars), send SHA256 hash as code_challenge with S256 method. Must address in Phase 1 (OAuth Implementation).

3. **Insecure Token Storage (Plaintext)** — Refresh tokens in plaintext DynamoDB enable persistent access if database compromised via backups, logs, or credential leaks. Prevention: client-side KMS encryption before write, use customer-managed keys (not AWS-managed), rotate keys annually, never log decrypted tokens. Must address in Phase 2 (Token Storage) before first production deployment.

4. **Token Refresh Race Conditions** — Concurrent API requests trigger simultaneous token refreshes, first refresh invalidates the refresh token, subsequent attempts fail with invalid_grant causing 50%+ request failures. Prevention: distributed locking with Redis or DynamoDB conditional writes, queue concurrent requests during refresh, proactive refresh at 50-minute mark (tokens live 60 minutes). Must address in Phase 3 (Multi-user Support) before production.

5. **Google API Rate Limit Cascades** — Single user hits rate limit (250 Gmail reads/sec), gateway doesn't backoff properly, burns through quota, all 20 users blocked for 60 seconds, retry storm amplifies. Prevention: exponential backoff with jitter, parse Retry-After headers from 429 responses, circuit breaker per API (fail fast after 5 consecutive 429s), per-user rate limiting at 80% quota. Must address in Phase 4 (API Integration) before load testing.

**Additional critical concerns:**
- **State parameter CSRF vulnerability**: Generate cryptographically random state per OAuth flow, validate on callback and immediately delete, expire after 10 minutes
- **Google domain takeover**: Validate hd claim on every token refresh to detect domain ownership changes (domain lapses or acquisition)
- **SSE connection exhaustion**: Fargate default 1024 file descriptor limit, implement per-user connection limits (max 10), increase ulimit to 4096

## Implications for Roadmap

Based on research, the roadmap should follow a **security-first, incremental integration** pattern with 5 phases: Foundation (OAuth + MCP), Core APIs (Gmail/Calendar/Drive), Multi-user Support, Production Hardening, and Launch. This order addresses dependencies discovered in the architecture research (OAuth must work before API calls, multi-user infrastructure needed before concurrent requests, observability required for troubleshooting) and mitigates critical pitfalls (security patterns baked in from Phase 1, token storage encrypted from first write, rate limiting added before scale).

### Phase 1: OAuth + MCP Foundation
**Rationale:** Establish secure authentication before adding API complexity. OAuth security patterns (PKCE, state validation, redirect URI whitelisting) must be correct from day one—retrofitting causes user re-authentication and security gaps. MCP protocol lifecycle (initialize, capability negotiation, session management) independent of Google APIs.

**Delivers:** Working OAuth 2.1 flow with Google, SSE transport accepting Cursor connections, MCP protocol handler responding to initialize/tools/list, session management with Mcp-Session-Id headers

**Addresses (from FEATURES.md):**
- OAuth 2.1 Authentication with PKCE (table stakes)
- SSE Transport Support (table stakes)
- HTTPS/TLS Configuration (table stakes)
- Domain Restriction via hd claim validation (table stakes)

**Avoids (from PITFALLS.md):**
- Pitfall 1: Insufficient Redirect URI Validation
- Pitfall 2: Missing PKCE Implementation
- Pitfall 3: State Parameter CSRF Vulnerability
- Pitfall 5: Google OAuth Domain Takeover

**Tech Stack (from STACK.md):**
- Node.js 22 LTS + TypeScript 5.7.x
- Fastify 5.x for HTTP server
- @modelcontextprotocol/sdk for protocol
- google-auth-library 9.x for OAuth
- better-sse if Cursor requires SSE (verify first)

**Research Flag:** MEDIUM - OAuth patterns well-documented in official specs (RFC 9700, MCP Authorization spec), but Cursor-specific SSE authentication flow has limited documentation. Test with real Cursor client early to validate integration.

### Phase 2: Encrypted Token Storage
**Rationale:** Token security non-negotiable before storing real user credentials. Fixing plaintext storage post-launch requires user re-authentication. KMS setup and DynamoDB schema must be correct before first OAuth token persists.

**Delivers:** DynamoDB table for tokens with client-side KMS encryption, token store component with encrypt/decrypt methods, AWS Secrets Manager integration for OAuth client secrets, automatic token TTL cleanup

**Addresses (from FEATURES.md):**
- Secure Credential Storage (table stakes)
- Token Validation & Audience Binding (table stakes)

**Avoids (from PITFALLS.md):**
- Pitfall 4: Insecure Token Storage (Plaintext in DynamoDB)
- Pitfall 9: Secrets in ECS Environment Variables

**Tech Stack (from STACK.md):**
- @aws-sdk/client-dynamodb + @aws-sdk/lib-dynamodb
- @aws-sdk/client-kms for encryption
- DynamoDB with customer-managed KMS key

**Research Flag:** LOW - AWS patterns well-documented with official examples. Standard DynamoDB + KMS integration.

### Phase 3: Core Google APIs (Gmail, Calendar, Drive)
**Rationale:** Deliver user value with most-requested Workspace tools. Gmail highest priority (email reading/sending), Calendar second (event management), Drive third (file access). Build API adapters incrementally to validate architecture pattern before expanding.

**Delivers:** Gmail tools (list/search/read/send), Calendar tools (list/create events), Drive tools (search/read files), API adapter pattern established, automatic token refresh logic, error handling for 401/403 responses

**Addresses (from FEATURES.md):**
- Google Workspace Tool Coverage (table stakes)
- Scope Management with minimal scopes (table stakes)
- Automatic Token Refresh (differentiator for MVP)

**Avoids (from PITFALLS.md):**
- Pitfall 13: Insufficient Scope Validation (request minimal scopes)
- Pitfall 18: No Retry Logic for Transient Failures (5xx errors)

**Tech Stack (from STACK.md):**
- googleapis 170.x for Gmail/Calendar/Drive APIs
- Zod for request parameter validation

**Research Flag:** LOW - Google Workspace APIs have excellent official documentation with TypeScript examples. Standard REST API integration.

### Phase 4: Multi-User Support & Rate Limiting
**Rationale:** Scale from single-user proof-of-concept to 20-user production deployment. Multi-user infrastructure (session isolation, per-user tokens, distributed locking) required before concurrent usage. Rate limiting prevents single user from monopolizing resources.

**Delivers:** Session store (Redis or DynamoDB), session-to-user mapping, distributed token refresh locking, per-user rate limiting (API calls per minute), connection limit per user (max 10 SSE connections), graceful degradation at capacity

**Addresses (from FEATURES.md):**
- Basic Rate Limiting (table stakes)
- Multi-user session isolation (implicit requirement)

**Avoids (from PITFALLS.md):**
- Pitfall 6: Token Refresh Race Conditions
- Pitfall 8: SSE Connection Exhaustion on ECS Fargate
- Pitfall 7: Google API Rate Limit Cascades (partial—full solution in Phase 5)

**Tech Stack (from STACK.md):**
- Redis Cluster or DynamoDB for session store
- Distributed lock implementation (Redis SETNX or DynamoDB conditional writes)

**Research Flag:** MEDIUM - Distributed locking patterns well-documented but require careful implementation and testing. Load testing reveals edge cases.

### Phase 5: Production Hardening & Launch
**Rationale:** Operational readiness for production deployment. Observability enables troubleshooting without SSH-ing into containers. Circuit breakers prevent cascade failures. Health checks enable zero-downtime deployments. Google OAuth verification unblocks enterprise adoption.

**Delivers:** Structured logging with correlation IDs, CloudWatch dashboards and alarms, OpenTelemetry distributed tracing, circuit breakers per API, comprehensive health checks (DynamoDB, KMS, Google OAuth), Google OAuth app verification submission, exponential backoff with retry-after parsing, metrics for token refresh latency and API call success rates

**Addresses (from FEATURES.md):**
- Health Check Endpoint (table stakes)
- Structured Logging (table stakes)
- Error Handling 401/403 with WWW-Authenticate (table stakes)

**Avoids (from PITFALLS.md):**
- Pitfall 7: Google API Rate Limit Cascades (full solution with circuit breakers)
- Pitfall 10: Missing Observability for OAuth Flows
- Pitfall 17: Google OAuth App Verification Status Ignored

**Tech Stack (from STACK.md):**
- Pino for structured logging
- pino-pretty for development
- AWS CloudWatch for logs and metrics

**Research Flag:** LOW - Standard DevOps patterns for Node.js on ECS. Well-documented monitoring and observability practices.

### Phase Ordering Rationale

The phase structure follows these principles from the research:

**Dependency-driven sequencing:** OAuth must work before storing tokens, tokens must exist before API calls, single-user must work before multi-user, basic functionality before observability. The Architecture research (Build Order Recommendations section) explicitly recommends this sequence: Core MCP Protocol → OAuth Integration (Single User) → Multi-User Support → Google API Integration → Production Hardening.

**Security-first approach:** Critical security pitfalls (Pitfalls 1-5) distributed across early phases to prevent retrofitting. OAuth security patterns (PKCE, state validation, redirect URI whitelisting) in Phase 1, encrypted storage in Phase 2 before real credentials stored, distributed locking in Phase 4 before concurrent load. The Pitfalls research found that "fixing post-launch requires user re-authentication" for token storage and OAuth patterns.

**Risk mitigation through incremental integration:** Build each API adapter (Gmail, Calendar, Drive) separately in Phase 3 to validate pattern before expanding. Add multi-user infrastructure (Phase 4) after APIs proven with single user. Add production hardening (Phase 5) after core functionality stable. The Architecture research's "Pattern 4: Tool-to-API Mapping with Adapters" demonstrates this incremental approach.

**Load testing validation points:** Phase 3 end: single-user API load test reveals rate limiting needs. Phase 4 end: multi-user load test reveals connection exhaustion and refresh race conditions. Phase 5: production traffic patterns validate observability. The Pitfalls research identifies SSE connection exhaustion (Pitfall 8) as "revealed by load testing before production."

### Research Flags

**Phases needing research during planning:**

- **Phase 1 (OAuth + MCP):** MEDIUM priority research on Cursor-specific SSE authentication patterns. Official Cursor documentation limited, community forums provide fragmented guidance. Recommendation: allocate 1-2 hours for Cursor integration testing and potential `/gsd:research-phase` if authentication flow unclear.

- **Phase 4 (Multi-User Support):** LOW-MEDIUM priority research on distributed locking patterns for token refresh. Multiple implementation options (Redis SETNX, DynamoDB conditional writes, SQS queuing), trade-offs between complexity and reliability. Recommendation: validate locking strategy with load testing, may need `/gsd:research-phase` if race conditions persist.

**Phases with standard patterns (skip deep research):**

- **Phase 2 (Token Storage):** AWS DynamoDB + KMS integration well-documented with official examples. Standard client-side encryption pattern. Skip additional research.

- **Phase 3 (Core APIs):** Google Workspace APIs have excellent official documentation, TypeScript SDK, and extensive examples. Standard REST API integration. Skip additional research.

- **Phase 5 (Production Hardening):** Standard DevOps patterns for Node.js on ECS. CloudWatch integration, structured logging, health checks all well-documented. Skip additional research.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Verified with official Node.js LTS roadmap, Fastify benchmarks, MCP SDK documentation, AWS official docs. All recommendations based on 2026 production standards. |
| Features | HIGH | MCP specification provides authoritative requirements, Google OAuth documentation is comprehensive, feature expectations validated across multiple production MCP gateway implementations (IBM Context Forge, Kong, AWS Bedrock). |
| Architecture | MEDIUM-HIGH | Architecture patterns verified with official MCP spec and production gateway references (IBM, WorkOS). DynamoDB + KMS patterns from AWS official docs. Reduced confidence on Cursor-specific SSE authentication (community sources, limited official docs). |
| Pitfalls | HIGH | OAuth security pitfalls verified with RFC 9700 (OAuth 2.0 Security Best Practices), Google official docs, and documented security incidents (Allianz breach July 2025). Rate limiting and infrastructure pitfalls from AWS and Google official documentation. MCP-specific pitfalls from 2026 community security research. |

**Overall confidence:** HIGH

The research benefits from authoritative sources: official specifications (MCP protocol, OAuth 2.1 RFC 9700), official vendor documentation (Google OAuth, AWS services), and verified production patterns from enterprise implementations. The single area of reduced confidence—Cursor SSE authentication—is flagged for validation during Phase 1 implementation with recommendation to test against real Cursor client early.

### Gaps to Address

**Cursor transport requirements:** MCP specification deprecated SSE in favor of Streamable HTTP (as of 2025-03-26), but Cursor may still require SSE for backward compatibility. Research found conflicting information: MCP docs recommend Streamable HTTP, but Cursor forum posts reference SSE configuration. **Resolution:** Verify Cursor's current transport support during Phase 1 by testing both SSE and Streamable HTTP. Use MCP SDK's built-in Streamable HTTP transport if supported (simpler), add better-sse library only if Cursor definitively requires SSE.

**Session control policies:** Google Workspace session control settings (max session duration, geographic restrictions) can invalidate refresh tokens with `invalid_grant` errors. Research documents the error pattern but not detection/recovery strategy for all policy types. **Resolution:** Document known session control impacts, implement graceful re-authentication flow for `invalid_grant` errors during Phase 3, test with workspace that has strict session policies if available.

**Optimal rate limiting thresholds:** Google Workspace APIs have documented quota limits (e.g., 250 Gmail reads/sec per user), but optimal soft limits for 20-user gateway depend on usage patterns. Research provides general guidance (80% of quota) but not validated thresholds. **Resolution:** Start conservative (100 API calls/minute per user), monitor actual usage during Phase 4 load testing, adjust based on CloudWatch metrics. Build configurability into rate limiter from the start.

**Connection scaling on ECS Fargate:** Research identifies 1024 file descriptor default limit and recommends increasing to 4096, but optimal per-user connection limit (currently recommended: 10 SSE connections per user) depends on Cursor reconnection behavior. **Resolution:** Implement connection tracking and configurable per-user limits in Phase 4, validate with multi-user load test simulating network instability and Cursor reconnections.

**Google OAuth app verification timeline:** Research states verification takes 2-4 weeks but doesn't account for potential rejections or additional verification rounds for sensitive scopes (gmail.send, drive.file). **Resolution:** Start verification submission early in Phase 5, prepare detailed scope justification documentation, have contingency for 4-6 week timeline including potential rejection/resubmission.

## Sources

### Primary (HIGH confidence)

**Official Specifications & Standards:**
- [MCP Specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25) — Core protocol requirements, lifecycle management, capability negotiation
- [MCP Authorization Specification](https://modelcontextprotocol.io/specification/draft/basic/authorization) — OAuth 2.1 requirements, resource indicators (RFC 8707), token validation
- [MCP Transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports) — SSE vs Streamable HTTP, transport layer requirements
- [OAuth 2.0 Security Best Practices (RFC 9700)](https://datatracker.ietf.org/doc/rfc9700/) — PKCE requirements, authorization code security
- [OAuth 2.0 Resource Indicators (RFC 8707)](https://datatracker.ietf.org/doc/html/rfc8707) — Token audience binding, confused deputy prevention

**Official Google Documentation:**
- [Google OAuth 2.0 for Web Server Applications](https://developers.google.com/identity/protocols/oauth2/web-server) — PKCE flow, token exchange, refresh patterns
- [Google API Node.js Client](https://github.com/googleapis/google-api-nodejs-client) — Official googleapis library usage, TypeScript types
- [Gmail API Reference](https://developers.google.com/workspace/gmail/api/reference/rest) — API endpoints, quota limits (250 reads/sec per user)
- [Google OAuth Scopes](https://developers.google.com/identity/protocols/oauth2/scopes) — Complete scope list, least privilege guidance
- [Configure OAuth Consent Screen](https://developers.google.com/workspace/guides/configure-oauth-consent) — Verification requirements, privacy policy needs

**Official AWS Documentation:**
- [AWS SDK for JavaScript v3](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/) — DynamoDB, KMS, Secrets Manager integration patterns
- [DynamoDB Encryption Best Practices](https://docs.aws.amazon.com/prescriptive-guidance/latest/encryption-best-practices/dynamodb.html) — Client-side encryption with KMS
- [ECS Secrets Manager Integration](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/secrets-envvar-secrets-manager.html) — Secure credential injection
- [ECS Fargate Platform Versions](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/platform_versions.html) — Feature availability, limits

**Official Node.js & Library Documentation:**
- [Node.js Releases](https://nodejs.org/en/about/previous-releases) — LTS roadmap, Node 22 support through Oct 2027
- [Fastify Documentation](https://fastify.dev/) — Performance benchmarks, TypeScript integration
- [Pino Documentation](https://getpino.io/) — Structured logging, CloudWatch integration

### Secondary (MEDIUM confidence)

**Production MCP Gateway Implementations:**
- [IBM MCP Context Forge](https://ibm.github.io/mcp-context-forge/) — Enterprise gateway architecture, multi-server federation
- [Kong Enterprise MCP Gateway](https://konghq.com/blog/product-releases/enterprise-mcp-gateway) — API gateway patterns for MCP
- [AWS Bedrock AgentCore Gateway](https://aws.amazon.com/blogs/machine-learning/transform-your-mcp-architecture-unite-mcp-servers-through-agentcore-gateway/) — AWS-native MCP gateway architecture

**OAuth Security Research:**
- [Auth0: OAuth for MCP](https://auth0.com/blog/an-introduction-to-mcp-and-authorization/) — OAuth integration patterns for MCP
- [Stytch: OAuth for MCP Explained](https://stytch.com/blog/oauth-for-mcp-explained-with-a-real-world-example/) — Real-world implementation examples
- [WorkOS: OAuth Best Practices](https://workos.com/blog/oauth-best-practices) — Industry standard OAuth patterns
- [Truffle Security: Google OAuth Domain Takeover](https://trufflesecurity.com/blog/google-oauth-is-broken-sort-of) — hd claim validation importance

**MCP Security Research:**
- [Red Hat: MCP Security Risks and Controls](https://www.redhat.com/en/blog/model-context-protocol-mcp-understanding-security-risks-and-controls) — Security analysis of MCP protocol
- [Docker: MCP Security Explained](https://www.docker.com/blog/mcp-security-explained/) — Container security considerations
- [Descope: Top 6 MCP Vulnerabilities](https://www.descope.com/blog/post/mcp-vulnerabilities) — Common security pitfalls
- [CData: MCP Server Best Practices 2026](https://www.cdata.com/blog/mcp-server-best-practices-2026) — Production deployment guidance

**Google Workspace Integration:**
- [Google Workspace MCP by taylorwilsdon](https://github.com/taylorwilsdon/google_workspace_mcp) — Reference implementation, .dxt bundle approach
- [workspacemcp.com](https://workspacemcp.com) — Production Google Workspace MCP service
- [Google Workspace MCP by j3k0](https://github.com/j3k0/mcp-google-workspace) — Gmail + Calendar focus

**Framework & Infrastructure Comparisons:**
- [Fastify vs Express vs Hono 2025](https://redskydigital.com/us/comparing-hono-express-and-fastify-lightweight-frameworks-today/) — Performance benchmarks, use case analysis
- [Pino vs Winston 2025](https://betterstack.com/community/comparisons/pino-vs-winston/) — Logging framework comparison
- [Node.js Logging Frameworks 2025](https://www.dash0.com/faq/the-top-5-best-node-js-and-javascript-logging-frameworks-in-2025-a-complete-guide) — Comprehensive framework evaluation

### Tertiary (LOW confidence - needs validation)

**Cursor Integration Patterns:**
- [Cursor MCP Documentation](https://docs.cursor.com/context/model-context-protocol) — Basic MCP setup, limited auth details
- [Cursor Forum: Google OAuth for MCP SSE](https://forum.cursor.com/t/integrating-google-oauth-for-mcp-sse-connections-in-cursor/49189) — Community discussion on SSE auth patterns
- [Cursor Forum: MCP Server with Auth](https://forum.cursor.com/t/how-to-implement-a-mcp-server-with-auth-and-trigger-cursor-login/100433) — Community approaches to authentication

**Emerging Patterns:**
- [MCP Gateways Guide 2026](https://composio.dev/blog/mcp-gateways-guide) — Gateway concepts (content not fully accessible)
- [2026: Year for Enterprise MCP Adoption](https://www.cdata.com/blog/2026-year-enterprise-ready-mcp-adoption) — Market analysis and trends

---
**Research completed:** 2026-01-31
**Ready for roadmap:** yes
