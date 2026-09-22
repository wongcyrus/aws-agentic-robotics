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
    const fsModule = require("fs") as typeof import("fs");
    const originalExistsSync = fsModule.existsSync;
    const originalReadFileSync = fsModule.readFileSync;
    const existsSpy = jest.spyOn(fsModule, "existsSync");
    const readSpy = jest.spyOn(fsModule, "readFileSync");
    existsSpy.mockImplementation((filePath) =>
      String(filePath).endsWith("/cdk/.env")
        ? true
        : originalExistsSync(filePath)
    );
    readSpy.mockImplementation((filePath, options) =>
      String(filePath).endsWith("/cdk/.env")
        ? ("# test settings\nMALFORMED\nOPENCLAW_SESSION_ID='telegram:test=room'\nIGNORED=x\n" as never)
        : originalReadFileSync(filePath, options as never)
    );
    const testStack = stack("DomainStack");
    const database = new DatabaseConstruct(testStack, "Database");
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
        database,
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
    existsSpy.mockRestore();
    readSpy.mockRestore();
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
          OPENCLAW_SESSION_ID: "telegram:test=room",
          ROBOT_API_ENDPOINT: "https://simulator.example.test",
          McpServerGatewayUrl: "https://gateway.example.test",
          DEFAULT_SESSION_KEY: "mcpserver",
        }),
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
        // Both buckets intentionally serve browser content; public ACLs stay blocked.
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: false,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: false,
        },
      }),
      2
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

  test("domain expansion falls back to the default OpenClaw session after dotenv errors", () => {
    const { imageSpy, sourceSpy } = mockLocalAssets();
    const fsModule = require("fs") as typeof import("fs");
    const originalExistsSync = fsModule.existsSync;
    const originalReadFileSync = fsModule.readFileSync;
    const existsSpy = jest
      .spyOn(fsModule, "existsSync")
      .mockImplementation((filePath) =>
        String(filePath).endsWith("/cdk/.env")
          ? true
          : originalExistsSync(filePath)
      );
    const readSpy = jest
      .spyOn(fsModule, "readFileSync")
      .mockImplementation((filePath, options) => {
        if (String(filePath).endsWith("/cdk/.env")) {
          throw new Error("unreadable");
        }
        return originalReadFileSync(filePath, options as never);
      });
    const warnSpy = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const testStack = stack("DomainDefaultSessionStack");
    const database = new DatabaseConstruct(testStack, "Database");
    const userPool = new cognito.UserPool(testStack, "UserPool");
    const userPoolClient = new cognito.UserPoolClient(
      testStack,
      "UserPoolClient",
      { userPool }
    );

    new DomainExpansionServerlessConstruct(testStack, "Domain", {
      database,
      robotSimulatorServerlessConstruct: {
        serviceUrl: "simulator.example.test",
      } as never,
      userPool,
      userPoolClient,
      robotGatewayConstruct: {
        gatewayUrl: "https://gateway.example.test",
        grantInvokeGateway: jest.fn(),
      } as never,
    });

    const lambdaProps = mockAgentcorePythonFunctionProps.find(
      (props) =>
        (props.environment as Record<string, string>).OPENCLAW_SESSION_ID ===
        "telegram:default"
    );
    expect(lambdaProps).toBeDefined();
    expect(warnSpy).toHaveBeenCalledWith(
      "Failed to parse .env file:",
      expect.any(Error)
    );

    warnSpy.mockClear();
    existsSpy.mockImplementation((filePath) =>
      String(filePath).endsWith("/cdk/.env")
        ? false
        : originalExistsSync(filePath)
    );
    readSpy.mockImplementation((filePath, options) =>
      originalReadFileSync(filePath, options as never)
    );
    const absentEnvStack = stack("DomainAbsentEnvStack");
    const absentDatabase = new DatabaseConstruct(absentEnvStack, "Database");
    const absentUserPool = new cognito.UserPool(absentEnvStack, "UserPool");
    const absentUserPoolClient = new cognito.UserPoolClient(
      absentEnvStack,
      "UserPoolClient",
      { userPool: absentUserPool }
    );
    new DomainExpansionServerlessConstruct(absentEnvStack, "Domain", {
      database: absentDatabase,
      robotSimulatorServerlessConstruct: {
        serviceUrl: "simulator.example.test",
      } as never,
      userPool: absentUserPool,
      userPoolClient: absentUserPoolClient,
      robotGatewayConstruct: {
        gatewayUrl: "https://gateway.example.test",
        grantInvokeGateway: jest.fn(),
      } as never,
    });
    expect(warnSpy).not.toHaveBeenCalled();
    expect(
      (
        mockAgentcorePythonFunctionProps[
          mockAgentcorePythonFunctionProps.length - 1
        ].environment as Record<string, string>
      ).OPENCLAW_SESSION_ID
    ).toBe("telegram:default");

    existsSpy.mockRestore();
    readSpy.mockRestore();
    warnSpy.mockRestore();
    imageSpy.mockRestore();
    sourceSpy.mockRestore();
  });
});
