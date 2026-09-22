import { RestApi, LambdaIntegration } from "aws-cdk-lib/aws-apigateway";
import { CfnOutput, Duration, RemovalPolicy, SecretValue } from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as fs from "fs";

import { Construct } from "constructs";
import path = require("path");
import * as iam from "aws-cdk-lib/aws-iam";
import { DatabaseConstruct } from "./datebase";
import { UserPool, UserPoolClient } from "aws-cdk-lib/aws-cognito";
import { TableV2 } from "aws-cdk-lib/aws-dynamodb";
import * as crypto from "crypto";
import { PythonFunction } from "@aws-cdk/aws-lambda-python-alpha";
import * as ssm from "aws-cdk-lib/aws-ssm";
import {
  createDestroyableLambdaLogGroup,
  SHARED_PYTHON_RUNTIME,
  SHARED_PYTHON_BUNDLING,
} from "./lambda-config";
interface AgentCoreGatewayAccess {
  readonly gatewayUrl: string;
  grantInvokeGateway(grantee: iam.IGrantable): void;
}

export interface TextControlWebConstructProps {
  readonly database: DatabaseConstruct;
  readonly speechTable: TableV2;
  readonly robotGatewayConstruct: AgentCoreGatewayAccess;
  readonly userPool: UserPool;
  readonly userPoolClient: UserPoolClient;
  readonly roboticBucket: s3.IBucket;
  readonly internalRobotSecret: string;
}

export class TextControlWebConstruct extends Construct {
  public readonly serviceUrl: string;

