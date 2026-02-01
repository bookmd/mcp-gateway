#!/usr/bin/env node
import 'source-map-support/register.js';
import * as cdk from 'aws-cdk-lib';
import { McpGatewayStack } from '../lib/fargate-stack.js';

const app = new cdk.App();

// Deploy to Vim IT Corp account (232282424912) using AssumeCorpAdmin role
new McpGatewayStack(app, 'McpGatewayStack', {
  env: {
    account: '232282424912',  // Vim IT Corp
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
  },
  description: 'MCP Gateway for Google Workspace - ECS Fargate deployment',
});
