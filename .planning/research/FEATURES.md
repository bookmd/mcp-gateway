# Feature Landscape

**Domain:** MCP Gateway with Google Workspace OAuth Integration
**Researched:** 2026-01-31
**Confidence:** HIGH (based on MCP specification, Google Workspace OAuth documentation, and 2026 market analysis)

## Table Stakes

Features users expect from an MCP gateway with OAuth. Missing any of these = product feels incomplete or insecure.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **OAuth 2.1 Authentication** | MCP specification mandates OAuth 2.1 for HTTP-based transports. Industry standard for secure authentication. | Medium | Must implement PKCE, token validation, refresh token rotation. MCP spec compliance required. |
| **SSE Transport Support** | Cursor and remote MCP clients require SSE for network-based connections. Standard for remote MCP. | Low | HTTP+SSE replaced pure SSE in protocol 2024-11-05, but SSE remains primary remote transport. |
| **Token Validation & Audience Binding** | Critical security requirement. MCP servers MUST validate tokens are issued specifically for them (RFC 8707). | Medium | Prevents confused deputy attacks and token theft. MCP spec mandates resource parameter usage. |
| **Secure Credential Storage** | Production deployment requirement. Credentials must never be in plaintext environment variables or code. | Medium | Use AWS Secrets Manager or similar. 43% of servers have injection vulnerabilities per 2026 research. |
| **HTTPS/TLS Everywhere** | MCP OAuth spec requires all endpoints use HTTPS. Fundamental security requirement. | Low | No production exceptions. Includes authorization server, redirect URIs (except localhost). |
| **Basic Rate Limiting** | Prevents resource monopolization and runaway costs. Expected in all production gateways. | Low-Medium | Per-user or per-client limits. Protects against both malicious and accidental overuse. |
| **Health Check Endpoint** | Required for AWS/orchestration monitoring, auto-restart, load balancing. Standard DevOps practice. | Low | `/health` endpoint returning server status. Enables zero-downtime deployments. |
| **Structured Logging** | Troubleshooting, security audit, incident response. Essential for production operations. | Low | JSON logs with request IDs, timestamps, user context. CloudWatch integration for AWS. |
| **Google Workspace Tool Coverage** | Users expect Gmail, Drive, Calendar, Docs as minimum. These are the "big 4" Workspace APIs. | Medium-High | Each API requires separate OAuth scopes and tool implementations. See Feature Dependencies. |
| **Scope Management** | Users must grant only necessary permissions. Required by Google OAuth policies (Jan 2026). | Medium | Request minimal scopes initially, support step-up auth for additional permissions. Critical for user trust. |
| **Domain Restriction** | IT-managed deployments require limiting access to organizational domain (e.g., @company.com). | Medium | Validates user email domain during OAuth flow. Prevents external user access. Multi-tenant isolation. |
| **Error Handling (401/403)** | MCP spec requires specific HTTP status codes for auth errors. Clients depend on this for retry logic. | Low | 401 for invalid/missing token, 403 for insufficient scopes with WWW-Authenticate header. |

## Differentiators

