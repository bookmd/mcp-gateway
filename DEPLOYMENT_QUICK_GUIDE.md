# Quick Deployment Guide

## Prerequisites

```bash
# Required tools
- AWS CLI configured with corp-admin profile
- Docker running locally
- Node.js 22+
```

## Method 1: Quick Code-Only Deployment (Recommended)

Use this when you only changed **code** (not infrastructure).

### Steps:

```bash
# 1. Navigate to project
cd /Users/ravidkatmor/Projects/mcp-gateway

# 2. Commit your changes
git add -A
git commit -m "your commit message"
git push origin master

# 3. Build and push Docker image
export AWS_PROFILE=corp-admin
export REPO_URI="232282424912.dkr.ecr.us-east-1.amazonaws.com/cdk-hnb659fds-container-assets-232282424912-us-east-1"
export IMAGE_TAG="mcp-gateway-$(git rev-parse --short HEAD)"

# Login to ECR
aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin $REPO_URI

# Build image
docker build -t $REPO_URI:$IMAGE_TAG .

# Push to ECR
docker push $REPO_URI:$IMAGE_TAG

# 4. Register new task definition
# Get current task def
aws ecs describe-task-definition \
  --task-definition McpGatewayStackMcpGatewayServiceTaskDefD65C6F52:33 \
  --region us-east-1 | \
  jq -r '.taskDefinition | del(.taskDefinitionArn, .revision, .status, .requiresAttributes, .compatibilities, .registeredAt, .registeredBy)' \
  > /tmp/new-task-def.json

# Update image in task def
cat /tmp/new-task-def.json | \
  jq --arg img "$REPO_URI:$IMAGE_TAG" '.containerDefinitions[0].image = $img' \
  > /tmp/updated-task-def.json

# Register new revision
aws ecs register-task-definition \
  --region us-east-1 \
  --cli-input-json file:///tmp/updated-task-def.json \
  --query 'taskDefinition.taskDefinitionArn' \
  --output text

# 5. Update ECS service (use the ARN from previous command)
NEW_TASK_DEF_ARN="<paste-arn-here>"

aws ecs update-service \
  --cluster McpGatewayStack-McpGatewayClusterF62BAB07-ReOuwDcNOL7x \
  --service McpGatewayStack-McpGatewayServiceA4E5E3B0-XMUJF6L137Fz \
  --task-definition $NEW_TASK_DEF_ARN \
  --force-new-deployment \
  --region us-east-1

# 6. Monitor deployment
aws ecs describe-services \
  --cluster McpGatewayStack-McpGatewayClusterF62BAB07-ReOuwDcNOL7x \
  --services McpGatewayStack-McpGatewayServiceA4E5E3B0-XMUJF6L137Fz \
  --region us-east-1 \
  --query 'services[0].deployments[*].{Status:status,Running:runningCount,Desired:desiredCount}' \
  --output table
```

**Total time:** ~5-10 minutes

---

## Method 2: Full CDK Deployment

Use this when you changed **infrastructure** (VPC, ALB, security groups, etc.).

### Steps:

```bash
# 1. Navigate to infra directory
cd /Users/ravidkatmor/Projects/mcp-gateway/infra

# 2. Set environment variables
export AWS_PROFILE=corp-admin
export GOOGLE_REDIRECT_URI="https://mgw.ext.getvim.com/auth/callback"
export ALLOWED_DOMAIN="getvim.com"

# 3. Install dependencies (first time only)
npm install

# 4. Check what will change
cdk diff

# 5. Deploy
cdk deploy --require-approval never

# 6. Verify
curl https://mgw.ext.getvim.com/health
```

**Total time:** ~10-20 minutes

**⚠️ Warning:** CDK deployments can change infrastructure. Review `cdk diff` output carefully!

---

## Quick Copy-Paste Script

Save this as `deploy.sh`:

```bash
#!/bin/bash
set -e

echo "🚀 Starting deployment..."

# Config
export AWS_PROFILE=corp-admin
export REPO_URI="232282424912.dkr.ecr.us-east-1.amazonaws.com/cdk-hnb659fds-container-assets-232282424912-us-east-1"
export IMAGE_TAG="mcp-gateway-$(git rev-parse --short HEAD)"
export CLUSTER="McpGatewayStack-McpGatewayClusterF62BAB07-ReOuwDcNOL7x"
export SERVICE="McpGatewayStack-McpGatewayServiceA4E5E3B0-XMUJF6L137Fz"
export TASK_DEF_FAMILY="McpGatewayStackMcpGatewayServiceTaskDefD65C6F52"

echo "📦 Building image: $IMAGE_TAG"

# Login to ECR
aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin $REPO_URI

# Build and push
docker build -q -t $REPO_URI:$IMAGE_TAG .
docker push -q $REPO_URI:$IMAGE_TAG

echo "✅ Image pushed"

# Get latest task definition
LATEST_TASK_DEF=$(aws ecs list-task-definitions \
  --family-prefix $TASK_DEF_FAMILY \
  --region us-east-1 \
  --sort DESC \
  --max-items 1 \
  --query 'taskDefinitionArns[0]' \
  --output text | awk -F'/' '{print $2}')

echo "📋 Creating new task definition from: $LATEST_TASK_DEF"

# Register new task def with new image
aws ecs describe-task-definition \
  --task-definition $LATEST_TASK_DEF \
  --region us-east-1 | \
  jq -r '.taskDefinition | del(.taskDefinitionArn, .revision, .status, .requiresAttributes, .compatibilities, .registeredAt, .registeredBy)' | \
  jq --arg img "$REPO_URI:$IMAGE_TAG" '.containerDefinitions[0].image = $img' > /tmp/task-def.json

NEW_TASK_DEF=$(aws ecs register-task-definition \
  --region us-east-1 \
  --cli-input-json file:///tmp/task-def.json \
  --query 'taskDefinition.taskDefinitionArn' \
  --output text)

echo "✅ New task definition: $NEW_TASK_DEF"

# Update service
echo "🔄 Updating service..."
aws ecs update-service \
  --cluster $CLUSTER \
  --service $SERVICE \
  --task-definition $NEW_TASK_DEF \
  --force-new-deployment \
  --region us-east-1 \
  --query 'service.deployments[0].{Status:status,TaskDef:taskDefinition}' \
  --output table

echo "✅ Deployment started!"
echo ""
echo "Monitor with:"
echo "  watch -n 5 'aws ecs describe-services --cluster $CLUSTER --services $SERVICE --region us-east-1 --query \"services[0].deployments\" --output table'"
```

Make it executable:
```bash
chmod +x deploy.sh
./deploy.sh
```

---

## Verification

After deployment:

```bash
# Check health
curl https://mgw.ext.getvim.com/health

# Check OAuth discovery
curl https://mgw.ext.getvim.com/.well-known/oauth-authorization-server

# Check logs (last 5 minutes)
aws logs filter-log-events \
  --log-group-name McpGatewayStack-McpGatewayServiceTaskDefwebLogGroupE020C6D5-rxJLR91SlWeK \
  --region us-east-1 \
  --start-time $(($(date +%s) - 300))000 \
  --output json | jq -r '.events[] | .message' | tail -20
```

---

## Rollback

If something breaks:

```bash
# List recent task definitions
aws ecs list-task-definitions \
  --family-prefix McpGatewayStackMcpGatewayServiceTaskDefD65C6F52 \
  --region us-east-1 \
  --sort DESC \
  --max-items 5

# Rollback to previous version (e.g., revision 33)
aws ecs update-service \
  --cluster McpGatewayStack-McpGatewayClusterF62BAB07-ReOuwDcNOL7x \
  --service McpGatewayStack-McpGatewayServiceA4E5E3B0-XMUJF6L137Fz \
  --task-definition McpGatewayStackMcpGatewayServiceTaskDefD65C6F52:33 \
  --region us-east-1
```

---

## Troubleshooting

### Docker not running
```bash
open -a Docker
sleep 10
```

### Image build fails
```bash
# Clean build
docker system prune -f
npm run build
docker build --no-cache -t test .
```

### Deployment stuck
```bash
# Check service events
aws ecs describe-services \
  --cluster McpGatewayStack-McpGatewayClusterF62BAB07-ReOuwDcNOL7x \
  --services McpGatewayStack-McpGatewayServiceA4E5E3B0-XMUJF6L137Fz \
  --region us-east-1 \
  --query 'services[0].events[0:5]' \
  --output table
```

### Port 443 blocked (like today)
```bash
# Check security group
aws ec2 describe-security-groups \
  --group-ids sg-0406a5db5c1e7edce \
  --region us-east-1 \
  --query 'SecurityGroups[0].IpPermissions'

# Add port 443 if missing
aws ec2 authorize-security-group-ingress \
  --group-id sg-0406a5db5c1e7edce \
  --ip-permissions IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges='[{CidrIp=0.0.0.0/0}]' \
  --region us-east-1
```
