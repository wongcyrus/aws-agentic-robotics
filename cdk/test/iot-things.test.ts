import { describe, expect, test } from "@jest/globals";
import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as s3 from "aws-cdk-lib/aws-s3";
import { BatchIoTThings } from "../lib/construct/iot-things";

describe("BatchIoTThings", () => {
  const app = () => new App({ outdir: "cdk.out/jest-iot" });

  test("rejects an empty thing list before creating resources", () => {
    const stack = new Stack(app(), "EmptyStack");

    expect(
      () => new BatchIoTThings(stack, "Things", { thingNames: [] })
    ).toThrow("At least one thing name must be provided");
  });

  test("uses SSM storage defaults and returns defensive certificate metadata", () => {
    const stack = new Stack(app(), "SsmThingsStack", {
      env: { account: "111122223333", region: "us-east-1" },
    });

    const things = new BatchIoTThings(stack, "Things", {
      thingNames: ["robot_1", "robot_2"],
    });

    expect(things.getCertificateInfo("robot_1")).toEqual({
      thingName: "robot_1",
      thingArn: expect.stringMatching(
        /^arn:aws:iot:.*:.*:thing\/robot_1$/
      ),
      certId: "stored-in-ssm",
      certPem: "ssm:/iot/things/robot_1/certPem",
      privKey: "ssm:/iot/things/robot_1/privKey",
    });
    expect(things.getCertificateInfo("missing")).toBeUndefined();
    const allCertificates = things.getAllCertificateInfo();
    allCertificates.pop();
    expect(things.getAllCertificateInfo()).toHaveLength(2);

    const template = Template.fromStack(stack);
    template.resourceCountIs("Custom::AWS", 0);
    template.hasResourceProperties("AWS::CloudFormation::CustomResource", {
      ThingNames: ["robot_1", "robot_2"],
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs24.x",
      Timeout: 900,
      Environment: {
        Variables: Match.objectLike({
          PARAM_PREFIX: "iot/things",
          SAVE_TO_PARAM_STORE: "true",
          S3_BUCKET_NAME: "",
          SAVE_TO_S3: "false",
        }),
      },
    });
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ["ssm:PutParameter", "ssm:DeleteParameter"],
            Resource: Match.anyValue(),
          }),
        ]),
      },
    });
  });

  test("uses S3 certificate locations and conditionally grants bucket access", () => {
    const stack = new Stack(app(), "S3ThingsStack", {
      env: { account: "111122223333", region: "us-east-1" },
    });
    const bucket = new s3.Bucket(stack, "CertificateBucket");

    const things = new BatchIoTThings(stack, "Things", {
      thingNames: ["robot_alpha"],
      saveToParamStore: false,
      paramPrefix: "custom/prefix",
      saveFileBucket: bucket,
    });

    expect(things.getAllCertificateInfo()).toEqual([
      {
        thingName: "robot_alpha",
        thingArn: expect.stringMatching(
          /^arn:aws:iot:.*:.*:thing\/robot_alpha$/
        ),
        certId: "stored-in-s3",
        certPem: expect.stringMatching(
          /^s3:\/\/.+\/iot-certificates\/robot_alpha\/robot_alpha\.cert\.pem$/
        ),
        privKey: expect.stringMatching(
          /^s3:\/\/.+\/iot-certificates\/robot_alpha\/robot_alpha\.private\.key$/
        ),
      },
    ]);

    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          PARAM_PREFIX: "custom/prefix",
          SAVE_TO_PARAM_STORE: "false",
          SAVE_TO_S3: "true",
        }),
      },
    });
    const policies = template.findResources("AWS::IAM::Policy");
    const serializedPolicies = JSON.stringify(policies);
    expect(serializedPolicies).toContain("s3:PutObject");
    expect(serializedPolicies).not.toContain("ssm:PutParameter");
  });
});
