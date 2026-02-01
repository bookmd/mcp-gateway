# Phase 6: AWS Deployment - Research

**Researched:** 2026-02-01
**Domain:** AWS ECS Fargate containerized deployment with Application Load Balancer
**Confidence:** HIGH

## Summary

AWS ECS Fargate provides serverless container orchestration for deploying Node.js applications without managing EC2 instances. The standard architecture combines ECS Fargate with Application Load Balancer (ALB) for HTTPS traffic routing, CloudWatch for logging and monitoring, and AWS CDK for infrastructure-as-code.

For this MCP gateway deployment, the recommended approach uses AWS CDK's `ApplicationLoadBalancedFargateService` construct which creates a complete stack including VPC, ECS cluster, Fargate service, ALB with HTTPS, target groups, security groups, and IAM roles. The gateway will run as containerized tasks with automatic health checks, graceful shutdown handling, and auto-scaling based on connection load metrics.

Key architectural decisions: Use Docker multi-stage builds with `node:22-alpine` base image for minimal size, configure container health checks (not just ALB health checks) for faster failure detection, implement SIGTERM handlers for graceful shutdown during deployments, store secrets in AWS Secrets Manager and inject as environment variables at container startup, and use CloudWatch awslogs driver for centralized logging.

**Primary recommendation:** Use AWS CDK with ApplicationLoadBalancedFargateService pattern to deploy the gateway, leveraging AWS-managed infrastructure components rather than building custom deployment scripts.

## Standard Stack

The established libraries/tools for this domain:

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| AWS CDK | 2.x | Infrastructure as code | Official AWS IaC tool with TypeScript support, higher-level constructs than CloudFormation |
| aws-cdk-lib | 2.x | CDK core library | Modular AWS service constructs for ECS, EC2, IAM, etc. |
| Docker | Latest | Container runtime | Industry standard for containerization, required for ECS |
| Node.js | 22.x LTS | Application runtime | Active LTS version, supported by AWS SDK v3 until January 2027+ |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| @aws-sdk/client-ecs | 3.x | ECS API calls | If custom deployment scripts needed (CDK handles automatically) |
| @aws-sdk/client-secrets-manager | 3.x | Secrets retrieval | Already used in app, CDK injects secrets automatically |
| @aws-sdk/client-cloudwatch-logs | 3.x | Log queries | If custom log analysis needed beyond CloudWatch console |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| AWS CDK | Terraform | CDK integrates better with AWS, TypeScript native. Terraform multi-cloud but more verbose |
| ECS Fargate | ECS EC2 | Fargate serverless, no instance management. EC2 cheaper at scale but operational overhead |
| ApplicationLoadBalancedFargateService | Manual ECS setup | High-level construct reduces boilerplate 90%. Manual gives more control but error-prone |

**Installation:**
```bash
npm install --save-dev aws-cdk-lib constructs
npm install -g aws-cdk  # CDK CLI for deployment
```

## Architecture Patterns

### Recommended Project Structure
```
mcp-gateway/
├── src/                    # Application code (existing)
├── infra/                  # Infrastructure code (new)
│   ├── bin/
│   │   └── app.ts         # CDK app entry point
│   ├── lib/
│   │   └── fargate-stack.ts  # ECS Fargate stack definition
│   └── cdk.json           # CDK configuration
├── Dockerfile             # Container definition
└── .dockerignore          # Exclude node_modules, .env, etc.
```

