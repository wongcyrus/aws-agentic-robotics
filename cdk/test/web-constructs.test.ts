import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as crypto from "crypto";

const mockPythonFunctionProps: Record<string, unknown>[] = [];

jest.mock("@aws-cdk/aws-lambda-python-alpha", () => {
  const lambda = require("aws-cdk-lib/aws-lambda");

  return {
    PythonFunction: class extends lambda.Function {
      constructor(scope: unknown, id: string, props: Record<string, unknown>) {
        mockPythonFunctionProps.push(props);
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

import { DatabaseConstruct } from "../lib/construct/datebase";
import { RobotSimulatorServerlessConstruct } from "../lib/construct/robot-simulator-serverless";
import { TextControlWebConstruct } from "../lib/construct/text-web";

describe("serverless web constructs", () => {
  const app = (context?: Record<string, unknown>) =>
    new App({ context, outdir: "cdk.out/jest-web-constructs" });

  beforeEach(() => {
    mockPythonFunctionProps.length = 0;
  });

  test("robot simulator configures REST, WebSocket, CloudFront, and storage", () => {
    const stack = new Stack(app(), "SimulatorStack", {
      env: { account: "111122223333", region: "us-east-1" },
    });

    const simulator = new RobotSimulatorServerlessConstruct(stack, "Simulator", {
      userPoolId: "user-pool-id",
      userPoolClientId: "client-id",
    });

    expect(simulator.serviceUrl).toBeDefined();
    expect(simulator.webSocketUrl).toContain("wss://");

    const template = Template.fromStack(stack);
    template.resourceCountIs("AWS::DynamoDB::Table", 2);
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      KeySchema: [{ AttributeName: "connection_id", KeyType: "HASH" }],
      GlobalSecondaryIndexes: [
        Match.objectLike({
          IndexName: "SessionKeyIndex",
          Projection: { ProjectionType: "ALL" },
        }),
      ],
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "lambda_function.py.lambda_handler",
      Runtime: "python3.12",
      MemorySize: 256,
      Timeout: 30,
      Environment: {
        Variables: Match.objectLike({
          IsInCloud: "yes",
          LOG_LEVEL: "WARNING",
          AWS_BEDROCK_REGION: "us-east-1",
          XIAOICE_APP_SECRET: "",
        }),
      },
    });
    template.hasResourceProperties("AWS::ApiGatewayV2::Api", {
      Name: "RobotSimulatorWebSocketApi",
      ProtocolType: "WEBSOCKET",
      RouteSelectionExpression: "$request.body.action",
    });
    template.resourceCountIs("AWS::ApiGatewayV2::Route", 3);
    template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
      AutoDeploy: true,
      StageName: "prod",
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
    const policies = JSON.stringify(template.findResources("AWS::IAM::Policy"));
    expect(policies).toContain("execute-api:ManageConnections");
    expect(policies).toContain("cloudfront:GetInvalidation");
    expect(policies).toContain("ssm:GetParameter");
  });

  test("robot simulator supports default props and forwards optional credentials", () => {
    process.env.XIAOICE_APP_SECRET = "app-secret";
    process.env.XIAOICE_COMPANY_ID = "company-id";
    process.env.XIAOICE_PROJECT_ID = "project-id";
    process.env.XIAOICE_SUBSCRIPTION_KEY = "subscription-key";
    try {
      const testStack = new Stack(app(), "DefaultSimulatorStack", {
        env: { account: "111122223333", region: "us-east-1" },
      });

      new RobotSimulatorServerlessConstruct(testStack, "Simulator");

      const lambdaProps = mockPythonFunctionProps.find(
        (props) => props.index === "lambda_function.py"
      );
      expect(lambdaProps?.environment).toEqual(
        expect.objectContaining({
          XIAOICE_APP_SECRET: "app-secret",
          XIAOICE_COMPANY_ID: "company-id",
          XIAOICE_PROJECT_ID: "project-id",
          XIAOICE_SUBSCRIPTION_KEY: "subscription-key",
        })
      );
    } finally {
      delete process.env.XIAOICE_APP_SECRET;
      delete process.env.XIAOICE_COMPANY_ID;
      delete process.env.XIAOICE_PROJECT_ID;
      delete process.env.XIAOICE_SUBSCRIPTION_KEY;
    }
  });

  test("text web derives stable secrets and exposes expected routes and permissions", () => {
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const stack = new Stack(app({ AwsUserId: "test-user" }), "TextStack", {
      env: { account: "111122223333", region: "us-east-1" },
    });
    const database = new DatabaseConstruct(stack, "Database");
    const speechTable = new dynamodb.TableV2(stack, "SpeechTable", {
      partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
    });
    const userPool = new cognito.UserPool(stack, "UserPool");
    const userPoolClient = new cognito.UserPoolClient(stack, "UserPoolClient", {
      userPool,
    });
    const roboticBucket = new s3.Bucket(stack, "RoboticBucket");
    const grantInvokeGateway = jest.fn();

    const textWeb = new TextControlWebConstruct(stack, "TextWeb", {
      database,
      speechTable,
      userPool,
      userPoolClient,
      roboticBucket,
      robotGatewayConstruct: {
        gatewayUrl: "https://gateway.example.test",
        grantInvokeGateway,
      },
    });

    expect(textWeb.serviceUrl).toMatch(/^https:\/\/.+\/.+\/index$/);
    expect(grantInvokeGateway).toHaveBeenCalledTimes(1);

    const template = Template.fromStack(stack);
    const hash = crypto.createHash("sha256").update("test-user").digest("hex");
    const chatSecret = crypto
      .createHash("sha256")
      .update(hash + "chat-secret-key")
      .digest("hex");
    const chatAccess = crypto
      .createHash("sha256")
      .update(hash + "chat-access-key")
      .digest("hex");

    template.hasResource("AWS::SecretsManager::Secret", {
      DeletionPolicy: "Delete",
      UpdateReplacePolicy: "Delete",
      Properties: Match.objectLike({
        Name: "XiaoiceProjectCredentials",
        SecretString: Match.anyValue(),
      }),
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "app.py.handler",
      Runtime: "python3.12",
      MemorySize: 512,
      Timeout: 30,
      Environment: {
        Variables: Match.objectLike({
          FlaskSecretKey: hash,
          XiaoiceChatSecretKey: chatSecret,
          XiaoiceChatAccessKey: chatAccess,
          McpServerGatewayUrl: "https://gateway.example.test",
        }),
      },
    });
    template.hasResourceProperties("AWS::SSM::Parameter", {
      Name: "/robotics/robot_api_url",
      Type: "String",
    });
    const methods = template.findResources("AWS::ApiGateway::Method");
    expect(Object.keys(methods).length).toBeGreaterThanOrEqual(7);
    const policies = JSON.stringify(template.findResources("AWS::IAM::Policy"));
    expect(policies).toContain("cognito-idp:AdminInitiateAuth");
    expect(policies).toContain("bedrock:InvokeModelWithResponseStream");
    expect(policies).toContain("iot-data:Publish");

    const textLambdaProps = mockPythonFunctionProps.find(
      (props) => props.index === "app.py"
    );
    const bundling = textLambdaProps?.bundling as {
      commandHooks: {
        beforeBundling(inputDir: string, outputDir: string): string[];
        afterBundling(inputDir: string, outputDir: string): string[];
      };
    };
    expect(
      bundling.commandHooks.beforeBundling("/asset-input", "/asset-output")
    ).toEqual([
      'echo "Running pre-build commands for /asset-input"',
      "cd /asset-input",
      "chmod +x pre_deploy_update_commands.sh",
      "./pre_deploy_update_commands.sh",
    ]);
    expect(
      bundling.commandHooks.afterBundling("/asset-input", "/asset-output")
    ).toEqual([
      'echo "Post-build verification for /asset-output"',
      "ls -la /asset-output/command_config/",
    ]);
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  test("text web uses default user context and includes available credential JSON", () => {
    const fsModule = require("fs") as typeof import("fs");
    const originalReadFileSync = fsModule.readFileSync;
    const readSpy = jest
      .spyOn(fsModule, "readFileSync")
      .mockImplementation((filePath, options) =>
        String(filePath).endsWith("/text_control/xiaoice_credentials.json")
          ? ('{"project":"credential"}' as never)
          : originalReadFileSync(filePath, options as never)
      );
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const testStack = new Stack(app(), "DefaultTextStack", {
      env: { account: "111122223333", region: "us-east-1" },
    });
    const database = new DatabaseConstruct(testStack, "Database");
    const speechTable = new dynamodb.TableV2(testStack, "SpeechTable", {
      partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
    });
    const userPool = new cognito.UserPool(testStack, "UserPool");
    const userPoolClient = new cognito.UserPoolClient(testStack, "Client", {
      userPool,
    });

    new TextControlWebConstruct(testStack, "TextWeb", {
      database,
      speechTable,
      userPool,
      userPoolClient,
      roboticBucket: new s3.Bucket(testStack, "Bucket"),
      robotGatewayConstruct: {
        gatewayUrl: "https://gateway.example.test",
        grantInvokeGateway: jest.fn(),
      },
    });

    const defaultHash = crypto
      .createHash("sha256")
      .update("default-user")
      .digest("hex");
    expect(
      mockPythonFunctionProps.find((props) => props.index === "app.py")
        ?.environment
    ).toEqual(expect.objectContaining({ FlaskSecretKey: defaultHash }));
    const template = Template.fromStack(testStack);
    template.hasResourceProperties("AWS::SecretsManager::Secret", {
      SecretString: '{"project":"credential"}',
    });

    readSpy.mockRestore();
    logSpy.mockRestore();
  });
});
