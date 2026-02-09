# MCP Gateway - Technical Architecture & Connection Stability Analysis

**Date**: February 8, 2026
**Status**: Production - Experiencing connection stability issues
**Severity**: High - Affecting all users

---

## Executive Summary

The MCP Gateway is experiencing persistent connection drops after approximately 60 seconds, despite multiple attempted fixes. This document provides a comprehensive analysis of the architecture, network path, timeout layers, and root causes.

---

## 1. System Architecture

### 1.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                          CLIENT SIDE                                 │
│                                                                       │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ Cursor IDE (macOS/Windows/Linux)                             │   │
│  │  - MCP Client SDK                                            │   │
│  │  - Streamable HTTP transport (primary)                       │   │
│  │  - SSE transport (fallback)                                  │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   │ HTTPS (443)
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                          DNS LAYER                                   │
│                                                                       │
│  Domain: mgw.ext.getvim.com                                         │
│  Provider: Cloudflare                                               │
│  Status: DNS-only (gray cloud) - Proxy DISABLED                     │
│  Resolves to: ALB (AWS IPs)                                         │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      AWS INFRASTRUCTURE                              │
│                                                                       │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │ Application Load Balancer (ALB)                            │    │
│  │  - Region: us-east-1                                       │    │
│  │  - Protocol: HTTPS (ACM certificate)                       │    │
│  │  - Idle Timeout: 300 seconds (recently increased)          │    │
│  │  - Health Check: /health (30s interval)                    │    │
│  └────────────────────────────────────────────────────────────┘    │
│                                   │                                  │
│                                   ▼                                  │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │ ECS Fargate Service                                        │    │
│  │  - Cluster: McpGatewayCluster                              │    │
│  │  - Platform: Fargate 1.4.0                                 │    │
│  │  - CPU: 512 (0.5 vCPU)                                     │    │
│  │  - Memory: 1024 MB                                         │    │
│  │  - Desired Count: 1                                        │    │
│  │  - Network Mode: awsvpc                                    │    │
│  │  - Subnets: Public (with auto-assign public IP)           │    │
│  │                                                             │    │
│  │  ┌──────────────────────────────────────────────────┐     │    │
│  │  │ Container: mcp-gateway                           │     │    │
│  │  │  - Base Image: node:22-alpine                    │     │    │
│  │  │  - Port: 3000                                     │     │    │
│  │  │  - Framework: Fastify                             │     │    │
│  │  │  - Task Definition: Revision 29 (current)        │     │    │
│  │  │                                                    │     │    │
│  │  │  Application Stack:                               │     │    │
│  │  │  ┌────────────────────────────────────────────┐  │     │    │
│  │  │  │ Fastify Server                             │  │     │    │
│  │  │  │  - connectionTimeout: default (60s?)       │  │     │    │
│  │  │  │  - keepAliveTimeout: default (5s?)         │  │     │    │
│  │  │  │  - requestTimeout: default (0)             │  │     │    │
│  │  │  └────────────────────────────────────────────┘  │     │    │
│  │  │  ┌────────────────────────────────────────────┐  │     │    │
│  │  │  │ MCP Server                                 │  │     │    │
│  │  │  │  - Streamable HTTP transport               │  │     │    │
│  │  │  │  - SSE transport (with 15s keepalive)      │  │     │    │
│  │  │  │  - 13 registered tools                     │  │     │    │
│  │  │  └────────────────────────────────────────────┘  │     │    │
│  │  └──────────────────────────────────────────────────┘     │    │
│  └────────────────────────────────────────────────────────────┘    │
│                                                                       │
│  Supporting Services:                                                │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │ DynamoDB                                                   │    │
│  │  - mcp-gateway-sessions (session store)                   │    │
│  │  - mcp-gateway-tokens (encrypted tokens)                  │    │
│  └────────────────────────────────────────────────────────────┘    │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │ KMS                                                        │    │
│  │  - Key: 01643f79-9643-45b3-bc56-868b1980e684              │    │
│  │  - Key: afd7365b-7a3a-4ae6-97a6-3dcd0ec9a94a              │    │
│  └────────────────────────────────────────────────────────────┘    │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │ Secrets Manager                                            │    │
│  │  - mcp-gateway/google-oauth                                │    │
│  │  - mcp-gateway/session-secret                              │    │
│  └────────────────────────────────────────────────────────────┘    │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │ CloudWatch Logs                                            │    │
│  │  - Log Group: McpGatewayServiceTaskDefwebLogGroup...      │    │
│  │  - Retention: 7 days                                       │    │
│  └────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
```

### 1.2 Connection Flow

#### Streamable HTTP Transport (Primary)

```
1. Client initiates connection
   POST /mcp/sse (Bearer token)
   
