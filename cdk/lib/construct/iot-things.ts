import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as cfn from "aws-cdk-lib/aws-cloudformation";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Provider } from "aws-cdk-lib/custom-resources";

export interface BatchIoTThingsProps {
  /**
   * List of thing names to create
   */
  readonly thingNames: string[];

  /**
   * Whether to save certificates to Parameter Store
   * @default true
   */
  readonly saveToParamStore?: boolean;

  /**
   * Prefix for Parameter Store paths
   * @default "iot/things"
   */
  readonly paramPrefix?: string;

  /**
   * S3 bucket to save certificate files
   * @default - certificates are not saved to S3
   */
  readonly saveFileBucket?: s3.IBucket;
}

export interface ThingCertificateInfo {
  readonly thingName: string;
  readonly thingArn: string;
  readonly certId: string;
  readonly certPem: string;
  readonly privKey: string;
}

/**
 * Construct for creating multiple IoT Things with certificates
 * Uses a single Lambda function to handle all operations
 */
export class BatchIoTThings extends Construct {
  public readonly thingCertificates: ThingCertificateInfo[];
  private readonly customResource: cfn.CfnCustomResource;

  constructor(scope: Construct, id: string, props: BatchIoTThingsProps) {
    super(scope, id);

    const {
      thingNames,
      saveToParamStore = true,
      paramPrefix = "iot/things",
      saveFileBucket,
    } = props;

    if (thingNames.length === 0) {
      throw new Error("At least one thing name must be provided");
    }

    // Create single IAM role for the Lambda function
    const lambdaRole = new iam.Role(this, "BatchIoTLambdaRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AWSLambdaBasicExecutionRole"
        ),
      ],
    });

    // Add IoT permissions
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "iot:CreateThing",
          "iot:DeleteThing",
          "iot:CreateKeysAndCertificate",
          "iot:DeleteCertificate",
          "iot:UpdateCertificate",
          "iot:CreatePolicy",
          "iot:DeletePolicy",
          "iot:AttachPrincipalPolicy",
          "iot:DetachPrincipalPolicy",
          "iot:AttachThingPrincipal",
          "iot:DetachThingPrincipal",
          "iot:ListThingPrincipals",
        ],
        resources: ["*"],
      })
    );

    // Add SSM permissions if saving to Parameter Store
    if (saveToParamStore) {
      lambdaRole.addToPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["ssm:PutParameter", "ssm:DeleteParameter"],
          resources: [
            `arn:aws:ssm:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:parameter/${paramPrefix}/*`,
          ],
        })
      );
    }

    // Add S3 permissions if bucket is provided
    if (saveFileBucket) {
      lambdaRole.addToPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            "s3:PutObject",
            "s3:DeleteObject",
            "s3:GetObject",
            "s3:ListBucket",
          ],
          resources: [
            saveFileBucket.bucketArn,
            `${saveFileBucket.bucketArn}/*`,
          ],
        })
      );
    }

    // Create the Lambda function
    const logGroup = new logs.LogGroup(this, "BatchIoTFunctionLogGroup", {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const batchIoTFunction = new nodejs.NodejsFunction(
      this,
      "BatchIoTFunction",
      {
        entry: require.resolve(
          "./function/batch-iot-custom-resources/batch-iot-handler.ts"
        ),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_24_X,
        timeout: cdk.Duration.minutes(15), // Longer timeout for batch operations
        role: lambdaRole,
        logGroup: logGroup,
        environment: {
          PARAM_PREFIX: paramPrefix,
          SAVE_TO_PARAM_STORE: saveToParamStore.toString(),
          S3_BUCKET_NAME: saveFileBucket?.bucketName || "",
          SAVE_TO_S3: saveFileBucket ? "true" : "false",
        },
        bundling: {
          externalModules: [
            "@aws-sdk/client-iot",
            "@aws-sdk/client-ssm",
            "@aws-sdk/client-s3",
          ], // These are available in Lambda runtime
        },
      }
    );

    // Create custom resource provider
    const provider = new Provider(this, "BatchIoTProvider", {
      onEventHandler: batchIoTFunction,
    });

    // Create the custom resource
    this.customResource = new cfn.CfnCustomResource(
      this,
      "BatchIoTCustomResource",
      {
        serviceToken: provider.serviceToken,
      }
    );

    this.customResource.addPropertyOverride("ThingNames", thingNames);

    // Initialize the thing certificates array based on the simplified response
    this.thingCertificates = thingNames.map((thingName) => {
      if (saveFileBucket) {
        // When using S3, certificates are stored there with predictable paths
        const certS3Path = `iot-certificates/${thingName}/${thingName}.cert.pem`;
        const privKeyS3Path = `iot-certificates/${thingName}/${thingName}.private.key`;

        return {
          thingName,
          thingArn: `arn:aws:iot:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:thing/${thingName}`,
          certId: "stored-in-s3", // Actual cert ID is not returned in minimal response
          // Return S3 URLs for certificate access
          certPem: `s3://${saveFileBucket.bucketName}/${certS3Path}`,
          privKey: `s3://${saveFileBucket.bucketName}/${privKeyS3Path}`,
        };
      } else {
        // When not using S3, certificates are stored in SSM Parameter Store
        return {
          thingName,
          thingArn: `arn:aws:iot:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:thing/${thingName}`,
          certId: "stored-in-ssm", // Actual cert ID is not returned in minimal response
          certPem: `ssm:/${paramPrefix}/${thingName}/certPem`,
          privKey: `ssm:/${paramPrefix}/${thingName}/privKey`,
        };
      }
    });

    // Create SSM parameters if requested
    if (saveToParamStore) {
      // Note: SSM parameters are created by the Lambda function directly
      // since we use a minimal response format to avoid CloudFormation size limits
      // Certificates can be accessed via SSM Parameter Store at: /{paramPrefix}/{thingName}/certPem and /{paramPrefix}/{thingName}/privKey
    }

    // Note: Certificates are automatically saved to S3 by the Lambda function
    // if saveFileBucket is provided
  }

  /**
   * Get certificate information for a specific thing
   */
  public getCertificateInfo(
    thingName: string
  ): ThingCertificateInfo | undefined {
    return this.thingCertificates.find((cert) => cert.thingName === thingName);
  }

  /**
   * Get all certificate information
   */
  public getAllCertificateInfo(): ThingCertificateInfo[] {
    return [...this.thingCertificates];
  }
}
