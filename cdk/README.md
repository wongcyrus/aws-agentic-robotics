# CDK Infrastructure

This CDK app provisions the AWS infrastructure for the AWS Agentic Robotics project, including the **speech AgentCore runtime**, the **dual-target AgentCore gateway** for humanoid and digital-human tools, static websites, Cognito, and supporting data stores.

## Useful commands

- `npm run build` — compile TypeScript
- `npm run typecheck` — validate strict TypeScript without emitting files
- `npm run lint` — lint the CDK app and tests with ESLint
- `npm run test` — run unit tests
- `npm run test:coverage` — run tests with the enforced 95% global coverage thresholds
- `npx cdk synth AwsAgenticRobotics` — synthesize CloudFormation
- `npx cdk diff AwsAgenticRobotics` — compare local changes with the deployed stack
- `npx cdk deploy AwsAgenticRobotics` — deploy the `aws-agentic-robotics` stack
- `npx cdk destroy AwsAgenticRobotics` — destroy the `aws-agentic-robotics` stack

`AwsAgenticRobotics` is the CDK app selector. The physical CloudFormation stack name is `aws-agentic-robotics`.

## Current speech + gateway deployment shape

The voice cockpit no longer points at a shared mixed MCP surface.

It now deploys and uses a **single AgentCore gateway with isolated targets**:

- `cdk/lib/construct/robot-tool-gateway.ts`
  - creates a dedicated Lambda target for robot-only tools
  - creates a separate Lambda target for digital-human tools
  - publishes filtered tool schema assets for both targets
  - sets the AgentCore gateway target names to `robot-only-mcp-lambda` and `digital-human-mcp-lambda`
- `cdk/lib/construct/speech-web-agentcore.ts`
  - points the speech runtime at that robot-only gateway
  - grants the speech runtime permission to invoke that gateway
  - injects the exact gateway-visible tool names into runtime environment variables

## Important AgentCore tool naming rule

For AgentCore Lambda targets, the MCP-visible tool name is:

`{gatewayTargetName}___{toolName}`

In this stack that means tools are exposed as names such as:

- `robot-only-mcp-lambda___robot_wave`
- `robot-only-mcp-lambda___robot_stop`

Important implications:

1. The speech runtime/model must use the **exact prefixed names** from the gateway.
2. The Lambda target must strip the `robot-only-mcp-lambda___` prefix before dispatching to the internal robot action map.
3. If the Lambda cannot read the AgentCore-provided tool name from the invocation context, the gateway call fails before any robot action is executed.

## Important implementation findings

- The clean solution is **not** to rename tools for the model. The current code keeps the exact AgentCore gateway names end-to-end on the speech side.
- The robot Lambda now relies on the documented AgentCore context contract for tool-name resolution instead of broad fallback parsing.
- For tool-call debugging, the most useful log stream is often the **BedrockAgentCoreGateway application log**, not only the speech runtime log stream.
- `cdk.out/` can grow very large after repeated synth/deploy cycles and is safe to remove when cleaning local workspace disk usage.

## OpenClaw gateway callers

The AgentCore gateway is granted to the current AWS account by default. That lets OpenClaw callers in the same account invoke the gateway while still relying on the caller-side IAM policy for the final allow/deny decision.

You can override the allowed caller accounts with CDK context:

- `openclawCallerAccountIds`: comma-separated string or array of AWS account IDs that should be allowed to invoke the AgentCore gateway

## 👩 Xiaoice Digital Human Credentials & Dynamic Avatar Switching

The Xiaoice Digital Human Bridge Console (`xiaoice_human.html`) supports secure, serverless dynamic signature token generation using an integrated client-safe API endpoint on the AWS Lambda backend. 

### 🛡️ Secret Hygiene & Security Architecture
To ensure complete protection against **secret leaks**:
- The partner developer credentials (`XIAOICE_SUBSCRIPTION_KEY` and `XIAOICE_APP_SECRET`) reside **exclusively on the AWS Lambda backend** as environment variables.
- They are **never** exposed in frontend HTML, CSS, JavaScript, or client logs.
- They are stored locally in the gitignored `cdk/.env` file. **Never commit `.env` or hardcode credentials into Git.**

---

### 🎨 How to Handle and Switch Multiple Avatar Project IDs (Dynamic Switcher)
If you have multiple projects or different digital human avatars, you can switch between them on the fly **without redeploying any backend code or changing server configurations**. 

Simply append the target project ID as a query parameter in your browser URL when opening the console:

```markdown
https://djt9g9bto90gy.cloudfront.net/xiaoice_human.html?project_id=<TARGET_PROJECT_ID>
```

#### Supported Query Parameter Formats:
- `project_id` (e.g., `?project_id=3779193f0f9b4f74afd2121617ab4252`)
- `projectId` (e.g., `?projectId=3779193f0f9b4f74afd2121617ab4252`)
- `project-id` (e.g., `?project-id=3779193f0f9b4f74afd2121617ab4252`)

#### How it works under the hood:
1. **Client URL Parse**: `xiaoice_human.html` extracts the `project_id` from the browser address bar search query.
2. **Backend Query Forwarding**: The frontend requests a token from `/api/xiaoice_token?project_id=<TARGET_PROJECT_ID>`.
3. **Dynamic Signature Generation**: The AWS Lambda retrieves the request, extracts the specified `project_id`, calls the official Xiaoice signature generator API with your secret `XIAOICE_SUBSCRIPTION_KEY`, base64-encodes the resulting JWT signature token (preventing browser decoding exceptions), and returns both the safe token and target `project_id` back to the frontend.
4. **Resilient Auto-Refresh**: The background refresh loop in the frontend is fully aware of the chosen project ID and refreshes the token for that specific active avatar every 45 minutes automatically, preventing stream termination.

---

### 🚀 Setup & Deployment Instructions

1. **Create your `.env` file** (if it doesn't already exist) by copying the template:
   ```bash
   cp .env.template .env
   ```
2. **Open the `cdk/.env` file** and configure your Xiaoice credentials:
   ```ini
   XIAOICE_APP_SECRET=your_app_secret_here
   XIAOICE_COMPANY_ID=your_company_id_here
   XIAOICE_SUBSCRIPTION_KEY=your_partner_subscription_key_here
   XIAOICE_PROJECT_ID=f989c84f7bc7439aa238356ebe5045f1
   ```
3. **Deploy the Stack**:
   Run the deployment script:
   ```bash
   ./deploy.sh
   ```
   The CDK application automatically maps these values securely into the Lambda function's environment variables. If no `XIAOICE_SUBSCRIPTION_KEY` is supplied, the Lambda backend will recognize this and gracefully fallback to generating local signature handshakes using the app secret, keeping the console operational.
