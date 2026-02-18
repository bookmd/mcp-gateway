import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecs_patterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { Construct } from 'constructs';

export class McpGatewayStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Get configuration from CDK context (passed via --context or cdk.json)
    const googleRedirectUri = this.node.tryGetContext('googleRedirectUri') || process.env.GOOGLE_REDIRECT_URI;
    const allowedDomain = this.node.tryGetContext('allowedDomain') || process.env.ALLOWED_DOMAIN;
    const dynamoTableName = this.node.tryGetContext('dynamoTableName') || 'mcp-gateway-sessions';

    // Import secrets from Secrets Manager using full ARN (P0 Security Fix)
    // Using fromSecretCompleteArn ensures exact ARN matching for IAM policies
    const googleOAuthSecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      'GoogleOAuthSecret',
      'arn:aws:secretsmanager:us-east-1:232282424912:secret:mcp-gateway/google-oauth-89qXYD'
    );
    
    const sessionSecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      'SessionSecret',
      'arn:aws:secretsmanager:us-east-1:232282424912:secret:mcp-gateway/session-secret-WoJjev'
    );

    // Import KMS key for session encryption (P0 Security Fix)
    // Use direct key ID since alias lookup has region issues
    const encryptionKey = kms.Key.fromKeyArn(
      this,
      'EncryptionKey',
      'arn:aws:kms:us-east-1:232282424912:key/01643f79-9643-45b3-bc56-868b1980e684'
    );

    // Import ACM certificate for HTTPS (P0 Security Fix)
    // Updated to mgw.ext.getvim.com domain
    const certificate = acm.Certificate.fromCertificateArn(
      this,
      'Certificate',
      'arn:aws:acm:us-east-1:232282424912:certificate/943e6cda-c88e-4d9b-9b53-b3916bdea88e'
    );

    // VPC with 2 AZs and 0 NAT Gateways (use public subnets to avoid EIP limit)
    // Fargate tasks will be assigned public IPs in public subnets
    const vpc = new ec2.Vpc(this, 'McpGatewayVpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
      ],
    });

    // ECS Cluster with Container Insights enabled
    const cluster = new ecs.Cluster(this, 'McpGatewayCluster', {
      vpc,
      containerInsights: true,
    });

    // Reference existing DynamoDB table (created in Phase 2)
    const sessionsTable = dynamodb.Table.fromTableName(
      this,
      'SessionsTable',
      dynamoTableName
    );

    // Fargate service with ALB (HTTPS with certificate)
    const fargateService = new ecs_patterns.ApplicationLoadBalancedFargateService(
      this,
      'McpGatewayService',
      {
        cluster,
        cpu: 512,  // 0.5 vCPU
        memoryLimitMiB: 1024,  // 1 GB (valid Fargate combination)
        desiredCount: 1,  // Start with 1 task, auto-scaling handles the rest
        platformVersion: ecs.FargatePlatformVersion.LATEST,
        assignPublicIp: true,  // Assign public IP to tasks in public subnets
        taskSubnets: {
          subnetType: ec2.SubnetType.PUBLIC,
        },

        taskImageOptions: {
          // Build Docker image from project root (where Dockerfile is)
          // Force linux/amd64 platform for Fargate x86_64 compatibility (cross-compile on ARM Mac)
          image: ecs.ContainerImage.fromAsset('../', {
            file: 'Dockerfile',
            platform: Platform.LINUX_AMD64,
          }),
          containerPort: 3000,

          // Environment variables passed to container
          environment: {
            NODE_ENV: 'production',
            PORT: '3000',
            AWS_REGION: cdk.Stack.of(this).region,
            DYNAMODB_TABLE_NAME: dynamoTableName,
            GOOGLE_REDIRECT_URI: googleRedirectUri || '',
            ALLOWED_DOMAIN: allowedDomain || '',
            KMS_KEY_ARN: encryptionKey.keyArn,
          },

          // NOTE: Secrets are added after via escape hatch to use full ARNs with suffix
          // CDK strips the suffix but ECS needs full ARNs to resolve secrets

          // CloudWatch logging with 7-day retention
          logDriver: ecs.LogDrivers.awsLogs({
            streamPrefix: 'mcp-gateway',
            logRetention: logs.RetentionDays.ONE_WEEK,
          }),
        },

        // HTTPS listener on port 443
        publicLoadBalancer: true,
        listenerPort: 443,
        protocol: elbv2.ApplicationProtocol.HTTPS,
        certificate: certificate,
        redirectHTTP: true,  // Redirect HTTP to HTTPS

        // Deployment configuration with circuit breaker
        circuitBreaker: { rollback: true },
        minHealthyPercent: 100,
        maxHealthyPercent: 200,

        // Health check grace period for container startup
        healthCheckGracePeriod: cdk.Duration.seconds(60),
      }
    );

    // ESCAPE HATCH: Add secrets with full ARNs (including suffix)
    // CDK's ecs.Secret.fromSecretsManager strips the suffix, but ECS needs full ARNs
    // to resolve secrets. Partial ARNs cause ResourceNotFoundException.
    const cfnTaskDef = fargateService.taskDefinition.node.defaultChild as ecs.CfnTaskDefinition;
    cfnTaskDef.addPropertyOverride('ContainerDefinitions.0.Secrets', [
      {
        Name: 'GOOGLE_CLIENT_ID',
        ValueFrom: 'arn:aws:secretsmanager:us-east-1:232282424912:secret:mcp-gateway/google-oauth-89qXYD:client_id::',
      },
      {
        Name: 'GOOGLE_CLIENT_SECRET',
        ValueFrom: 'arn:aws:secretsmanager:us-east-1:232282424912:secret:mcp-gateway/google-oauth-89qXYD:client_secret::',
      },
      {
        Name: 'SESSION_SECRET',
        ValueFrom: 'arn:aws:secretsmanager:us-east-1:232282424912:secret:mcp-gateway/session-secret-WoJjev',
      },
    ]);

    // Configure ALB target group health check
    fargateService.targetGroup.configureHealthCheck({
      path: '/health',
      interval: cdk.Duration.seconds(30),
      timeout: cdk.Duration.seconds(5),
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 3,
      healthyHttpCodes: '200',
    });

    // Enable sticky sessions for OAuth flow (session stored in memory)
    fargateService.targetGroup.setAttribute('stickiness.enabled', 'true');
    fargateService.targetGroup.setAttribute('stickiness.type', 'lb_cookie');
    fargateService.targetGroup.setAttribute('stickiness.lb_cookie.duration_seconds', '86400');

    // Increase ALB idle timeout for long-lived SSE connections
    // Default is 60s, but MCP SSE connections can be idle between requests
    // Keep-alive sends data every 10s, so 300s provides safe buffer for any delays
    // Note: Using CfnLoadBalancer to set attributes since setAttribute doesn't work on ALB
    const cfnLoadBalancer = fargateService.loadBalancer.node.defaultChild as elbv2.CfnLoadBalancer;
    cfnLoadBalancer.loadBalancerAttributes = [
      { key: 'idle_timeout.timeout_seconds', value: '300' },
      { key: 'deletion_protection.enabled', value: 'false' },
    ];

    // Grant DynamoDB read/write access to task role
    sessionsTable.grantReadWriteData(fargateService.taskDefinition.taskRole);

    // Grant KMS encrypt/decrypt access to task role (P0 Security Fix)
    encryptionKey.grantEncryptDecrypt(fargateService.taskDefinition.taskRole);

    // Grant Secrets Manager read access to task role (P0 Security Fix)
    googleOAuthSecret.grantRead(fargateService.taskDefinition.taskRole);
    sessionSecret.grantRead(fargateService.taskDefinition.taskRole);

    // Grant Secrets Manager read access to execution role (required for ECS to inject secrets at container startup)
    googleOAuthSecret.grantRead(fargateService.taskDefinition.executionRole!);
    sessionSecret.grantRead(fargateService.taskDefinition.executionRole!);

    // Add explicit IAM policy for secrets access with wildcard to cover both partial and full ARN references
    // ECS task definitions reference secrets by partial ARN (without suffix), but Secrets Manager ARNs include a suffix
    fargateService.taskDefinition.executionRole!.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
      resources: [
        'arn:aws:secretsmanager:us-east-1:232282424912:secret:mcp-gateway/google-oauth*',
        'arn:aws:secretsmanager:us-east-1:232282424912:secret:mcp-gateway/session-secret*',
      ],
    }));

    // Auto-scaling based on connection count (1-3 tasks)
    const scaling = fargateService.service.autoScaleTaskCount({
      minCapacity: 1,
      maxCapacity: 3,
    });

    // Scale on active connection count using ALB metric
    // 0-50 connections: 1 task
    // 50-100 connections: 2 tasks
    // 100+ connections: 3 tasks
    scaling.scaleOnMetric('ConnectionScaling', {
      metric: fargateService.loadBalancer.metricActiveConnectionCount({
        statistic: 'Average',
        period: cdk.Duration.minutes(1),
      }),
      scalingSteps: [
        { upper: 50, change: 0 },     // 0-50 connections: maintain current (1 task)
        { lower: 50, change: +1 },    // 50+ connections: add 1 task
        { lower: 100, change: +1 },   // 100+ connections: add another task
      ],
      adjustmentType: cdk.aws_applicationautoscaling.AdjustmentType.CHANGE_IN_CAPACITY,
    });

    // Stack outputs
    new cdk.CfnOutput(this, 'LoadBalancerDNS', {
      value: fargateService.loadBalancer.loadBalancerDnsName,
      description: 'ALB DNS name - use this as production URL',
      exportName: 'McpGatewayALBDNS',
    });

    new cdk.CfnOutput(this, 'ServiceArn', {
      value: fargateService.service.serviceArn,
      description: 'ECS service ARN',
      exportName: 'McpGatewayServiceArn',
    });

    new cdk.CfnOutput(this, 'ClusterName', {
      value: cluster.clusterName,
      description: 'ECS cluster name',
      exportName: 'McpGatewayClusterName',
    });
  }
}