### Pattern 1: ApplicationLoadBalancedFargateService with CDK
**What:** High-level CDK construct that creates ECS Fargate service with ALB in single declaration
**When to use:** When deploying containerized web services with HTTPS (99% of cases)
**Example:**
```typescript
// Source: https://github.com/aws-samples/aws-cdk-examples/blob/main/typescript/ecs/fargate-application-load-balanced-service/index.ts
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecs_patterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

export class GatewayStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // VPC with 2 AZs (avoid resource quotas)
    const vpc = new ec2.Vpc(this, 'GatewayVpc', { maxAzs: 2 });

    // ECS Cluster
    const cluster = new ecs.Cluster(this, 'GatewayCluster', {
      vpc,
      containerInsights: true  // Enable CloudWatch Container Insights
    });

    // Reference existing secrets
    const googleClientSecret = secretsmanager.Secret.fromSecretNameV2(
      this, 'GoogleClientSecret', 'mcp-gateway/google-client-secret'
    );

    // Fargate service with ALB
    const fargateService = new ecs_patterns.ApplicationLoadBalancedFargateService(
      this, 'GatewayService',
      {
        cluster,
        cpu: 512,  // 0.5 vCPU
        memoryLimitMiB: 1024,  // 1 GB
        desiredCount: 1,  // Single instance for 20 users
        taskImageOptions: {
          image: ecs.ContainerImage.fromAsset('../'),  // Build from Dockerfile
          containerPort: 3000,
          environment: {
            NODE_ENV: 'production',
            PORT: '3000',
          },
          secrets: {
            // Injected at container startup
            GOOGLE_CLIENT_SECRET: ecs.Secret.fromSecretsManager(googleClientSecret),
          },
          logDriver: ecs.LogDrivers.awsLogs({
            streamPrefix: 'mcp-gateway',
            logRetention: 7,  // Days
          }),
        },
        publicLoadBalancer: true,
        listenerPort: 443,
        protocol: ecs.ApplicationProtocol.HTTPS,
        certificate: certificate,  // ACM certificate for domain
        redirectHTTP: true,  // Redirect HTTP -> HTTPS
      }
    );

    // Configure health check
    fargateService.targetGroup.configureHealthCheck({
      path: '/health',
      interval: cdk.Duration.seconds(30),
      timeout: cdk.Duration.seconds(5),
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 3,
    });

    // Auto-scaling based on connection load
    const scaling = fargateService.service.autoScaleTaskCount({
      minCapacity: 1,
      maxCapacity: 3,
    });

    scaling.scaleOnMetric('ConnectionScaling', {
      metric: fargateService.targetGroup.metricTargetConnectionCount(),
      scalingSteps: [
        { upper: 50, change: 0 },   // 0-50 connections: 1 task
        { lower: 50, change: +1 },  // 50+ connections: add task
        { lower: 100, change: +1 }, // 100+ connections: add another
      ],
    });
  }
}
```

### Pattern 2: Multi-Stage Dockerfile for Node.js Production
**What:** Separate build stage from runtime stage to minimize image size and attack surface
**When to use:** All production Node.js deployments (required best practice)
**Example:**
```dockerfile
# Source: https://github.com/nodejs/docker-node/blob/main/docs/BestPractices.md

# Build stage
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .
RUN npm run build  # If TypeScript compilation needed

# Production stage
FROM node:22-alpine
ENV NODE_ENV=production

# Run as non-root user
USER node
WORKDIR /app

# Copy only production dependencies and built code
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/dist ./dist
COPY --chown=node:node --from=builder /app/package.json ./

# Health check (runs inside container)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

# Use CMD array form (not npm start) for proper signal handling
CMD ["node", "dist/server.js"]
```

### Pattern 3: Graceful Shutdown Handler
**What:** Handle SIGTERM signal to close connections cleanly before container stops
**When to use:** All long-lived connections (WebSocket, SSE, HTTP keep-alive)
**Example:**
```typescript
// Source: https://aws.amazon.com/blogs/containers/graceful-shutdowns-with-ecs/
// Source: https://medium.com/@dar3.st/graceful-termination-of-a-node-app-in-aws-ecs-29e8c596c47d

const server = app.listen(port);

// Graceful shutdown on SIGTERM (ECS sends this before SIGKILL)
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, starting graceful shutdown');

  // Stop accepting new connections
  server.close(() => {
    console.log('HTTP server closed');
  });

  // Close MCP connections
  for (const [sessionId, transport] of mcpConnections) {
    console.log(`Closing MCP connection: ${sessionId}`);
    await transport.close();
  }

  // Close database connections
  await dynamoClient.destroy();

  // Exit cleanly (ECS waits stopTimeout seconds, default 30s)
  process.exit(0);
});
```

