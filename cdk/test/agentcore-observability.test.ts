import { describe, expect, test } from "@jest/globals";
import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import {
  applyAgentCoreGatewayObservability,
  applyAgentCoreRuntimeLogRetention,
  createAgentCoreRuntimeObservability,
} from "../lib/construct/agentcore-observability";

describe("AgentCore observability", () => {
  const app = () => new App({ outdir: "cdk.out/jest-observability" });

  test("runtime observability creates destroyable application and usage logs", () => {
    const stack = new Stack(app(), "RuntimeObservabilityStack");

    const observability = createAgentCoreRuntimeObservability(
      stack,
      "Runtime",
      "test_runtime"
    );

    expect(observability.loggingConfigs).toHaveLength(2);
    const template = Template.fromStack(stack);
    template.resourceCountIs("AWS::Logs::LogGroup", 2);
    template.hasResource("AWS::Logs::LogGroup", {
      DeletionPolicy: "Delete",
      UpdateReplacePolicy: "Delete",
      Properties: {
        LogGroupName:
          "/aws/vendedlogs/bedrock-agentcore/runtime/APPLICATION_LOGS/test_runtime",
        RetentionInDays: 3,
      },
    });
    template.hasResourceProperties("AWS::Logs::LogGroup", {
      LogGroupName:
        "/aws/vendedlogs/bedrock-agentcore/runtime/USAGE_LOGS/test_runtime",
      RetentionInDays: 3,
    });
  });

  test("runtime retention targets the runtime-specific default log group", () => {
    const stack = new Stack(app(), "RuntimeRetentionStack");

    applyAgentCoreRuntimeLogRetention(stack, "Test", {
      agentRuntimeId: "runtime-123",
    } as never);

    Template.fromStack(stack).hasResourceProperties("Custom::LogRetention", {
      LogGroupName:
        "/aws/bedrock-agentcore/runtimes/runtime-123-DEFAULT/runtime-logs",
      RetentionInDays: 3,
    });
  });

  test("gateway observability creates CloudWatch and X-Ray deliveries with shared policies", () => {
    const stack = new Stack(app(), "GatewayObservabilityStack", {
      env: { account: "111122223333", region: "us-east-1" },
    });
    const gatewayArn =
      "arn:aws:bedrock-agentcore:us-east-1:111122223333:gateway/gateway-123";
    const gateway = {
      gatewayId: "gateway-123",
      gatewayArn,
    } as never;

    applyAgentCoreGatewayObservability(stack, "First", gateway);
    applyAgentCoreGatewayObservability(stack, "Second", {
      gatewayId: "gateway-456",
      gatewayArn:
        "arn:aws:bedrock-agentcore:us-east-1:111122223333:gateway/gateway-456",
    } as never);

    const template = Template.fromStack(stack);
    template.resourceCountIs("Custom::LogRetention", 2);
    template.resourceCountIs("AWS::Logs::DeliverySource", 4);
    template.resourceCountIs("AWS::Logs::DeliveryDestination", 4);
    template.resourceCountIs("AWS::Logs::Delivery", 4);
    template.resourceCountIs("AWS::Logs::ResourcePolicy", 1);
    template.resourceCountIs("AWS::XRay::ResourcePolicy", 1);
    template.hasResourceProperties("AWS::Logs::LogGroup", {
      LogGroupName:
        "/aws/vendedlogs/bedrock-agentcore/gateway/APPLICATION_LOGS/gateway-123",
      RetentionInDays: 3,
    });
    template.hasResourceProperties("AWS::Logs::DeliveryDestination", {
      DeliveryDestinationType: "XRAY",
    });
    template.hasResourceProperties("AWS::Logs::DeliverySource", {
      LogType: "TRACES",
      ResourceArn: gatewayArn,
    });
    const resourcePolicies = JSON.stringify(
      template.findResources("AWS::Logs::ResourcePolicy")
    );
    expect(resourcePolicies).toContain("logs:CreateLogStream");
    expect(resourcePolicies).toContain("logs:PutLogEvents");
    expect(resourcePolicies).toContain("delivery.logs.amazonaws.com");
  });
});
