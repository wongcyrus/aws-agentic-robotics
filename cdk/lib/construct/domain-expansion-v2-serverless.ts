import { Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as apigatewayv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as path from "path";
import { PythonFunction } from "@aws-cdk/aws-lambda-python-alpha";
import { UserPool } from "aws-cdk-lib/aws-cognito";
import { Construct } from "constructs";
import {
  createDestroyableLambdaLogGroup,
  SHARED_PYTHON_BUNDLING,
  SHARED_PYTHON_RUNTIME,
} from "./lambda-config";

export interface DomainExpansionV2ServerlessConstructProps {
  readonly userPoolId: string;
  readonly userPoolClientId: string;
  readonly commentatorRuntimeArn: string;
  readonly openClawRuntimeArn: string;
  readonly robotApiEndpoint: string;
  readonly robotGatewayUrl: string;
}

export class DomainExpansionV2ServerlessConstruct extends Construct {
  public readonly serviceUrl: string;
  public readonly webSocketUrl: string;
  public readonly restApiUrl: string;
  public readonly websiteBucket: s3.Bucket;

  constructor(
    scope: Construct,
    id: string,
    props: DomainExpansionV2ServerlessConstructProps
  ) {
    super(scope, id);

    const userPool = UserPool.fromUserPoolId(
      this,
      "ImportedUserPool",
      props.userPoolId
    );

    this.websiteBucket = new s3.Bucket(this, "WebsiteBucket", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const photosBucket = new s3.Bucket(this, "PhotosBucket", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      publicReadAccess: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ACLS_ONLY,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ expiration: Duration.days(7) }],
      cors: [
        {
          allowedHeaders: ["*"],
          allowedMethods: [
            s3.HttpMethods.GET,
            s3.HttpMethods.HEAD,
            s3.HttpMethods.POST,
          ],
          allowedOrigins: ["*"],
          maxAge: 3000,
        },
      ],
    });
    photosBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [photosBucket.arnForObjects("*")],
        principals: [new iam.AnyPrincipal()],
      })
    );

    const connectionsTable = new dynamodb.Table(this, "ConnectionsTable", {
      partitionKey: {
        name: "connection_id",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: "ttl",
      removalPolicy: RemovalPolicy.DESTROY,
    });
    connectionsTable.addGlobalSecondaryIndex({
      indexName: "RoomCodeIndex",
      partitionKey: {
        name: "room_code",
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const sessionsTable = new dynamodb.Table(this, "SessionsTable", {
      partitionKey: {
        name: "session_id",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: "ttl",
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const lambdaFunction = new PythonFunction(this, "BackendFunction", {
      entry: path.join(
        __dirname,
        "../../../domain-expansion-ar-game-v2-serverless/backend"
      ),
      index: "lambda_function.py",
      handler: "lambda_handler",
      runtime: SHARED_PYTHON_RUNTIME,
      timeout: Duration.seconds(55),
      memorySize: 512,
      logGroup: createDestroyableLambdaLogGroup(this, "BackendLogGroup"),
      bundling: SHARED_PYTHON_BUNDLING,
      environment: {
        IsInCloud: "yes",
        LOG_LEVEL: "INFO",
        AWS_BEDROCK_REGION: "us-east-1",
        CONNECTIONS_TABLE: connectionsTable.tableName,
        SESSIONS_TABLE: sessionsTable.tableName,
        AGENT_TYPE: "agentcore_runtime",
        AGENTCORE_RUNTIME_ARN: props.commentatorRuntimeArn,
        OPENCLAW_RUNTIME_ARN: props.openClawRuntimeArn,
        OPENCLAW_SESSION_ID: "telegram:default",
        BEDROCK_MODEL_ID: "global.moonshotai.kimi-k3",
        COMMENTARY_MAX_TOKENS: "1600",
        AGENTCORE_READ_TIMEOUT_SECONDS: "50",
        BEDROCK_REGION: Stack.of(this).region,
        PHOTOS_S3_BUCKET: photosBucket.bucketName,
        PHOTOS_S3_DOMAIN: photosBucket.bucketRegionalDomainName,
        COMMENTARY_AUDIO_PREFIX: "commentary-audio",
        COMMENTARY_AUDIO_URL_EXPIRY: "600",
        COGNITO_USER_POOL_ID: props.userPoolId,
        COGNITO_USER_POOL_CLIENT_ID: props.userPoolClientId,
        COGNITO_REGION: Stack.of(this).region,
        ROBOT_API_ENDPOINT: props.robotApiEndpoint,
        DEFAULT_SESSION_KEY: "mcpserver",
        McpServerGatewayUrl: props.robotGatewayUrl,
      },
    });

    connectionsTable.grantReadWriteData(lambdaFunction);
    sessionsTable.grantReadWriteData(lambdaFunction);
    photosBucket.grantReadWrite(lambdaFunction);
    lambdaFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
          "bedrock-agentcore:InvokeAgentRuntime",
          "bedrock-agentcore:InvokeAgentRuntimeWithWebSocketStream",
          "polly:SynthesizeSpeech",
        ],
        resources: [
          Stack.of(this).formatArn({
            service: "bedrock",
            resource: "inference-profile",
            resourceName: "global.moonshotai.kimi-k3",
          }),
          "arn:aws:bedrock:*::foundation-model/moonshotai.kimi-k3",
          props.commentatorRuntimeArn,
          `${props.commentatorRuntimeArn}/*`,
          props.openClawRuntimeArn,
          `${props.openClawRuntimeArn}/*`,
          "*",
        ],
      })
    );
    lambdaFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock-agentcore:InvokeGateway"],
        resources: ["*"],
      })
    );

    const restApi = new apigateway.RestApi(this, "RestApi", {
      restApiName: "Domain Expansion V2 REST API",
      description: "Online-only API for Domain Expansion V2",
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
      },
    });
    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(
      this,
      "RestAuthorizer",
      { cognitoUserPools: [userPool] }
    );
    const integration = new apigateway.LambdaIntegration(lambdaFunction, {
      timeout: Duration.seconds(60),
    });
    const api = restApi.root.addResource("api");
    const publicGetRoutes = ["get-snapshot", "last-image"];
    const authenticatedPostRoutes = [
      "webcam-upload",
      "log",
      "register-room",
      "live-status",
      "battle-result",
      "trigger-technique",
    ];
    for (const route of publicGetRoutes) {
      api.addResource(route).addMethod("GET", integration, {
        authorizationType: apigateway.AuthorizationType.NONE,
      });
    }
    for (const route of authenticatedPostRoutes) {
      api.addResource(route).addMethod("POST", integration, {
        authorizationType: apigateway.AuthorizationType.COGNITO,
        authorizer,
      });
    }
    restApi.root.addResource("health").addMethod("GET", integration, {
      authorizationType: apigateway.AuthorizationType.NONE,
    });

    const webSocketApi = new apigatewayv2.CfnApi(this, "WebSocketApi", {
      name: "DomainExpansionV2WebSocketApi",
      protocolType: "WEBSOCKET",
      routeSelectionExpression: "$request.body.action",
    });
    const wsAuthorizer = new apigatewayv2.CfnAuthorizer(
      this,
      "WebSocketAuthorizer",
      {
        apiId: webSocketApi.ref,
        name: "DomainExpansionV2WebSocketAuthorizer",
        authorizerType: "REQUEST",
        authorizerUri: `arn:aws:apigateway:${Stack.of(this).region}:lambda:path/2015-03-31/functions/${lambdaFunction.functionArn}/invocations`,
        identitySource: ["route.request.querystring.token"],
      }
    );
    lambdaFunction.addPermission("WebSocketAuthorizerPermission", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      sourceArn: `arn:aws:execute-api:${Stack.of(this).region}:${Stack.of(this).account}:${webSocketApi.ref}/*`,
    });
    const wsIntegration = new apigatewayv2.CfnIntegration(
      this,
      "WebSocketIntegration",
      {
        apiId: webSocketApi.ref,
        integrationType: "AWS_PROXY",
        integrationUri: `arn:aws:apigateway:${Stack.of(this).region}:lambda:path/2015-03-31/functions/${lambdaFunction.functionArn}/invocations`,
      }
    );
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
    const deployment = new apigatewayv2.CfnDeployment(
      this,
      "WebSocketDeployment",
      { apiId: webSocketApi.ref }
    );
    deployment.node.addDependency(connectRoute);
    deployment.node.addDependency(disconnectRoute);
    deployment.node.addDependency(defaultRoute);
    const stage = new apigatewayv2.CfnStage(this, "WebSocketStage", {
      apiId: webSocketApi.ref,
      stageName: "prod",
      deploymentId: deployment.ref,
      autoDeploy: true,
    });
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

    const distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultRootObject: "index.html",
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.websiteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
    });
    const apiOrigin = new origins.RestApiOrigin(restApi, {
      readTimeout: Duration.seconds(60),
    });
    const dynamicBehavior: cloudfront.BehaviorOptions = {
      origin: apiOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy:
        cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
    };
    distribution.addBehavior("/api/*", apiOrigin, dynamicBehavior);
    distribution.addBehavior("/health", apiOrigin, dynamicBehavior);

    const webSocketOrigin = new origins.HttpOrigin(
      `${webSocketApi.ref}.execute-api.${Stack.of(this).region}.amazonaws.com`,
      { originPath: `/${stage.stageName}` }
    );
    distribution.addBehavior("/ws", webSocketOrigin, {
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy:
        cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
    });

    new s3deploy.BucketDeployment(this, "DeployWeb", {
      sources: [
        s3deploy.Source.asset(
          path.join(__dirname, "../../../domain-expansion-ar-game-v2/dist"),
          { exclude: ["static/video/**"] }
        ),
        s3deploy.Source.jsonData("config.json", {
          protocolVersion: "2.0",
          apiBaseUrl: `https://${distribution.distributionDomainName}`,
          webSocketUrl: `wss://${webSocketApi.ref}.execute-api.${Stack.of(this).region}.amazonaws.com/${stage.stageName}`,
          robotApiEndpoint: props.robotApiEndpoint,
          defaultSessionKey: "mcpserver",
          cognitoUserPoolId: props.userPoolId,
          cognitoUserPoolClientId: props.userPoolClientId,
          cognitoRegion: Stack.of(this).region,
        }),
      ],
      destinationBucket: this.websiteBucket,
      distribution,
      distributionPaths: ["/*"],
      prune: true,
      memoryLimit: 1024,
    });

    this.serviceUrl = distribution.distributionDomainName;
    this.webSocketUrl = `wss://${webSocketApi.ref}.execute-api.${Stack.of(this).region}.amazonaws.com/${stage.stageName}`;
    this.restApiUrl = restApi.url;
  }
}