### Pattern 4: Container Health Check (not just ALB)
**What:** Define health check in task definition that runs inside container
**When to use:** Always, for faster failure detection than ALB health checks alone
**Example:**
```typescript
// Source: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/healthcheck.html

const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
  memoryLimitMiB: 1024,
  cpu: 512,
});

const container = taskDefinition.addContainer('app', {
  image: ecs.ContainerImage.fromAsset('../'),
  logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'mcp-gateway' }),
  healthCheck: {
    command: ['CMD-SHELL', 'curl -f http://localhost:3000/health || exit 1'],
    interval: cdk.Duration.seconds(30),
    timeout: cdk.Duration.seconds(5),
    retries: 3,
    startPeriod: cdk.Duration.seconds(10),  // Grace period for app startup
  },
});
```

### Anti-Patterns to Avoid
- **Using npm start in CMD**: npm swallows SIGTERM signals, preventing graceful shutdown. Use `CMD ["node", "server.js"]` instead.
- **Running as root**: Security risk. Always `USER node` in Dockerfile.
- **Large base images**: `node:22` is 350MB, `node:22-alpine` is 40MB. Fargate pulls image every time, no caching.
- **Secrets in environment variables at build time**: Leaks in logs and docker inspect. Use AWS Secrets Manager injected at runtime.
- **No health check or only ALB health check**: Container health checks detect failures faster and enable automatic task restart.
- **Ignoring SIGTERM**: Results in forceful SIGKILL after 30s, interrupting active connections.

## Don't Hand-Roll

Problems that look simple but have existing solutions:

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Infrastructure provisioning | Custom CloudFormation templates | AWS CDK ApplicationLoadBalancedFargateService | CDK construct creates VPC, subnets, security groups, ALB, target groups, ECS cluster, service, task definition, IAM roles automatically. 500+ lines of CloudFormation → 50 lines of CDK. |
| Container orchestration | EC2 with Docker Compose | ECS Fargate | Fargate manages container lifecycle, placement, scaling, health checks. No SSH access needed, immutable infrastructure. |
| Load balancing | Nginx reverse proxy | Application Load Balancer | ALB integrates with ECS service discovery, automatic target registration/deregistration, AWS WAF, ACM certificates, health checks. |
| HTTPS/TLS certificates | Let's Encrypt with certbot | AWS Certificate Manager | ACM auto-renews certificates, integrates with ALB, no cron jobs or cert storage needed. |
| Secrets rotation | Custom rotation scripts | AWS Secrets Manager rotation | Secrets Manager integrates with RDS, has lambda-based rotation for custom secrets, audit trail in CloudTrail. |
| Log aggregation | ELK stack or Loki | CloudWatch Logs with awslogs driver | CloudWatch integrates with ECS, automatic log collection, retention policies, alarms. No separate log infrastructure. |
| Metrics and monitoring | Prometheus + Grafana | CloudWatch Container Insights | Container Insights provides curated dashboards for ECS, collects CPU/memory/network/disk metrics automatically, integrates with CloudWatch Alarms. |
| Auto-scaling logic | Custom metric polling + API calls | Application Auto Scaling | Application Auto Scaling monitors metrics, calculates desired capacity, scales ECS service automatically. Supports target tracking, step scaling, scheduled scaling. |

**Key insight:** AWS provides managed infrastructure components specifically designed for ECS Fargate. Custom solutions require significant operational overhead (patching, monitoring, scaling, HA) that AWS handles automatically. For a 20-user deployment, managed services eliminate operational burden with negligible cost increase.

## Common Pitfalls

### Pitfall 1: Invalid CPU/Memory Combinations
**What goes wrong:** Task fails to start with "No Fargate configuration exists for given values" error
**Why it happens:** Fargate only supports specific CPU/memory pairings, not arbitrary combinations
**How to avoid:** Use valid combinations from AWS documentation:
- 256 CPU (.25 vCPU): 512 MB, 1024 MB, 2048 MB
- 512 CPU (.5 vCPU): 1024 MB - 4096 MB (1 GB increments)
- 1024 CPU (1 vCPU): 2048 MB - 8192 MB (1 GB increments)
- 2048 CPU (2 vCPU): 4096 MB - 16384 MB (1 GB increments)
**Warning signs:** Task stuck in PROVISIONING state, CloudWatch logs show "InvalidParameterException"

