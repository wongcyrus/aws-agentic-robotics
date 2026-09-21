import { Construct } from "constructs";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as iam from "aws-cdk-lib/aws-iam";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as apigatewayv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
import { Table, AttributeType, BillingMode, ProjectionType } from "aws-cdk-lib/aws-dynamodb";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { PythonFunction } from "@aws-cdk/aws-lambda-python-alpha";
import { Platform } from "aws-cdk-lib/aws-ecr-assets";
import { Duration, Stack, RemovalPolicy, DockerImage } from "aws-cdk-lib";
import { UserPool, UserPoolClient } from "aws-cdk-lib/aws-cognito";
import { DatabaseConstruct } from "./datebase";
import { RobotSimulatorServerlessConstruct } from "./robot-simulator-serverless";
import {
  createDestroyableLambdaLogGroup,
  SHARED_PYTHON_RUNTIME,
  SHARED_PYTHON_BUNDLING,
} from "./lambda-config";
import {
  applyAgentCoreRuntimeLogRetention,
  createAgentCoreRuntimeObservability,
} from "./agentcore-observability";

const KIMI_MODEL_ID = "global.moonshotai.kimi-k3";

function parseDotEnv(filePath: string): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf-8");
      content.split("\n").forEach((line) => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#")) {
          const parts = trimmed.split("=");
          if (parts.length >= 2) {
            const key = parts[0].trim();
            const value = parts.slice(1).join("=").trim().replace(/^['"]|['"]$/g, "");
            env[key] = value;
          }
        }
      });
    }
  } catch (err) {
    console.warn("Failed to parse .env file:", err);
  }
  return env;
}



export interface DomainExpansionServerlessConstructProps {
  readonly database: DatabaseConstruct;
  readonly robotSimulatorServerlessConstruct: RobotSimulatorServerlessConstruct;
  readonly userPool: UserPool;
  readonly userPoolClient: UserPoolClient;
  readonly robotGatewayConstruct: import("./robot-tool-gateway").RobotToolGatewayConstruct;
}

export class DomainExpansionServerlessConstruct extends Construct {
  public readonly serviceUrl: string;
  public readonly webSocketUrl: string;
  public readonly websiteBucket: s3.Bucket;
  public readonly runtimeArn: string;

