# CRITICAL FIX - Server Not Accessible (Feb 9, 2026)

## Issue Reported

MCP client in Cursor couldn't connect to the server:
```
Connect Timeout Error (attempted addresses: 18.235.245.108:443, 98.83.126.168:443, timeout: 10000ms)
```

## Root Causes Found

### 1. ⛔ **Missing Port 443 in ALB Security Group** (CRITICAL)
**Problem:** The Application Load Balancer security group (`sg-0406a5db5c1e7edce`) only allowed port 80, **NOT port 443 (HTTPS)**.

**Impact:** All HTTPS connections to `mgw.ext.getvim.com` were blocked by the firewall.

**Why it happened:** Recent CDK deployment didn't properly configure the security group for HTTPS.

**Fix Applied:**
```bash
aws ec2 authorize-security-group-ingress \
  --group-id sg-0406a5db5c1e7edce \
  --ip-permissions IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges='[{CidrIp=0.0.0.0/0}]' \
  --region us-east-1
```

**Result:** Port 443 now open, HTTPS connections can reach ALB ✅

---

### 2. 🔐 **Wrong SSL Certificate on HTTPS Listener** (CRITICAL)
**Problem:** The ALB HTTPS listener was using certificate for `vim-mcp-gateway.com` instead of `mgw.ext.getvim.com`.

**Impact:** SSL certificate mismatch - browsers/clients rejected the connection.

**Certificate Details:**
- **Wrong cert:** `371c575c-15e9-4545-9128-4d5ade6cdeba` (vim-mcp-gateway.com)
- **Correct cert:** `943e6cda-c88e-4d9b-9b53-b3916bdea88e` (mgw.ext.getvim.com)

**Fix Applied:**
```bash
aws elbv2 modify-listener \
  --listener-arn <LISTENER_ARN> \
  --certificates CertificateArn=arn:aws:acm:us-east-1:232282424912:certificate/943e6cda-c88e-4d9b-9b53-b3916bdea88e \
  --region us-east-1
```

**Result:** SSL certificate now matches domain ✅

---

## Verification

After fixes:
```bash
$ curl https://mgw.ext.getvim.com/health
{"status":"ok","timestamp":"2026-02-09T18:26:32.475Z"}

$ curl https://mgw.ext.getvim.com/.well-known/oauth-authorization-server
{
  "issuer": "https://mgw.ext.getvim.com",
  "authorization_endpoint": "https://mgw.ext.getvim.com/oauth/authorize",
  ...
}
```

**SSL Certificate:**
```
Subject: CN=mgw.ext.getvim.com
Subject Alternative Name: DNS:mgw.ext.getvim.com
Valid: Feb 2, 2026 - Mar 3, 2027
```

---

## Timeline

| Time | Event |
|------|-------|
| ~4 hours ago | CDK deployment (revision 33) |
| ~18:21 UTC | User reports MCP won't connect |
| 18:25 UTC | Diagnosed: Port 443 blocked + wrong certificate |
| 18:26 UTC | Fixed: Added port 443 to security group |
| 18:26 UTC | Fixed: Updated SSL certificate |
| 18:26 UTC | Verified: Server accessible ✅ |

---

## Why This Happened

**Recent CDK Deployment Issues:**

The recent CDK deployment (creating revision 33) had two critical misconfigurations:

1. **Security Group:** The CDK pattern `ApplicationLoadBalancedFargateService` should automatically create security groups with port 443 allowed, but something went wrong in the deployment.

2. **Certificate:** The ALB was using an old certificate ARN that wasn't updated when the domain changed from `vim-mcp-gateway.com` to `mgw.ext.getvim.com`.

**CDK Code vs Reality:**

The CDK code in `infra/lib/fargate-stack.ts` was **correct**:
```typescript
listenerPort: 443,
protocol: elbv2.ApplicationProtocol.HTTPS,
certificate: certificate,  // Correct ARN
```

But the deployed resources didn't match. This suggests:
- Partial deployment failure
- Manual modifications that weren't tracked
- CloudFormation drift

---

## Prevention

### Immediate Actions Needed:

1. **Fix CDK Stack Drift:**
   ```bash
   cd infra
   cdk diff  # Check for drift
   cdk deploy --force  # Re-deploy to fix security group
   ```

2. **Add Monitoring:**
   - CloudWatch alarm on ALB unhealthy target count
   - Synthetic monitoring (ping health endpoint every 5min)
   - Alert on SSL certificate expiry

3. **Document Domain Migration:**
   - Create checklist for domain changes
   - Verify security groups, certificates, DNS

### Long-term:

1. **Deployment Verification Script:**
   ```bash
   #!/bin/bash
   # After CDK deploy, verify:
   # - Port 443 open in security group
   # - Correct SSL certificate on HTTPS listener
   # - Health endpoint responds with 200
   # - OAuth discovery endpoint accessible
   ```

2. **Infrastructure Tests:**
   - Add automated tests to verify ALB configuration
   - Check security group rules
   - Validate SSL certificate matches domain

---

## Current Status

✅ **RESOLVED** - Server is fully accessible

**What's working:**
- HTTPS connections on port 443
- SSL certificate valid for `mgw.ext.getvim.com`
- Health checks passing
- OAuth discovery endpoint responding
- MCP client should be able to connect

**Next steps:**
1. User should test MCP connection in Cursor
2. Monitor logs for successful connections
3. Fix CDK stack drift to prevent recurrence

---

## Commands for Monitoring

**Check recent connections:**
```bash
AWS_PROFILE=corp-admin aws logs filter-log-events \
  --log-group-name McpGatewayStack-McpGatewayServiceTaskDefwebLogGroupE020C6D5-rxJLR91SlWeK \
  --region us-east-1 \
  --start-time $(($(date +%s) - 600))000 \
  --filter-pattern "incoming request" \
  --output json | jq -r '.events[] | .message' | tail -20
```

**Verify security group:**
```bash
AWS_PROFILE=corp-admin aws ec2 describe-security-groups \
  --group-ids sg-0406a5db5c1e7edce \
  --region us-east-1 \
  --query 'SecurityGroups[0].IpPermissions[?FromPort==`443`]'
```

**Verify SSL certificate:**
```bash
echo | openssl s_client -connect mgw.ext.getvim.com:443 \
  -servername mgw.ext.getvim.com 2>/dev/null | \
  openssl x509 -noout -subject -ext subjectAltName
```

---

## Summary

Two critical infrastructure misconfigurations from recent CDK deployment prevented all client connections:
1. Port 443 blocked in security group
2. Wrong SSL certificate on HTTPS listener

Both issues fixed manually. Server now fully accessible. User should be able to connect from Cursor.

**Fix Duration:** < 5 minutes  
**Impact Duration:** ~4 hours (from deployment until fix)