### Pitfall 2: Secrets Not Updated After Rotation
**What goes wrong:** Application continues using old/revoked credentials after secret rotation
**Why it happens:** Secrets are injected only at container startup, not dynamically updated
**How to avoid:** After rotating secrets in Secrets Manager, force new ECS service deployment: `aws ecs update-service --cluster <cluster> --service <service> --force-new-deployment`
**Warning signs:** Authentication failures after known secret rotation, credentials work in AWS console but not in app

### Pitfall 3: Health Check Failing Due to Missing Dependencies
**What goes wrong:** Container health check fails because health check command requires tools not in image (curl, wget, etc.)
**Why it happens:** Alpine base images are minimal, don't include common utilities
**How to avoid:**
- Option 1: Install required tools: `RUN apk add --no-cache curl` in Dockerfile
- Option 2: Use Node.js for health check: `CMD-SHELL node -e "require('http').get('http://localhost:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"`
- Option 3: Use TCP check: `command: ["CMD-SHELL", "nc -z localhost 3000 || exit 1"]` (nc included in alpine)
**Warning signs:** Task repeatedly starting and stopping, container logs show health check command not found

### Pitfall 4: Target Type Mismatch (IP vs Instance)
**What goes wrong:** ECS tasks don't register with ALB target group, no traffic reaches containers
**Why it happens:** Fargate requires `awsvpc` network mode, which requires `ip` target type (not `instance`)
**How to avoid:** When creating target group, set target type to `ip`. CDK ApplicationLoadBalancedFargateService does this automatically.
**Warning signs:** ALB target group shows no healthy targets, tasks running but unreachable

### Pitfall 5: Security Group Misconfiguration
**What goes wrong:** ALB can't reach tasks, or tasks can't reach DynamoDB/KMS
**Why it happens:** Fargate tasks get their own ENI with security group, must allow ALB → Task traffic
**How to avoid:**
- Allow inbound traffic to task security group from ALB security group on container port
- Allow outbound traffic from task security group to VPC endpoints (DynamoDB, KMS) on port 443
- CDK ApplicationLoadBalancedFargateService configures this automatically
**Warning signs:** ALB health checks fail, tasks marked unhealthy, can't connect to AWS services

### Pitfall 6: Insufficient stopTimeout for Graceful Shutdown
**What goes wrong:** ECS sends SIGKILL before app finishes closing connections, interrupts active requests
**Why it happens:** Default stopTimeout is 30 seconds, may be insufficient for draining connections
**How to avoid:** Set `stopTimeout` in task definition based on max expected connection duration. For MCP gateway with long-lived SSE, use 60-120 seconds.
**Warning signs:** Client errors during deployments, "connection reset" in logs, incomplete request handling

### Pitfall 7: Image Pull from Docker Hub Rate Limiting
**What goes wrong:** Task fails to start during deployment with "toomanyrequests: too many failed login attempts"
**Why it happens:** Docker Hub limits anonymous pulls to 100/6hrs, 200/6hrs for authenticated
**How to avoid:**
- Option 1: Use Amazon ECR Public Gallery images: `public.ecr.aws/docker/library/node:22-alpine`
- Option 2: Push base images to private ECR, pull from there
- Option 3: Authenticate with Docker Hub (store credentials in Secrets Manager)
**Warning signs:** Intermittent task start failures, especially during scaling or deployments

### Pitfall 8: Container Insights Not Enabled
**What goes wrong:** Missing detailed container metrics (per-task CPU/memory), troubleshooting difficult
**Why it happens:** Container Insights is opt-in, not enabled by default
**How to avoid:** Set `containerInsights: true` when creating ECS cluster in CDK
**Warning signs:** CloudWatch only shows service-level metrics, no per-task breakdowns

### Pitfall 9: Logs Not Configured, Container Output Lost
**What goes wrong:** Application logs not visible in CloudWatch, debugging impossible
**Why it happens:** Must explicitly configure awslogs log driver in task definition
**How to avoid:** Always configure logDriver in CDK:
```typescript
logDriver: ecs.LogDrivers.awsLogs({
  streamPrefix: 'mcp-gateway',
  logRetention: logs.RetentionDays.ONE_WEEK,
})
```
**Warning signs:** No logs in CloudWatch Logs, only "Task started" messages

