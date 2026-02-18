# MCP Gateway Deployment Issues - February 17, 2026

## Summary

Multiple deployment failures occurred due to IAM permission mismatches between ECS task definitions and Secrets Manager access policies.

---

## Issue 1: AWS Credentials Configuration

**Problem:** The default AWS credentials were overwritten with a BedrockAPIKey user that lacked CloudFormation permissions.

**Symptoms:**
```
User: arn:aws:iam::232282424912:user/BedrockAPIKey-0dfl is not authorized to perform: cloudformation:DescribeStacks
```

**Resolution:** Restored the original `ravidk` user credentials and the `default-original` profile required by the `mfa` tool.

**Files affected:** `~/.aws/credentials`

---

## Issue 2: Secrets Manager Permission Denied

**Problem:** ECS tasks failed to start because the execution role couldn't read secrets from Secrets Manager.

**Symptoms:**
```
ResourceInitializationError: unable to pull secrets or registry auth: execution resource retrieval failed: 
unable to retrieve secret from asm: ... AccessDeniedException: User: 
arn:aws:sts::232282424912:assumed-role/McpGatewayStack-McpGatewayServiceTaskDefExecutionRo-pgMhvfH2zrMA/... 
is not authorized to perform: secretsmanager:GetSecretValue on resource: 
arn:aws:secretsmanager:us-east-1:232282424912:secret:mcp-gateway/session-secret
```

**Root Cause:** 
1. The CDK code only granted Secrets Manager access to the **task role**, not the **execution role**
2. ECS requires the execution role to have secrets access because it injects secrets at container startup time (before the task role is assumed)

**Initial Fix Attempt:** Added `grantRead()` for the execution role:
```typescript
googleOAuthSecret.grantRead(fargateService.taskDefinition.executionRole!);
sessionSecret.grantRead(fargateService.taskDefinition.executionRole!);
```

---

## Issue 3: Secret ARN Mismatch

**Problem:** Even after granting execution role access, tasks still failed with the same permission error.

**Root Cause:** 
- ECS task definitions reference secrets by **partial ARN** (without the random suffix): `arn:aws:secretsmanager:us-east-1:232282424912:secret:mcp-gateway/session-secret`
- Secrets Manager ARNs include a **random suffix**: `arn:aws:secretsmanager:us-east-1:232282424912:secret:mcp-gateway/session-secret-WoJjev`
- CDK's `fromSecretNameV2()` generates IAM policies with wildcard patterns like `mcp-gateway/session-secret-??????`
- The wildcard pattern `??????` (6 characters) doesn't match the partial ARN (no suffix)

**IAM Policy Generated:**
```json
{
  "Action": ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
  "Resource": "arn:aws:secretsmanager:us-east-1:232282424912:secret:mcp-gateway/session-secret-??????",
  "Effect": "Allow"
}
```

**ECS Task Definition Secret Reference:**
```json
{
  "name": "SESSION_SECRET",
  "valueFrom": "arn:aws:secretsmanager:us-east-1:232282424912:secret:mcp-gateway/session-secret"
}
```

**The Mismatch:** `mcp-gateway/session-secret` does NOT match `mcp-gateway/session-secret-??????`

**Final Fix:** Added explicit IAM policy with wildcard `*` to cover both partial and full ARN references:
```typescript
fargateService.taskDefinition.executionRole!.addToPrincipalPolicy(new iam.PolicyStatement({
  actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
  resources: [
    'arn:aws:secretsmanager:us-east-1:232282424912:secret:mcp-gateway/google-oauth*',
    'arn:aws:secretsmanager:us-east-1:232282424912:secret:mcp-gateway/session-secret*',
  ],
}));
```

---

## Issue 4: CloudFormation Rollback Failures

**Problem:** After ECS deployment failures, CloudFormation rollback also failed.

**Symptoms:**
```
UPDATE_ROLLBACK_FAILED
Listener port '80' is already in use
```

**Root Cause:** 
- The deployment created a new HTTP→HTTPS redirect listener on port 80
- During rollback, CloudFormation tried to recreate the original port 80 listener
- The new redirect listener was still present, causing a port conflict

**Resolution:** Used `continue-update-rollback` with `--resources-to-skip` to skip the conflicting listener:
```bash
aws cloudformation continue-update-rollback --stack-name McpGatewayStack \
  --resources-to-skip McpGatewayServiceLBPublicListener39E958C5
```

---

## Issue 5: ECS Circuit Breaker Triggering Rollbacks

**Problem:** The ECS deployment circuit breaker kept triggering automatic rollbacks.

**Symptoms:**
```
Error occurred during operation 'ECS Deployment Circuit Breaker was triggered'
```

**Root Cause:** Tasks failed to start due to the Secrets Manager permission issue, causing the circuit breaker to detect unhealthy deployments and trigger rollbacks.

**Resolution:** Fix the underlying Secrets Manager permission issue (Issue 3).

---

## Secrets Information

| Secret Name | Full ARN |
|-------------|----------|
| Google OAuth | `arn:aws:secretsmanager:us-east-1:232282424912:secret:mcp-gateway/google-oauth-89qXYD` |
| Session Secret | `arn:aws:secretsmanager:us-east-1:232282424912:secret:mcp-gateway/session-secret-WoJjev` |

---

## Files Modified

1. **`infra/lib/fargate-stack.ts`**
   - Added `import * as iam from 'aws-cdk-lib/aws-iam'`
   - Changed `fromSecretNameV2()` to `fromSecretCompleteArn()` with full secret ARNs
   - Added `grantRead()` for execution role
   - Added explicit IAM policy statement with wildcard resources

2. **`~/.aws/config`**
   - Temporarily added `mfa_serial` to corp-admin profile (later removed as it caused double MFA prompts)

3. **`~/.aws/credentials`**
   - Restored `default-original` profile required by `mfa` tool

---

## Deployment Commands

```bash
# Authenticate with MFA
mfa default

# Deploy
cd /Users/ravidkatmor/Projects/mcp-gateway/infra
AWS_PROFILE=corp-admin cdk deploy --require-approval never

# If rollback fails
AWS_PROFILE=corp-admin aws cloudformation continue-update-rollback \
  --stack-name McpGatewayStack \
  --resources-to-skip McpGatewayServiceLBPublicListener39E958C5

# Check status
AWS_PROFILE=corp-admin aws cloudformation describe-stacks \
  --stack-name McpGatewayStack \
  --query 'Stacks[0].StackStatus'

# Check ECS deployment
AWS_PROFILE=corp-admin aws ecs describe-services \
  --cluster McpGatewayStack-McpGatewayClusterF62BAB07-ReOuwDcNOL7x \
  --services <service-arn> \
  --query 'services[0].deployments'

# Check stopped task errors
AWS_PROFILE=corp-admin aws ecs describe-tasks \
  --cluster <cluster-name> \
  --tasks <task-arn> \
  --query 'tasks[0].stoppedReason'
```

---

## Lessons Learned

1. **ECS Secrets require execution role permissions**, not just task role permissions
2. **CDK's `fromSecretNameV2()` generates wildcard IAM policies** that may not match partial ARN references in ECS task definitions
3. **Use explicit IAM policies with `*` wildcards** when dealing with Secrets Manager to cover both partial and full ARN patterns
4. **CloudFormation rollback failures** can be resolved by skipping problematic resources
5. **Always check stopped task `stoppedReason`** for the actual error when ECS deployments fail
