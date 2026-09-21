# AWS Bedrock AgentCore Secure Gateway Design Specification (Robot Tool Gateway)

This document details the architectural specifications of `RobotToolGatewayConstruct`. This construct deploys a secure, enterprise-grade **AWS Bedrock AgentCore Secure Gateway** as the unified API ingress and firewall fronting backend tool execution Lambdas.

---

## 1. Bedrock AgentCore Gateway Core Design

Exposing Lambdas directly to the public internet using naked API Gateways or direct Function URLs introduces vulnerabilities such as brute-force attacks or API probing.

The system utilizes `aws-cdk-lib/aws-bedrockagentcore`'s **Gateway** construct to deliver major security benefits:
* **Unified Entrypoint**: Fronts all physical robot skills and multi-modal presenter web apps.
* **IAM Cryptographic Authentication**: Configured with `bedrockagentcore.GatewayAuthorizer.usingAwsIam()`. Every single request arriving at the gateway must be signed using AWS Signature Version 4 (SigV4), preventing unauthorized anonymous access.
* **Observability**: Automatically invokes `applyAgentCoreGatewayObservability(this, "RobotOnlyTools", this.gateway)`, establishing metric alarms for latency, error rates, and concurrent invocations.

---

## 2. L2 Target & Sandboxing Isolation Design

To prevent interference between critical physical robot actuators and multi-modal digital human systems, the gateway deploys a **dual-target sandboxed isolation model** with two independent Lambda targets:

![L2 Sandbox Targets](./img/robot_tool_gateway_sandbox_aws.png)

### Sandbox Target Comparison Specifications

| Feature / Detail | Target A: `robot-only-mcp-lambda` | Target B: `digital-human-mcp-lambda` |
| :--- | :--- | :--- |
| **Gateway Target Name** | `robot-only-mcp-lambda` | `digital-human-mcp-lambda` |
| **Backend Lambda** | `RobotToolFunction` | `DigitalHumanToolFunction` |
| **Code Entrypoint** | `mcp_server/robot_tool_lambda.py` | `mcp_server/digital_human_tool_lambda.py` |
| **Tool Schema Asset** | `aws-agentic-robotics-robot-tool-schema.json` | `aws-agentic-robotics-digital-human-tool-schema.json` |
| **Supported Actions (API)**| **Robot Motion Control (31 Actions)**:<br> - Go forward, backup, strafe, stand, squat, bow, push-ups, kick, turn, wave (`robot_wave`), and camera capture (`robot_see`, `get_image`). | **Presenter Controls**:<br> - Digital human vocalization (`digital_human_speech`). |
| **Environment Keys** | `SIMULATOR_ENDPOINT`, `IMAGE_BUCKET_NAME` | `SIMULATOR_ENDPOINT`, `IMAGE_BUCKET_NAME`, `SpeechTable` |
| **S3 Bucket Access** | Read-Write (Stores capture frames) | Read-Only |
| **DynamoDB Table Access** | None (Completely disconnected) | Read-Write (Stores vocalization cache) |

---

## 3. Caller Authorization & Execution Flow

The sequence diagram below shows an external edge skill client (running on physical hardware) utilizing a dedicated IAM User (`SkillMcpUser`) to invoke the Bedrock Secure Gateway:

![Caller Authorization & Execution Flow](./img/robot_tool_gateway_flow_aws.png)

### Key Security IAM Policy Configuration
In `cdk-stack.ts`, security bindings lock down this execution flow:
1. **Dedicated IAM User Creation**:
   ```typescript
   const skillUser = new iam.User(this, "SkillMcpUser", {
     userName: "AmazonNovaRoboticsSkillUser",
   });
   ```
2. **Explicit Target Permission Grant**:
   ```typescript
   robotToolGatewayConstruct.grantInvokeGateway(skillUser);
   skillUser.addToPolicy(
     new iam.PolicyStatement({
       effect: iam.Effect.ALLOW,
       actions: ["bedrock-agentcore:InvokeGateway"],
       resources: [robotToolGatewayConstruct.gateway.gatewayArn],
     })
   );
   ```
3. **Multi-Tenant Cross-Account Access (OpenClaw Federation)**:
   The system supports secure federated tool calls from external AWS developer accounts. CDK dynamically parses the `openclawCallerAccountIds` context parameter and appends trust mappings (`AccountPrincipal`), keeping multi-tenant connections safe and centralized:
   ```typescript
   for (const accountId of [...new Set(openClawCallerAccountIds)]) {
     robotToolGatewayConstruct.grantInvokeGateway(new iam.AccountPrincipal(accountId));
   }
   ```