### Pitfall 10: Platform Version Too Old for Features
**What goes wrong:** Fargate features don't work (ephemeral storage, secrets injection, health checks)
**Why it happens:** Fargate platform versions add features over time, old versions lack support
**How to avoid:** Use `platformVersion: ecs.FargatePlatformVersion.LATEST` in CDK (default). For specific version: `FargatePlatformVersion.VERSION1_4_0` or later.
**Warning signs:** Features documented but not working, CloudWatch shows "unsupported platform version" errors

## Code Examples

Verified patterns from official sources:

### Complete CDK Stack with All Best Practices
```typescript
// Source: https://docs.aws.amazon.com/cdk/v2/guide/ecs-example.html
// Source: https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_ecs_patterns.ApplicationLoadBalancedFargateService.html

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecs_patterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';

export class McpGatewayStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // VPC with 2 AZs (cost optimization, avoid quotas)
    const vpc = new ec2.Vpc(this, 'McpGatewayVpc', {
      maxAzs: 2,
      natGateways: 1,  // Single NAT for cost savings (20 users)
    });

    // ECS Cluster with Container Insights
    const cluster = new ecs.Cluster(this, 'McpGatewayCluster', {
      vpc,
      containerInsights: true,
    });

    // Reference existing secrets (created during Phase 1-5)
    const googleClientSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'GoogleClientSecret',
      'mcp-gateway/google-client-secret'
    );

    const kmsKeyId = secretsmanager.Secret.fromSecretNameV2(
      this,
      'KmsKeyId',
      'mcp-gateway/kms-key-id'
    );

    // ACM certificate for HTTPS (must be created manually or in separate stack)
    const certificate = acm.Certificate.fromCertificateArn(
      this,
      'Certificate',
      'arn:aws:acm:us-east-1:123456789012:certificate/abc-123'
    );

    // Fargate service with ALB
    const fargateService = new ecs_patterns.ApplicationLoadBalancedFargateService(
      this,
      'McpGatewayService',
      {
        cluster,
        cpu: 512,  // 0.5 vCPU
        memoryLimitMiB: 1024,  // 1 GB (valid combination)
        desiredCount: 1,
        platformVersion: ecs.FargatePlatformVersion.LATEST,

        taskImageOptions: {
          image: ecs.ContainerImage.fromAsset('../', {
            file: 'Dockerfile',
          }),
          containerPort: 3000,

          // Non-sensitive configuration
          environment: {
            NODE_ENV: 'production',
            PORT: '3000',
            AWS_REGION: cdk.Stack.of(this).region,
            DYNAMODB_TABLE_NAME: 'mcp-gateway-sessions',
          },

          // Sensitive data from Secrets Manager
          secrets: {
            GOOGLE_CLIENT_ID: ecs.Secret.fromSecretsManager(googleClientSecret, 'client_id'),
            GOOGLE_CLIENT_SECRET: ecs.Secret.fromSecretsManager(googleClientSecret, 'client_secret'),
            KMS_KEY_ID: ecs.Secret.fromSecretsManager(kmsKeyId),
          },

          // CloudWatch logging
          logDriver: ecs.LogDrivers.awsLogs({
            streamPrefix: 'mcp-gateway',
            logRetention: logs.RetentionDays.ONE_WEEK,
          }),
        },

        // HTTPS configuration
        publicLoadBalancer: true,
        listenerPort: 443,
        protocol: ecs.ApplicationProtocol.HTTPS,
        certificate,
        redirectHTTP: true,  // HTTP -> HTTPS redirect

        // Deployment configuration
        circuitBreaker: { rollback: true },  // Auto-rollback on failure
        minHealthyPercent: 100,  // Keep old task until new is healthy
        maxHealthyPercent: 200,  // Allow both during deployment

        // Health check grace period
        healthCheckGracePeriod: cdk.Duration.seconds(60),
      }
    );

    // Configure ALB target group health check
    fargateService.targetGroup.configureHealthCheck({
      path: '/health',
      interval: cdk.Duration.seconds(30),
      timeout: cdk.Duration.seconds(5),
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 3,
      healthyHttpCodes: '200',
    });

    // Grant DynamoDB access to task role
    const table = dynamodb.Table.fromTableName(
      this,
      'SessionTable',
      'mcp-gateway-sessions'
    );
    table.grantReadWriteData(fargateService.taskDefinition.taskRole);

    // Grant KMS access to task role
    const kmsKey = kms.Key.fromKeyArn(
      this,
      'KmsKey',
      'arn:aws:kms:us-east-1:123456789012:key/abc-123'
    );
    kmsKey.grantEncryptDecrypt(fargateService.taskDefinition.taskRole);

    // Auto-scaling based on connection count
    const scaling = fargateService.service.autoScaleTaskCount({
      minCapacity: 1,
      maxCapacity: 3,  // Max 3 tasks for 20 users
    });

    // Scale on active connection count (most relevant for MCP gateway)
    scaling.scaleOnMetric('ConnectionScaling', {
      metric: fargateService.targetGroup.metricTargetConnectionCount({
        statistic: 'Average',
      }),
      scalingSteps: [
        { upper: 50, change: 0 },    // 0-50 connections: 1 task
        { lower: 50, change: +1 },   // 50-100 connections: 2 tasks
        { lower: 100, change: +1 },  // 100+ connections: 3 tasks
      ],
      adjustmentType: ecs.AdjustmentType.CHANGE_IN_CAPACITY,
    });

    // Output ALB DNS name
    new cdk.CfnOutput(this, 'LoadBalancerDNS', {
      value: fargateService.loadBalancer.loadBalancerDnsName,
      description: 'ALB DNS name',
    });

    // Output service ARN
    new cdk.CfnOutput(this, 'ServiceArn', {
      value: fargateService.service.serviceArn,
      description: 'ECS service ARN',
    });
  }
}
```