  constructor(
    scope: Construct,
    id: string,
    props: DomainExpansionServerlessConstructProps
  ) {
    super(scope, id);

    const openclawRuntimeArn = ssm.StringParameter.valueForStringParameter(
      this,
      "/openclaw/agentcore/runtime-arn-dev"
    );

    const cdkEnv = parseDotEnv(path.join(__dirname, "../../.env"));
    const openclawSessionId = cdkEnv["OPENCLAW_SESSION_ID"] || "telegram:default";

    // 1. Pack and deploy JJK Commentator container as a dedicated Bedrock AgentCore Runtime
    const observability = createAgentCoreRuntimeObservability(
      this,
      "DomainExpansionObservability",
      "domain_commentator_agentcore"
    );

    const agentRuntimeArtifact = agentcore.AgentRuntimeArtifact.fromAsset(
      path.join(__dirname, "../../../domain-expansion-commentator-agentcore"),
      {
        platform: Platform.LINUX_ARM64,
      }
    );

    const runtime = new agentcore.Runtime(this, "Runtime", {
      runtimeName: "domain_commentator_agentcore",
      agentRuntimeArtifact: agentRuntimeArtifact,
      authorizerConfiguration: agentcore.RuntimeAuthorizerConfiguration.usingIAM(),
      lifecycleConfiguration: {
        idleRuntimeSessionTimeout: Duration.seconds(120),
        maxLifetime: Duration.seconds(900),
      },
      tracingEnabled: true,
      loggingConfigs: observability.loggingConfigs,
      environmentVariables: {
        IsInCloud: "yes",
        AWS_BEDROCK_REGION: "us-east-1",
        BEDROCK_MODEL_ID: KIMI_MODEL_ID,
      },
    });

    this.runtimeArn = runtime.agentRuntimeArn;
    applyAgentCoreRuntimeLogRetention(this, "DomainExpansionAgentcore", runtime);

    // Grant access to Bedrock models to the AgentCore execution role
    runtime.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
        ],
        resources: [
          Stack.of(this).formatArn({
            service: "bedrock",
            resource: "inference-profile",
            resourceName: KIMI_MODEL_ID,
          }),
          "arn:aws:bedrock:*::foundation-model/moonshotai.kimi-k3",
        ],
      })
    );

    // 2. Serverless S3 Website Bucket
    this.websiteBucket = new s3.Bucket(this, "DomainExpansionWebsiteBucket", {
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

    // 3. DynamoDB Connection & Session State Tables
    const connectionsTable = new Table(this, "ConnectionsTable", {
      tableName: "DomainExpansionConnections",
      partitionKey: { name: "connection_id", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    connectionsTable.addGlobalSecondaryIndex({
      indexName: "RoomCodeIndex",
      partitionKey: { name: "room_code", type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    const sessionsTable = new Table(this, "SessionsTable", {
      tableName: "DomainExpansionSessions",
      partitionKey: { name: "session_id", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // S3 Bucket for Webcam Snaps & AI Portraits with 7-day lifecycle policy
    const photosBucket = new s3.Bucket(this, "DomainExpansionPhotosBucket", {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      publicReadAccess: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ACLS_ONLY,
      lifecycleRules: [{ expiration: Duration.days(7) }],
      cors: [{
        allowedHeaders: ["*"],
        allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.HEAD, s3.HttpMethods.POST],
        allowedOrigins: ["*"],
        maxAge: 3000,
      }],
    });

    photosBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [photosBucket.arnForObjects("*")],
        principals: [new iam.AnyPrincipal()],
      })
    );

    // 4. Monolithic Python Lambda Backend Router
    const lambdaFunction = new PythonFunction(this, "LambdaFunction", {
      entry: path.join(__dirname, "../../../domain-expansion-ar-game-serverless/backend"),
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
        AGENT_TYPE: "agentcore_runtime",
        AGENTCORE_RUNTIME_ARN: runtime.agentRuntimeArn,
        OPENCLAW_RUNTIME_ARN: openclawRuntimeArn,
        OPENCLAW_SESSION_ID: openclawSessionId,
        BEDROCK_MODEL_ID: KIMI_MODEL_ID,
        BEDROCK_REGION: Stack.of(this).region,
        PHOTOS_S3_BUCKET: photosBucket.bucketName,
        PHOTOS_S3_DOMAIN: photosBucket.bucketRegionalDomainName,
        COMMENTARY_AUDIO_PREFIX: "commentary-audio",
        COMMENTARY_AUDIO_URL_EXPIRY: "600",
        COGNITO_USER_POOL_ID: props.userPool.userPoolId,
        COGNITO_USER_POOL_CLIENT_ID: props.userPoolClient.userPoolClientId,
        COGNITO_REGION: Stack.of(this).region,
        ROBOT_API_ENDPOINT: "https://" + props.robotSimulatorServerlessConstruct.serviceUrl,
        DEFAULT_SESSION_KEY: "mcpserver",
        McpServerGatewayUrl: props.robotGatewayConstruct.gatewayUrl,
      },
    });

    props.robotGatewayConstruct.grantInvokeGateway(lambdaFunction.role!);

    // Grant DynamoDB & S3 access to Lambda
    connectionsTable.grantReadWriteData(lambdaFunction);
    sessionsTable.grantReadWriteData(lambdaFunction);
    photosBucket.grantReadWrite(lambdaFunction);

    // Grant Bedrock Model invocation access to Lambda (for Strands Local commentary fallback)
    lambdaFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
        ],
        resources: [
          Stack.of(this).formatArn({
            service: "bedrock",
            resource: "inference-profile",
            resourceName: KIMI_MODEL_ID,
          }),
          "arn:aws:bedrock:*::foundation-model/moonshotai.kimi-k3",
        ],
      })
    );

    lambdaFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["polly:SynthesizeSpeech"],
        resources: ["*"],
      })
    );

    // Grant Bedrock AgentCore invocation permission to Lambda
    lambdaFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "bedrock-agentcore:InvokeAgentRuntime",
          "bedrock-agentcore:InvokeAgentRuntimeWithWebSocketStream",
        ],
        resources: [
          runtime.agentRuntimeArn,
          `${runtime.agentRuntimeArn}/*`,
          openclawRuntimeArn,
          `${openclawRuntimeArn}/*`,
        ],
      })
    );

    // 5. API Gateway REST API for HTTP endpoints (/api/*)
    const restApi = new apigateway.RestApi(this, "DomainExpansionRestApi", {
      restApiName: "Domain Expansion Serverless REST API",
      description: "REST API for JJK Domain Expansion AR Game TEST CHANGE",
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
      },
    });

    const restAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(this, "DomainExpansionRestApiAuthorizer", {
      cognitoUserPools: [props.userPool],
    });

    const lambdaIntegration = new apigateway.LambdaIntegration(lambdaFunction);

    // Explicitly add /api/get-snapshot and /api/last-image as public resources to support direct browser <img> rendering
    const apiResource = restApi.root.addResource("api");
    const getSnapshotResource = apiResource.addResource("get-snapshot");
    getSnapshotResource.addMethod("GET", lambdaIntegration, {
      authorizationType: apigateway.AuthorizationType.NONE,
    });

    const lastImageResource = apiResource.addResource("last-image");
    lastImageResource.addMethod("GET", lambdaIntegration, {
      authorizationType: apigateway.AuthorizationType.NONE,
    });

    const webcamUploadResource = apiResource.addResource("webcam-upload");
    webcamUploadResource.addMethod("POST", lambdaIntegration, {
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer: restAuthorizer,
    });

    const logResource = apiResource.addResource("log");
    logResource.addMethod("POST", lambdaIntegration, {
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer: restAuthorizer,
    });

    const registerRoomResource = apiResource.addResource("register-room");
    registerRoomResource.addMethod("POST", lambdaIntegration, {
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer: restAuthorizer,
    });

    const enhancePortraitResource = apiResource.addResource("enhance-portrait");
    enhancePortraitResource.addMethod("POST", lambdaIntegration, {
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer: restAuthorizer,
    });

    const checkEnhancementResource = apiResource.addResource("check-enhancement");
    checkEnhancementResource.addMethod("GET", lambdaIntegration, {
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer: restAuthorizer,
    });

    const liveStatusResource = apiResource.addResource("live-status");
    liveStatusResource.addMethod("POST", lambdaIntegration, {
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer: restAuthorizer,
    });

    const battleResultResource = apiResource.addResource("battle-result");
    battleResultResource.addMethod("POST", lambdaIntegration, {
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer: restAuthorizer,
    });

    const triggerTechniqueResource = apiResource.addResource("trigger-technique");
    triggerTechniqueResource.addMethod("POST", lambdaIntegration, {
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer: restAuthorizer,
    });

    const healthResource = restApi.root.addResource("health");
    healthResource.addMethod("GET", lambdaIntegration, {
      authorizationType: apigateway.AuthorizationType.NONE,
    });

    // Fallback catch-all proxy routes remain securely protected by Cognito Authorization
    restApi.root.addProxy({
      defaultIntegration: lambdaIntegration,
      defaultMethodOptions: {
        authorizer: restAuthorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      },
    });

    // 6. API Gateway WebSocket API for real-time signaling
    const webSocketApi = new apigatewayv2.CfnApi(this, "DomainExpansionWebSocketApi", {
      name: "DomainExpansionWebSocketApi",
      protocolType: "WEBSOCKET",
      routeSelectionExpression: "$request.body.action",
    });

    const wsAuthorizer = new apigatewayv2.CfnAuthorizer(this, "WebSocketCognitoAuthorizer", {
      apiId: webSocketApi.ref,
      name: "WebSocketCognitoAuthorizer",
      authorizerType: "REQUEST",
      authorizerUri: `arn:aws:apigateway:${Stack.of(this).region}:lambda:path/2015-03-31/functions/${lambdaFunction.functionArn}/invocations`,
      identitySource: ["route.request.querystring.token"],
    });

    lambdaFunction.addPermission("WebSocketAuthPermission", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      sourceArn: `arn:aws:execute-api:${Stack.of(this).region}:${Stack.of(this).account}:${webSocketApi.ref}/*`,
    });

    const wsIntegration = new apigatewayv2.CfnIntegration(this, "WebSocketIntegration", {
      apiId: webSocketApi.ref,
      integrationType: "AWS_PROXY",
      integrationUri: `arn:aws:apigateway:${Stack.of(this).region}:lambda:path/2015-03-31/functions/${lambdaFunction.functionArn}/invocations`,
    });

    const connectRoute = new apigatewayv2.CfnRoute(this, "ConnectRoute", {
      apiId: webSocketApi.ref,
      routeKey: "$connect",
      authorizationType: "CUSTOM",
      authorizerId: wsAuthorizer.ref,
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

    // 7. Cost-Efficient CloudFront Distribution (Price Class 100)
    const oai = new cloudfront.OriginAccessIdentity(this, "OAI");
    this.websiteBucket.grantRead(oai);

    const distribution = new cloudfront.Distribution(this, "GameDistribution", {
      defaultRootObject: "index.html",
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
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

    // 8. Auto-deploy and cache-invalidate Static S3 Frontend assets and dynamic config.json
    const gameDeployment = new s3deploy.BucketDeployment(this, "DeployGameAssetsAndConfig", {
      sources: [
        s3deploy.Source.asset(path.join(__dirname, "../../../domain-expansion-ar-game"), {
          exclude: [
            "node_modules",
            "node_modules/**",
            "node_modules/*",
            ".git",
            ".git/**",
            "docs",
            "docs/**",
            "server.js",
            "clean_sessions.js",
            "Dockerfile",
            "docker-compose.yml",
            "package.json",
            "package-lock.json",
            "cert.pem",
            "key.pem",
            "deploy.sh",
            "undeploy.sh",
            ".antigravitycli",
            ".antigravitycli/**",
            "static/video",
            "static/video/**",
            "static/video/*"
          ],
        }),
        s3deploy.Source.jsonData("config.json", {
          isServerless: true,
          webSocketUrl: `wss://${webSocketApi.ref}.execute-api.${Stack.of(this).region}.amazonaws.com/${stage.stageName}`,
          robotApiEndpoint: "https://" + props.robotSimulatorServerlessConstruct.serviceUrl,
          defaultSessionKey: "mcpserver",
          cognitoUserPoolId: props.userPool.userPoolId,
          cognitoUserPoolClientId: props.userPoolClient.userPoolClientId,
          cognitoRegion: Stack.of(this).region,
        }),
      ],
      destinationBucket: this.websiteBucket,
      distribution,
      distributionPaths: ["/*"],
      prune: false,
      memoryLimit: 1024,
    });
    gameDeployment.handlerRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          "cloudfront:CreateInvalidation",
          "cloudfront:GetInvalidation",
        ],
        resources: [distribution.distributionArn],
      })
    );

    this.serviceUrl = distribution.distributionDomainName;
    this.webSocketUrl = `wss://${webSocketApi.ref}.execute-api.${Stack.of(this).region}.amazonaws.com/${stage.stageName}`;
  }
}
