# Technology Stack

**Project:** MCP Gateway with Google OAuth
**Researched:** 2026-01-31
**Overall Confidence:** HIGH

## Recommended Stack

### Core Runtime

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| Node.js | 22.x LTS (Jod) | JavaScript runtime | Active LTS with support through Oct 2027. Node 22 includes native .env support and is the recommended production version for 2025-2026. Node 24.x (Krypton) is also LTS but Node 22 has broader ecosystem stability. |
| TypeScript | ^5.7.x | Type safety | MCP SDK requires TypeScript for full type safety. Latest stable version with improved performance and type inference. |

**Confidence:** HIGH - Official Node.js LTS roadmap and widespread adoption.

**Sources:**
- [Node.js Releases](https://nodejs.org/en/about/previous-releases)
- [Node.js LTS Explained 2025](https://jesuspaz.com/articles/node-lts-versioning-explained)

### MCP Protocol

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| @modelcontextprotocol/sdk | ^1.25.x | MCP server implementation | Official TypeScript SDK for MCP. Version 1.25.2 is current stable. Note: SSE transport is deprecated as of protocol 2025-03-26; use Streamable HTTP for new implementations. SDK includes built-in support for both. |
| zod | ^3.25.x | Schema validation | Required peer dependency for MCP SDK. TypeScript-first validation with zero dependencies and excellent performance. Industry standard for runtime validation in 2025. |

**Confidence:** HIGH - Official MCP SDK from modelcontextprotocol.io

**Important Note:** The MCP protocol deprecated HTTP+SSE transport in favor of Streamable HTTP as of specification version 2025-03-26. While SSE is still supported for backward compatibility, new implementations should use Streamable HTTP. However, for Cursor integration which may expect SSE, verify current Cursor requirements before finalizing transport choice.

**Sources:**
- [@modelcontextprotocol/sdk npm](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
- [MCP TypeScript SDK GitHub](https://github.com/modelcontextprotocol/typescript-sdk)
- [Why MCP Deprecated SSE](https://blog.fka.dev/blog/2025-06-06-why-mcp-deprecated-sse-and-go-with-streamable-http/)
- [MCP Transports Documentation](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)

### Web Framework

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| Fastify | ^5.x | HTTP server | 3-5x faster than Express (76k req/sec vs 15k). Native TypeScript support, built-in validation/serialization, excellent async/await handling. Better choice than Express for greenfield projects in 2025. Hono is faster (80k req/sec) but Fastify has superior ecosystem maturity for Node.js. |
| @fastify/cors | ^10.x | CORS handling | Official Fastify plugin for CORS with type safety |
| @fastify/helmet | ^12.x | Security headers | Official security plugin, sets HTTP headers to protect against common attacks |

**Confidence:** HIGH - Extensive benchmarks and 2025 ecosystem surveys show Fastify as the optimal choice for TypeScript Node.js APIs.

**Alternative:** Express 5.x if team has extensive Express expertise, but performance gap is significant (50-80% slower).

**Sources:**
- [Fastify vs Express vs Hono 2025](https://redskydigital.com/us/comparing-hono-express-and-fastify-lightweight-frameworks-today/)
- [Beyond Express: Fastify vs Hono](https://dev.to/alex_aslam/beyond-express-fastify-vs-hono-which-wins-for-high-throughput-apis-373i)
- [Fastify Benchmarks](https://fastify.dev/benchmarks/)

### SSE Implementation (If Required)

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| better-sse | ^0.x | SSE transport | If SSE is required for Cursor compatibility. Dependency-free, spec-compliant, written in TypeScript. Works with any Node HTTP framework including Fastify. 100% test coverage. |

**Confidence:** MEDIUM - SSE is deprecated in MCP spec but may be needed for Cursor. Verify Cursor's current transport requirements.

**Note:** Only include if Cursor definitively requires SSE. Otherwise, use MCP SDK's built-in Streamable HTTP transport.

**Sources:**
- [better-sse npm](https://www.npmjs.com/package/better-sse)
- [better-sse GitHub](https://github.com/MatthewWid/better-sse)
- [SSE's Comeback in 2025](https://portalzine.de/sses-glorious-comeback-why-2025-is-the-year-of-server-sent-events/)

### Google OAuth & APIs

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| google-auth-library | ^9.x | OAuth 2.0 authentication | Official Google library. Provides OAuth2Client class for web server flows. Handles token exchange, refresh, and validation. Version 9.0.0 is current stable. |
| googleapis | ^170.x | Google Workspace APIs | Official Node.js client for Gmail, Drive, Calendar, Docs APIs. Version 170.1.0 is current (updated weekly). Includes TypeScript types. Single library for all Google APIs with shared auth. |

**Confidence:** HIGH - Official Google libraries, actively maintained.

**Sources:**
- [google-auth-library npm](https://www.npmjs.com/package/google-auth-library)
- [Google Auth Library Reference](https://cloud.google.com/nodejs/docs/reference/google-auth-library/latest)
- [googleapis npm](https://www.npmjs.com/package/googleapis)
- [Google API Node.js Client GitHub](https://github.com/googleapis/google-api-nodejs-client)

### AWS Integration

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| @aws-sdk/client-dynamodb | ^3.x | DynamoDB client | AWS SDK v3 low-level client. Modular architecture (only install what you need). Built with TypeScript for first-class type support. |
| @aws-sdk/lib-dynamodb | ^3.x | DynamoDB document client | High-level client that abstracts DynamoDB type descriptors (S, N, B). Use this for all operations - cleaner API than low-level client. Wraps client-dynamodb. |
| @aws-sdk/client-kms | ^3.x | KMS encryption | For encrypting OAuth tokens at rest in DynamoDB. AWS SDK v3 modular package. |

**Confidence:** HIGH - Official AWS SDK v3, recommended approach for TypeScript.

**Pattern:** Always use DynamoDBDocumentClient from @aws-sdk/lib-dynamodb instead of raw DynamoDB client. It handles type conversion automatically and provides cleaner TypeScript experience.

**Sources:**
- [AWS SDK v3 GitHub](https://github.com/aws/aws-sdk-js-v3)
- [@aws-sdk/lib-dynamodb Documentation](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/Package/-aws-sdk-lib-dynamodb/)
- [DynamoDB with TypeScript Examples](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/javascript_dynamodb_code_examples.html)

### Logging

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| pino | ^9.x | Structured logging | 5x faster than Winston. JSON-formatted logs ideal for CloudWatch. Asynchronous logging with minimal overhead. De facto standard for high-performance Node.js logging in 2025. |
| pino-pretty | ^13.x | Development logging | Pretty-print logs in development. Dev dependency only. |

**Confidence:** HIGH - Industry standard for production Node.js logging.

**Alternative:** Winston if team requires multiple transports or complex formatting, but performance gap is significant.

**Sources:**
- [Pino vs Winston 2025](https://betterstack.com/community/comparisons/pino-vs-winston/)
- [Pino High-Performance Logging](https://last9.io/blog/npm-pino-logger/)
- [Node.js Logging Frameworks 2025](https://www.dash0.com/faq/the-top-5-best-node-js-and-javascript-logging-frameworks-in-2025-a-complete-guide)

### Environment & Configuration

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| (Native Node.js) | Built-in | Environment variables | Node 22 has native .env support via --env-file flag or process.loadEnvFile(). No dotenv dependency needed. |
| ts-dotenv | ^0.9.x | Type-safe env vars | Optional: Provides strongly-typed environment variables with runtime validation. Fails fast if required env vars are missing or wrong type. Good for catching config errors early. |

**Confidence:** HIGH - Native Node.js support eliminates dependency.

**Note:** For Node 22, you don't need the `dotenv` package. Use `--env-file` flag or `process.loadEnvFile()`. Consider ts-dotenv for type safety if environment variables are complex.

**Sources:**
- [Node.js Environment Variables](https://nodejs.org/api/environment_variables.html)
- [You Don't Need dotenv Anymore](https://typescript.tv/best-practices/you-dont-need-dotenv-anymore/)
- [ts-dotenv GitHub](https://github.com/LeoBakerHytch/ts-dotenv)

### Development Tools

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| tsx | ^4.x | TypeScript execution | Faster than ts-node for development. Built on esbuild. Use for running TS files directly. |
| vitest | ^2.x | Testing framework | Native ESM support, fast, compatible with Jest API. Better TypeScript integration than Jest. |
| @types/node | ^22.x | Node.js types | Type definitions matching Node.js 22 LTS |

**Confidence:** HIGH - Standard TypeScript development tooling for 2025.

## Alternatives Considered

| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| Web Framework | Fastify | Express.js | Express is 3-5x slower and has synchronous bottlenecks. Ecosystem is mature but performance matters for gateway. Fastify has better TypeScript support. |
| Web Framework | Fastify | Hono | Hono is slightly faster but optimized for edge/serverless. Fastify has better Node.js ecosystem and ECS deployment patterns. |
| Validation | Zod | Joi | Joi is heavier and has worse TypeScript integration. Zod is required by MCP SDK anyway. |
| Validation | Zod | Yup | Yup's TypeScript support is weaker. Zod is more performant and has better type inference. |
| Logging | Pino | Winston | Winston is 5x slower. Pino's JSON output is better for CloudWatch. For a gateway handling many requests, performance matters. |
| AWS SDK | v3 | v2 | v2 is in maintenance mode. v3 has better TypeScript support and modular architecture (smaller bundle sizes). |
| Node.js | 22.x LTS | 24.x LTS | Both are LTS, but 22.x has longer remaining support window and broader ecosystem testing. 24.x is newer but 22.x is the safe choice. |
| Node.js | 22.x LTS | 20.x LTS | 20.x is in Maintenance LTS (until April 2026). Use 22.x for Active LTS with longer support. |

## Installation

### Core Dependencies

```bash
npm install \
  @modelcontextprotocol/sdk \
  zod \
  fastify \
  @fastify/cors \
  @fastify/helmet \
  google-auth-library \
  googleapis \
  @aws-sdk/client-dynamodb \
  @aws-sdk/lib-dynamodb \
  @aws-sdk/client-kms \
  pino
```

### Optional: SSE Support (if Cursor requires)

```bash
npm install better-sse
```

### Optional: Type-safe Environment Variables

```bash
npm install ts-dotenv
```

### Development Dependencies

```bash
npm install -D \
  typescript \
  @types/node \
  tsx \
  vitest \
  pino-pretty
```

## Package.json Scripts

```json
{
  "scripts": {
    "dev": "tsx watch --env-file=.env src/index.ts",
    "build": "tsc",
    "start": "node --env-file=.env dist/index.js",
    "test": "vitest",
    "test:coverage": "vitest --coverage"
  }
}
```

## TypeScript Configuration

Recommended tsconfig.json for Node 22 + Fastify + AWS SDK:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

## Docker Configuration for ECS Fargate

Recommended Dockerfile for production deployment:

```dockerfile
FROM node:22-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN npm run build

FROM node:22-alpine

WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Fargate requires app to listen on 0.0.0.0
ENV HOST=0.0.0.0
ENV PORT=80

EXPOSE 80

CMD ["node", "dist/index.js"]
```

**Key ECS Fargate Notes:**
- App MUST bind to 0.0.0.0 (not localhost/127.0.0.1)
- Use port 80 for HTTP traffic
- Move typescript and @types/node to regular dependencies (not devDependencies) if using RUN npm run build in Dockerfile
- Use multi-stage build to reduce final image size

**Sources:**
- [AWS ECS Fargate TypeScript Best Practices](https://blog.appsignal.com/2024/06/05/develop-a-serverless-typescript-api-on-aws-ecs-with-fargate.html)
- [Deploying TypeScript to ECS Fargate](https://medium.com/@davidkelley87/deploying-a-fastify-api-to-aws-ecs-fargate-using-cdk-d8f799f8ebbf)

## Deployment: AWS CDK Recommendation

For infrastructure as code, use AWS CDK with TypeScript:

```bash
npm install -D \
  aws-cdk-lib \
  @aws-cdk/aws-ecs-patterns
```

The `ApplicationLoadBalancedFargateService` construct simplifies ECS+ALB setup significantly.

**Sources:**
- [AWS CDK ECS Patterns](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_ecs_patterns-readme.html)

## Version Locking Strategy

For production stability:

1. **Lock exact versions** in package.json (no ^ or ~) for deployment
2. **Use ^ for development** to catch breaking changes early
3. **Update quarterly** with comprehensive testing
4. **Monitor security advisories** via GitHub Dependabot

## Security Considerations

1. **OAuth Token Storage:**
   - Encrypt tokens at rest using AWS KMS before storing in DynamoDB
   - Implement token refresh rotation (issue new refresh token on each use)
   - Store refresh tokens separately from access tokens
   - Use DynamoDB TTL for automatic token expiration cleanup

2. **Environment Variables:**
   - Never commit .env files
   - Use AWS Secrets Manager or Parameter Store for production secrets
   - Use IAM roles for ECS tasks (no hardcoded AWS credentials)

3. **Domain Restriction:**
   - Validate Google OAuth domain restriction in googleapis configuration
   - Implement additional server-side domain checks as defense-in-depth

**Sources:**
- [OAuth Token Refresh Best Practices 2025](https://auth0.com/blog/refresh-tokens-what-are-they-and-when-to-use-them/)
- [Refresh Token Rotation](https://authjs.dev/guides/refresh-token-rotation)

## Architecture Decision: Transport Layer

**Critical Decision Required:** Verify Cursor's current MCP transport requirements.

- If Cursor supports Streamable HTTP → Use MCP SDK's built-in transport (simpler, more maintainable)
- If Cursor requires SSE → Add better-sse and implement SSE transport (legacy support)

The MCP specification recommends Streamable HTTP as of 2025-03-26, but client compatibility determines actual implementation.

**Next Step:** Check Cursor documentation or test with Cursor to determine transport requirement before finalizing stack.

## Confidence Assessment

| Component | Confidence | Rationale |
|-----------|-----------|-----------|
| Node.js 22 LTS | HIGH | Official LTS roadmap, widespread production use |
| Fastify | HIGH | Extensive benchmarks, proven in production at scale |
| MCP SDK | HIGH | Official SDK, actively maintained by MCP team |
| Google Auth Library | HIGH | Official Google library, version 9.x stable |
| AWS SDK v3 | HIGH | Official AWS SDK, TypeScript-first design |
| Pino | HIGH | Industry standard for high-performance logging |
| Zod | HIGH | Required by MCP SDK, widely adopted |
| SSE Transport | MEDIUM | Deprecated in MCP but may be needed for Cursor - requires verification |
| better-sse | MEDIUM | If SSE needed, this is best library, but SSE itself is deprecated |

## Open Questions for Phase-Specific Research

1. **Cursor Transport:** Does Cursor support Streamable HTTP or require SSE? (Test before implementation)
2. **Google OAuth Scopes:** Exact scopes needed for Gmail, Drive, Calendar, Docs access?
3. **Rate Limiting:** Does this gateway need rate limiting per-user? (Not in stack but may need library)
4. **Monitoring:** APM strategy for ECS? (CloudWatch, Datadog, etc.)
5. **Session Management:** Is stateless JWT sufficient or need Redis for session storage?

These questions should be answered during relevant implementation phases.

## Summary

This stack prioritizes:
- **Performance:** Fastify + Pino for high-throughput, low-latency gateway
- **Type Safety:** TypeScript-first libraries (Zod, MCP SDK, AWS SDK v3)
- **Official Libraries:** Google and AWS official SDKs for reliability
- **Production Readiness:** LTS Node.js, battle-tested libraries, security best practices
- **Developer Experience:** Modern tooling (tsx, vitest), excellent TypeScript support

For a ~20 user deployment on ECS Fargate, this stack is over-engineered for scale but provides excellent developer experience and positions the project for growth.
