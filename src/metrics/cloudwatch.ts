import {
  CloudWatchClient,
  PutMetricDataCommand,
  StandardUnit,
  MetricDatum,
} from '@aws-sdk/client-cloudwatch';
import { getConnectionMetrics, getSseHealthMetrics } from '../routes/sse.js';

// CloudWatch namespace for all MCP Gateway metrics
const NAMESPACE = 'McpGateway';

// Publish interval: 60 seconds
const PUBLISH_INTERVAL_MS = 60 * 1000;

// Track previous values for delta calculations
let previousTotalDisconnections = 0;
let previousTotalKeepaliveErrors = 0;

// CloudWatch client (uses default credential chain - ECS task role in production)
const cloudwatch = new CloudWatchClient({
  region: process.env.AWS_REGION || 'us-east-1',
});

// Interval handle for graceful shutdown
let publishInterval: NodeJS.Timeout | null = null;

/**
 * Publish metrics to CloudWatch
 */
async function publishMetrics(): Promise<void> {
  try {
    const metrics = getConnectionMetrics();
    const healthMetrics = getSseHealthMetrics();

    // Calculate deltas for counter metrics
    const disconnectionsDelta = metrics.totalDisconnections - previousTotalDisconnections;
    const keepaliveErrorsDelta = metrics.totalKeepaliveErrors - previousTotalKeepaliveErrors;

    // Update previous values
    previousTotalDisconnections = metrics.totalDisconnections;
    previousTotalKeepaliveErrors = metrics.totalKeepaliveErrors;

    // Calculate keepalive error rate (errors / total keepalives sent)
    const keepaliveErrorRate = metrics.totalKeepalivesSent > 0
      ? (metrics.totalKeepaliveErrors / metrics.totalKeepalivesSent) * 100
      : 0;

    const timestamp = new Date();

    const metricData: MetricDatum[] = [
      // Gauge metrics - current state
      {
        MetricName: 'ActiveSseConnections',
        Value: metrics.activeSseConnections,
        Unit: StandardUnit.Count,
        Timestamp: timestamp,
      },
      {
        MetricName: 'ActiveHttpSessions',
        Value: metrics.activeHttpSessions,
        Unit: StandardUnit.Count,
        Timestamp: timestamp,
      },
      {
        MetricName: 'UnhealthyConnections',
        Value: healthMetrics.unhealthyConnections,
        Unit: StandardUnit.Count,
        Timestamp: timestamp,
      },
      {
        MetricName: 'StaleConnections',
        Value: healthMetrics.staleConnections,
        Unit: StandardUnit.Count,
        Timestamp: timestamp,
      },
      // Percentage metric
      {
        MetricName: 'KeepaliveErrorRate',
        Value: keepaliveErrorRate,
        Unit: StandardUnit.Percent,
        Timestamp: timestamp,
      },
      // Delta counter metrics (change since last publish)
      {
        MetricName: 'Disconnections',
        Value: disconnectionsDelta,
        Unit: StandardUnit.Count,
        Timestamp: timestamp,
      },
      {
        MetricName: 'KeepaliveErrors',
        Value: keepaliveErrorsDelta,
        Unit: StandardUnit.Count,
        Timestamp: timestamp,
      },
    ];

    await cloudwatch.send(new PutMetricDataCommand({
      Namespace: NAMESPACE,
      MetricData: metricData,
    }));

    console.log(`[CloudWatch] Published ${metricData.length} metrics: SSE=${metrics.activeSseConnections}, HTTP=${metrics.activeHttpSessions}, Unhealthy=${healthMetrics.unhealthyConnections}, Stale=${healthMetrics.staleConnections}`);
  } catch (error) {
    // Log but don't crash - metrics are not critical
    console.error('[CloudWatch] Failed to publish metrics:', error);
  }
}

/**
 * Start publishing metrics to CloudWatch at regular intervals
 */
export function startMetricsPublishing(): void {
  // Skip in development (no AWS credentials)
  if (process.env.NODE_ENV !== 'production') {
    console.log('[CloudWatch] Metrics publishing disabled (not in production)');
    return;
  }

  console.log(`[CloudWatch] Starting metrics publishing every ${PUBLISH_INTERVAL_MS / 1000}s to namespace: ${NAMESPACE}`);

  // Publish immediately on startup
  publishMetrics();

  // Then publish at regular intervals
  publishInterval = setInterval(publishMetrics, PUBLISH_INTERVAL_MS);
}

/**
 * Stop publishing metrics (for graceful shutdown)
 */
export function stopMetricsPublishing(): void {
  if (publishInterval) {
    console.log('[CloudWatch] Stopping metrics publishing');
    clearInterval(publishInterval);
    publishInterval = null;
  }
}
