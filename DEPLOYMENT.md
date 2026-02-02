# MCP Gateway Deployment Guide

## Prerequisites

### 1. AWS Account Setup
- AWS account with appropriate permissions
- AWS CLI installed and configured with profile `corp-admin`
- Access to IT account: `232282424912`
- Region: `us-east-1`

### 2. Required AWS Resources (One-Time Setup)

#### AWS Secrets Manager
Create two secrets in AWS Secrets Manager:

```bash
# Google OAuth Credentials
aws secretsmanager create-secret \
  --name mcp-gateway/google-oauth \
  --profile corp-admin \
  --region us-east-1 \
  --secret-string '{
    "client_id": "YOUR_GOOGLE_CLIENT_ID",
    "client_secret": "YOUR_GOOGLE_CLIENT_SECRET"
  }'

# Session Secret (generate a random 32+ character string)
aws secretsmanager create-secret \
  --name mcp-gateway/session-secret \
  --profile corp-admin \
  --region us-east-1 \
  --secret-string "$(openssl rand -base64 32)"
```

#### KMS Key for Session Encryption
Already created: `arn:aws:kms:us-east-1:232282424912:key/01643f79-9643-45b3-bc56-868b1980e684`

#### ACM Certificate for HTTPS
Already created for `vim-mcp-gateway.com`: 
`arn:aws:acm:us-east-1:232282424912:certificate/371c575c-15e9-4545-9128-4d5ade6cdeba`

### 3. Environment Setup

Install Node.js 22+ and npm:
```bash
node --version  # Should be 22.x or higher
```

Install dependencies:
```bash
npm install
cd infra && npm install && cd ..
```

## Deployment Methods

### Method 1: Full CDK Deployment (Recommended for Infrastructure Changes)

This deploys/updates the entire infrastructure stack including ECS, ALB, DynamoDB, etc.

```bash
# 1. Build the application
npm run build

# 2. Deploy via CDK
cd infra
export AWS_PROFILE=corp-admin
export GOOGLE_REDIRECT_URI="https://vim-mcp-gateway.com/auth/callback"
export ALLOWED_DOMAIN="getvim.com"

cdk deploy --require-approval never
```

**What it deploys:**
- ECS Fargate cluster and service
- Application Load Balancer (ALB) with HTTPS
- DynamoDB table for sessions
- Docker image build and push to ECR
- CloudWatch Logs
- Security groups and networking
- IAM roles and permissions

**Deployment time:** ~5-8 minutes

**When to use:**
- First deployment
- Infrastructure configuration changes
- CDK stack updates
- Certificate or KMS key changes

### Method 2: Quick Code-Only Deployment (Recommended for Code Changes)

This only rebuilds and redeploys the Docker container without touching infrastructure.

```bash
# 1. Build the application
npm run build

# 2. Force new ECS deployment
AWS_PROFILE=corp-admin aws ecs update-service \
  --cluster McpGatewayStack-McpGatewayClusterF62BAB07-ReOuwDcNOL7x \
  --service McpGatewayStack-McpGatewayServiceA4E5E3B0-XMUJF6L137Fz \
  --force-new-deployment \
  --region us-east-1
```

**What it does:**
- Builds new Docker image with latest code
- Pushes to ECR
- Forces ECS to pull and deploy new image
- Does NOT change infrastructure

**Deployment time:** ~2-4 minutes

**When to use:**
- Code changes only
- Bug fixes
- Feature additions
- HTML/view updates

### Method 3: Monitor Deployment

Wait for deployment to complete:

```bash
#!/bin/bash
echo "Waiting for deployment..."
for i in {1..40}; do
  primary=$(AWS_PROFILE=corp-admin aws ecs describe-services \
    --cluster McpGatewayStack-McpGatewayClusterF62BAB07-ReOuwDcNOL7x \
    --service McpGatewayStack-McpGatewayServiceA4E5E3B0-XMUJF6L137Fz \
    --query "services[0].deployments[?status==\`PRIMARY\`].runningCount" \
    --output text \
    --region us-east-1)
  
  echo "[$i/40] PRIMARY running: $primary"
  
  if [ "$primary" = "1" ]; then
    echo "✅ Deployment complete!"
    exit 0
  fi
  
  sleep 5
done

echo "⏱️ Deployment still in progress"
```

