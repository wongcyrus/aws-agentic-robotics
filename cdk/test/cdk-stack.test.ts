import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";

jest.mock("../lib/construct/authenticator", () => {
  const { Construct } = require("constructs");
  const cognito = require("aws-cdk-lib/aws-cognito");
  const iam = require("aws-cdk-lib/aws-iam");

  return {
    Authenticator: class extends Construct {
      public readonly userPool;
      public readonly userPoolClient;
      public readonly identityPool;
      public readonly authenticatedRole;

      constructor(scope: unknown, id: string) {
        super(scope, id);
        this.userPool = new cognito.UserPool(this, "MockUserPool");
        this.userPoolClient = new cognito.UserPoolClient(this, "MockClient", {
          userPool: this.userPool,
        });
        this.identityPool = new cognito.CfnIdentityPool(this, "MockIdentityPool", {
          allowUnauthenticatedIdentities: false,
        });
        this.authenticatedRole = new iam.Role(this, "MockAuthenticatedRole", {
          assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
        });
      }
    },
  };
});

jest.mock("../lib/construct/datebase", () => {
  const { Construct } = require("constructs");
  const dynamodb = require("aws-cdk-lib/aws-dynamodb");

  return {
    DatabaseConstruct: class extends Construct {
      public readonly robotTable;

      constructor(scope: unknown, id: string) {
        super(scope, id);
        this.robotTable = new dynamodb.TableV2(this, "MockRobotTable", {
          partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
          billing: dynamodb.Billing.onDemand(),
        });
      }
    },
  };
});

jest.mock("../lib/construct/robot-simulator-serverless", () => {
  const { Construct } = require("constructs");
  const s3 = require("aws-cdk-lib/aws-s3");

  return {
    RobotSimulatorServerlessConstruct: class extends Construct {
      public readonly serviceUrl = "simulator.example.test";
      public readonly webSocketUrl = "wss://simulator.example.test/prod";
      public readonly websiteBucket;

      constructor(scope: unknown, id: string) {
        super(scope, id);
        this.websiteBucket = new s3.Bucket(this, "MockWebsiteBucket");
      }
    },
  };
});

jest.mock("../lib/construct/robot-iot", () => {
  const { Construct } = require("constructs");
  const s3 = require("aws-cdk-lib/aws-s3");

  return {
    RoboticConstruct: class extends Construct {
      public readonly bucket;

      constructor(scope: unknown, id: string) {
        super(scope, id);
        this.bucket = new s3.Bucket(this, "MockRobotBucket");
      }
    },
  };
});

jest.mock("../lib/construct/robot-tool-gateway", () => {
  const { Construct } = require("constructs");
  const gatewayGrantees: string[] = [];

  return {
    gatewayGrantees,
    RobotToolGatewayConstruct: class extends Construct {
      public readonly gatewayUrl = "https://gateway.example.test";
      public readonly gateway = {
        gatewayArn:
          "arn:aws:bedrock-agentcore:us-east-1:111122223333:gateway/mock",
      };

      grantInvokeGateway(grantee: {
        grantPrincipal: { policyFragment: { principalJson: unknown } };
      }): void {
        gatewayGrantees.push(String(grantee.grantPrincipal));
      }
    },
  };
});

jest.mock("../lib/construct/speech-web-agentcore", () => {
  const { Construct } = require("constructs");

  return {
    SpeechControlAgentcoreConstruct: class extends Construct {
      public readonly runtimeArn =
        "arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/speech";
      public readonly serviceUrl = "speech.example.test";
    },
  };
});

jest.mock("../lib/construct/text-web", () => {
  const { Construct } = require("constructs");

  return {
    TextControlWebConstruct: class extends Construct {
      public readonly serviceUrl = "https://text.example.test/index";
    },
  };
});

jest.mock("../lib/construct/ssm-user", () => {
  const { Construct } = require("constructs");

  return {
    SsmUserConstruct: class extends Construct {},
  };
});

jest.mock("../lib/construct/robot-ssm", () => {
  const { Construct } = require("constructs");

  return {
    RobotSsmConstruct: class extends Construct {},
  };
});

jest.mock("../lib/construct/domain-expansion-serverless", () => {
  const { Construct } = require("constructs");
  const s3 = require("aws-cdk-lib/aws-s3");

  return {
    DomainExpansionServerlessConstruct: class extends Construct {
      public readonly serviceUrl = "domain.example.test";
      public readonly webSocketUrl = "wss://domain.example.test/prod";
      public readonly runtimeArn =
        "arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/domain";
      public readonly websiteBucket;

      constructor(scope: unknown, id: string) {
        super(scope, id);
        this.websiteBucket = new s3.Bucket(this, "MockWebsiteBucket");
      }
    },
  };
});

