import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";

const pythonFunctionProps: Record<string, unknown>[] = [];

jest.mock("@aws-cdk/aws-lambda-python-alpha", () => {
  const lambda = require("aws-cdk-lib/aws-lambda");
  return {
    PythonFunction: class extends lambda.Function {
      constructor(scope: unknown, id: string, props: Record<string, unknown>) {
        pythonFunctionProps.push(props);
        super(scope, id, {
          runtime: props.runtime,
          handler: `${props.index}.${props.handler}`,
          code: lambda.Code.fromInline("def handler(event, context): pass"),
          timeout: props.timeout,
          memorySize: props.memorySize,
          logGroup: props.logGroup,
          environment: props.environment,
        });
      }
    },
  };
});

jest.mock("aws-cdk-lib/aws-s3-deployment", () => {
  const cdk = require("aws-cdk-lib");
  const iam = require("aws-cdk-lib/aws-iam");
  return {
    Source: {
      asset: jest.fn(() => ({ bind: jest.fn() })),
      jsonData: jest.fn(() => ({ bind: jest.fn() })),
    },
    BucketDeployment: class extends cdk.Resource {
      public readonly handlerRole;

      constructor(scope: unknown, id: string) {
        super(scope, id);
        this.handlerRole = new iam.Role(this, "HandlerRole", {
          assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
        });
      }
    },
  };
});

import { DomainExpansionV2ServerlessConstruct } from "../lib/construct/domain-expansion-v2-serverless";
import { DomainExpansionV2Stack } from "../lib/domain-expansion-v2-stack";

describe("DomainExpansionV2ServerlessConstruct", () => {
  beforeEach(() => {
    pythonFunctionProps.length = 0;
  });

  test("creates isolated online-only V2 resources", () => {
    const app = new App({ outdir: "cdk.out/jest-domain-v2" });
    const stack = new Stack(app, "DomainV2Test", {
      env: { account: "111122223333", region: "us-east-1" },
    });

    const construct = new DomainExpansionV2ServerlessConstruct(
      stack,
      "DomainV2",
      {
        userPoolId: "us-east-1_example",
        userPoolClientId: "client-id",
        commentatorRuntimeArn:
          "arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/commentator",
        openClawRuntimeArn:
          "arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/openclaw",
        robotApiEndpoint: "https://robot.example.test",
        robotGatewayUrl: "https://gateway.example.test",
      }
    );

    expect(construct.serviceUrl).toBeDefined();
    expect(construct.webSocketUrl).toContain("wss://");
    expect(construct.restApiUrl).toContain("https://");

    const template = Template.fromStack(stack);
    template.resourceCountIs("AWS::DynamoDB::Table", 2);
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      KeySchema: [{ AttributeName: "connection_id", KeyType: "HASH" }],
      TimeToLiveSpecification: {
        AttributeName: "ttl",
        Enabled: true,
      },
      GlobalSecondaryIndexes: [
        Match.objectLike({ IndexName: "RoomCodeIndex" }),
      ],
    });
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      KeySchema: [{ AttributeName: "session_id", KeyType: "HASH" }],
      TimeToLiveSpecification: {
        AttributeName: "ttl",
        Enabled: true,
      },
    });
    template.hasResourceProperties("AWS::ApiGatewayV2::Api", {
      Name: "DomainExpansionV2WebSocketApi",
      ProtocolType: "WEBSOCKET",
      RouteSelectionExpression: "$request.body.action",
    });
    template.hasResourceProperties("AWS::ApiGateway::RestApi", {
      Name: "Domain Expansion V2 REST API",
    });
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        DefaultRootObject: "index.html",
        PriceClass: "PriceClass_100",
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({ PathPattern: "/api/*" }),
          Match.objectLike({ PathPattern: "/ws" }),
        ]),
      }),
    });

    expect(pythonFunctionProps).toHaveLength(1);
    expect(pythonFunctionProps[0].entry).toContain(
      "domain-expansion-ar-game-v2-serverless/backend"
    );
    expect(pythonFunctionProps[0].environment).toEqual(
      expect.objectContaining({
        BEDROCK_MODEL_ID: "global.moonshotai.kimi-k3",
        COMMENTARY_MAX_TOKENS: "1600",
        COGNITO_USER_POOL_ID: "us-east-1_example",
        ROBOT_API_ENDPOINT: "https://robot.example.test",
      })
    );
    const templateJson = JSON.stringify(template.toJSON());
    expect(templateJson).toContain("execute-api:ManageConnections");
    expect(templateJson).not.toContain("DomainExpansionConnections");
    expect(templateJson).not.toContain("DomainExpansionSessions");
  });

  test("stack wrapper exposes the V2 service outputs", () => {
    const app = new App({ outdir: "cdk.out/jest-domain-v2-stack" });
    const stack = new DomainExpansionV2Stack(app, "DomainV2StackTest", {
      env: { account: "111122223333", region: "us-east-1" },
      userPoolId: "us-east-1_example",
      userPoolClientId: "client-id",
      commentatorRuntimeArn:
        "arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/commentator",
      openClawRuntimeArn:
        "arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/openclaw",
      robotApiEndpoint: "https://robot.example.test",
      robotGatewayUrl: "https://gateway.example.test",
    });

    const template = Template.fromStack(stack);
    template.hasOutput("DomainExpansionV2Url", {
      Description: "Parallel Domain Expansion V2 website",
    });
    template.hasOutput("DomainExpansionV2WebSocketUrl", {
      Description: "Domain Expansion V2 WebSocket endpoint",
    });
    template.hasOutput("DomainExpansionV2RestApiUrl", {
      Description: "Domain Expansion V2 REST API endpoint",
    });
    template.hasOutput("DomainExpansionV2WebsiteBucket", {
      Description: "Domain Expansion V2 website bucket",
    });
  });
});