Features that set your gateway apart. Not expected, but valued by users. Competitive advantages.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Granular Scope Control** | Users can approve some scopes and deny others (Google Jan 2026 feature). Reduces consent friction. | High | App must degrade gracefully when scopes denied. Disable specific features, show helpful errors. Major UX advantage. |
| **Unified MCP Registry** | Single configuration point for all Google Workspace tools. Simpler setup than managing individual servers. | Medium | Similar to ContextForge/Kong approach. One endpoint exposes all Workspace APIs. Reduces client config complexity. |
| **Real-Time Usage Dashboard** | Shows token usage, API call metrics, rate limit status per user. Transparency builds trust. | Medium-High | Live metrics via WebSocket or polling. Helps users understand costs and limits. IT admin visibility. |
| **Advanced Observability** | Detailed tracing, latency metrics, error rates per tool/user. Beyond basic logging. | High | Distributed tracing (OpenTelemetry), custom CloudWatch dashboards. Sub-3ms latency monitoring. |
| **Audit Trail** | Complete record of all API calls, who made them, what data accessed. Compliance and security. | Medium | Immutable logs with user identity, timestamp, operation, result. Required for regulated industries. |
| **Workspace-Aware Tools** | Tools understand Google Workspace relationships (e.g., find Drive files shared in Calendar events). | High | Cross-API intelligence. Goes beyond simple CRUD operations. Provides contextual value. |
| **Client ID Metadata Documents (CIMD)** | Modern OAuth approach. No pre-registration needed. Clients use HTTPS URLs as identifiers. | Medium-High | MCP spec SHOULD support. Better than Dynamic Client Registration. Reduces IT setup burden. |
| **Smart Rate Limiting** | Per-user, per-tool, per-time-window limits with burst allowance. More sophisticated than basic. | High | Prevents one user/tool from starving others. Configurable by IT admin. Requires in-memory state management. |
| **Automatic Token Refresh** | Gateway handles refresh token rotation transparently. Users never see auth errors from expired tokens. | Medium | MCP spec requires refresh token rotation for public clients. Improves UX by reducing interruptions. |
| **Multi-Account Support** | Users can connect multiple Google accounts and switch between them. | High | Requires account selection UI, separate token storage per account. Useful for users with personal + work accounts. |
| **Cursor-Optimized Integration** | One-click installation, pre-configured .mcp file, no terminal/JSON editing. | Medium | Similar to Google Workspace MCP by taylorwilsdon (.dxt bundle approach). Dramatically lowers adoption friction. |
| **Graceful Degradation** | If one Workspace API is down, others continue working. Partial failures handled elegantly. | Medium | Circuit breaker pattern per API. Users can still access Calendar even if Gmail API fails. |
| **Workspace Admin Controls** | IT admins can allowlist specific tools, block others, set org-wide rate limits. | High | Central policy management. Required for enterprise adoption. Prevents shadow IT tool sprawl. |

## Anti-Features

Features to explicitly NOT build. Common mistakes in this domain.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| **Token Passthrough** | MCP spec explicitly forbids passing client tokens to upstream APIs. Creates confused deputy vulnerabilities. | Gateway obtains its own tokens for upstream APIs. Client token only validates at gateway. |
| **Binding to 0.0.0.0** | Exposes server to entire network. Enables DNS rebinding and remote attacks. Most common misconfiguration in 2026. | Always bind to 127.0.0.1 for local servers. For remote, use proper firewall/VPC rules, never expose directly. |
| **Dynamic Client Registration (DCR)** | Legacy OAuth approach. Creates security issues with static client IDs in multi-tenant scenarios. | Use Client ID Metadata Documents (CIMD) or pre-registration. MCP spec prioritizes CIMD over DCR. |
| **Storing Credentials in Environment Variables** | Leading cause of credential leakage. Credentials end up in logs, tool outputs, model completions. | Use AWS Secrets Manager, never plaintext. Rotate credentials regularly. |
| **All-or-Nothing Scope Requests** | Legacy OAuth pattern. Users forced to grant all scopes or none. Poor UX, increases security risk. | Support granular consent (Google Jan 2026). Request minimal scopes initially, step-up authorization for more. |
| **Automatic Permission Escalation** | Requesting broad scopes "just in case." Violates principle of least privilege. Fails Google OAuth review. | Only request scopes when user action requires them. Document why each scope is needed. |
| **Per-API MCP Servers** | Deploying separate server per Workspace API. Config nightmare, auth duplication, poor UX. | Single gateway federating all Workspace APIs. One auth flow, one config, unified registry. |
| **Ignoring WWW-Authenticate Headers** | MCP spec requires parsing these for auth server discovery and scope requirements. | Always parse WWW-Authenticate on 401/403. Use scope hints for authorization requests. |
| **No Input Validation** | 43% of MCP servers have command injection vulnerabilities. Critical security gap. | Validate all user inputs. Sanitize parameters passed to Google APIs. Use parameterized queries. |
| **Mixed Transport in Same Instance** | Supporting both stdio and SSE in one server process. Complex, error-prone, unnecessary. | Choose one transport per deployment. Use SSE for centralized gateway, stdio only for local dev. |
| **Overly Verbose Consent Screens** | Overwhelming users with technical details during OAuth. Causes consent fatigue and abandonment. | Clear, simple language. Group related permissions. Explain benefits, not technical details. |
| **No Scope Audit Process** | Requesting scopes that aren't actively used. Accumulates permissions over time. | Periodic scope audits. Remove unused scopes. Delete obsolete clients. Document scope justification. |
| **Hardcoded Authorization Server URLs** | Breaks when auth server changes. Ignores MCP discovery protocol. | Always use Protected Resource Metadata for auth server discovery. Support both WWW-Authenticate and well-known URIs. |

