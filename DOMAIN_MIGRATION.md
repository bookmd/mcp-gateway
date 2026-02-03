# Domain Migration: mgw.ext.getvim.com

## Current Status

✅ **CNAME Record Created** - `mgw.ext.getvim.com` → ALB  
🔄 **ACM Certificate Requested** - Pending DNS validation  
⏳ **Infrastructure Update** - Ready to deploy

---

## Action Required from Manager

### Add DNS Validation Record for SSL Certificate

To validate the SSL certificate for `mgw.ext.getvim.com`, add this DNS record:

**Record Details:**
```
Type: CNAME
Name: _88a71d27348da9c599099608b70dd2da.mgw.ext.getvim.com
Value: _ff0fa9c12d3d4cd80e015d22929a2be8.jkddzztszm.acm-validations.aws.
TTL: Auto or 300
```

**Where to add it:**
- Same DNS management interface where you created the `mgw.ext` CNAME
- This is a one-time validation record
- AWS will automatically validate the certificate once the record is added

**How to check if it's working:**
```bash
dig _88a71d27348da9c599099608b70dd2da.mgw.ext.getvim.com CNAME
```

---

## What Happens Next (After DNS Validation)

Once your manager adds the validation record (usually takes 5-30 minutes):

### 1. Certificate Status
Check certificate validation:
```bash
AWS_PROFILE=corp-admin aws acm describe-certificate \
  --certificate-arn arn:aws:acm:us-east-1:232282424912:certificate/943e6cda-c88e-4d9b-9b53-b3916bdea88e \
  --region us-east-1 \
  --query 'Certificate.Status'
```

Wait for status to be: `"ISSUED"`

### 2. Update Google OAuth Redirect URI

**Google Cloud Console:**
1. Go to: https://console.cloud.google.com/apis/credentials
2. Find your OAuth 2.0 Client ID
3. Update **Authorized redirect URIs:**
   - Remove: `https://vim-mcp-gateway.com/auth/callback`
   - Add: `https://mgw.ext.getvim.com/auth/callback`

### 3. Deploy Updated Infrastructure

**Command:**
```bash
cd infra
export AWS_PROFILE=corp-admin
export GOOGLE_REDIRECT_URI="https://mgw.ext.getvim.com/auth/callback"
export ALLOWED_DOMAIN="getvim.com"
cdk deploy --require-approval never
```

This will:
- Update ALB to use new certificate
- Update environment variables
- Deploy new container with updated redirect URI

### 4. Update User Configuration

Users need to update their `~/.cursor/mcp.json`:

**Old:**
```json
{
  "mcpServers": {
    "vim-workspace": {
      "url": "https://vim-mcp-gateway.com/mcp/sse"
    }
  }
}
```

**New:**
```json
{
  "mcpServers": {
    "vim-workspace": {
      "url": "https://mgw.ext.getvim.com/mcp/sse"
    }
  }
}
```

---

## URLs After Migration

| Service | Old URL | New URL |
|---------|---------|---------|
| MCP Endpoint | `https://vim-mcp-gateway.com/mcp/sse` | `https://mgw.ext.getvim.com/mcp/sse` |
| Login Page | `https://vim-mcp-gateway.com/auth/login` | `https://mgw.ext.getvim.com/auth/login` |
| OAuth Callback | `https://vim-mcp-gateway.com/auth/callback` | `https://mgw.ext.getvim.com/auth/callback` |
| Health Check | `https://vim-mcp-gateway.com/health` | `https://mgw.ext.getvim.com/health` |

---

## Verification Steps (After Deployment)

1. **Test HTTPS:**
   ```bash
   curl https://mgw.ext.getvim.com/health
   ```
   Expected: `{"status":"ok",...}`

2. **Test Login Page:**
   Open in browser: https://mgw.ext.getvim.com/auth/login
   
3. **Test MCP Connection:**
   Update `mcp.json` and restart Cursor

---

## Rollback Plan (If Issues)

If anything goes wrong, rollback by:

1. **Revert certificate in CDK:**
   ```typescript
   // Change back to old certificate ARN
   'arn:aws:acm:us-east-1:232282424912:certificate/371c575c-15e9-4545-9128-4d5ade6cdeba'
   ```

2. **Revert Google OAuth redirect URI** to old domain

3. **Re-deploy:**
   ```bash
   export GOOGLE_REDIRECT_URI="https://vim-mcp-gateway.com/auth/callback"
   cdk deploy
   ```

---

## Timeline

1. **Now:** Manager adds DNS validation record
2. **5-30 min:** AWS validates certificate (automatic)
3. **Now:** Update Google OAuth settings (manual, 2 min)
4. **5-10 min:** Deploy infrastructure update
5. **Done:** Service running on new domain

**Total estimated time:** 30-45 minutes

---

## Old Domain (vim-mcp-gateway.com)

**Options:**
1. **Keep it running** - Both domains work simultaneously
2. **Redirect it** - Add redirect from old to new
3. **Deprecate it** - Eventually remove after all users migrate

**Recommendation:** Keep both running for 1-2 weeks while users migrate.

---

## Need Help?

- **Check certificate status:** Run command in Step 1 above
- **Check DNS propagation:** `dig mgw.ext.getvim.com`
- **Check validation record:** `dig _88a71d27348da9c599099608b70dd2da.mgw.ext.getvim.com CNAME`
- **View ALB logs:** CloudWatch Logs `/ecs/McpGatewayService`

---

**New Certificate ARN:**
```
arn:aws:acm:us-east-1:232282424912:certificate/943e6cda-c88e-4d9b-9b53-b3916bdea88e
```

**New Domain:**
```
mgw.ext.getvim.com
```

**Status:** Waiting for DNS validation record
