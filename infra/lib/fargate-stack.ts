import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecs_patterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

export class McpGatewayStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Get configuration from CDK context (passed via --context or cdk.json)
    const googleClientId = this.node.tryGetContext('googleClientId') || process.env.GOOGLE_CLIENT_ID;
    const googleClientSecret = this.node.tryGetContext('googleClientSecret') || process.env.GOOGLE_CLIENT_SECRET;
    const googleRedirectUri = this.node.tryGetContext('googleRedirectUri') || process.env.GOOGLE_REDIRECT_URI;
    const allowedDomain = this.node.tryGetContext('allowedDomain') || process.env.ALLOWED_DOMAIN;
    const sessionSecret = this.node.tryGetContext('sessionSecret') || process.env.SESSION_SECRET;
    const kmsKeyArn = this.node.tryGetContext('kmsKeyArn') || process.env.KMS_KEY_ARN;
    const dynamoTableName = this.node.tryGetContext('dynamoTableName') || 'mcp-gateway-sessions';

    // VPC with 2 AZs and 1 NAT Gateway (cost optimization for 20 users)
    const vpc = new ec2.Vpc(this, 'McpGatewayVpc', {
      maxAzs: 2,
      natGateways: 1,
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

    // Reference existing KMS key (created in Phase 2)
    // KMS key ARN must be provided via context or environment
    const encryptionKey = kmsKeyArn
      ? kms.Key.fromKeyArn(this, 'EncryptionKey', kmsKeyArn)
      : undefined;

    // Fargate service with ALB (HTTP on port 80 for initial deployment)
    const fargateService = new ecs_patterns.ApplicationLoadBalancedFargateService(
      this,
      'McpGatewayService',
      {
        cluster,
        cpu: 512,  // 0.5 vCPU
        memoryLimitMiB: 1024,  // 1 GB (valid Fargate combination)
        desiredCount: 1,  // Start with 1 task, auto-scaling handles the rest
        platformVersion: ecs.FargatePlatformVersion.LATEST,

        taskImageOptions: {
          // Build Docker image from project root (where Dockerfile is)
          image: ecs.ContainerImage.fromAsset('../', {
            file: 'Dockerfile',
          }),
          containerPort: 3000,

          // Environment variables passed to container
          environment: {
            NODE_ENV: 'production',
            PORT: '3000',
            AWS_REGION: cdk.Stack.of(this).region,
            DYNAMODB_TABLE_NAME: dynamoTableName,
            // OAuth and sensitive config from CDK context
            GOOGLE_CLIENT_ID: googleClientId || '',
            GOOGLE_CLIENT_SECRET: googleClientSecret || '',
            GOOGLE_REDIRECT_URI: googleRedirectUri || '',
            ALLOWED_DOMAIN: allowedDomain || '',
            SESSION_SECRET: sessionSecret || '',
            KMS_KEY_ID: kmsKeyArn || '',
          },

          // CloudWatch logging with 7-day retention
          logDriver: ecs.LogDrivers.awsLogs({
            streamPrefix: 'mcp-gateway',
            logRetention: logs.RetentionDays.ONE_WEEK,
          }),
        },

        // HTTP listener on port 80 (HTTPS with custom domain deferred)
        publicLoadBalancer: true,
        listenerPort: 80,

        // Deployment configuration with circuit breaker
        circuitBreaker: { rollback: true },
        minHealthyPercent: 100,
        maxHealthyPercent: 200,

        // Health check grace period for container startup
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

    // Grant DynamoDB read/write access to task role
    sessionsTable.grantReadWriteData(fargateService.taskDefinition.taskRole);

    // Grant KMS encrypt/decrypt access to task role (if key provided)
    if (encryptionKey) {
      encryptionKey.grantEncryptDecrypt(fargateService.taskDefinition.taskRole);
    }

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