## Feature Dependencies

```
FOUNDATIONAL (Must build first):
  ├─ OAuth 2.1 Authentication (PKCE, token validation)
  ├─ SSE Transport
  ├─ HTTPS/TLS Configuration
  └─ Secure Credential Storage (AWS Secrets Manager)
      │
      ▼
CORE GOOGLE WORKSPACE TOOLS (Build in order of user value):
  ├─ Gmail Tools
  │   ├─ Requires: gmail.readonly scope (minimum)
  │   ├─ Requires: gmail.send scope (for sending)
  │   └─ Tools: list_emails, search_emails, send_email, read_email
  │
  ├─ Calendar Tools
  │   ├─ Requires: calendar.readonly or calendar.events scope
  │   ├─ Depends on: Gmail (for meeting attendee email lookup)
  │   └─ Tools: list_events, create_event, update_event, search_events
  │
  ├─ Drive Tools
  │   ├─ Requires: drive.readonly or drive.file scope
  │   ├─ Depends on: None (standalone)
  │   └─ Tools: list_files, search_files, read_file, upload_file, share_file
  │
  └─ Docs Tools
      ├─ Requires: documents.readonly or documents scope
      ├─ Depends on: Drive (docs are Drive files)
      └─ Tools: read_doc, create_doc, update_doc
      │
      ▼
SECURITY & OPERATIONS (Build alongside core tools):
  ├─ Domain Restriction
  ├─ Rate Limiting
  ├─ Health Check Endpoint
  ├─ Structured Logging
  └─ Error Handling (401/403 with proper headers)
      │
      ▼
ADVANCED FEATURES (Build after core is stable):
  ├─ Granular Scope Control
  │   └─ Depends on: Core tool implementation (graceful degradation)
  │
  ├─ Audit Trail
  │   └─ Depends on: Structured Logging
  │
  ├─ Real-Time Usage Dashboard
  │   └─ Depends on: Rate Limiting, Structured Logging
  │
  ├─ Client ID Metadata Documents (CIMD)
  │   └─ Alternative to pre-registration, standalone feature
  │
  └─ Workspace-Aware Tools
      └─ Depends on: All core Workspace tool implementations

SCOPE DEPENDENCIES (OAuth scopes):
- Gmail: https://www.googleapis.com/auth/gmail.readonly (read)
- Gmail: https://www.googleapis.com/auth/gmail.send (send)
- Calendar: https://www.googleapis.com/auth/calendar.readonly (read)
- Calendar: https://www.googleapis.com/auth/calendar.events (read/write)
- Drive: https://www.googleapis.com/auth/drive.readonly (read)
- Drive: https://www.googleapis.com/auth/drive.file (read/write)
- Docs: https://www.googleapis.com/auth/documents.readonly (read)
- Docs: https://www.googleapis.com/auth/documents (read/write)
- Profile: openid, email, profile (user identity)

Note: Requesting .readonly first, then step-up to read/write when needed
is best practice per Google OAuth policies (Jan 2026).
```

## MVP Recommendation

For MVP (~20 users, IT-managed, AWS deployment), prioritize:

### Phase 1: Foundation (Week 1-2)
1. **OAuth 2.1 Authentication** - Table stakes, required by MCP spec
2. **SSE Transport** - Required for Cursor integration
3. **Domain Restriction** - IT requirement for org-only access
4. **Secure Credential Storage** - AWS Secrets Manager, non-negotiable for production

### Phase 2: Core Workspace Tools (Week 3-5)
5. **Gmail Tools** (read + send) - Highest user value, most requested
6. **Calendar Tools** (read + create events) - High value, common use case
7. **Drive Tools** (read + search) - Essential for document access
8. **Basic Rate Limiting** - Protect against runaway usage early

### Phase 3: Production Readiness (Week 6)
9. **Health Check Endpoint** - Required for AWS deployment
10. **Structured Logging** - CloudWatch integration for troubleshooting
11. **Error Handling** - Proper 401/403 responses per MCP spec

### Defer to Post-MVP:
- **Docs Tools**: Lower priority than Gmail/Calendar/Drive, can access via Drive
- **Granular Scope Control**: Valuable but complex, wait for user feedback
- **Audit Trail**: Important for compliance but not blocking for 20-user pilot
- **Real-Time Dashboard**: Nice to have, not critical for initial deployment
- **Multi-Account Support**: Single work account sufficient for IT-managed deployment
- **Workspace-Aware Tools**: Advanced feature requiring all core tools first
- **CIMD Support**: Pre-registration simpler for small closed user group

### One Differentiator for MVP:
- **Automatic Token Refresh** - Low friction, high UX value. Prevents auth interruptions during long coding sessions. Medium complexity, high impact.

## Scale Considerations (Future)

For scaling beyond 20 users:

| User Count | Additional Features Needed | Why |
|------------|---------------------------|-----|
| 20-100 | Audit Trail, Advanced Observability | Compliance, troubleshooting at scale |
| 100-500 | Smart Rate Limiting, Real-Time Dashboard | Fair resource distribution, transparency |
| 500+ | Workspace Admin Controls, Multi-Region Deployment | Central policy management, latency optimization |

## Sources

