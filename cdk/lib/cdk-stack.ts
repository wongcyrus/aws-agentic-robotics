import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as path from "path";
import { Construct } from "constructs";
import { RoboticConstruct } from "./construct/robot-iot";
import { SpeechControlAgentcoreConstruct } from "./construct/speech-web-agentcore";
import { TextControlWebConstruct } from "./construct/text-web";
import { RobotSsmConstruct } from "./construct/robot-ssm";
import { SsmUserConstruct } from "./construct/ssm-user";
import { DatabaseConstruct } from "./construct/datebase";
import { RobotSimulatorServerlessConstruct } from "./construct/robot-simulator-serverless";
import {
  AttributeType,
  Billing,
  TableEncryptionV2,
  TableV2,
} from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Authenticator } from "./construct/authenticator";
import { DomainExpansionServerlessConstruct } from "./construct/domain-expansion-serverless";
import { RobotToolGatewayConstruct } from "./construct/robot-tool-gateway";

function normalizeContextList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => String(entry ?? "").trim())
      .filter((entry) => entry.length > 0);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  return [];
}

export class AwsAgenticRoboticsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const authenticator = new Authenticator(this, "Authenticator");

    const databaseConstruct = new DatabaseConstruct(this, "DatabaseConstruct");

    const internalRobotSecret = new secretsmanager.Secret(
      this,
      "InternalRobotSecret",
      {
        description:
          "Shared authentication secret for simulator-to-text-control requests",
        generateSecretString: {
          excludePunctuation: true,
          passwordLength: 48,
        },
      }
    );
    const internalRobotSecretValue =
      internalRobotSecret.secretValue.unsafeUnwrap();

    // Create the new serverless robot simulator construct side-by-side
    const humanoidRobotSimulatorServerlessConstruct = new RobotSimulatorServerlessConstruct(
      this,
      "RobotSimulatorServerlessConstruct",
      {
        userPoolId: authenticator.userPool.userPoolId,
        userPoolClientId: authenticator.userPoolClient.userPoolClientId,
        internalRobotSecret: internalRobotSecretValue,
      }
    );

    const speechTable = new TableV2(this, "SpeechTable", {
      partitionKey: {
        name: "id",
        type: AttributeType.STRING,
      },
      billing: Billing.onDemand(),
      encryption: TableEncryptionV2.awsManagedKey(),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: false,
      },
      timeToLiveAttribute: "ttl",
    });

    new cdk.CfnOutput(this, "SpeechTableName", {
      key: "SpeechTable",
      value: speechTable.tableName,
      description: "The name of the DynamoDB table for xiaoice speech messages",
    });

    const mediaBucket = new s3.Bucket(this, "RobotMediaBucket", {
      websiteIndexDocument: "index.html",
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      publicReadAccess: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ACLS_ONLY,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET],
          allowedOrigins: ["*"],
          allowedHeaders: ["*"],
        },
      ],
    });

    mediaBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [mediaBucket.arnForObjects("*")],
        principals: [new iam.AnyPrincipal()],
      })
    );

    new s3deploy.BucketDeployment(this, "DeployMediaWebsite", {
      sources: [s3deploy.Source.asset(path.join(__dirname, "../../robot-media-website"))],
      destinationBucket: mediaBucket,
    });

    const robotToolGatewayConstruct = new RobotToolGatewayConstruct(
      this,
      "RobotToolGatewayConstruct",
      {
        simulatorEndpoint: humanoidRobotSimulatorServerlessConstruct.serviceUrl,
        mediaBucket: mediaBucket,
        speechTable: speechTable,
      }
    );

    // Device configuration
    const numberOfRobots = 6; // Number of robots
    const numberOfXiaoice = 1; // Number of xiaoice Digital Humans

    // Generate device names
    const thingNames = Array.from(
      { length: numberOfRobots },
      (_, i) => `robot_${i + 1}`
    );
    const xiaoiceNames = Array.from(
      { length: numberOfXiaoice },
      (_, i) => `xiaoice_${i + 1}`
    );
    thingNames.push(...xiaoiceNames);

    // BATCH PROCESSING: Single construct creates all IoT devices with 1 Lambda function
    // Previous: 13 separate ThingWithCert constructs = 13 Lambda functions
    // Current: 1 RoboticConstruct = 1 Lambda function (92.3% resource reduction)
    const roboticConstruct = new RoboticConstruct(this, "RoboticConstruct", {
      thingNames: thingNames,
    });

    const speechControlAgentcoreConstruct = new SpeechControlAgentcoreConstruct(
      this,
      "SpeechControlAgentcoreConstruct",
      {
        database: databaseConstruct,
        robotGatewayConstruct: robotToolGatewayConstruct,
        userPoolId: authenticator.userPool.userPoolId,
        userPoolClientId: authenticator.userPoolClient.userPoolClientId,
        identityPoolId: authenticator.identityPool.ref,
      }
    );

    // Grant Cognito authenticated users permission to invoke our Bedrock AgentCore Runtime
    authenticator.authenticatedRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "bedrock-agentcore:InvokeAgentRuntime",
          "bedrock-agentcore:InvokeAgentRuntimeWithWebSocketStream",
        ],
        resources: [
          speechControlAgentcoreConstruct.runtimeArn,
          `${speechControlAgentcoreConstruct.runtimeArn}/*`,
        ],
      })
    );