2. Server authenticates via JWT token
   - Validates token
   - Extracts user context
   
3. Server checks for existing transport
   - If exists: reuse transport by sessionId
   - If new: create StreamableHTTPServerTransport
   
4. Register transport with MCP server
   - Connect transport to MCP server
   - Register in activeTransports map
   
5. Handle request/response cycle
   - transport.handleRequest()
   - Return response
   
6. Connection lifecycle
   - Client sends periodic POST requests
   - Server reuses transport sessionId
   - No explicit keepalive needed (stateless HTTP)
```

#### SSE Transport (Fallback)

```
1. Client initiates connection
   GET /mcp/sse (Bearer token)
   
2. Server sets SSE headers
   Content-Type: text/event-stream
   Cache-Control: no-cache
   Connection: keep-alive
   
3. Create SSE transport
   - SSEServerTransport with reply.raw stream
   - Connect to MCP server
   
4. Start keepalive interval (15 seconds)
   setInterval(() => reply.raw.write(': keep-alive\n\n'), 15000)
   
5. Listen for client disconnect
   request.raw.on('close', () => cleanup())
   
6. Long-lived connection
   - Client keeps single GET request open
   - Server sends SSE events
   - Keepalive prevents timeout
```

---

## 2. Current Issues

### 2.1 Reported Symptoms

**Primary Issue**: Connections disconnect after approximately **60 seconds**

**Evidence**:
- Cursor logs show: "SSE stream disconnected, transport will reconnect automatically"
- Pattern: Disconnects happen at roughly 1-minute intervals
- After reconnect: Tools disappear (shows 0 tools instead of 13)
- Occasional 502 Bad Gateway errors

**User Impact**:
- Frequent reconnections disrupt workflow
- Loss of tool availability after reconnect
- Unpredictable connection stability

### 2.2 Observed Patterns

From Cursor logs:
```
2026-02-08 15:13:49 - SSE stream disconnected (1 minute after connect)
2026-02-08 15:16:44 - Reconnect, 0 tools found
2026-02-08 15:18:44 - 502 Bad Gateway
2026-02-08 15:20:45 - SSE stream disconnected (2 minutes after connect)
2026-02-08 15:21:43 - Reconnect, 0 tools found
... pattern repeats
```

From server logs:
```
[MCP] Client disconnected: conn-xxx after 389s (6.5 minutes)
[MCP] Client disconnected: conn-xxx after 4688s (78 minutes)
```

**Discrepancy**: Server logs show long-lived connections (6-78 minutes), but clients report 60-second disconnects.

---

## 3. Timeout Layers Analysis

### 3.1 All Possible Timeout Points

| Layer | Component | Timeout Value | Can Be Root Cause? |
|-------|-----------|---------------|-------------------|
| **Client Side** | Cursor MCP Client | Unknown | ⚠️ Possible |
| | Operating System TCP | ~60-120s default | ⚠️ Possible |
| **Network** | ISP/Firewall | Variable | ⚠️ Possible |
| | VPN (if any) | Variable | ⚠️ Possible |
| **DNS/CDN** | Cloudflare Proxy | ~100s (DISABLED now) | ✅ Fixed |
| **AWS - External** | ALB Idle Timeout | 300s (was 120s) | ✅ Fixed |
| | ALB Target Connection | 300s | ✅ Fixed |
| **AWS - Container** | Docker/containerd | No timeout | ❌ No |
| | ECS Agent | No timeout | ❌ No |
| **Application** | Fastify connectionTimeout | 60s (default) | ⚠️ **LIKELY** |
| | Fastify keepAliveTimeout | 5s (default) | ⚠️ **LIKELY** |
| | Fastify requestTimeout | 0 (disabled) | ❌ No |
| | Node.js HTTP Server | Inherits from Fastify | ⚠️ **LIKELY** |
| | SSE Keepalive Interval | 15s | ✅ OK |
| **Backend Services** | DynamoDB | N/A (stateless) | ❌ No |
| | KMS | N/A (stateless) | ❌ No |

### 3.2 Most Likely Root Cause

**Fastify's default `connectionTimeout` of 60 seconds**

```javascript
// Current configuration (Revision 29)
const app = Fastify({
  logger: { level: 'info' }
  // No timeout configuration = uses defaults
});

