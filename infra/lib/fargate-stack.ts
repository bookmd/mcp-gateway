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
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
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

    // Import HubSpot OAuth secret
    const hubspotOAuthSecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      'HubSpotOAuthSecret',
      'arn:aws:secretsmanager:us-east-1:232282424912:secret:mcp-gateway/hubspot-oauth-WGG97y'
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
      {
        Name: 'HUBSPOT_CLIENT_ID',
        ValueFrom: 'arn:aws:secretsmanager:us-east-1:232282424912:secret:mcp-gateway/hubspot-oauth-WGG97y:client_id::',
      },
      {
        Name: 'HUBSPOT_CLIENT_SECRET',
        ValueFrom: 'arn:aws:secretsmanager:us-east-1:232282424912:secret:mcp-gateway/hubspot-oauth-WGG97y:client_secret::',
      },
      // Slack OAuth (optional - only loaded if secret exists)
      {
        Name: 'SLACK_CLIENT_ID',
        ValueFrom: 'arn:aws:secretsmanager:us-east-1:232282424912:secret:mcp-gateway/slack-oauth-??????:client_id::',
      },
      {
        Name: 'SLACK_CLIENT_SECRET',
        ValueFrom: 'arn:aws:secretsmanager:us-east-1:232282424912:secret:mcp-gateway/slack-oauth-??????:client_secret::',
      },
      {
        Name: 'SLACK_TEAM_ID',
        ValueFrom: 'arn:aws:secretsmanager:us-east-1:232282424912:secret:mcp-gateway/slack-oauth-??????:team_id::',
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
    hubspotOAuthSecret.grantRead(fargateService.taskDefinition.taskRole);

    // Grant Secrets Manager read access to execution role (required for ECS to inject secrets at container startup)
    googleOAuthSecret.grantRead(fargateService.taskDefinition.executionRole!);
    sessionSecret.grantRead(fargateService.taskDefinition.executionRole!);
    hubspotOAuthSecret.grantRead(fargateService.taskDefinition.executionRole!);

    // Add explicit IAM policy for secrets access with wildcard to cover both partial and full ARN references
    // ECS task definitions reference secrets by partial ARN (without suffix), but Secrets Manager ARNs include a suffix
    fargateService.taskDefinition.executionRole!.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
      resources: [
        'arn:aws:secretsmanager:us-east-1:232282424912:secret:mcp-gateway/google-oauth*',
        'arn:aws:secretsmanager:us-east-1:232282424912:secret:mcp-gateway/session-secret*',
        'arn:aws:secretsmanager:us-east-1:232282424912:secret:mcp-gateway/hubspot-oauth*',
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

    // ============================================================
    // CLOUDWATCH METRICS PERMISSIONS
    // ============================================================

    // Grant cloudwatch:PutMetricData to task role for custom metrics
    fargateService.taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'], // PutMetricData doesn't support resource-level permissions
      conditions: {
        StringEquals: {
          'cloudwatch:namespace': 'McpGateway',
        },
      },
    }));

    // ============================================================
    // CLOUDWATCH ALARMS
    // ============================================================

    const mcpGatewayNamespace = 'McpGateway';

    // Custom metric for Unhealthy Connections
    const unhealthyConnectionsMetric = new cloudwatch.Metric({
      namespace: mcpGatewayNamespace,
      metricName: 'UnhealthyConnections',
      statistic: 'Maximum',
      period: cdk.Duration.minutes(1),
    });

    // Alarm: High Unhealthy Connections (> 0 for 2 periods)
    new cloudwatch.Alarm(this, 'HighUnhealthyConnectionsAlarm', {
      alarmName: 'McpGateway-HighUnhealthyConnections',
      alarmDescription: 'Unhealthy SSE connections detected',
      metric: unhealthyConnectionsMetric,
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Custom metric for Stale Connections
    const staleConnectionsMetric = new cloudwatch.Metric({
      namespace: mcpGatewayNamespace,
      metricName: 'StaleConnections',
      statistic: 'Maximum',
      period: cdk.Duration.minutes(1),
    });

    // Alarm: High Stale Connections (> 2 for 2 periods)
    new cloudwatch.Alarm(this, 'HighStaleConnectionsAlarm', {
      alarmName: 'McpGateway-HighStaleConnections',
      alarmDescription: 'More than 2 stale SSE connections for 2 minutes',
      metric: staleConnectionsMetric,
      threshold: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Custom metric for Active HTTP Sessions
    const activeHttpSessionsMetric = new cloudwatch.Metric({
      namespace: mcpGatewayNamespace,
      metricName: 'ActiveHttpSessions',
      statistic: 'Maximum',
      period: cdk.Duration.minutes(5),
    });

    // Alarm: High Session Count (> 100 sessions for 5 min)
    new cloudwatch.Alarm(this, 'HighSessionCountAlarm', {
      alarmName: 'McpGateway-HighSessionCount',
      alarmDescription: 'More than 100 active MCP sessions',
      metric: activeHttpSessionsMetric,
      threshold: 100,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Alarm: ECS CPU High (> 80% for 3 periods of 1 min)
    new cloudwatch.Alarm(this, 'EcsCpuHighAlarm', {
      alarmName: 'McpGateway-EcsCpuHigh',
      alarmDescription: 'ECS service CPU utilization above 80%',
      metric: fargateService.service.metricCpuUtilization({
        statistic: 'Average',
        period: cdk.Duration.minutes(1),
      }),
      threshold: 80,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Alarm: ECS Memory High (> 80% for 3 periods of 1 min)
    new cloudwatch.Alarm(this, 'EcsMemoryHighAlarm', {
      alarmName: 'McpGateway-EcsMemoryHigh',
      alarmDescription: 'ECS service memory utilization above 80%',
      metric: fargateService.service.metricMemoryUtilization({
        statistic: 'Average',
        period: cdk.Duration.minutes(1),
      }),
      threshold: 80,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Alarm: ALB 5xx Errors (> 5 for 2 periods of 1 min)
    new cloudwatch.Alarm(this, 'Alb5xxErrorsAlarm', {
      alarmName: 'McpGateway-Alb5xxErrors',
      alarmDescription: 'More than 5 ALB 5xx errors per minute',
      metric: fargateService.loadBalancer.metricHttpCodeElb(
        elbv2.HttpCodeElb.ELB_5XX_COUNT,
        {
          statistic: 'Sum',
          period: cdk.Duration.minutes(1),
        }
      ),
      threshold: 5,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // ============================================================
    // CLOUDWATCH DASHBOARD
    // ============================================================

    const dashboard = new cloudwatch.Dashboard(this, 'McpGatewayDashboard', {
      dashboardName: 'McpGateway-Monitoring',
    });

    // Row 1: Active Connections
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Active Connections',
        left: [
          new cloudwatch.Metric({
            namespace: mcpGatewayNamespace,
            metricName: 'ActiveSseConnections',
            statistic: 'Maximum',
            period: cdk.Duration.minutes(1),
            label: 'SSE Connections',
          }),
          new cloudwatch.Metric({
            namespace: mcpGatewayNamespace,
            metricName: 'ActiveHttpSessions',
            statistic: 'Maximum',
            period: cdk.Duration.minutes(1),
            label: 'HTTP Sessions',
          }),
        ],
        width: 12,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Connection Health',
        left: [
          new cloudwatch.Metric({
            namespace: mcpGatewayNamespace,
            metricName: 'UnhealthyConnections',
            statistic: 'Maximum',
            period: cdk.Duration.minutes(1),
            label: 'Unhealthy',
            color: '#d62728', // red
          }),
          new cloudwatch.Metric({
            namespace: mcpGatewayNamespace,
            metricName: 'StaleConnections',
            statistic: 'Maximum',
            period: cdk.Duration.minutes(1),
            label: 'Stale',
            color: '#ff7f0e', // orange
          }),
        ],
        width: 12,
        height: 6,
      }),
    );

    // Row 2: ECS Metrics
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'ECS CPU & Memory',
        left: [
          fargateService.service.metricCpuUtilization({
            statistic: 'Average',
            period: cdk.Duration.minutes(1),
            label: 'CPU %',
          }),
          fargateService.service.metricMemoryUtilization({
            statistic: 'Average',
            period: cdk.Duration.minutes(1),
            label: 'Memory %',
          }),
        ],
        leftYAxis: { max: 100 },
        width: 12,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'ECS Task Count',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/ECS',
            metricName: 'RunningTaskCount',
            dimensionsMap: {
              ClusterName: cluster.clusterName,
              ServiceName: fargateService.service.serviceName,
            },
            statistic: 'Average',
            period: cdk.Duration.minutes(1),
            label: 'Running Tasks',
          }),
        ],
        width: 12,
        height: 6,
      }),
    );

    // Row 3: ALB Metrics
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'ALB Request Count',
        left: [
          fargateService.loadBalancer.metricRequestCount({
            statistic: 'Sum',
            period: cdk.Duration.minutes(1),
            label: 'Requests',
          }),
        ],
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'ALB Errors',
        left: [
          fargateService.loadBalancer.metricHttpCodeElb(
            elbv2.HttpCodeElb.ELB_5XX_COUNT,
            {
              statistic: 'Sum',
              period: cdk.Duration.minutes(1),
              label: '5xx Errors',
              color: '#d62728', // red
            }
          ),
          fargateService.loadBalancer.metricHttpCodeTarget(
            elbv2.HttpCodeTarget.TARGET_4XX_COUNT,
            {
              statistic: 'Sum',
              period: cdk.Duration.minutes(1),
              label: '4xx Errors',
              color: '#ff7f0e', // orange
            }
          ),
        ],
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'ALB Latency',
        left: [
          fargateService.loadBalancer.metricTargetResponseTime({
            statistic: 'Average',
            period: cdk.Duration.minutes(1),
            label: 'Avg Response Time',
          }),
          fargateService.loadBalancer.metricTargetResponseTime({
            statistic: 'p99',
            period: cdk.Duration.minutes(1),
            label: 'p99 Response Time',
          }),
        ],
        width: 8,
        height: 6,
      }),
    );

    // Row 4: Keepalive & Disconnection Metrics
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Keepalive Error Rate',
        left: [
          new cloudwatch.Metric({
            namespace: mcpGatewayNamespace,
            metricName: 'KeepaliveErrorRate',
            statistic: 'Maximum',
            period: cdk.Duration.minutes(1),
            label: 'Error Rate %',
          }),
        ],
        leftYAxis: { max: 100 },
        width: 12,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Disconnections',
        left: [
          new cloudwatch.Metric({
            namespace: mcpGatewayNamespace,
            metricName: 'Disconnections',
            statistic: 'Sum',
            period: cdk.Duration.minutes(1),
            label: 'Disconnections/min',
          }),
        ],
        width: 12,
        height: 6,
      }),
    );

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
