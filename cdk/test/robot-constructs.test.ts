import { describe, expect, jest, test } from "@jest/globals";
import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { RoboticConstruct } from "../lib/construct/robot-iot";
import { RobotSsmConstruct } from "../lib/construct/robot-ssm";

describe("robot infrastructure constructs", () => {
  const app = () => new App({ outdir: "cdk.out/jest-robot-constructs" });

  test("RoboticConstruct provisions batched IoT access and certificate outputs", () => {
    const stack = new Stack(app(), "RoboticStack", {
      env: { account: "111122223333", region: "us-east-1" },
    });

    const robotic = new RoboticConstruct(stack, "Robotic", {
      thingNames: ["robot_1", "xiaoice_1"],
    });

    expect(robotic.getCertificateInfo("robot_1")?.certId).toBe("stored-in-s3");
    expect(robotic.getCertificateInfo("missing")).toBeUndefined();
    expect(robotic.getAllCertificateInfo()).toHaveLength(2);

    const template = Template.fromStack(stack);
    template.hasResource("AWS::S3::Bucket", {
      DeletionPolicy: "Delete",
      UpdateReplacePolicy: "Delete",
    });
    template.hasResourceProperties("AWS::IAM::User", {
      UserName: "AmazonNovaRoboticsIoTRobotUser",
    });
    const policies = JSON.stringify(template.findResources("AWS::IAM::Policy"));
    expect(policies).toContain("iot:Connect");
    expect(policies).toContain("iot:Publish");
    template.resourceCountIs("AWS::IAM::AccessKey", 1);

    const outputs = Object.values(template.toJSON().Outputs);
    expect(outputs).toContainEqual(
      expect.objectContaining({ Value: "2" })
    );
    expect(outputs).toContainEqual(
      expect.objectContaining({ Value: "robot_1, xiaoice_1" })
    );
  });

  test("RobotSsmConstruct creates one activation per robot with constrained trust", () => {
    const codeSpy = jest
      .spyOn(lambda.Code, "fromAsset")
      .mockReturnValue(
        lambda.Code.fromInline(
          "def lambda_handler(event, context): pass"
        ) as never
      );
    try {
      const stack = new Stack(app(), "RobotSsmStack", {
        env: { account: "111122223333", region: "us-east-1" },
      });

      new RobotSsmConstruct(stack, "RobotSsm", {
        prefix: "humanoid",
        thingNames: ["RaspberryPiRobot1", "RaspberryPiRobot2"],
      });

      const template = Template.fromStack(stack);
      template.resourceCountIs("AWS::CloudFormation::CustomResource", 2);
      template.hasResourceProperties("AWS::CloudFormation::CustomResource", {
        Prefix: "humanoid",
        ThingName: "RaspberryPiRobot1",
      });
      template.hasResourceProperties("AWS::Lambda::Function", {
        Handler: "index.lambda_handler",
        Runtime: "python3.10",
        Timeout: 30,
        Environment: {
          Variables: {
            REGION: Match.anyValue(),
            SSM_SERVICE_ROLE: Match.anyValue(),
          },
        },
      });
      template.hasResource("AWS::Logs::LogGroup", {
        DeletionPolicy: "Delete",
        UpdateReplacePolicy: "Delete",
        Properties: { RetentionInDays: 3 },
      });
      template.hasResourceProperties("AWS::IAM::Role", {
        AssumeRolePolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Principal: { Service: "ssm.amazonaws.com" },
              Condition: {
                ArnEquals: {
                  "aws:SourceArn": Match.anyValue(),
                },
                StringEquals: {
                  "aws:SourceAccount": Match.anyValue(),
                },
              },
            }),
          ]),
        },
      });
      expect(Object.keys(template.toJSON().Outputs)).toHaveLength(4);
    } finally {
      codeSpy.mockRestore();
    }
  });
});