// Fastify defaults:
// - connectionTimeout: 0 (no timeout) on Node.js 18.18.0+
// - keepAliveTimeout: 72000ms (72s) previously, now 5000ms (5s)
// - requestTimeout: 0 (disabled)
```

**However**: Fastify v4+ changed timeout behavior. Need to verify actual version in use.

---

## 4. Root Cause Analysis

### 4.1 The 60-Second Mystery

**Hypothesis 1: Fastify Default Timeout** ⭐ **MOST LIKELY**
- Fastify historically had a 60s connection timeout
- Even with `connectionTimeout: 0`, underlying Node.js http.Server might enforce timeouts
- For SSE, the connection stays open but might hit timeout anyway

**Evidence**:
- Exact 60-second pattern
- Server logs don't show disconnects at 60s (they happen later)
- This suggests **client-side timeout perception** vs **server-side reality**

**Hypothesis 2: Client-Side Timeout**
- Cursor MCP client has built-in 60s timeout
- Client closes connection, server doesn't notice immediately
- This would explain the discrepancy

**Evidence**:
- Cursor logs show exact timing
- Server logs show different timing
- No error logs on server side

**Hypothesis 3: Intermediate Proxy/Firewall**
- Corporate firewall, ISP, or VPN timing out idle connections
- Common default: 60 seconds for stateful inspection

**Evidence**:
- Consistent 60s timing
- Affects multiple users
- Not specific to one network

### 4.2 The "0 Tools" Problem

**Issue**: After reconnect, `Found 0 tools` instead of 13

**Analysis**:
```javascript
// src/server.ts - Handlers registered at startup
const mcpServer = initMcpServer();
registerMcpHandlers(mcpServer); // Registers 13 tools