const textControlWebConstruct = new TextControlWebConstruct(
  this,
  "TextControlWebConstruct",
  {
    database: databaseConstruct,
    speechTable: speechTable,
    robotGatewayConstruct: robotToolGatewayConstruct,
    userPool: authenticator.userPool,
    userPoolClient: authenticator.userPoolClient,
    roboticBucket: roboticConstruct.bucket,
    internalRobotSecret: internalRobotSecretValue,
  }
);

    // Create shared SSM user construct
    const ssmUserConstruct = new SsmUserConstruct(this, "SsmUserConstruct", {
      userName: "AmazonNovaRoboticsSsmUser",
    });

    // Create IAM user for robot skills to invoke Bedrock AgentCore Gateway
    const skillUser = new iam.User(this, "SkillMcpUser", {
      userName: "AmazonNovaRoboticsSkillUser",
    });
    robotToolGatewayConstruct.grantInvokeGateway(skillUser);
    skillUser.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["bedrock-agentcore:InvokeGateway"],
        resources: [robotToolGatewayConstruct.gateway.gatewayArn],
      })
    );

    const explicitOpenClawCallerAccountIds = normalizeContextList(
      this.node.tryGetContext("openclawCallerAccountIds")
    );
    const openClawCallerAccountIds =
      explicitOpenClawCallerAccountIds.length > 0
        ? explicitOpenClawCallerAccountIds
        : [cdk.Stack.of(this).account];

    for (const accountId of [...new Set(openClawCallerAccountIds)]) {
      robotToolGatewayConstruct.grantInvokeGateway(new iam.AccountPrincipal(accountId));
    }

    const skillAccessKey = new iam.CfnAccessKey(this, "SkillMcpUserAccessKey", {
      userName: skillUser.userName,
    });

    const ssmRobotNames = Array.from(
      { length: numberOfRobots },
      (_, i) => `RaspberryPiRobot${i + 1}`
    );
    new RobotSsmConstruct(this, "RobotSsmConstruct", {
      prefix: "humanoid",
      thingNames: ssmRobotNames,
      ssmUserConstruct: ssmUserConstruct,
    });

    const domainExpansionServerlessConstruct = new DomainExpansionServerlessConstruct(
      this,
      "DomainExpansionServerlessConstruct",
      {
        database: databaseConstruct,
        robotSimulatorServerlessConstruct: humanoidRobotSimulatorServerlessConstruct,
        userPool: authenticator.userPool,
        userPoolClient: authenticator.userPoolClient,
        robotGatewayConstruct: robotToolGatewayConstruct,
      }
    );

    new cdk.CfnOutput(this, "domainExpansionServerlessUrl", {
      description: "The URL of the Domain Expansion AR Game S3/CloudFront (Serverless)",
      value: "https://" + domainExpansionServerlessConstruct.serviceUrl,
    });

    new cdk.CfnOutput(this, "domainExpansionServerlessWebSocketUrl", {
      description: "The WebSocket URL for Domain Expansion signaling",
      value: domainExpansionServerlessConstruct.webSocketUrl,
    });

    new cdk.CfnOutput(this, "domainExpansionCommentatorRuntimeArn", {
      description: "The ARN of the JJK Commentator Bedrock AgentCore Runtime",
      value: domainExpansionServerlessConstruct.runtimeArn,
    });

    new cdk.CfnOutput(this, "DomainExpansionWebsiteBucket", {
      description: "The S3 Website Bucket Name for JJK Domain Expansion",
      value: domainExpansionServerlessConstruct.websiteBucket.bucketName,
    });

    new cdk.CfnOutput(this, "speechAgentcoreUrl", {
      description: "The URL of the AgentCore Speech Control Web (Serverless CloudFront)",
      value: "https://" + speechControlAgentcoreConstruct.serviceUrl,
    });

    new cdk.CfnOutput(this, "AgentCoreRuntimeArn", {
      description: "The ARN of the Bedrock AgentCore Runtime",
      value: speechControlAgentcoreConstruct.runtimeArn,
    });

    new cdk.CfnOutput(this, "CognitoIdentityPoolId", {
      description: "Cognito Identity Pool ID for credentials federation",
      value: authenticator.identityPool.ref,
    });

    new cdk.CfnOutput(this, "textUrl", {
      description: "The URL of the Text Control Web",
      value: textControlWebConstruct.serviceUrl,
    });



    new cdk.CfnOutput(this, "humanoidRobotSimulatorServerlessUrl", {
      description: "The URL of the Humanoid Robot Simulator (Serverless)",
      value: "https://" + humanoidRobotSimulatorServerlessConstruct.serviceUrl,
    });

    new cdk.CfnOutput(this, "humanoidRobotSimulatorServerlessWebSocketUrl", {
      description: "The WebSocket URL of the Humanoid Robot Simulator (Serverless)",
      value: humanoidRobotSimulatorServerlessConstruct.webSocketUrl,
    });

    new cdk.CfnOutput(this, "ServerlessWebsiteBucket", {
      value: humanoidRobotSimulatorServerlessConstruct.websiteBucket.bucketName,
      description: "The name of the S3 bucket for the Serverless Humanoid Robot Simulator",
    });

    new cdk.CfnOutput(this, "RobotDataBucketName", {
      value: roboticConstruct.bucket.bucketName,
      description: "The name of the S3 bucket for storing robot data",
    });

    new cdk.CfnOutput(this, "McpServerUrl", {
      value: robotToolGatewayConstruct.gatewayUrl,
      description: "The URL of the Bedrock AgentCore Secure Gateway",
    });

    new cdk.CfnOutput(this, "SkillMcpUserAccessKeyId", {
      value: skillAccessKey.ref,
      description: "Access Key ID for the skill user to invoke Bedrock AgentCore Secure Gateway",
    });

    new cdk.CfnOutput(this, "SkillMcpUserSecretAccessKey", {
      value: skillAccessKey.attrSecretAccessKey,
      description: "Secret Access Key for the skill user to invoke Bedrock AgentCore Secure Gateway",
    });

    new cdk.CfnOutput(this, "RobotMediaBucketWebsiteUrl", {
      value: mediaBucket.bucketWebsiteUrl,
      description: "The URL of the Robot Media S3 Website",
    });

    new cdk.CfnOutput(this, "MediaBucketName", {
      value: mediaBucket.bucketName,
      description: "The name of the Robot Media S3 Bucket",
    });

    new cdk.CfnOutput(this, "CognitoUserPoolId", {
      value: authenticator.userPool.userPoolId,
      description: "Cognito User Pool ID for authentication",
    });

    new cdk.CfnOutput(this, "CognitoUserPoolClientId", {
      value: authenticator.userPoolClient.userPoolClientId,
      description: "Cognito User Pool Client ID for authentication",
    });

    new cdk.CfnOutput(this, "CognitoRegion", {
      value: this.region,
      description: "AWS region for Cognito User Pool",
    });

    new cdk.CfnOutput(this, "CognitoUserPoolDomain", {
      value: `https://cognito-idp.${this.region}.amazonaws.com/${authenticator.userPool.userPoolId}`,
      description: "Cognito User Pool domain for JWKS",
    });

    // Resource efficiency summary outputs
    new cdk.CfnOutput(this, "IoTBatchProcessingSummary", {
      value: `Created ${thingNames.length} IoT devices with 1 Lambda function instead of ${thingNames.length}`,
      description:
        "IoT batch processing: Single Lambda function handles all devices",
    });

    new cdk.CfnOutput(this, "ResourceSavings", {
      value: `92.3% reduction in Lambda functions, IAM roles, and custom resources`,
      description: "Resource efficiency gains from batch IoT processing",
    });
  }
}
