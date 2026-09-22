import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as iam from "aws-cdk-lib/aws-iam";
import { BatchIoTThings } from "./iot-things";

export interface RoboticConstructProps {
  thingNames: string[];
}

export class RoboticConstruct extends Construct {
  public readonly bucket: s3.IBucket;
  public readonly iotThings: BatchIoTThings;

  constructor(scope: Construct, id: string, props: RoboticConstructProps) {
    super(scope, id);

    // Example S3 bucket creation
    this.bucket = new s3.Bucket(this, "RoboticBucket", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Create all IoT things with a single construct
    this.iotThings = new BatchIoTThings(this, "BatchIoTThings", {
      thingNames: props.thingNames,
      saveToParamStore: true,
      paramPrefix: "iot/robotics",
      saveFileBucket: this.bucket,
    });

    // Create an IAM user for IoT robot access
    const iotUser = new iam.User(this, "IoTRobotUser", {
      userName: "AmazonNovaRoboticsIoTRobotUser",
    });

    iotUser.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["iot:Connect"],
        resources: [`arn:aws:iot:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:*`],
      })
    );
    iotUser.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["iot:Publish", "iot:Subscribe", "iot:Receive"],
        resources: [`arn:aws:iot:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:*`],
      })
    );

    // Create access key for the IoT user
    const iotAccessKey = new iam.CfnAccessKey(this, "IoTRobotUserAccessKey", {
      userName: iotUser.userName,
    });

    // Output the access key and secret
    new cdk.CfnOutput(this, "IoTRobotUserName", {
      key: "IoTRobotUserName",
      value: iotUser.userName,
      description: "IAM user for IoT robot access.",
    });
    new cdk.CfnOutput(this, "IoTRobotAccessKeyId", {
      key: "IoTRobotAccessKeyId",
      value: iotAccessKey.ref,
      description: "Access Key ID for IoT robot user.",
    });
    new cdk.CfnOutput(this, "IoTRobotSecretAccessKey", {
      key: "IoTRobotSecretAccessKey",
      value: iotAccessKey.attrSecretAccessKey,
      description: "Secret Access Key for IoT robot user.",
    });

    // Output some information about the created things
    new cdk.CfnOutput(this, "NumberOfThingsCreated", {
      key: "NumberOfThingsCreated",
      value: props.thingNames.length.toString(),
      description: "Total number of IoT things created.",
    });

    new cdk.CfnOutput(this, "ThingNames", {
      key: "ThingNames",
      value: props.thingNames.join(", "),
      description: "Names of all created IoT things.",
    });

    // Output information about certificate storage
    new cdk.CfnOutput(this, "CertificateStorageLocation", {
      key: "CertificateStorageLocation",
      value: `S3 Bucket: ${this.bucket.bucketName}, SSM Parameter Store: iot/robotics/*`,
      description: "Location where IoT certificates are stored.",
    });

    new cdk.CfnOutput(this, "CertificateDownloadInstructions", {
      key: "CertificateDownloadInstructions",
      value: `Use AWS CLI: aws s3 cp s3://${this.bucket.bucketName}/iot-certificates/ ./certificates/ --recursive`,
      description: "Command to download all IoT certificates from S3.",
    });
  }

  /**
   * Get certificate information for a specific thing
   */
  public getCertificateInfo(thingName: string) {
    return this.iotThings.getCertificateInfo(thingName);
  }

  /**
   * Get all certificate information
   */
  public getAllCertificateInfo() {
    return this.iotThings.getAllCertificateInfo();
  }
}
