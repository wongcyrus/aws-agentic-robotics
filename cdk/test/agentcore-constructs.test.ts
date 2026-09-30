import { describe, expect, jest, test } from "@jest/globals";
import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";

const mockAgentcorePythonFunctionProps: Record<string, unknown>[] = [];

jest.mock("@aws-cdk/aws-lambda-python-alpha", () => {
  const lambdaModule = require("aws-cdk-lib/aws-lambda");

  return {
    PythonFunction: class extends lambdaModule.Function {
      constructor(scope: unknown, id: string, props: Record<string, unknown>) {
        mockAgentcorePythonFunctionProps.push(props);
        super(scope, id, {
          runtime: props.runtime,
          handler: `${props.index}.${props.handler}`,
          code: lambdaModule.Code.fromInline(
            "def lambda_handler(event, context): pass"
          ),
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
import { DomainExpansionServerlessConstruct } from "../lib/construct/domain-expansion-serverless";
import { RobotToolGatewayConstruct } from "../lib/construct/robot-tool-gateway";
import { SpeechControlAgentcoreConstruct } from "../lib/construct/speech-web-agentcore";

describe("AgentCore-backed constructs", () => {
  const app = () => new App({ outdir: "cdk.out/jest-agentcore-constructs" });

  function stack(id: string): Stack {
    return new Stack(app(), id, {
      env: { account: "111122223333", region: "us-east-1" },
    });
  }

  function mockLocalAssets() {
    const fixtureAsset = s3deploy.Source.asset("test/fixtures/static");
    const imageSpy = jest
      .spyOn(agentcore.AgentRuntimeArtifact, "fromAsset")
      .mockReturnValue(
        agentcore.AgentRuntimeArtifact.fromImageUri(
          "111122223333.dkr.ecr.us-east-1.amazonaws.com/test:latest"
        )
      );
    const sourceSpy = jest
      .spyOn(s3deploy.Source, "asset")
      .mockReturnValue(fixtureAsset);
    return { imageSpy, sourceSpy };
  }

  test("robot gateway filters tool schemas and grants only required Lambda access", () => {
    const testStack = stack("GatewayStack");
    const mediaBucket = new s3.Bucket(testStack, "MediaBucket");
    const speechTable = new dynamodb.TableV2(testStack, "SpeechTable", {
      partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
    });
    const schemaWrites: string[] = [];
    const osModule = require("os") as typeof import("os");
    const fsModule = require("fs") as typeof import("fs");
    const tmpdirSpy = jest
      .spyOn(osModule, "tmpdir")
      .mockReturnValue("cdk.out/jest-agentcore-constructs");
    const writeSpy = jest
      .spyOn(fsModule, "writeFileSync")
      .mockImplementation((_path, content) => {
        const serialized = String(content);
        try {
          const candidate = JSON.parse(serialized) as unknown;
          if (
            Array.isArray(candidate) &&
            candidate.every(
              (entry) =>
                typeof entry === "object" &&
                entry !== null &&
                "name" in entry
            )
          ) {
            schemaWrites.push(serialized);
          }
        } catch {
          // Ignore unrelated CDK cache writes.
        }
      });
    const schemaSpy = jest
      .spyOn(agentcore.ToolSchema, "fromLocalAsset")
      .mockImplementation(() =>
        agentcore.ToolSchema.fromInline([
          {
            name: "placeholder",
            description: "placeholder",
            inputSchema: {
              type: agentcore.SchemaDefinitionType.OBJECT,
              properties: {},
            },
          },
        ])
      );

    const gateway = new RobotToolGatewayConstruct(testStack, "Gateway", {
      simulatorEndpoint: "https://simulator.example.test",
      mediaBucket,
      speechTable,
    });
    new RobotToolGatewayConstruct(testStack, "DefaultGateway", {
      mediaBucket,
      speechTable,
    });
    writeSpy.mockRestore();
    tmpdirSpy.mockRestore();
    schemaSpy.mockRestore();

    expect(schemaWrites).toHaveLength(4);
    const robotSchema = JSON.parse(schemaWrites[0]) as Array<{ name: string }>;
    const digitalHumanSchema = JSON.parse(schemaWrites[1]) as Array<{
      name: string;
    }>;
    expect(robotSchema.map(({ name }) => name)).toEqual(
      expect.arrayContaining(["robot_go_forward", "robot_see", "get_image"])
    );
    expect(robotSchema.some(({ name }) => name === "digital_human_speech")).toBe(
      false
    );
    expect(digitalHumanSchema.map(({ name }) => name)).toEqual([
      "digital_human_speech",
    ]);
    expect(gateway.gatewayUrl).toBeDefined();
    expect(
      mockAgentcorePythonFunctionProps.filter(
        (props) =>
          (props.environment as Record<string, string>).SIMULATOR_ENDPOINT === ""
      )
    ).toHaveLength(2);

    const grantee = new lambda.Function(testStack, "GatewayConsumer", {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "index.handler",
      code: lambda.Code.fromInline("exports.handler = async () => {};"),
    });
    gateway.grantInvokeGateway(grantee);

    const template = Template.fromStack(testStack);
    template.resourceCountIs("AWS::BedrockAgentCore::Gateway", 2);
    template.resourceCountIs("AWS::BedrockAgentCore::GatewayTarget", 4);
    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "robot_tool_lambda.py.lambda_handler",
      Runtime: "python3.12",
      Environment: {
        Variables: Match.objectLike({
          SIMULATOR_ENDPOINT: "https://simulator.example.test",
        }),
      },
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "digital_human_tool_lambda.py.lambda_handler",
      Runtime: "python3.12",
    });
    const policies = JSON.stringify(template.findResources("AWS::IAM::Policy"));
    expect(policies).toContain("bedrock-agentcore:InvokeGateway");
    expect(policies).toContain("polly:SynthesizeSpeech");
    expect(policies).toContain("iot-data:Publish");
    expect(policies).toContain("dynamodb:UpdateItem");
    expect(policies).toContain("s3:PutObject");
  });

  test("speech runtime configures model access, gateway tools, frontend, and invalidation", () => {
    const { imageSpy, sourceSpy } = mockLocalAssets();
    const testStack = stack("SpeechStack");
    const database = new DatabaseConstruct(testStack, "Database");
    const grantInvokeGateway = jest.fn();

    new SpeechControlAgentcoreConstruct(testStack, "Speech", {
      database,
      robotGatewayConstruct: {
        gatewayUrl: "https://gateway.example.test",
        grantInvokeGateway,
      },
      userPoolId: "user-pool-id",
      userPoolClientId: "client-id",
      identityPoolId: "identity-pool-id",
    });
    imageSpy.mockRestore();
    sourceSpy.mockRestore();

    expect(grantInvokeGateway).toHaveBeenCalledTimes(1);
    const template = Template.fromStack(testStack);
    template.hasResourceProperties("AWS::BedrockAgentCore::Runtime", {
      AgentRuntimeName: "robot_voice_agentcore",
      EnvironmentVariables: Match.objectLike({
        AWS_BEDROCK_REGION: "us-east-1",
        McpServerGatewayUrl: "https://gateway.example.test",
        MCP_TOOL_PREFIX_ALLOW: "robot-only-mcp-lambda___robot_",
        MCP_TOOL_NAME_ALLOW: Match.stringLikeRegexp(
          "robot-only-mcp-lambda___robot_go_forward"
        ),
      }),
      ProtocolConfiguration: "HTTP",
    });
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        DefaultRootObject: "index.html",
        PriceClass: "PriceClass_100",
      }),
    });
    template.hasResourceProperties("AWS::S3::Bucket", {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          {
            ServerSideEncryptionByDefault: {
              SSEAlgorithm: "AES256",
            },
          },
        ],
      },
    });
    const policies = JSON.stringify(template.findResources("AWS::IAM::Policy"));
    expect(policies).toContain("bedrock:InvokeModelWithResponseStream");
    expect(policies).toContain("amazon.nova-2-sonic-v1:0");
    expect(policies).toContain("cloudfront:GetInvalidation");
    expect(policies).toContain('"Action":"dynamodb:*"');
  });

  test("domain expansion configures authenticated APIs and explicit public endpoints", () => {
    const { imageSpy, sourceSpy } = mockLocalAssets();
    const testStack = stack("DomainStack");
    const userPool = new cognito.UserPool(testStack, "UserPool");
    const userPoolClient = new cognito.UserPoolClient(
      testStack,
      "UserPoolClient",
      { userPool }
    );
    const grantInvokeGateway = jest.fn();

    const domain = new DomainExpansionServerlessConstruct(
      testStack,
      "Domain",
      {
        robotSimulatorServerlessConstruct: {
          serviceUrl: "simulator.example.test",
        } as never,
        userPool,
        userPoolClient,
        robotGatewayConstruct: {
          gatewayUrl: "https://gateway.example.test",
          grantInvokeGateway,
        } as never,
      }
    );
    imageSpy.mockRestore();
    sourceSpy.mockRestore();

    expect(domain.serviceUrl).toBeDefined();
    expect(domain.webSocketUrl).toContain("wss://");
    expect(domain.runtimeArn).toBeDefined();
    expect(grantInvokeGateway).toHaveBeenCalledTimes(1);

    const template = Template.fromStack(testStack);
    template.hasResourceProperties("AWS::BedrockAgentCore::Runtime", {
      AgentRuntimeName: "domain_commentator_agentcore",
      EnvironmentVariables: {
        IsInCloud: "yes",
        AWS_BEDROCK_REGION: "us-east-1",
        BEDROCK_MODEL_ID: "global.moonshotai.kimi-k3",
      },
      LifecycleConfiguration: {
        IdleRuntimeSessionTimeout: 120,
        MaxLifetime: 900,
      },
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "lambda_function.py.lambda_handler",
      Runtime: "python3.12",
      Environment: {
        Variables: Match.objectLike({
          OPENCLAW_SESSION_ID: "telegram:default",
          OPENCLAW_AGENT_ID: "main",
          OPENCLAW_USER_FILES_BUCKET:
            "openclaw-user-files-111122223333-us-east-1-dev",
          ROBOT_API_ENDPOINT: "https://simulator.example.test",
          McpServerGatewayUrl: "https://gateway.example.test",
          DEFAULT_SESSION_KEY: "mcpserver",
        }),
      },
    });
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              "s3:GetObject*",
              "s3:DeleteObject*",
              "s3:PutObject",
            ]),
            Effect: "Allow",
            Resource: Match.arrayWith([
              {
                "Fn::Join": [
                  "",
                  [
                    "arn:",
                    { Ref: "AWS::Partition" },
                    ":s3:::openclaw-user-files-111122223333-us-east-1-dev/telegram_default/_uploads/*",
                  ],
                ],
              },
            ]),
          }),
          {
            Action: ["kms:Encrypt", "kms:GenerateDataKey"],
            Condition: {
              StringEquals: {
                "kms:ViaService": "s3.us-east-1.amazonaws.com",
              },
              StringLike: {
                "kms:EncryptionContext:aws:s3:arn": {
                  "Fn::Join": [
                    "",
                    [
                      "arn:",
                      { Ref: "AWS::Partition" },
                      ":s3:::openclaw-user-files-111122223333-us-east-1-dev/telegram_default/_uploads/*",
                    ],
                  ],
                },
              },
            },
            Effect: "Allow",
            Resource: "*",
          },
        ]),
      },
    });
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "DomainExpansionConnections",
      GlobalSecondaryIndexes: [
        Match.objectLike({ IndexName: "RoomCodeIndex" }),
      ],
      SSESpecification: {
        SSEEnabled: true,
      },
    });
    template.hasResourceProperties("AWS::S3::Bucket", {
      LifecycleConfiguration: {
        Rules: [
          Match.objectLike({
            ExpirationInDays: 7,
            Status: "Enabled",
          }),
        ],
      },
    });
    template.resourcePropertiesCountIs(
      "AWS::S3::Bucket",
      Match.objectLike({
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            {
              ServerSideEncryptionByDefault: {
                SSEAlgorithm: "AES256",
              },
            },
          ],
        },
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: false,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: false,
        },
      }),
      1
    );
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      AuthorizationType: "CUSTOM",
      RouteKey: "$connect",
    });
    template.hasResourceProperties("AWS::ApiGateway::Method", {
      AuthorizationType: "NONE",
      HttpMethod: "GET",
    });
    template.hasResourceProperties("AWS::ApiGateway::Method", {
      AuthorizationType: "COGNITO_USER_POOLS",
      HttpMethod: "POST",
    });
    const policies = JSON.stringify(template.findResources("AWS::IAM::Policy"));
    expect(policies).toContain("bedrock-agentcore:InvokeAgentRuntime");
    expect(policies).toContain("moonshotai.kimi-k3");
    expect(policies).toContain("cloudfront:GetInvalidation");
    expect(policies).toContain("execute-api:ManageConnections");
  });

});
