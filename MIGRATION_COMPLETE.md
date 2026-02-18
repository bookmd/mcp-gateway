# ✅ Domain Migration Complete!

## New Domain: mgw.ext.getvim.com

**Migration Date:** February 3, 2026  
**Status:** ✅ LIVE AND WORKING

---

## What Was Done

### 1. SSL Certificate
- ✅ Requested new ACM certificate for `mgw.ext.getvim.com`
- ✅ DNS validation record added by manager
- ✅ Certificate issued and validated
- ✅ ALB updated to use new certificate

### 2. Infrastructure Updates
- ✅ Updated ALB HTTPS listener certificate
- ✅ Updated ECS task definition environment variables
- ✅ Deployed new task with correct `GOOGLE_REDIRECT_URI`
- ✅ Verified OAuth flow using new domain

### 3. Google OAuth
- ✅ Updated redirect URI in Google Cloud Console
- ✅ Application now redirects to: `https://mgw.ext.getvim.com/auth/callback`

---

## New URLs

| Service | URL |
|---------|-----|
| MCP Endpoint | `https://mgw.ext.getvim.com/mcp/sse` |
| Login Page | `https://mgw.ext.getvim.com/auth/login` |
| OAuth Callback | `https://mgw.ext.getvim.com/auth/callback` |
| Health Check | `https://mgw.ext.getvim.com/health` |
| OAuth Discovery | `https://mgw.ext.getvim.com/.well-known/oauth-authorization-server` |

---

## User Configuration

Users need to update their `~/.cursor/mcp.json`:

**New configuration:**
```json
{
  "mcpServers": {
    "vim-workspace": {
      "url": "https://mgw.ext.getvim.com/mcp/sse"
    }
  }
}
```

**Steps:**
1. Edit `~/.cursor/mcp.json`
2. Change URL from `vim-mcp-gateway.com` to `mgw.ext.getvim.com`
3. Restart Cursor
4. Browser will open for OAuth (use new domain)
5. MCP connection established

---

## Infrastructure Details

### SSL/TLS
- **Certificate ARN:** `arn:aws:acm:us-east-1:232282424912:certificate/943e6cda-c88e-4d9b-9b53-b3916bdea88e`
- **Domain:** `mgw.ext.getvim.com`
- **Validation:** DNS (CNAME)
- **Status:** Issued and Active

### Application Load Balancer
- **Name:** `McpGat-McpGa-Xypm6FSSJFFK`
- **DNS:** `McpGat-McpGa-Xypm6FSSJFFK-652751931.us-east-1.elb.amazonaws.com`
- **IPs:** `18.205.224.28`, `54.221.230.161`
- **HTTPS:** Port 443 with new certificate
- **HTTP:** Port 80 redirects to HTTPS

### ECS Service
- **Cluster:** `McpGatewayStack-McpGatewayClusterF62BAB07-ReOuwDcNOL7x`
- **Service:** `McpGatewayStack-McpGatewayServiceA4E5E3B0-XMUJF6L137Fz`
- **Task Definition:** `McpGatewayStackMcpGatewayServiceTaskDefD65C6F52:25`
- **Environment Variables:**
  - `GOOGLE_REDIRECT_URI=https://mgw.ext.getvim.com/auth/callback`
  - `ALLOWED_DOMAIN=getvim.com`

### DNS Configuration
- **Main Record:**
  - Type: CNAME
  - Name: `mgw.ext.getvim.com`
  - Value: ALB DNS name
  - Proxy: Yes (via Cloudflare)

- **Validation Record:**
  - Type: CNAME
  - Name: `_88a71d27348da9c599099608b70dd2da.mgw.ext.getvim.com`
  - Value: `_ff0fa9c12d3d4cd80e015d22929a2be8.jkddzztszm.acm-validations.aws.`
  - Proxy: No (DNS only)

---

## Verification Tests

All tests passing:

```bash
# Health check
curl https://mgw.ext.getvim.com/health
# ✅ {"status":"ok","timestamp":"..."}

# OAuth flow
curl -I https://mgw.ext.getvim.com/auth/login
# ✅ Redirects to Google with correct callback URL

# MCP discovery
curl https://mgw.ext.getvim.com/.well-known/oauth-authorization-server | jq
# ✅ Returns OAuth metadata

# DNS resolution
dig +short mgw.ext.getvim.com
# ✅ Resolves to ALB IPs
```

---

## Old Domain (vim-mcp-gateway.com)

**Status:** Still active (both domains work)

**Options:**
1. **Keep both active** - Users can migrate gradually
2. **Add redirect** - Redirect old domain to new
3. **Deprecate old** - Remove after migration period

**Recommendation:** Keep both active for 2-4 weeks to allow user migration.

---

## Troubleshooting

### If OAuth fails with "redirect_uri_mismatch"
1. Check Google Cloud Console has new URI
2. Verify task is running revision 25
3. Check environment variable in task definition

### If HTTPS doesn't work
1. Check certificate is attached to ALB listener
2. Verify DNS points to correct ALB
3. Check security group allows port 443

### If MCP connection fails
1. Verify user updated `mcp.json` with new URL
2. Check health endpoint is responding
3. Verify OAuth flow completes successfully

---

## Rollback Procedure (If Needed)

**To rollback to old domain:**

1. **Update ALB certificate:**
   ```bash
   AWS_PROFILE=corp-admin aws elbv2 modify-listener \
     --listener-arn arn:aws:elasticloadbalancing:us-east-1:232282424912:listener/app/McpGat-McpGa-Xypm6FSSJFFK/76a924b21de1c147/762d4aba4195f394 \
     --certificates CertificateArn=arn:aws:acm:us-east-1:232282424912:certificate/371c575c-15e9-4545-9128-4d5ade6cdeba \
     --region us-east-1
   ```

2. **Update Google OAuth redirect URI** back to old domain

3. **Update task definition** environment variable back to old domain

4. **Deploy:** Force new deployment with old configuration

---

## Next Steps

1. ✅ **Migration complete** - New domain live
2. 📢 **Notify users** - Share new `mcp.json` configuration
3. ⏳ **Monitor** - Watch for any OAuth/connection issues
4. 📅 **Deprecation** - Plan old domain sunset (2-4 weeks)

---

## Technical Notes

### Why Task Restart Was Needed
- Environment variables are loaded at container startup
- Even though task definition was updated, running container had cached old value
- Forced task stop/start ensured fresh environment

### Why CDK Deploy Failed
- CloudFormation stack was in `UPDATE_ROLLBACK_FAILED` state
- Manual update via AWS CLI bypassed CloudFormation
- Future updates should fix CloudFormation stack first

### Certificate Validation
- DNS validation requires CNAME record
- Validation typically takes 5-30 minutes
- Record must be "DNS only" (not proxied through Cloudflare)

---

**Deployment completed:** February 3, 2026, 18:01 UTC  
**New domain:** https://mgw.ext.getvim.com  
**Status:** ✅ Production Ready