## Verification

### 1. Health Check

```bash
curl https://vim-mcp-gateway.com/health
# Expected: {"status":"ok","timestamp":"..."}
```

### 2. OAuth Discovery

```bash
curl https://vim-mcp-gateway.com/.well-known/oauth-authorization-server | jq
```

### 3. Login Page

Open in browser:
```
https://vim-mcp-gateway.com/auth/login
```

Should see a beautiful login page.

### 4. MCP Connection Test

Add to `~/.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "vim-workspace": {
      "url": "https://vim-mcp-gateway.com/mcp/sse"
    }
  }
}
```

Restart Cursor and verify MCP connection opens OAuth flow.

## Deployment Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                       Internet                               │
└────────────────────────┬────────────────────────────────────┘
                         │
                         │ HTTPS (443)
                         ▼
┌─────────────────────────────────────────────────────────────┐
│              Application Load Balancer (ALB)                 │
│  - ACM Certificate (vim-mcp-gateway.com)                    │
│  - HTTP → HTTPS redirect                                     │
│  - Health checks on /health                                  │
└────────────────────────┬────────────────────────────────────┘
                         │
                         │ HTTP (3000)
                         ▼
┌─────────────────────────────────────────────────────────────┐
│               ECS Fargate Service (1 task)                   │
│  - Node.js 22 Alpine                                         │
│  - Docker container                                          │
│  - Auto-scaling: min=1, max=3                               │
│  - Memory: 512 MB                                            │
│  - CPU: 256 units (0.25 vCPU)                               │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ├─► DynamoDB (Sessions)
                         ├─► KMS (Session encryption)
                         ├─► Secrets Manager (OAuth creds)
                         └─► CloudWatch Logs
```

## Build Process

The deployment process:

1. **TypeScript Compilation**
   ```bash
   npm run build
   # Runs: tsc && cp -r src/views dist/
   ```
   - Compiles TypeScript to JavaScript in `dist/`
   - Copies HTML views to `dist/views/`

2. **Docker Build** (Multi-stage)
   - **Builder stage**: Installs all deps, builds TypeScript
   - **Production stage**: Only production deps, copies built code
   - Final image: ~150MB

3. **ECR Push**
   - Docker image tagged with git SHA or timestamp
   - Pushed to ECR repository in IT account

4. **ECS Deployment**
   - New task definition created
   - Rolling update (blue/green)
   - Old tasks drain connections (30s)
   - New tasks start and pass health checks
   - Old tasks terminated

## Configuration

### Environment Variables (in ECS Task)

**From Secrets Manager:**
- `GOOGLE_CLIENT_ID` - Google OAuth client ID
- `GOOGLE_CLIENT_SECRET` - Google OAuth client secret  
- `SESSION_SECRET` - Fastify session encryption secret

**From CDK Context:**
- `GOOGLE_REDIRECT_URI` - `https://vim-mcp-gateway.com/auth/callback`
- `ALLOWED_DOMAIN` - `getvim.com`
- `AWS_REGION` - `us-east-1`
- `DYNAMO_TABLE_NAME` - `mcp-gateway-sessions`
- `KMS_KEY_ARN` - KMS key for session encryption
- `PORT` - `3000`
- `NODE_ENV` - `production`

### IAM Permissions

The ECS task role has permissions to:
- Read from Secrets Manager
- Encrypt/decrypt with KMS
- Read/write DynamoDB table
- Write CloudWatch Logs

## Rollback

### Quick Rollback (ECS)

