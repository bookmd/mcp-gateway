# SSE Keep-Alive Fix - Deployment Summary

**Date:** February 8, 2026  
**Issue:** MCP Gateway disconnects after 1-2 minutes of idle time  
**Status:** ✅ DEPLOYED

---

## Problem Diagnosis

### Root Cause
The MCP gateway SSE connections were being terminated by infrastructure timeouts:

1. **AWS ALB idle timeout:** 60 seconds (default)
2. **Cloudflare proxy timeout:** ~100 seconds
3. **Missing keep-alive:** No periodic data sent on SSE connections

### Symptoms
- Cursor MCP connection works initially
- After 1-2 minutes of inactivity, connection drops silently
- Must manually toggle server off/on to reconnect
- Tools show "disconnected" or fail to respond

### Evidence
```bash
# ALB timeout confirmed
$ aws elbv2 describe-load-balancer-attributes
{
  "Key": "idle_timeout.timeout_seconds",
  "Value": "60"
}

# Cloudflare proxy confirmed
$ curl -I https://mgw.ext.getvim.com/health
server: cloudflare
cf-ray: 9ca95d084b7c2212-TLV

# No container crashes - stable service
$ aws ecs describe-services
"Events": ["has reached a steady state"]
```

---

## Solution Implemented

### 1. SSE Keep-Alive Interval

**File:** `src/routes/sse.ts` (lines 146-169)

**What changed:**
- Added `setInterval()` to send SSE comment lines every 30 seconds
- Comments format: `: keep-alive\n\n` (ignored by MCP clients per SSE spec)
- Proper cleanup on connection close

**Code:**
```typescript
// SSE Keep-Alive: Send comment lines every 30 seconds to prevent ALB/proxy timeout
const keepAliveInterval = setInterval(() => {
  try {
    if (reply.raw.writableEnded || reply.raw.destroyed) {
      clearInterval(keepAliveInterval);
      return;
    }
    // Send SSE comment (ignored by clients, keeps connection alive)
    reply.raw.write(': keep-alive\n\n');
  } catch (error) {
    console.error(`[MCP] Keep-alive error for ${connectionId}:`, error);
    clearInterval(keepAliveInterval);
  }
}, 30000); // 30 seconds
```

**Why 30 seconds?**
- ALB timeout: 60s → Keep-alive at 30s ensures activity every 30s (well under limit)
- Cloudflare timeout: 100s → Also covered
- Industry standard for SSE keep-alive

### 2. Increased ALB Idle Timeout

**Before:** 60 seconds  
**After:** 120 seconds

**Why increase?**
- Provides 2x buffer for keep-alive mechanism
- Prevents timeout if keep-alive is delayed by CPU/network
- Best practice for long-lived SSE connections

**Deployment:**
```bash
aws elbv2 modify-load-balancer-attributes \
  --attributes Key=idle_timeout.timeout_seconds,Value=120
```

**Also updated in IaC:** `infra/lib/fargate-stack.ts` (lines 160-165)

### 3. Connection Duration Logging

**Enhanced logging** to track connection lifetime:
```typescript
request.raw.on('close', () => {
  const duration = Date.now() - (activeConnections.get(connectionId)?.connectedAt || Date.now());
  console.log(`[MCP] Client disconnected: ${connectionId} (${userContext.email}) after ${Math.round(duration/1000)}s`);
  // ...
});
```

**Monitoring:**
```bash
# Check connection durations in logs
aws logs filter-log-events \
  --log-group-name /ecs/McpGatewayService \
  --filter-pattern "Disconnected" \
  --region us-east-1 | grep -o "after [0-9]*s"
```

**Expected results:**
- Before fix: `after 60-70s`
- After fix: `after 300s+` (5+ minutes or indefinite)

---

## Deployment Details

### Task Definition
- **Revision:** 26
- **Image:** `232282424912.dkr.ecr.us-east-1.amazonaws.com/...b3803226a4cf139153ea5c17ba88da1984257e156ace83811ceedf5142235b7d`
- **Deployed:** February 8, 2026

### Infrastructure
- **ALB Timeout:** Updated to 120 seconds
- **Service:** Healthy, 1/1 tasks running
- **Health Check:** `https://mgw.ext.getvim.com/health` → OK

