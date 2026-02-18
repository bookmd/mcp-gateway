# SSE Connection Reliability Design

**Date:** 2026-02-18
**Status:** Implemented

## Problem

MCP Gateway SSE connections were disconnecting after ~2.5 minutes of inactivity with error:
```
SSE stream disconnected: TypeError: terminated
```

The previous keep-alive (10 second interval) was not sufficient to prevent disconnections.

## Root Cause Analysis

1. **Keep-alive interval too long** - 10 seconds left room for network hiccups
2. **No connection health monitoring** - Couldn't detect stale/unhealthy connections
3. **No metrics** - Couldn't track connection patterns or diagnose issues
4. **No visibility** - No way to see connection state in real-time

## Solution Implemented

### 1. Aggressive Keep-Alive (5 seconds)

Reduced keep-alive interval from 10s to 5s to provide more safety margin:
- ALB timeout: 300s
- Cloudflare timeout: 100s
- Keep-alive: 5s (20x safety margin)

### 2. Connection Health Monitoring

Added health tracking for each SSE connection:
- `connectionHealthy` flag
- `lastKeepaliveAt` timestamp
- `keepaliveCount` counter
- Socket/stream state checking before each keep-alive

### 3. Metrics Collection

New metrics tracked:
- `totalConnections` - Lifetime connection count
- `totalDisconnections` - Lifetime disconnect count
- `totalKeepalivesSent` - Total keep-alives sent
- `totalKeepaliveErrors` - Keep-alive failures
- `longestConnectionMs` - Longest connection duration
- `averageConnectionMs` - Average connection duration
- `connectionDurations[]` - Last 100 durations for analysis

### 4. New Endpoints

**GET /mcp/health** - Public health check
```json
{
  "status": "healthy",
  "activeSseConnections": 1,
  "activeHttpSessions": 2,
  "unhealthyConnections": 0,
  "staleConnections": 0,
  "keepaliveIntervalMs": 5000,
  "metrics": {...}
}
```

**GET /mcp/status** - Authenticated detailed status (enhanced)
- Now includes SSE connection details
- Keep-alive counts per connection
- Connection health status

### 5. Enhanced Logging

Clear connection lifecycle logging:
```
[MCP/SSE] ══════════════════════════════════════════════════════
[MCP/SSE] NEW CONNECTION: sse-1739952000000-abc123
[MCP/SSE] User: user@example.com
[MCP/SSE] Time: 2026-02-18T08:00:00.000Z
[MCP/SSE] ══════════════════════════════════════════════════════

[MCP/SSE] Keepalive #12 for sse-xxx (user@example.com) - 60s connected

[MCP/SSE] ──────────────────────────────────────────────────────
[MCP/SSE] DISCONNECTED: sse-1739952000000-abc123
[MCP/SSE] Duration: 300s
[MCP/SSE] Keepalives sent: 60
[MCP/SSE] Was healthy: true
[MCP/SSE] ──────────────────────────────────────────────────────
```

## Files Changed

- `src/routes/sse.ts` - Enhanced keep-alive, metrics, health monitoring

## Monitoring

To check connection health:
```bash
curl https://mgw.ext.getvim.com/mcp/health
```

To check detailed status (requires auth):
```bash
curl -H "Authorization: Bearer <token>" https://mgw.ext.getvim.com/mcp/status
```

## Success Criteria

- [ ] SSE connections remain stable for 5+ minutes
- [ ] Keep-alives logged every minute (12th keepalive)
- [ ] /mcp/health shows "healthy" status
- [ ] No "TypeError: terminated" errors in Cursor logs

## Future Improvements

1. **CloudWatch Alarms** - Alert on unhealthy connections or high error rates
2. **Connection Retry Logic** - Automatic reconnection on server side
3. **Distributed Session Store** - Move sessions to Redis/DynamoDB for multi-task resilience
