import { Construct } from "constructs";
import * as path from "path";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as iam from "aws-cdk-lib/aws-iam";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as apigatewayv2 from "aws-cdk-lib/aws-apigatewayv2";
import { Table, AttributeType, BillingMode, ProjectionType } from "aws-cdk-lib/aws-dynamodb";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { PythonFunction } from "@aws-cdk/aws-lambda-python-alpha";
import { Duration, Stack, RemovalPolicy, DockerImage } from "aws-cdk-lib";
import {
  createDestroyableLambdaLogGroup,
  SHARED_PYTHON_RUNTIME,
  SHARED_PYTHON_BUNDLING,
} from "./lambda-config";

export interface RobotSimulatorServerlessConstructProps {
  userPoolId?: string;
  userPoolClientId?: string;
}

export class RobotSimulatorServerlessConstruct extends Construct {
  public readonly serviceUrl: string;
  public readonly webSocketUrl: string;
  public readonly websiteBucket: s3.Bucket;

  constructor(
    scope: Construct,
    id: string,
    props: RobotSimulatorServerlessConstructProps = {}
  ) {
    super(scope, id);

    // 1. Static Website S3 Bucket
    this.websiteBucket = new s3.Bucket(this, "RobotSimulatorServerlessWebsiteBucket", {
      websiteIndexDocument: "index.html",
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      publicReadAccess: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ACLS_ONLY,
      cors: [
        {
          allowedHeaders: ["*"],
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          allowedOrigins: ["*"],
          exposedHeaders: ["Date", "ETag", "x-amz-request-id"],
          maxAge: 3000,
        },
      ],
    });

    this.websiteBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [this.websiteBucket.arnForObjects("*")],
        principals: [new iam.AnyPrincipal()],
      })
    );

    // 2. DynamoDB Connection & Session State Tables
    const connectionsTable = new Table(this, "ConnectionsTable", {
      partitionKey: { name: "connection_id", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    connectionsTable.addGlobalSecondaryIndex({
      indexName: "SessionKeyIndex",
      partitionKey: { name: "session_key", type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    const sessionsTable = new Table(this, "SessionsTable", {
      partitionKey: { name: "session_key", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // 3. Monolithic Python Lambda Router
    const lambdaFunction = new PythonFunction(this, "LambdaFunction", {
      entry: path.join(__dirname, "../../../humanoid-robot-simulator-serverless/backend"),
      index: "lambda_function.py",
      handler: "lambda_handler",
      runtime: SHARED_PYTHON_RUNTIME,
      timeout: Duration.seconds(30),
      memorySize: 256,
      logGroup: createDestroyableLambdaLogGroup(this, "LambdaLogGroup"),
      bundling: SHARED_PYTHON_BUNDLING,
      environment: {
        IsInCloud: "yes",
        LOG_LEVEL: "WARNING",
        AWS_BEDROCK_REGION: "us-east-1",
        CONNECTIONS_TABLE: connectionsTable.tableName,
        SESSIONS_TABLE: sessionsTable.tableName,
        VIDEO_BUCKET_NAME: this.websiteBucket.bucketName,
        XIAOICE_APP_SECRET: process.env.XIAOICE_APP_SECRET || "",
        XIAOICE_COMPANY_ID: process.env.XIAOICE_COMPANY_ID || "",
        XIAOICE_PROJECT_ID: process.env.XIAOICE_PROJECT_ID || "",
        XIAOICE_SUBSCRIPTION_KEY: process.env.XIAOICE_SUBSCRIPTION_KEY || "",
      },
    });

    // Grant DynamoDB access to Lambda
    connectionsTable.grantReadWriteData(lambdaFunction);
    sessionsTable.grantReadWriteData(lambdaFunction);
    this.websiteBucket.grantRead(lambdaFunction);

    // Grant permission to read SSM parameters for service discovery
    lambdaFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [
          `arn:aws:ssm:${Stack.of(this).region}:${Stack.of(this).account}:parameter/robotics/*`,
        ],
      })
    );

    // 4. API Gateway REST API for HTTP endpoints
    const restApi = new apigateway.RestApi(this, "RobotSimulatorRestApi", {
      restApiName: "Robot Simulator Serverless REST API",
      description: "REST API for Humanoid Robot Simulator",
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
      },
    });

    const lambdaIntegration = new apigateway.LambdaIntegration(lambdaFunction);
    restApi.root.addProxy({
      defaultIntegration: lambdaIntegration,
    });

    // 5. API Gateway WebSocket API using Stable L1 Construct
    const webSocketApi = new apigatewayv2.CfnApi(this, "RobotSimulatorWebSocketApi", {
      name: "RobotSimulatorWebSocketApi",
      protocolType: "WEBSOCKET",
      routeSelectionExpression: "$request.body.action",
    });

    const wsIntegration = new apigatewayv2.CfnIntegration(this, "WebSocketIntegration", {
      apiId: webSocketApi.ref,
      integrationType: "AWS_PROXY",
      integrationUri: `arn:aws:apigateway:${Stack.of(this).region}:lambda:path/2015-03-31/functions/${lambdaFunction.functionArn}/invocations`,
    });

    const connectRoute = new apigatewayv2.CfnRoute(this, "ConnectRoute", {
      apiId: webSocketApi.ref,
      routeKey: "$connect",
      authorizationType: "NONE",
      target: `integrations/${wsIntegration.ref}`,
    });

    const disconnectRoute = new apigatewayv2.CfnRoute(this, "DisconnectRoute", {
      apiId: webSocketApi.ref,
      routeKey: "$disconnect",
      target: `integrations/${wsIntegration.ref}`,
    });

    const defaultRoute = new apigatewayv2.CfnRoute(this, "DefaultRoute", {
      apiId: webSocketApi.ref,
      routeKey: "$default",
      target: `integrations/${wsIntegration.ref}`,
    });

    const deployment = new apigatewayv2.CfnDeployment(this, "WebSocketDeployment", {
      apiId: webSocketApi.ref,
    });

    const stage = new apigatewayv2.CfnStage(this, "WebSocketStage", {
      apiId: webSocketApi.ref,
      stageName: "prod",
      deploymentId: deployment.ref,
      autoDeploy: true,
    });

    deployment.node.addDependency(connectRoute);
    deployment.node.addDependency(disconnectRoute);
    deployment.node.addDependency(defaultRoute);

    // Permit API Gateway WebSocket connection execution and callbacks
    lambdaFunction.addPermission("WebSocketInvokePermission", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      sourceArn: `arn:aws:execute-api:${Stack.of(this).region}:${Stack.of(this).account}:${webSocketApi.ref}/*`,
    });

    lambdaFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["execute-api:ManageConnections"],
        resources: [
          `arn:aws:execute-api:${Stack.of(this).region}:${Stack.of(this).account}:${webSocketApi.ref}/${stage.stageName}/*`,
        ],
      })
    );

    // Pass real websocket callback endpoint to monolithic Lambda
    lambdaFunction.addEnvironment(
      "WEBSOCKET_ENDPOINT",
      `https://${webSocketApi.ref}.execute-api.${Stack.of(this).region}.amazonaws.com/${stage.stageName}`
    );

    // 6. Cost-Efficient CloudFront Distribution (Price Class 100)
    const oai = new cloudfront.OriginAccessIdentity(this, "OAI");
    this.websiteBucket.grantRead(oai);

    const distribution = new cloudfront.Distribution(this, "SimulatorDistribution", {
      defaultRootObject: "index.html",
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100, // Strictly Price Class 100 to maximize cost efficiency
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessIdentity(this.websiteBucket, { originAccessIdentity: oai }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
    });

    const apiOrigin = new origins.RestApiOrigin(restApi);

    // Dynamic routing behaviors to prevent CORS issues
    const dynamicApiBehavior: cloudfront.BehaviorOptions = {
      origin: apiOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
    };

    distribution.addBehavior("/api/*", apiOrigin, dynamicApiBehavior);
    distribution.addBehavior("/run_action/*", apiOrigin, dynamicApiBehavior);
    distribution.addBehavior("/speech/*", apiOrigin, dynamicApiBehavior);
    distribution.addBehavior("/health", apiOrigin, dynamicApiBehavior);

    // WebSocket routing behavior to bridge client-side relative ws requests to serverless API Gateway
    const wsOrigin = new origins.HttpOrigin(
      `${webSocketApi.ref}.execute-api.${Stack.of(this).region}.amazonaws.com`,
      {
        originPath: `/${stage.stageName}`,
      }
    );

    const wsBehavior: cloudfront.BehaviorOptions = {
      origin: wsOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
    };

    distribution.addBehavior("/ws", wsOrigin, wsBehavior);

    // 7. Auto-deploy and cache-invalidate Static S3 Frontend assets (excluding large video assets)
    new s3deploy.BucketDeployment(this, "DeployWebsite", {
      sources: [
        s3deploy.Source.asset(path.join(__dirname, "../../../humanoid-robot-simulator-serverless/frontend"), {
          exclude: ["video/*"],
        }),
        s3deploy.Source.jsonData("config.json", {
          webSocketUrl: `wss://${webSocketApi.ref}.execute-api.${Stack.of(this).region}.amazonaws.com/${stage.stageName}`,
          region: Stack.of(this).region,
          userPoolId: props.userPoolId,
          clientId: props.userPoolClientId,
        }),
      ],
      destinationBucket: this.websiteBucket,
      distribution,
      distributionPaths: ["/*"],
      prune: false,
    });

    this.serviceUrl = distribution.distributionDomainName;
    this.webSocketUrl = `wss://${webSocketApi.ref}.execute-api.${Stack.of(this).region}.amazonaws.com/${stage.stageName}`;
  }
}