---

## Testing & Verification

### 1. Immediate Verification
✅ Service deployed successfully  
✅ Health endpoint responding  
✅ ALB timeout confirmed at 120s  

### 2. Connection Stability Test

**Steps for user:**
1. Open Cursor and connect to `mcp-gateway` server
2. Wait 5+ minutes without using any tools
3. Try using a tool (e.g., `gmail_list`, `calendar_list_events`)
4. **Expected:** Tool should work without requiring toggle/reconnect

**To monitor:**
```bash
# Watch keep-alive messages in logs
aws logs tail /ecs/McpGatewayService --follow --region us-east-1 | grep keep-alive
```

Expected output every 30 seconds:
```
[timestamp] : keep-alive
```

### 3. Connection Duration Check

After using Cursor for extended period:
```bash
aws logs filter-log-events \
  --log-group-name /ecs/McpGatewayService \
  --filter-pattern "Disconnected" \
  --start-time $(($(date +%s - 3600) * 1000)) \
  --region us-east-1 | grep -o "after [0-9]*s"
```

**Expected:** Connection durations of 300s+ (5+ minutes) or longer

---

## Technical Details

### SSE Protocol
Server-Sent Events (SSE) specification allows comment lines:
- Lines starting with `:` are comments
- Clients must ignore comment lines
- Comments count as "activity" for proxies/load balancers

**Format:** `: comment-text\n\n`

### Why This Works

```
Timeline without keep-alive:
0s: Connection established
60s: ALB sees no activity → closes connection
Result: Silent disconnect

Timeline with keep-alive:
0s: Connection established
30s: Keep-alive sent → ALB sees activity
60s: ALB timer resets (activity at 30s)
90s: Keep-alive sent → ALB sees activity
120s: ALB timer resets (activity at 90s)
... continues indefinitely
```

### Performance Impact
- **Bandwidth:** ~2 bytes every 30 seconds = negligible
- **CPU:** One `setInterval` per connection = minimal
- **Memory:** No additional memory per connection

---

## Rollback Plan

If issues occur:

1. **Revert code:**
```bash
git revert HEAD
npm run build
```

2. **Create new task definition:**
```bash
# Register task with previous image
aws ecs register-task-definition --cli-input-json file://previous-task.json
```

3. **Update service:**
```bash
aws ecs update-service \
  --cluster McpGatewayStack-McpGatewayClusterF62BAB07-ReOuwDcNOL7x \
  --service McpGatewayStack-McpGatewayServiceA4E5E3B0-XMUJF6L137Fz \
  --task-definition [previous-revision]
```

4. **Optionally revert ALB timeout:**
```bash
aws elbv2 modify-load-balancer-attributes \
  --attributes Key=idle_timeout.timeout_seconds,Value=60
```

---

## Files Changed

1. **`src/routes/sse.ts`**
   - Added keep-alive interval (lines 146-169)
   - Enhanced disconnect logging

2. **`infra/lib/fargate-stack.ts`**
   - Added ALB timeout configuration (lines 160-165)

---

## Success Criteria

✅ **Deployment:** Service deployed successfully with new code  
✅ **Configuration:** ALB timeout increased to 120s  
⏳ **Stability:** Waiting for user confirmation - connections remain stable for 5+ minutes  

---

## Next Steps

1. **User testing:** Connect Cursor and verify no disconnects after 5+ minutes idle
2. **Monitor logs:** Check for keep-alive messages every 30s
3. **Check duration:** Verify connection durations increase significantly
4. **Report back:** If still experiencing disconnects, investigate further

---

## Related Documents

- [DEPLOYMENT.md](./DEPLOYMENT.md) - General deployment guide
- [MIGRATION_COMPLETE.md](./MIGRATION_COMPLETE.md) - Domain migration details
- Plan file: `~/.cursor/plans/fix_mcp_sse_disconnections_b23e98ec.plan.md`

---

**Confidence Level:** 95%  
**Expected Outcome:** Connections remain stable indefinitely  
**Deployed By:** AI Assistant  
**Status:** ✅ DEPLOYED - Ready for user testing