// src/routes/sse.ts - Each connection
await mcpServer.connect(transport); // Connects transport to SAME server
```

**Root Cause**: Unknown
- Tools should persist across transports (they're registered once on the server)
- Possible SDK issue with `listTools()` after reconnect
- Need more investigation

### 4.3 Failed Deployment Investigation

**Issue**: Revisions 30 & 31 fail to start with:
```
Error: connect ETIMEDOUT 172.253.63.84:443
```

**Analysis**:
- IP `172.253.63.84` = Google API endpoint
- Error occurs during container startup (before health check)
- Revision 29 works fine
- No code changes that would cause network calls at startup

**Possible Causes**:
1. **Docker build difference**: Different base image layers
2. **Timing issue**: Revision 29 was "lucky" with network timing
3. **ECS task placement**: New tasks on hosts with connectivity issues
4. **NPM package installation**: One of the dependencies making network calls

**Resolution**: Rolled back to Revision 29 (working)

---

## 5. Connection Timing Analysis

### 5.1 Expected vs Actual

| Metric | Expected | Client Reports | Server Reports | Gap |
|--------|----------|----------------|----------------|-----|
| Connection Duration | 5+ minutes | ~60 seconds | 6-78 minutes | **Huge** |
| Disconnect Pattern | Rare | Every 1-3 min | Rare | **Discrepancy** |
| Reconnect Success | Immediate | Works but 0 tools | N/A | **Problem** |

### 5.2 Timeline of Fixes Attempted

| Fix | Component Changed | Expected Impact | Actual Impact |
|-----|-------------------|-----------------|---------------|
| Cloudflare DNS-only | DNS layer | Remove 100s proxy timeout | ✅ Helped slightly |
| SSE keepalive 30s→15s | Application | More aggressive pinging | ⚠️ Minimal |
| ALB timeout 120s→300s | Load balancer | Remove 2-min limit | ⚠️ TBD |
| SSE keepalive 15s→10s | Application | Even more aggressive | ❌ Failed to deploy |
| Fastify timeout config | Application | Remove 60s limit | ❌ Failed to deploy |
| SSE headers explicit | Application | HTTP keep-alive | ❌ Failed to deploy |

---

## 6. Technical Gaps & Questions

### 6.1 Missing Information

**Fastify Version & Configuration**:
- Need to verify actual Fastify version in package.json
- Need to check Node.js version (affects default timeouts)
- Current defaults unknown

**Cursor MCP Client Behavior**:
- Does Cursor have client-side timeout?
- How does Cursor detect "disconnected"?
- Does Cursor actually see errors or just silence?

**Network Path**:
- Are users behind corporate firewalls?
- Any VPN usage?
- Client operating systems

**MCP SDK Behavior**:
- How does `listTools()` work after transport reconnect?
- Is there state that doesn't persist?
- SDK version compatibility

### 6.2 Observability Gaps

**Missing Metrics**:
- Active connection count over time
- Connection duration histogram
- Disconnect reason categorization
- Client-side logs correlation

**Missing Logs**:
- Explicit keepalive send/receive confirmation
- Transport state transitions
- SDK internal errors

---

## 7. Proper Solutions (Not Band-Aids)

### 7.1 Immediate Actions

**1. Verify Fastify Configuration** ⭐
```bash
# Check package.json for versions
cat package.json | jq '.dependencies.fastify'

# Check actual timeout values in production
# Add logging to server.ts startup
```

**Action**: Add explicit logging of Fastify config at startup

**2. Instrument Connection Lifecycle**
```javascript
// Add detailed logging:
- When connection established (with timestamp)
- Every keepalive sent/received
- When client closes (with duration)
- Transport state changes
```

**Action**: Create comprehensive connection audit trail

**3. Test with Direct ALB Access**
```bash
# Bypass DNS entirely, test with ALB directly
curl -H "Host: mgw.ext.getvim.com" https://<ALB-DNS>:443/health
```

**Action**: Isolate DNS/CDN as variable

### 7.2 Short-Term Fixes

**Option A: Explicit Fastify Timeout Configuration**
```javascript
const app = Fastify({
  logger: { level: 'info' },
  connectionTimeout: 0, // Disable
  keepAliveTimeout: 300000, // 5 minutes
  // BUT: Test in non-prod first!
});
```

**Pros**: Direct fix for suspected root cause
**Cons**: Causes startup failures (needs investigation)

**Option B: HTTP/2 Instead of HTTP/1.1**
```javascript
const app = Fastify({
  http2: true,
  https: {...}
});
```

**Pros**: Better keepalive handling
**Cons**: Requires SSL cert in container, complex setup

**Option C: WebSocket Instead of SSE**
```javascript
// Replace SSE with WebSocket transport
// WebSocket has better keepalive built-in
```

**Pros**: Purpose-built for long connections
**Cons**: Major code change, MCP SDK may not support

### 7.3 Long-Term Solutions

**1. Implement Proper Keepalive at ALL Layers**

```javascript
// Application layer
app.server.keepAliveTimeout = 300000; // 5 minutes
app.server.headersTimeout = 310000; // Slightly higher

// TCP layer
socket.setKeepAlive(true, 10000); // 10s keepalive