```bash
# List recent task definitions
AWS_PROFILE=corp-admin aws ecs list-task-definitions \
  --family-prefix McpGatewayStack \
  --status ACTIVE \
  --region us-east-1

# Update service to previous task definition
AWS_PROFILE=corp-admin aws ecs update-service \
  --cluster McpGatewayStack-McpGatewayClusterF62BAB07-ReOuwDcNOL7x \
  --service McpGatewayStack-McpGatewayServiceA4E5E3B0-XMUJF6L137Fz \
  --task-definition McpGatewayStackMcpGatewayServiceTaskDefD65C6F52:19 \
  --region us-east-1
```

### CDK Stack Rollback

```bash
# List CloudFormation stack events
AWS_PROFILE=corp-admin aws cloudformation describe-stack-events \
  --stack-name McpGatewayStack \
  --region us-east-1 \
  | jq -r '.StackEvents[] | "\(.Timestamp) \(.ResourceStatus) \(.LogicalResourceId)"' \
  | head -20

# Manual rollback via AWS Console or continue rollback
AWS_PROFILE=corp-admin aws cloudformation continue-update-rollback \
  --stack-name McpGatewayStack \
  --region us-east-1
```

## Troubleshooting

### Deployment Stuck

Check ECS service events:
```bash
AWS_PROFILE=corp-admin aws ecs describe-services \
  --cluster McpGatewayStack-McpGatewayClusterF62BAB07-ReOuwDcNOL7x \
  --service McpGatewayStack-McpGatewayServiceA4E5E3B0-XMUJF6L137Fz \
  --region us-east-1 \
  | jq '.services[0].events[0:10]'
```

### Application Errors

Check CloudWatch Logs:
```bash
AWS_PROFILE=corp-admin aws logs tail \
  /ecs/McpGatewayService \
  --follow \
  --region us-east-1
```

### Health Check Failing

```bash
# SSH into running task (if needed)
# Or check logs for startup errors

# Verify service is listening
curl -v http://localhost:3000/health
```

### Security Group Issues

If HTTPS not working, verify ALB security group:
```bash
AWS_PROFILE=corp-admin aws ec2 describe-security-groups \
  --group-ids sg-0406a5db5c1e7edce \
  --region us-east-1 \
  | jq '.SecurityGroups[0].IpPermissions'

# Should have port 443 ingress from 0.0.0.0/0
```

## Monitoring

### CloudWatch Metrics
- ECS CPU/Memory utilization
- ALB request count and latency
- Target health status

### CloudWatch Alarms
- ECS service health
- ALB 5xx errors
- High CPU/memory

### Logs
- Application logs in CloudWatch Logs group: `/ecs/McpGatewayService`
- ALB access logs (if enabled)

## Cost Estimation

**Monthly cost (approximate):**
- ECS Fargate (1 task, 512MB, 0.25 vCPU): ~$15
- Application Load Balancer: ~$20
- DynamoDB (on-demand, low traffic): ~$1-5
- Data transfer: ~$5-10
- CloudWatch Logs: ~$1-3
- KMS: ~$1
- Secrets Manager: ~$0.80

**Total: ~$43-55/month**

## CI/CD Integration (Future)

For automated deployments, add to your CI/CD pipeline:

```yaml
# Example GitHub Actions
- name: Deploy to AWS
  run: |
    npm run build
    cd infra
    export AWS_PROFILE=corp-admin
    export GOOGLE_REDIRECT_URI="https://vim-mcp-gateway.com/auth/callback"
    export ALLOWED_DOMAIN="getvim.com"
    cdk deploy --require-approval never
```

## Support

For issues:
1. Check CloudWatch Logs first
2. Verify secrets are accessible
3. Check security group rules
4. Verify DNS is pointing to ALB
5. Test health endpoint directly

---

**Last Updated:** 2026-02-02  
**Stack Version:** McpGatewayStack (CDK)  
**Domain:** vim-mcp-gateway.com  
**AWS Account:** 232282424912 (IT)