### MCP Specification (HIGH Confidence)
- [MCP Specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25) - Core protocol requirements
- [MCP Authorization Specification](https://modelcontextprotocol.io/specification/draft/basic/authorization) - OAuth 2.1 requirements
- [MCP Security Best Practices](https://modelcontextprotocol.io/specification/draft/basic/security_best_practices) - Security considerations
- [MCP Transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports) - SSE and HTTP transport details

### MCP Ecosystem & Gateways (MEDIUM-HIGH Confidence)
- [MCP Gateways in 2026: Top 10 Tools](https://bytebridge.medium.com/mcp-gateways-in-2026-top-10-tools-for-ai-agents-and-workflows-d98f54c3577a)
- [2026: The Year for Enterprise-Ready MCP Adoption](https://www.cdata.com/blog/2026-year-enterprise-ready-mcp-adoption)
- [Best MCP Gateways and AI Agent Security Tools (2026)](https://www.integrate.io/blog/best-mcp-gateways-and-ai-agent-security-tools/)
- [MCP Context Forge - IBM Gateway](https://ibm.github.io/mcp-context-forge/)
- [Kong Enterprise MCP Gateway](https://konghq.com/blog/product-releases/enterprise-mcp-gateway)
- [AWS Bedrock AgentCore Gateway](https://aws.amazon.com/blogs/machine-learning/transform-your-mcp-architecture-unite-mcp-servers-through-agentcore-gateway/)

### OAuth & Authentication (HIGH Confidence)
- [OAuth 2.1 and MCP](https://modelcontextprotocol.io/specification/draft/basic/authorization) - Authoritative MCP OAuth spec
- [Stytch: OAuth for MCP Explained](https://stytch.com/blog/oauth-for-mcp-explained-with-a-real-world-example/)
- [Auth0: Introduction to MCP and Authorization](https://auth0.com/blog/an-introduction-to-mcp-and-authorization/)
- [Understanding OAuth2 and Identity-Aware MCP Servers](https://heeki.medium.com/understanding-oauth2-and-implementing-identity-aware-mcp-servers-221a06b1a6cf)
- [MCP Server Best Practices for 2026](https://www.cdata.com/blog/mcp-server-best-practices-2026)

### Google Workspace MCP Implementations (MEDIUM Confidence)
- [Google Workspace MCP by taylorwilsdon](https://github.com/taylorwilsdon/google_workspace_mcp) - Most feature-complete, .dxt bundle
- [workspacemcp.com](https://workspacemcp.com) - Production Google Workspace MCP
- [Google Workspace MCP by aaronsb](https://github.com/aaronsb/google-workspace-mcp) - Docker-based
- [mcp-google-workspace by j3k0](https://github.com/j3k0/mcp-google-workspace) - Gmail + Calendar focus
- [Google Drive MCP Server by Anthropic](https://www.pulsemcp.com/servers/modelcontextprotocol-gdrive)

### Google Workspace OAuth (HIGH Confidence)
- [Configure OAuth Consent Screen](https://developers.google.com/workspace/guides/configure-oauth-consent) - Official Google docs
- [OAuth 2.0 Scopes for Google APIs](https://developers.google.com/identity/protocols/oauth2/scopes) - Complete scope list
- [Choose Gmail API Scopes](https://developers.google.com/workspace/gmail/api/auth/scopes) - Gmail-specific guidance
- [Granular OAuth Consent (Jan 2026)](https://medium.com/google-cloud/what-google-workspace-developers-need-to-know-about-granular-oauth-consent-ded63df85bf3)
- [Google OAuth Verification Guide 2025](https://medium.com/@info.brightconstruct/the-real-oauth-journey-getting-a-google-workspace-add-on-verified-fc31bc4c9858)

### Security & Common Pitfalls (HIGH Confidence)
- [MCP Security: Risks and Controls - Red Hat](https://www.redhat.com/en/blog/model-context-protocol-mcp-understanding-security-risks-and-controls)
- [MCP Security Exposed - Palo Alto Networks](https://live.paloaltonetworks.com/t5/community-blogs/mcp-security-exposed-what-you-need-to-know-now/ba-p/1227143)
- [MCP Security Explained - Docker](https://www.docker.com/blog/mcp-security-explained/)
- [Top 6 MCP Vulnerabilities - Descope](https://www.descope.com/blog/post/mcp-vulnerabilities)
- [MCP Security Checklist 2026](https://www.networkintelligence.ai/blogs/model-context-protocol-mcp-security-checklist/)
- [MCP Security Best Practices](https://research.aimultiple.com/mcp-security/)

### Transport & Cursor Integration (MEDIUM Confidence)
- [MCP SSE Transport](https://mcp-framework.com/docs/Transports/sse/)
- [How to use MCP servers in Cursor](https://cursor.fan/tutorial/HowTo/how-to-use-mcp-servers-sse-url/)
- [Build Remote MCP Server with FastMCP SSE](https://medium.com/@texasdave2/build-a-fully-remote-mcp-tool-server-with-fastmcp-sse-transport-and-cursor-integration-ec4ab0a3f01e)
- [Cursor MCP Documentation](https://docs.cursor.com/context/model-context-protocol)

### Production Deployment (MEDIUM Confidence)
- [MCP Server Best Practices for 2026](https://www.cdata.com/blog/mcp-server-best-practices-2026)
- [Deploy MCP Server to Production - Milvus](https://milvus.io/ai-quick-reference/whats-the-best-way-to-deploy-an-model-context-protocol-mcp-server-to-production)
- [Build and Deploy MCP Server - Northflank](https://northflank.com/blog/how-to-build-and-deploy-a-model-context-protocol-mcp-server)
- [MCP System Requirements - Milvus](https://milvus.io/ai-quick-reference/what-are-the-system-requirements-for-deploying-model-context-protocol-mcp-servers)