  constructor(
    scope: Construct,
    id: string,
    props: TextControlWebConstructProps
  ) {
    super(scope, id);

    const restApi = new RestApi(this, "TextControlWebApi", {
      restApiName: "TextControlWebApi",
      description: "API for Text Control Robot Web",
      deployOptions: {
        stageName: "prod",
        throttlingRateLimit: 100,
        throttlingBurstLimit: 200,
      },
    });
    const awsUserId = this.node.tryGetContext("AwsUserId") || "default-user";
    console.log("AWS User ID:", awsUserId);
    const hash = crypto.createHash("sha256").update(awsUserId).digest("hex");

    const chatSecretKey = crypto
      .createHash("sha256")
      .update(hash + "chat-secret-key")
      .digest("hex");

    const chatAccessKey = crypto
      .createHash("sha256")
      .update(hash + "chat-access-key")
      .digest("hex");

    let xiaoiceSecretValue = '{}';
    try {
      const secretPath = path.join(__dirname, "../../../text_control/xiaoice_credentials.json");
      xiaoiceSecretValue = fs.readFileSync(secretPath, "utf8");
    } catch {
      console.warn("xiaoice_credentials.json not found, using empty object");
    }

    const xiaoiceCredentialsSecret = new secretsmanager.Secret(this, "XiaoiceProjectCredentials", {
      secretName: "XiaoiceProjectCredentials",
      description: "Access keys and secret keys mapping for Xiaoice projects",
      secretStringValue: SecretValue.unsafePlainText(xiaoiceSecretValue),
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const flaskLambda = new PythonFunction(this, "TextControlLambda", {
      entry: path.join(__dirname, "../../../text_control"),
      runtime: SHARED_PYTHON_RUNTIME,
      index: "app.py",
      handler: "handler",
      timeout: Duration.seconds(30),
      memorySize: 512,
      logGroup: createDestroyableLambdaLogGroup(this, "TextControlLambdaLogGroup"),
      environment: {
        AWS_BEDROCK_REGION: "us-east-1",
        RobotTable: props.database.robotTable.tableName,
        McpServerGatewayUrl: props.robotGatewayConstruct.gatewayUrl,
        CognitoUserPoolId: props.userPool.userPoolId,
        CognitoUserPoolClientId: props.userPoolClient.userPoolClientId,
        FlaskSecretKey: hash,
        XiaoiceChatSecretKey: chatSecretKey,
        XiaoiceChatAccessKey: chatAccessKey,
        XIAOICE_SECRET_NAME: xiaoiceCredentialsSecret.secretName,
        SpeechTable: props.speechTable.tableName,
        RobotDataBucketName: props.roboticBucket.bucketName,
        INTERNAL_ROBOT_SECRET: props.internalRobotSecret,
      },
      bundling: {
        ...SHARED_PYTHON_BUNDLING,
        assetExcludes: [
          ".venv",
          "create_virtual_env.sh",
          ".dockerignore",
          "Dockerfile",
          "xiaoice_credentials.json",
        ],
        // Pre-build commands to run before packaging
        commandHooks: {
          beforeBundling(inputDir: string, _outputDir: string): string[] {
            return [
              `echo "Running pre-build commands for ${inputDir}"`,
              `cd ${inputDir}`,
              `chmod +x pre_deploy_update_commands.sh`,
              `./pre_deploy_update_commands.sh`,
            ];
          },
          afterBundling(inputDir: string, outputDir: string): string[] {
            return [
              `echo "Post-build verification for ${outputDir}"`,
              `ls -la ${outputDir}/command_config/`,
            ];
          },
        },
      },
    });

    props.database.robotTable.grantFullAccess(flaskLambda);

    // Grant read/write access to the speech table for xiaoice welcome flow
    props.speechTable.grantReadWriteData(flaskLambda);

    // Grant read/write access to robotic bucket
    props.roboticBucket.grantReadWrite(flaskLambda);

    // Grant read access to the Xiaoice Credentials secret
    xiaoiceCredentialsSecret.grantRead(flaskLambda);

    flaskLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["iot:Publish", "iot-data:Publish"],
        resources: [
          "arn:aws:iot:*:*:topic/robot_*/topic",
          "arn:aws:iot:*:*:topic/xiaoice_*/topic",
        ],
      })
    );
    flaskLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
          "bedrock:InvokeTool",
        ],
        resources: ["*"],
      })
    );

    // Add Cognito permissions for authentication
    flaskLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "cognito-idp:AdminInitiateAuth",
          "cognito-idp:AdminCreateUser",
          "cognito-idp:AdminSetUserPassword",
          "cognito-idp:AdminGetUser",
          "cognito-idp:AdminDeleteUser",
          "cognito-idp:ListUsers",
          "cognito-idp:AdminRespondToAuthChallenge",
        ],
        resources: [props.userPool.userPoolArn],
      })
    );

    // Grant permission to invoke the AgentCore Gateway
    props.robotGatewayConstruct.grantInvokeGateway(flaskLambda.role!);

    const rootResource = restApi.root;

    // Add root redirect (public)
    rootResource.addMethod("GET", new LambdaIntegration(flaskLambda));

    // Add UI routes (authentication handled by Flask middleware)
    const indexResource = rootResource.addResource("index");
    indexResource.addMethod("GET", new LambdaIntegration(flaskLambda));

    const robotResource = rootResource.addResource("robot");
    robotResource.addMethod("GET", new LambdaIntegration(flaskLambda));

    // Add SpeechTable Cleanup routes
    const cleanupResource = rootResource.addResource("cleanup");
    cleanupResource.addMethod("GET", new LambdaIntegration(flaskLambda));
    cleanupResource.addProxy({
      defaultIntegration: new LambdaIntegration(flaskLambda),
      anyMethod: true,
    });

    // Add public routes (no authentication required)
    const loginResource = rootResource.addResource("login");
    loginResource.addMethod("GET", new LambdaIntegration(flaskLambda));

    const staticResource = rootResource.addResource("static");
    staticResource.addProxy({
      defaultIntegration: new LambdaIntegration(flaskLambda),
      anyMethod: true,
    });

    // Add API routes (authentication handled by Flask middleware)
    const apiResource = rootResource.addResource("api");
    apiResource.addProxy({
      defaultIntegration: new LambdaIntegration(flaskLambda),
      anyMethod: true,
    });

    // Add auth routes for login/logout
    const authResource = rootResource.addResource("auth");
    authResource.addProxy({
      defaultIntegration: new LambdaIntegration(flaskLambda),
      anyMethod: true,
    });

    this.serviceUrl = restApi.url + "index";

    new CfnOutput(this, "XiaoiceChatSecretKey", {
      key: "XiaoiceChatSecretKey",
      value: chatSecretKey,
    });

    new CfnOutput(this, "XiaoiceChatAccessKey", {
      key: "XiaoiceChatAccessKey",
      value: chatAccessKey,
    });

    new CfnOutput(this, "XiaoiceApiUrl", {
      key: "XiaoiceApiUrl",
      value: restApi.url + "api/xiaoice-chat-api",
    });

    new CfnOutput(this, "XiaoiceSdkStreamingApiUrl", {
      key: "XiaoiceSdkStreamingApiUrl",
      value: restApi.url + "api/xiaoice-chat-api-strands-stream",
    });

    new CfnOutput(this, "XiaoiceMachineStreamingApiUrl", {
      key: "XiaoiceMachineStreamingApiUrl",
      value: restApi.url + "api/xiaoice-stream-machine",
    });

    new CfnOutput(this, "XiaoiceStreamingApiUrl", {
      key: "XiaoiceStreamingApiUrl",
      value: restApi.url.replace(/\/$/, ""),
    });

    // Save the API URL to SSM for Service Discovery (breaks circular dependency)
    new ssm.StringParameter(this, "RobotApiUrlParameter", {
      parameterName: "/robotics/robot_api_url",
      stringValue: `${restApi.url}api/run_action/`,
      description: "URL for the Robot Control REST API",
    });
  }
}
