import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
import { ArnFormat, Lazy, Names, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import type { IGateway } from "aws-cdk-lib/aws-bedrockagentcore";
import type { IBedrockAgentRuntime } from "aws-cdk-lib/aws-bedrockagentcore";
import * as xray from "aws-cdk-lib/aws-xray";
import { Construct } from "constructs";

const AGENTCORE_LOG_RETENTION = logs.RetentionDays.THREE_DAYS;
const MAX_DELIVERY_NAME_LENGTH = 60;

class XRayResourcePolicy extends Construct {
  public readonly document = new iam.PolicyDocument();

  constructor(scope: Construct, id: string) {
    super(scope, id);

    new xray.CfnResourcePolicy(this, "ResourcePolicy", {
      policyName: Lazy.string({
        produce: () =>
          Names.uniqueResourceName(this, {
            maxLength: 128,
          }),
      }),
      policyDocument: Lazy.string({
        produce: () => JSON.stringify(this.document.toJSON()),
      }),
    });
  }
}

function createLogGroup(scope: Construct, id: string, logGroupName: string): logs.LogGroup {
  return new logs.LogGroup(scope, id, {
    logGroupName,
    retention: AGENTCORE_LOG_RETENTION,
    removalPolicy: RemovalPolicy.DESTROY,
  });
}

function addLogsDeliveryWritePolicy(scope: Construct, logGroup: logs.ILogGroup): void {
  const stack = Stack.of(scope);
  const policyId = "CdkLogGroupLogsDeliveryPolicy";
  let resourcePolicy = stack.node.tryFindChild(policyId) as logs.ResourcePolicy | undefined;

  if (!resourcePolicy) {
    resourcePolicy = new logs.ResourcePolicy(stack, policyId);
  }

  resourcePolicy.document.addStatements(
    new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal("delivery.logs.amazonaws.com")],
      actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
      resources: [`${logGroup.logGroupArn}:log-stream:*`],
      conditions: {
        StringEquals: {
          "aws:SourceAccount": stack.account,
        },
        ArnLike: {
          "aws:SourceArn": stack.formatArn({
            service: "logs",
            resource: "*",
          }),
        },
      },
    })
  );
}

function configureTracingDelivery(scope: Construct, id: string, sourceArn: string): logs.CfnDelivery {
  const stack = Stack.of(scope);

  const deliverySource = new logs.CfnDeliverySource(scope, `${id}TracesDeliverySource`, {
    name: Lazy.string({
      produce: (): string =>
        Names.uniqueResourceName(deliverySource, {
          maxLength: MAX_DELIVERY_NAME_LENGTH,
        }),
    }),
    logType: "TRACES",
    resourceArn: sourceArn,
  });

  const policyId = "CdkXRayLogsDeliveryPolicy";
  let xrayPolicy = stack.node.tryFindChild(policyId) as XRayResourcePolicy | undefined;
  if (!xrayPolicy) {
    xrayPolicy = new XRayResourcePolicy(stack, policyId);
  }

  xrayPolicy.document.addStatements(
    new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal("delivery.logs.amazonaws.com")],
      actions: ["xray:PutTraceSegments"],
      resources: ["*"],
      conditions: {
        "ForAllValues:ArnLike": {
          "logs:LogGeneratingResourceArns": [sourceArn],
        },
        StringEquals: {
          "aws:SourceAccount": stack.account,
        },
        ArnLike: {
          "aws:SourceArn": stack.formatArn({
            service: "logs",
            resource: "delivery-source",
            resourceName: "*",
            arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          }),
        },
      },
    })
  );

  const deliveryDestination = new logs.CfnDeliveryDestination(
    scope,
    `${id}TracesDeliveryDestination`,
    {
      name: Lazy.string({
        produce: (): string =>
          Names.uniqueResourceName(deliveryDestination, {
            maxLength: MAX_DELIVERY_NAME_LENGTH,
          }),
      }),
      deliveryDestinationType: "XRAY",
    }
  );
  deliveryDestination.node.addDependency(xrayPolicy);

  const delivery = new logs.CfnDelivery(scope, `${id}TracesDelivery`, {
    deliverySourceName: deliverySource.deliverySourceRef.deliverySourceName,
    deliveryDestinationArn: deliveryDestination.attrArn,
  });
  delivery.node.addDependency(deliverySource);
  delivery.node.addDependency(deliveryDestination);

  return delivery;
}

