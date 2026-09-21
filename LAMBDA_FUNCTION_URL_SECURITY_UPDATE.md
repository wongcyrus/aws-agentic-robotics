# Lambda Function URL Authorization Model Update

> [!NOTE]
> This is a historical migration record. The current AWS Agentic Robotics architecture uses the AgentCore gateway implemented in `cdk/lib/construct/robot-tool-gateway.ts`; it no longer deploys the legacy Lambda MCP function URL described below.

## Overview

AWS Lambda has updated the authorization model for function URLs to improve security. Function URLs now require **both** `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction` actions in permission policies.

## Changes Made

### Historical File

- `cdk/lib/construct/mcp-server.ts` (removed during the AgentCore gateway migration)

### What Changed

The `grantInvokeFunctionUrl()` method in `LambdaMcpServerConstruct` has been updated to add both required permissions:

1. **lambda:InvokeFunctionUrl** - Required for function URL access
2. **lambda:InvokeFunction** - Required as of the new authorization model

### Before (Old Authorization Model)

```typescript
public grantInvokeFunctionUrl(principal: iam.IPrincipal): void {
  const permissionId = `InvokeFunctionUrlPermission-${++this.permissionCounter}`;

  this.mcpFunction.addPermission(permissionId, {
    principal: principal,
    action: "lambda:InvokeFunctionUrl",
    functionUrlAuthType: FunctionUrlAuthType.AWS_IAM,
  });
}
```

### After (New Authorization Model)

```typescript
public grantInvokeFunctionUrl(principal: iam.IPrincipal): void {
  const functionUrlPermissionId = `InvokeFunctionUrlPermission-${++this.permissionCounter}`;
  const invokeFunctionPermissionId = `InvokeFunctionPermission-${this.permissionCounter}`;

  // Add lambda:InvokeFunctionUrl permission
  this.mcpFunction.addPermission(functionUrlPermissionId, {
    principal: principal,
    action: "lambda:InvokeFunctionUrl",
    functionUrlAuthType: FunctionUrlAuthType.AWS_IAM,
  });

  // Add lambda:InvokeFunction permission (new requirement)
  this.mcpFunction.addPermission(invokeFunctionPermissionId, {
    principal: principal,
    action: "lambda:InvokeFunction",
  });
}
```

## Affected Components

The MCP server function URL is accessed by the following components:

1. **Speech Control Service** (`speech-web.ts`)
   - Principal: `apprunner.amazonaws.com` (service principal)
2. **Text Control Service** (`text-web.ts`)
   - Principal: Flask Lambda execution role

Both components will now have the proper permissions to invoke the MCP server function URL.

## CDK Version Compatibility

✅ **Compatible** - Current CDK version: `2.220.0`

- Requirement: CDK version 2.218.0 or newer
- Status: PASSED

## Deployment

To apply these changes:

From the repository root:

```bash
# Navigate to CDK directory
cd cdk

# Install dependencies (if needed)
npm install

# Build the TypeScript code
npm run build

# Deploy the current stack
npx cdk deploy AwsAgenticRobotics
```

Or use the deployment script from the root:

```bash
./deploy.sh
```

## Timeline

- **AWS Deadline**: November 1, 2026
- **Update Status**: Completed in the legacy implementation; superseded by AgentCore gateway migration
- **Action Required**: None for the current architecture

## Testing

After deployment, verify that:

1. The MCP server function URL remains accessible
2. The speech control service can invoke the MCP server
3. The text control service can invoke the MCP server
4. No authorization errors appear in CloudWatch Logs

## Additional Resources

- [AWS Lambda Function URLs Documentation](https://docs.aws.amazon.com/lambda/latest/dg/lambda-urls.html)
- [AWS Lambda AddPermission API](https://docs.aws.amazon.com/lambda/latest/dg/API_AddPermission.html)
- [AWS Health Dashboard](https://health.aws.amazon.com/health/home) - Check "Affected Resources" for your function ARNs

## Notes

- The temporary exception granted by AWS will expire on November 1, 2026
- Both permissions are now automatically added when calling `grantInvokeFunctionUrl()`
- The implementation is backward compatible and will work with the current function URL setup
- No changes are required in the calling code (speech-web.ts and text-web.ts)