### Production Dockerfile for Node.js 22
```dockerfile
# Source: https://github.com/nodejs/docker-node/blob/main/docs/BestPractices.md
# Source: https://snyk.io/blog/10-best-practices-to-containerize-nodejs-web-applications-with-docker/

# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev) for build
RUN npm ci && npm cache clean --force

# Copy source code
COPY . .

# Build TypeScript (if needed)
RUN npm run build

# Production stage
FROM node:22-alpine

# Set production environment
ENV NODE_ENV=production

# Install curl for health checks (lightweight)
RUN apk add --no-cache curl

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev && npm cache clean --force

# Copy built application from builder
COPY --from=builder /app/dist ./dist

# Switch to non-root user
USER node

# Expose application port
EXPOSE 3000

# Health check using curl
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# Use CMD array form (not npm start) for proper SIGTERM handling
CMD ["node", "dist/server.js"]
```

### .dockerignore File
```
# Source: https://betterstack.com/community/guides/scaling-nodejs/dockerize-nodejs/

node_modules
npm-debug.log
.git
.gitignore
.env
.env.local
.DS_Store
*.md
.vscode
.idea
coverage
.nyc_output
dist  # Built in container
.planning
```

### Graceful Shutdown Implementation
```typescript
// Source: https://aws.amazon.com/blogs/containers/graceful-shutdowns-with-ecs/
// Source: https://medium.com/@dar3.st/graceful-termination-of-a-node-app-in-aws-ecs-29e8c596c47d

import Fastify from 'fastify';

const app = Fastify({ logger: true });

// Track active MCP connections
const activeConnections = new Map<string, SSEServerTransport>();

// Your existing routes...
app.get('/health', async (request, reply) => {
  return { status: 'ok' };
});

// Start server
const server = await app.listen({
  port: Number(process.env.PORT) || 3000,
  host: '0.0.0.0'  // Required for container networking
});

// Graceful shutdown handler
process.on('SIGTERM', async () => {
  app.log.info('SIGTERM received, starting graceful shutdown');

  // Stop accepting new connections
  await app.close();
  app.log.info('Fastify server closed, no new connections accepted');

  // Close all active MCP connections
  app.log.info(`Closing ${activeConnections.size} active MCP connections`);
  const closePromises = Array.from(activeConnections.values()).map(
    async (transport) => {
      try {
        await transport.close();
      } catch (error) {
        app.log.error({ error }, 'Error closing MCP connection');
      }
    }
  );
  await Promise.allSettled(closePromises);

  app.log.info('All connections closed, exiting');
  process.exit(0);
});

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  app.log.fatal({ error }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  app.log.fatal({ reason }, 'Unhandled promise rejection');
  process.exit(1);
});
```