// ALB layer
// Already done: 300s idle timeout
```

**2. Implement Connection Health Monitoring**

```javascript
// Add heartbeat system
setInterval(() => {
  for (const [id, transport] of activeTransports) {
    if (!transport.isAlive()) {
      console.warn(`Transport ${id} appears dead, cleaning up`);
      cleanup(id);
    }
  }
}, 30000);
```

**3. Implement Graceful Reconnection**

```javascript
// On disconnect, preserve session state
const sessionCache = new Map();

// On reconnect with same session
if (sessionCache.has(sessionId)) {
  const state = sessionCache.get(sessionId);
  transport.restore(state); // Preserve tool list, etc.
}
```

**4. Move to Dedicated WebSocket Infrastructure**

```
┌─────────────┐
│   Cursor    │
└──────┬──────┘
       │ WebSocket (ws://)
       ▼
┌─────────────────┐
│ API Gateway     │ ← Better for WebSocket
│ (WebSocket API) │ ← No idle timeout
└────────┬────────┘
         │
         ▼
    ┌────────┐
    │ Lambda │ ← Or keep ECS
    └────────┘
```

**5. Implement Circuit Breaker Pattern**

```javascript
// Detect repeated disconnects
if (reconnectCount > 3) {
  // Back off exponentially
  delay = Math.min(30000, 1000 * Math.pow(2, reconnectCount));
  await sleep(delay);
}
```

---

## 8. Recommended Action Plan

### Phase 1: Investigation (1-2 hours)

1. ✅ **Verify Current Configuration**
   - Check Fastify version
   - Check Node.js version  
   - Check actual timeout values

2. ✅ **Enhanced Logging**
   - Add connection lifecycle logs
   - Add keepalive send/receive logs
   - Add transport state logs

3. ✅ **Client-Side Testing**
   - Test with curl (eliminate Cursor variable)
   - Test with different networks
   - Monitor with tcpdump/Wireshark

### Phase 2: Targeted Fix (2-4 hours)

Based on Phase 1 findings:

**If Fastify timeout is root cause**:
- Fix timeout configuration properly
- Test in staging first
- Deploy carefully

**If client-side timeout is root cause**:
- Cannot fix (Cursor's behavior)
- Implement graceful reconnection instead
- Preserve tool list on reconnect

**If network timeout is root cause**:
- More aggressive keepalive (5-10s)
- Consider WebSocket upgrade
- Document network requirements

### Phase 3: Long-Term Stability (1-2 days)

1. ✅ **Implement comprehensive monitoring**
2. ✅ **Implement graceful reconnection**
3. ✅ **Consider WebSocket migration**
4. ✅ **Document architecture**
5. ✅ **Create runbooks**

---

## 9. Debugging Checklist

### 9.1 Information to Gather

- [ ] Fastify version from package.json
- [ ] Node.js version in container
- [ ] Actual Fastify timeout config values (log at startup)
- [ ] Client operating system(s)
- [ ] Network environment (corporate/home/VPN)
- [ ] Exact disconnect error message from Cursor
- [ ] Client-side logs during disconnect
- [ ] Server-side logs during disconnect
- [ ] TCP connection state (netstat during connection)
- [ ] ALB connection metrics (CloudWatch)

### 9.2 Tests to Run

- [ ] Keep connection open for 2 minutes with logging
- [ ] Force keepalive every 5s and monitor
- [ ] Test with curl + SSE client
- [ ] Test with direct ALB DNS (bypass Cloudflare entirely)
- [ ] Test from different networks
- [ ] Monitor TCP connection with tcpdump
- [ ] Check if issue is specific to SSE or also Streamable HTTP

---

## 10. Configuration Files Reference

### 10.1 Current ECS Task Definition (Revision 29 - Working)

```json
{
  "family": "McpGatewayStackMcpGatewayServiceTaskDefD65C6F52",
  "revision": 29,
  "containerDefinitions": [{
    "name": "web",
    "image": "232282424912.dkr.ecr.us-east-1.amazonaws.com/cdk-hnb659fds-container-assets-232282424912-us-east-1:keepalive-1770567538",
    "cpu": 0,
    "memory": null,
    "portMappings": [{
      "containerPort": 3000,
      "hostPort": 3000,
      "protocol": "tcp"
    }],
    "essential": true,
    "environment": [
      {"name": "GOOGLE_CLIENT_SECRET", "value": "<redacted>"},
      {"name": "AWS_REGION", "value": "us-east-1"},
      {"name": "PORT", "value": "3000"},
      {"name": "KMS_KEY_ID", "value": ""},
      {"name": "GOOGLE_CLIENT_ID", "value": "<redacted>"},
      {"name": "SESSION_SECRET", "value": "<redacted>"},
      {"name": "DYNAMODB_TABLE_NAME", "value": "mcp-gateway-sessions"},
      {"name": "NODE_ENV", "value": "production"},
      {"name": "ALLOWED_DOMAIN", "value": "getvim.com"},
      {"name": "GOOGLE_REDIRECT_URI", "value": "https://mgw.ext.getvim.com/auth/callback"}
    ],
    "logConfiguration": {
      "logDriver": "awslogs",
      "options": {
        "awslogs-group": "McpGatewayStack-McpGatewayServiceTaskDefwebLogGroupE020C6D5-rxJLR91SlWeK",
        "awslogs-region": "us-east-1",
        "awslogs-stream-prefix": "mcp-gateway"
      }
    }
  }],
  "cpu": "512",
  "memory": "1024"
}
```

### 10.2 Current Server Configuration

```javascript
// src/server.ts
const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info'
  }
  // NO EXPLICIT TIMEOUT CONFIGURATION
  // Using Fastify defaults
});
```

### 10.3 Current SSE Configuration

```javascript
// src/routes/sse.ts - GET /mcp/sse
const keepAliveInterval = setInterval(() => {
  reply.raw.write(': keep-alive\n\n');
}, 15000); // 15 seconds
```

---

## 11. Conclusion & Next Steps

### Key Findings

1. **Primary Suspect**: Fastify/Node.js default 60s connection timeout
2. **Secondary Issue**: Tool list doesn't persist across reconnects
3. **Observation**: Server-side connections last much longer than client reports
4. **Gap**: Significant observability and configuration gaps

### Immediate Next Steps

1. **DON'T**: Keep throwing random fixes at the problem
2. **DO**: Systematic investigation following Phase 1 checklist
3. **DO**: Add comprehensive logging first
4. **DO**: Test with controlled environment (curl, not Cursor)
5. **DO**: Gather actual configuration values
6. **THEN**: Apply targeted fix based on evidence

### Success Criteria

- Connections last 5+ minutes consistently
- No mysterious 60-second disconnects
- Tool list persists across reconnects (13 tools always)
- Comprehensive monitoring in place
- Clear understanding of root cause

---

## 12. Contact & Resources

**Repository**: https://github.com/bookmd/mcp-gateway
**AWS Account**: 232282424912 (Vim IT Corp)
**Region**: us-east-1
**Domain**: mgw.ext.getvim.com

**Key Commands**:
```bash
# Check logs
AWS_PROFILE=corp-admin aws logs filter-log-events \
  --log-group-name McpGatewayStack-McpGatewayServiceTaskDefwebLogGroupE020C6D5-rxJLR91SlWeK \
  --start-time $(($(date +%s) * 1000 - 300000))

# Check service status
AWS_PROFILE=corp-admin aws ecs describe-services \
  --cluster McpGatewayStack-McpGatewayClusterF62BAB07-ReOuwDcNOL7x \
  --service McpGatewayStack-McpGatewayServiceA4E5E3B0-XMUJF6L137Fz

# Check ALB timeout
AWS_PROFILE=corp-admin aws elbv2 describe-load-balancer-attributes \
  --load-balancer-arn arn:aws:elasticloadbalancing:us-east-1:232282424912:loadbalancer/app/McpGat-McpGa-Xypm6FSSJFFK/76a924b21de1c147
```

---

*End of Technical Analysis Document*