import { AwsAgenticRoboticsStack } from "../lib/cdk-stack";

const gatewayMock = jest.requireMock("../lib/construct/robot-tool-gateway") as {
  gatewayGrantees: string[];
};

describe("AwsAgenticRoboticsStack", () => {
  beforeEach(() => {
    gatewayMock.gatewayGrantees.length = 0;
  });

  function createStack(context?: Record<string, unknown>) {
    const app = new App({
      context,
      outdir: "cdk.out/jest-stack",
    });
    return new AwsAgenticRoboticsStack(app, "AwsAgenticRobotics", {
      stackName: "aws-agentic-robotics",
      env: { account: "111122223333", region: "us-east-1" },
    });
  }

  test("preserves the logical selector and physical stack name", () => {
    const stack = createStack();

    expect(stack.node.id).toBe("AwsAgenticRobotics");
    expect(stack.stackName).toBe("aws-agentic-robotics");
  });

  test("creates core stack-owned resources, outputs, and deletion policies", () => {
    const stack = createStack();
    const template = Template.fromStack(stack);

    template.hasResource("AWS::DynamoDB::GlobalTable", {
      DeletionPolicy: "Delete",
      UpdateReplacePolicy: "Delete",
      Properties: Match.objectLike({
        AttributeDefinitions: [
          { AttributeName: "id", AttributeType: "S" },
        ],
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
        TimeToLiveSpecification: {
          AttributeName: "ttl",
          Enabled: true,
        },
      }),
    });
    template.hasResource("AWS::S3::Bucket", {
      DeletionPolicy: "Delete",
      UpdateReplacePolicy: "Delete",
      Properties: Match.objectLike({
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            {
              ServerSideEncryptionByDefault: {
                SSEAlgorithm: "AES256",
              },
            },
          ],
        },
        WebsiteConfiguration: { IndexDocument: "index.html" },
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: false,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: false,
        },
      }),
    });
    template.hasResourceProperties("AWS::IAM::User", {
      UserName: "AmazonNovaRoboticsSkillUser",
    });
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "bedrock-agentcore:InvokeGateway",
            Resource:
              "arn:aws:bedrock-agentcore:us-east-1:111122223333:gateway/mock",
          }),
        ]),
      },
    });
    template.resourceCountIs("AWS::IAM::AccessKey", 1);

    const outputs = template.toJSON().Outputs;
    expect(outputs).toEqual(
      expect.objectContaining({
        domainExpansionServerlessUrl: expect.objectContaining({
          Value: "https://domain.example.test",
        }),
        speechAgentcoreUrl: expect.objectContaining({
          Value: "https://speech.example.test",
        }),
        textUrl: expect.objectContaining({
          Value: "https://text.example.test/index",
        }),
        humanoidRobotSimulatorServerlessUrl: expect.objectContaining({
          Value: "https://simulator.example.test",
        }),
        McpServerUrl: expect.objectContaining({
          Value: "https://gateway.example.test",
        }),
        IoTBatchProcessingSummary: {
          Description:
            "IoT batch processing: Single Lambda function handles all devices",
          Value: "Created 7 IoT devices with 1 Lambda function instead of 7",
        },
      })
    );
  });

  test("normalizes comma-separated OpenClaw caller accounts and removes duplicates", () => {
    createStack({
      openclawCallerAccountIds:
        " 444455556666,777788889999,444455556666, , ",
    });

    const accountGrants = gatewayMock.gatewayGrantees.filter((principal) =>
      principal.includes("AccountPrincipal")
    );
    expect(accountGrants).toHaveLength(2);
    expect(accountGrants[0]).toContain("444455556666");
    expect(accountGrants[1]).toContain("777788889999");
  });

  test("accepts array context and falls back to the deployment account", () => {
    createStack({ openclawCallerAccountIds: ["", null, "999900001111"] });
    expect(
      gatewayMock.gatewayGrantees.some((principal) =>
        principal.includes("999900001111")
      )
    ).toBe(true);

    gatewayMock.gatewayGrantees.length = 0;
    createStack({ openclawCallerAccountIds: { invalid: true } });
    expect(
      gatewayMock.gatewayGrantees.some((principal) =>
        principal.includes("111122223333")
      )
    ).toBe(true);
  });
});