### CDK Deployment Script
```bash
# Source: https://docs.aws.amazon.com/cdk/v2/guide/getting_started.html

#!/bin/bash
set -e

# Navigate to infrastructure directory
cd infra

# Install CDK dependencies
npm install

# Bootstrap CDK (only needed once per account/region)
npx cdk bootstrap aws://ACCOUNT-ID/REGION

# Synthesize CloudFormation template (optional, for review)
npx cdk synth

# Deploy stack
npx cdk deploy --require-approval never

# Get outputs
npx cdk deploy --outputs-file ./outputs.json

echo "Deployment complete!"
cat ./outputs.json
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| EC2 with Docker Compose | ECS Fargate | 2017 (Fargate GA) | Eliminates instance management, patching, scaling. Serverless container orchestration. |
| CloudFormation YAML | AWS CDK (TypeScript) | 2019 (CDK GA) | Type-safe infrastructure, 90% less boilerplate, reusable constructs. |
| Let's Encrypt + certbot | AWS Certificate Manager | 2016 (ACM GA) | Auto-renewal, ALB integration, no cron jobs or cert storage. |
| ECS Classic (link-based networking) | awsvpc network mode | 2017 | Each task gets own ENI, security groups, no port conflicts. Required for Fargate. |
| Docker Hub for base images | ECR Public Gallery | 2020 | Avoids Docker Hub rate limits, faster pulls from AWS regions. |
| CodeDeploy for ECS blue/green | ECS native blue/green | 2025 | Simpler setup, works with Service Connect, no CodeDeploy configuration. |
| Manual container health checks | ECS health check in task definition | 2018 (Fargate 1.1.0) | Faster failure detection, automatic task restart. |
| CloudWatch manual setup | Container Insights enhanced observability | 2024 (December) | Auto-collects detailed metrics, curated dashboards, minimal config. |

**Deprecated/outdated:**
- **ECS EC2 launch type for simple apps**: Fargate is now cost-competitive for <20 tasks, eliminates operational overhead. Use EC2 only for GPU, privileged containers, or >100 tasks with consistent load.
- **AWS SDK v2**: AWS SDK v3 is modular (smaller bundles), has better TypeScript support, follows active LTS. v2 maintenance mode since 2023.
- **Node.js 18**: EOL April 2025. Use Node.js 22 (active LTS until April 2027).
- **Fargate platform version < 1.4.0**: Missing ephemeral storage config, some secrets features. Use LATEST (1.4.0+).

## Open Questions

Things that couldn't be fully resolved:

1. **Domain and ACM Certificate Setup**
   - What we know: ACM certificates must be created before CDK stack, requires domain ownership verification
   - What's unclear: User hasn't specified custom domain or if using ALB DNS directly
   - Recommendation: Create separate CDK stack for ACM certificate + Route53 hosted zone, reference in main stack. Or skip HTTPS initially, use HTTP on port 80 for POC, add HTTPS later.

2. **DynamoDB and KMS Resource References**
   - What we know: DynamoDB table and KMS key created in prior phases, need ARNs for IAM permissions
   - What's unclear: Whether resources have standard names or need discovery
   - Recommendation: Use CDK `Table.fromTableName()` and `Key.fromKeyArn()` with environment variables or SSM Parameter Store for ARNs. Document ARNs in Phase 5 completion.

3. **Cost Optimization: Fargate vs Fargate Spot**
   - What we know: Fargate Spot 70% cheaper but can be interrupted with 2-minute warning
   - What's unclear: Whether 20-user deployment justifies spot complexity (SIGTERM handling, interruption tolerance)
   - Recommendation: Start with regular Fargate for simplicity. Cost ~$15-30/month for 1 task (0.5 vCPU, 1GB). Fargate Spot adds interruption handling complexity not worth savings for small scale.

4. **Multi-Region Deployment**
   - What we know: CDK stacks are region-specific, can deploy to multiple regions
   - What's unclear: Whether global deployment is in scope for 20-user system
   - Recommendation: Single-region deployment sufficient for 20 users. Multi-region adds significant complexity (cross-region DynamoDB replication, Route53 health checks, global ALB). Defer until user base grows.

5. **CI/CD Pipeline Integration**
   - What we know: CDK can deploy from CLI or CI/CD pipeline (GitHub Actions, CodePipeline)
   - What's unclear: Whether automated deployments are in scope or manual `cdk deploy` acceptable
   - Recommendation: Start with manual CDK deployments. Add GitHub Actions workflow in future phase if frequent updates needed. For 20 users, manual deploys likely sufficient.

## Sources

### Primary (HIGH confidence)
- [Amazon ECS Developer Guide - Health Checks](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/healthcheck.html) - Official health check configuration
- [Amazon ECS Developer Guide - ALB Configuration](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/alb.html) - Official ALB integration guide
- [Amazon ECS Developer Guide - Fargate Security](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/security-fargate.html) - Fargate security best practices
- [Amazon ECS Developer Guide - Sensitive Data](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/specifying-sensitive-data.html) - Secrets Manager integration
- [Amazon ECS Developer Guide - CloudWatch Logs](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/using_awslogs.html) - awslogs log driver configuration
- [Node.js Docker Best Practices](https://github.com/nodejs/docker-node/blob/main/docs/BestPractices.md) - Official Node.js Docker guidance
- [AWS CDK Examples - Fargate ALB Service](https://github.com/aws-samples/aws-cdk-examples/blob/main/typescript/ecs/fargate-application-load-balanced-service/index.ts) - Official CDK example code
- [AWS CDK API Reference - ApplicationLoadBalancedFargateService](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_ecs_patterns.ApplicationLoadBalancedFargateService.html) - CDK construct documentation
- [AWS Blog - Graceful Shutdowns with ECS](https://aws.amazon.com/blogs/containers/graceful-shutdowns-with-ecs/) - Official graceful shutdown guide
- [AWS Blog - Autoscaling ECS with Custom Metrics](https://aws.amazon.com/blogs/containers/autoscaling-amazon-ecs-services-based-on-custom-metrics-with-application-auto-scaling/) - Auto-scaling guidance

### Secondary (MEDIUM confidence)
- [CloudLaya - AWS Node.js Deployment Guide](https://www.cloudlaya.com/blog/aws-node-js-deployment/) - Community guide verified with official docs
- [Better Stack - Dockerizing Node.js Apps](https://betterstack.com/community/guides/scaling-nodejs/dockerize-nodejs/) - Community guide, Docker best practices
- [Snyk - 10 Best Practices for Node.js Docker](https://snyk.io/blog/10-best-practices-to-containerize-nodejs-web-applications-with-docker/) - Security vendor guide, verified patterns
- [Medium - Graceful Node.js Shutdown in ECS](https://medium.com/@dar3.st/graceful-termination-of-a-node-app-in-aws-ecs-29e8c596c47d) - Community guide verified with AWS blog
- [DEV Community - 8 Common ECS Mistakes](https://dev.to/dashbird/8-common-mistakes-when-using-aws-ecs-to-manage-containers-1i0f) - Community wisdom, cross-verified
- [Containers on AWS - Advanced Health Checks](https://containersonaws.com/pattern/ecs-advanced-container-health-check) - AWS community patterns

### Tertiary (LOW confidence)
- [ElasticScale - Fargate CPU/Memory Combinations](https://elasticscale.com/blog/mastering-aws-fargate-cpu-and-memory-combinations-for-cost-and-performance/) - Community guide, needs official verification for current values
- [Medium - ECS Fargate Cost Comparison](https://medium.com/@inboryn/cost-optimization-why-ecs-fargate-costs-3x-more-than-kubernetes-2026-reality-check-f9a2bb726f00) - Opinion piece, cost claims unverified
- WebSearch results for ecosystem discovery (2025-2026) - Multiple sources agreeing, but unverified

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - Official AWS documentation and CDK examples provide definitive guidance
- Architecture: HIGH - ApplicationLoadBalancedFargateService is documented pattern with official examples
- Pitfalls: MEDIUM-HIGH - Mix of official AWS troubleshooting docs and verified community reports
- Cost estimates: LOW - Pricing varies by region and usage, needs AWS calculator for accuracy

**Research date:** 2026-02-01
**Valid until:** 2026-03-31 (60 days) - AWS ECS features stable, CDK patterns unlikely to change. Node.js 22 LTS until April 2027. Re-verify if major ECS announcements at AWS re:Invent 2026.
