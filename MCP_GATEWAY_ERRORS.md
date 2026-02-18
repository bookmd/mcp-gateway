# MCP Gateway - Error Documentation

This document summarizes the errors encountered during MCP Gateway deployment and their solutions.

---

## 1. ALB Security Group - Port 443 Blocked

**Symptom:** Connection timeout errors when connecting to `mgw.ext.getvim.com`
```
Connect Timeout Error (attempted addresses: 18.235.245.108:443, 98.83.126.168:443, timeout: 10000ms)
```

**Cause:** The ALB security group only allowed port 80, not port 443 (HTTPS).

**Solution:**
```bash
aws ec2 authorize-security-group-ingress \
  --group-id sg-0406a5db5c1e7edce \
  --ip-permissions IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges='[{CidrIp=0.0.0.0/0}]' \
  --region us-east-1
```

---

## 2. Wrong SSL Certificate on HTTPS Listener

**Symptom:** SSL certificate mismatch - clients rejected the connection.

**Cause:** ALB HTTPS listener was using certificate for `vim-mcp-gateway.com` instead of `mgw.ext.getvim.com`.

**Solution:**
```bash
aws elbv2 modify-listener \
  --listener-arn <LISTENER_ARN> \
  --certificates CertificateArn=arn:aws:acm:us-east-1:232282424912:certificate/943e6cda-c88e-4d9b-9b53-b3916bdea88e \
  --region us-east-1
```

---

## 3. MCP Session Routing - In-Memory Sessions with Multiple Tasks

**Symptom:** "Session not found" errors when making MCP requests.

**Cause:** Two ECS tasks are running, but MCP sessions (live socket connections) are stored in-memory. ALB routes requests to different tasks, breaking sessions.

**Solution:** Enable ALB sticky sessions (industry-standard pattern for stateful connections like SSE/WebSocket).

```bash
# Get target group ARN
TARGET_GROUP_ARN=$(aws elbv2 describe-target-groups \
  --region us-east-1 \
  --query "TargetGroups[?contains(TargetGroupName, 'McpGateway')].TargetGroupArn" \
  --output text)

# Enable sticky sessions (1 hour)
aws elbv2 modify-target-group-attributes \
  --target-group-arn $TARGET_GROUP_ARN \
  --attributes Key=stickiness.enabled,Value=true \
               Key=stickiness.type,Value=lb_cookie \
               Key=stickiness.lb_cookie.duration_seconds,Value=3600 \
  --region us-east-1
```

**CDK Persistence:** Add to `infra/lib/fargate-stack.ts`:
```typescript
fargateService.targetGroup.setAttribute('stickiness.enabled', 'true');
fargateService.targetGroup.setAttribute('stickiness.type', 'lb_cookie');
fargateService.targetGroup.setAttribute('stickiness.lb_cookie.duration_seconds', '3600');
```

---

## 4. SSE Stream Disconnections - "TypeError: terminated"

**Symptom:** Cursor MCP connection drops repeatedly with error:
```
SSE stream disconnected, transport will reconnect automatically SSE stream disconnected: TypeError: terminated
Found 0 tools, 0 prompts, and 0 resources
```

**Date:** February 17, 2026

**Possible Causes:**

1. **ALB Idle Timeout** - Default is 60 seconds, should be 120+ for SSE
2. **ECS Task Restarts** - Container health check failures or deployments
3. **Cloudflare Timeout** - If using Cloudflare proxy, 100s timeout for SSE
4. **Session Loss** - Streamable HTTP sessions stored in-memory, lost on task restart

**Current Mitigations:**
- Keep-alive interval: 10 seconds (sends `: keep-alive\n\n` comment)
- Server timeouts: 5 minutes (connectionTimeout, keepAliveTimeout)
- ALB timeout: Should be 120s (verify with AWS console)

**Diagnostic Steps:**

1. Check ALB idle timeout:
```bash
aws elbv2 describe-load-balancer-attributes \
  --load-balancer-arn <ALB_ARN> \
  --region us-east-1 \
  --query "Attributes[?Key=='idle_timeout.timeout_seconds']"
```

2. Check ECS task stability:
```bash
aws ecs describe-services \
  --cluster McpGatewayStack-McpGatewayClusterF62BAB07-ReOuwDcNOL7x \
  --services McpGatewayStack-McpGatewayServiceA4E5E3B0-XMUJF6L137Fz \
  --region us-east-1 \
  --query "services[0].events[:5]"
```

3. Check CloudWatch logs for disconnects:
```bash
aws logs filter-log-events \
  --log-group-name /ecs/McpGatewayService \
  --filter-pattern "disconnect" \
  --start-time $(($(date +%s) - 3600))000 \
  --region us-east-1
```

**Potential Fixes:**

1. **Increase ALB timeout to 300s:**
```bash
aws elbv2 modify-load-balancer-attributes \
  --load-balancer-arn <ALB_ARN> \
  --attributes Key=idle_timeout.timeout_seconds,Value=300 \
  --region us-east-1
```

2. **Add Redis/DynamoDB session store** - Persist MCP sessions across task restarts

3. **Reduce keep-alive interval** - Currently 10s, could try 5s

4. **Check if Cloudflare is in the path** - May need to disable proxy for SSE endpoint

**Status:** Investigating

---

## Summary

| Issue | Status |
|-------|--------|
| Port 443 blocked | Resolved |
| Wrong SSL certificate | Resolved |
| Session routing (sticky sessions) | Resolved |
| SSE disconnections (TypeError: terminated) | Investigating |