export interface AgentCoreRuntimeObservability {
  readonly loggingConfigs: agentcore.LoggingConfig[];
}

export function createAgentCoreRuntimeObservability(
  scope: Construct,
  id: string,
  runtimeName: string
): AgentCoreRuntimeObservability {
  const applicationLogGroup = createLogGroup(
    scope,
    `${id}ApplicationLogGroup`,
    `/aws/vendedlogs/bedrock-agentcore/runtime/APPLICATION_LOGS/${runtimeName}`
  );
  const usageLogGroup = createLogGroup(
    scope,
    `${id}UsageLogGroup`,
    `/aws/vendedlogs/bedrock-agentcore/runtime/USAGE_LOGS/${runtimeName}`
  );

  return {
    loggingConfigs: [
      {
        logType: agentcore.LogType.APPLICATION_LOGS,
        destination: agentcore.LoggingDestination.cloudWatchLogs(applicationLogGroup),
      },
      {
        logType: agentcore.LogType.USAGE_LOGS,
        destination: agentcore.LoggingDestination.cloudWatchLogs(usageLogGroup),
      },
    ],
  };
}

export function applyAgentCoreRuntimeLogRetention(
  scope: Construct,
  id: string,
  runtime: IBedrockAgentRuntime
): void {
  new logs.LogRetention(scope, `${id}RuntimeLogsRetention`, {
    logGroupName: `/aws/bedrock-agentcore/runtimes/${runtime.agentRuntimeId}-DEFAULT/runtime-logs`,
    retention: AGENTCORE_LOG_RETENTION,
  });
}

export function applyAgentCoreGatewayObservability(
  scope: Construct,
  id: string,
  gateway: IGateway
): void {
  new logs.LogRetention(scope, `${id}GatewayLogsRetention`, {
    logGroupName: `/aws/bedrock-agentcore/gateways/${gateway.gatewayId}`,
    retention: AGENTCORE_LOG_RETENTION,
  });

  const applicationLogGroup = createLogGroup(
    scope,
    `${id}ApplicationLogGroup`,
    `/aws/vendedlogs/bedrock-agentcore/gateway/APPLICATION_LOGS/${gateway.gatewayId}`
  );
  addLogsDeliveryWritePolicy(scope, applicationLogGroup);

  const deliverySource = new logs.CfnDeliverySource(scope, `${id}ApplicationDeliverySource`, {
    name: Lazy.string({
      produce: (): string =>
        Names.uniqueResourceName(deliverySource, {
          maxLength: MAX_DELIVERY_NAME_LENGTH,
        }),
    }),
    logType: "APPLICATION_LOGS",
    resourceArn: gateway.gatewayArn,
  });

  const deliveryDestination = new logs.CfnDeliveryDestination(
    scope,
    `${id}ApplicationDeliveryDestination`,
    {
      name: Lazy.string({
        produce: (): string =>
          Names.uniqueResourceName(deliveryDestination, {
            maxLength: MAX_DELIVERY_NAME_LENGTH,
          }),
      }),
      deliveryDestinationType: "CWL",
      destinationResourceArn: applicationLogGroup.logGroupArn,
    }
  );

  const delivery = new logs.CfnDelivery(scope, `${id}ApplicationDelivery`, {
    deliverySourceName: deliverySource.deliverySourceRef.deliverySourceName,
    deliveryDestinationArn: deliveryDestination.attrArn,
  });
  delivery.node.addDependency(deliverySource);
  delivery.node.addDependency(deliveryDestination);

  const tracingDelivery = configureTracingDelivery(scope, id, gateway.gatewayArn);
  tracingDelivery.node.addDependency(delivery);
}
