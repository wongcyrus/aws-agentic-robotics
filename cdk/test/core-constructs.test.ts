import { describe, expect, test } from "@jest/globals";
import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { Authenticator } from "../lib/construct/authenticator";
import { DatabaseConstruct } from "../lib/construct/datebase";
import {
  createDestroyableLambdaLogGroup,
  SHARED_PYTHON_BUNDLING,
  SHARED_PYTHON_RUNTIME,
} from "../lib/construct/lambda-config";
import { SsmUserConstruct } from "../lib/construct/ssm-user";

describe("core constructs", () => {
  const app = (context?: Record<string, unknown>) =>
    new App({ context, outdir: "cdk.out/jest-core" });

  test("Authenticator uses secure defaults and binds the identity pool role", () => {
    const stack = new Stack(app(), "AuthStack");

    new Authenticator(stack, "Authenticator");

    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      UserPoolName: "amazon-nona-robotics-app-user-pool",
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
      UsernameAttributes: ["email"],
      Schema: Match.arrayWith([
        Match.objectLike({
          Name: "email",
          Required: true,
          Mutable: true,
        }),
      ]),
    });
    template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      GenerateSecret: false,
      ExplicitAuthFlows: Match.arrayWith([
        "ALLOW_USER_PASSWORD_AUTH",
        "ALLOW_ADMIN_USER_PASSWORD_AUTH",
        "ALLOW_USER_SRP_AUTH",
      ]),
      IdTokenValidity: 60,
      AccessTokenValidity: 60,
      RefreshTokenValidity: 43200,
      TokenValidityUnits: {
        IdToken: "minutes",
        AccessToken: "minutes",
        RefreshToken: "minutes",
      },
    });
    template.hasResourceProperties("AWS::Cognito::IdentityPool", {
      AllowUnauthenticatedIdentities: false,
      IdentityPoolName: "AmazonNovaRoboticsIdentityPool",
    });
    template.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "sts:AssumeRoleWithWebIdentity",
            Principal: { Federated: "cognito-identity.amazonaws.com" },
            Condition: Match.objectLike({
              StringEquals: Match.objectLike({
                "cognito-identity.amazonaws.com:aud": Match.anyValue(),
              }),
              "ForAnyValue:StringLike": {
                "cognito-identity.amazonaws.com:amr": "authenticated",
              },
            }),
          }),
        ]),
      },
    });
    template.resourceCountIs("AWS::Cognito::IdentityPoolRoleAttachment", 1);
  });

  test("Authenticator context overrides constructor token validity settings", () => {
    const contextApp = app({
        idTokenValidityHours: "2",
        accessTokenValidityHours: 3,
        refreshTokenValidityDays: "45",
    });
    const stack = new Stack(contextApp, "ContextAuthStack");

    new Authenticator(stack, "Authenticator", {
      userPoolName: "custom-pool",
      idTokenValidityHours: 8,
      accessTokenValidityHours: 8,
      refreshTokenValidityDays: 90,
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      UserPoolName: "custom-pool",
    });
    template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      IdTokenValidity: 120,
      AccessTokenValidity: 180,
      RefreshTokenValidity: 64800,
    });
  });

  test("Database table is on-demand and destroyable", () => {
    const stack = new Stack(app(), "DatabaseStack");

    new DatabaseConstruct(stack, "Database");

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
      }),
    });
    expect(Object.values(template.toJSON().Outputs)).toContainEqual(
      expect.objectContaining({
        Description: "The name of the DynamoDB table for robots",
      })
    );
  });

  test("shared Lambda configuration pins runtime, cache, and cleanup behavior", () => {
    const stack = new Stack(app(), "LambdaConfigStack");

    createDestroyableLambdaLogGroup(stack, "FunctionLogs");

    const template = Template.fromStack(stack);
    template.hasResource("AWS::Logs::LogGroup", {
      DeletionPolicy: "Delete",
      UpdateReplacePolicy: "Delete",
      Properties: { RetentionInDays: 3 },
    });
    expect(SHARED_PYTHON_RUNTIME.name).toBe("python3.12");
    expect(SHARED_PYTHON_BUNDLING.assetExcludes).toEqual([
      ".venv",
      "__pycache__",
      "tests",
    ]);
    expect(SHARED_PYTHON_BUNDLING.environment).toEqual({
      PIP_CACHE_DIR: "/cache",
    });
    expect(SHARED_PYTHON_BUNDLING.volumes).toEqual([
      expect.objectContaining({
        containerPath: "/cache",
        hostPath: expect.stringMatching(/\.cache\/pip\/python3\.12$/),
      }),
    ]);
  });

  test("SSM user has scoped command/session permissions and credentials outputs", () => {
    const stack = new Stack(app(), "SsmUserStack");

    new SsmUserConstruct(stack, "SsmUser", { userName: "TestRobotSsmUser" });

    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::IAM::User", {
      UserName: "TestRobotSsmUser",
    });
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ["ssm:SendCommand", "ssm:StartSession"],
            Resource: "arn:aws:ssm:*:*:document/*",
          }),
          Match.objectLike({
            Action: ["ssm:ResumeSession", "ssm:TerminateSession"],
            Resource: "arn:aws:ssm:*:*:session/${aws:username}-*",
          }),
        ]),
      },
    });
    template.resourceCountIs("AWS::IAM::AccessKey", 1);
    expect(Object.keys(template.toJSON().Outputs)).toHaveLength(3);
  });

  test("SSM user applies its default user name", () => {
    const stack = new Stack(app(), "DefaultSsmUserStack");

    new SsmUserConstruct(stack, "SsmUser");

    Template.fromStack(stack).hasResourceProperties("AWS::IAM::User", {
      UserName: "RobotSsmRunCommandUser",
    });
  });
});
