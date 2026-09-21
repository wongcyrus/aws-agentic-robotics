import { Duration, CfnOutput } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as bedrockagentcore from "aws-cdk-lib/aws-bedrockagentcore";
import { TableV2 } from "aws-cdk-lib/aws-dynamodb";
import { PythonFunction } from "@aws-cdk/aws-lambda-python-alpha";
import { Construct } from "constructs";
import * as fs from "fs";
import * as os from "os";
import {
  createDestroyableLambdaLogGroup,
  SHARED_PYTHON_BUNDLING,
  SHARED_PYTHON_RUNTIME,
} from "./lambda-config";
import { applyAgentCoreGatewayObservability } from "./agentcore-observability";

import path = require("path");

type RobotToolSchemaDefinition = {
  name: string;
  description: string;
  inputSchema: any;
  outputSchema?: any;
};

export interface RobotToolGatewayConstructProps {
  readonly simulatorEndpoint?: string;
  readonly mediaBucket: s3.IBucket;
  readonly speechTable: TableV2;
}

const SUPPORTED_ROBOT_TOOL_NAMES = new Set([
  "robot_go_forward",
  "robot_back_fast",
  "robot_left_move_fast",
  "robot_right_move_fast",
  "robot_stand",
  "robot_squat",
  "robot_squat_up",
  "robot_stand_up_back",
  "robot_stand_up_front",
  "robot_bow",
  "robot_push_ups",
  "robot_sit_ups",
  "robot_chest",
  "robot_stepping",
  "robot_left_kick",
  "robot_right_kick",
  "robot_left_shot_fast",
  "robot_right_shot_fast",
  "robot_left_uppercut",
  "robot_right_uppercut",
  "robot_kung_fu",
  "robot_wing_chun",
  "robot_weightlifting",
  "robot_turn_left",
  "robot_turn_right",
  "robot_twist",
  "robot_wave",
  "robot_stop",
  "robot_speak",
  "robot_see",
  "get_image",
]);

const SUPPORTED_DIGITAL_HUMAN_TOOL_NAMES = new Set([
  "digital_human_speech",
]);

function loadRobotToolSchema(): RobotToolSchemaDefinition[] {
  const schemaPath = path.join(
    __dirname,
    "../../../mcp_server/agentcore-tool-schema.json"
  );
  const rawSchema = JSON.parse(
    fs.readFileSync(schemaPath, "utf8")
  ) as RobotToolSchemaDefinition[];

  return rawSchema.filter((tool) => SUPPORTED_ROBOT_TOOL_NAMES.has(tool.name));
}

function loadDigitalHumanToolSchema(): RobotToolSchemaDefinition[] {
  const schemaPath = path.join(
    __dirname,
    "../../../mcp_server/agentcore-tool-schema.json"
  );
  const rawSchema = JSON.parse(
    fs.readFileSync(schemaPath, "utf8")
  ) as RobotToolSchemaDefinition[];

  return rawSchema.filter((tool) => SUPPORTED_DIGITAL_HUMAN_TOOL_NAMES.has(tool.name));
}

function materializeRobotToolSchemaAsset(): string {
  const assetPath = path.join(
    os.tmpdir(),
    "aws-agentic-robotics-robot-tool-schema.json"
  );
  fs.writeFileSync(assetPath, JSON.stringify(loadRobotToolSchema(), null, 2));
  return assetPath;
}

function materializeDigitalHumanToolSchemaAsset(): string {
  const assetPath = path.join(
    os.tmpdir(),
    "aws-agentic-robotics-digital-human-tool-schema.json"
  );
  fs.writeFileSync(assetPath, JSON.stringify(loadDigitalHumanToolSchema(), null, 2));
  return assetPath;
}

export class RobotToolGatewayConstruct extends Construct {
  public readonly robotToolFunction: PythonFunction;
  public readonly digitalHumanToolFunction: PythonFunction;
  public readonly gateway: bedrockagentcore.Gateway;
  public readonly gatewayTarget: bedrockagentcore.GatewayTarget;
  public readonly digitalHumanGatewayTarget: bedrockagentcore.GatewayTarget;
  public readonly gatewayUrl: string;

  constructor(
    scope: Construct,
    id: string,
    props: RobotToolGatewayConstructProps
  ) {
    super(scope, id);

    this.robotToolFunction = new PythonFunction(this, "RobotToolFunction", {
      entry: path.join(__dirname, "../../../mcp_server"),
      runtime: SHARED_PYTHON_RUNTIME,
      index: "robot_tool_lambda.py",
      handler: "lambda_handler",
      timeout: Duration.seconds(30),
      logGroup: createDestroyableLambdaLogGroup(this, "RobotToolFunctionLogGroup"),
      bundling: SHARED_PYTHON_BUNDLING,
      environment: {
        SIMULATOR_ENDPOINT: props.simulatorEndpoint || "",
        MEDIA_BUCKET_NAME: props.mediaBucket.bucketName,
      },
    });

    props.mediaBucket.grantReadWrite(this.robotToolFunction);

    this.robotToolFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["iot:Publish", "iot-data:Publish"],
        resources: ["arn:aws:iot:*:*:topic/robot_*/topic"],
      })
    );

    this.robotToolFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["polly:SynthesizeSpeech"],
        resources: ["*"],
      })
    );

    // Create the Digital Human Tool Function
    this.digitalHumanToolFunction = new PythonFunction(this, "DigitalHumanToolFunction", {
      entry: path.join(__dirname, "../../../mcp_server"),
      runtime: SHARED_PYTHON_RUNTIME,
      index: "digital_human_tool_lambda.py",
      handler: "lambda_handler",
      timeout: Duration.seconds(30),
      logGroup: createDestroyableLambdaLogGroup(this, "DigitalHumanToolFunctionLogGroup"),
      bundling: SHARED_PYTHON_BUNDLING,
      environment: {
        SIMULATOR_ENDPOINT: props.simulatorEndpoint || "",
        MEDIA_BUCKET_NAME: props.mediaBucket.bucketName,
        SpeechTable: props.speechTable.tableName,
      },
    });

    props.mediaBucket.grantReadWrite(this.digitalHumanToolFunction);
    props.speechTable.grantReadWriteData(this.digitalHumanToolFunction);

    this.digitalHumanToolFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["iot:Publish", "iot-data:Publish"],
        resources: ["arn:aws:iot:*:*:topic/xiaoice_*/topic"],
      })
    );

    this.digitalHumanToolFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["polly:SynthesizeSpeech"],
        resources: ["*"],
      })
    );

    this.gateway = new bedrockagentcore.Gateway(this, "RobotToolGateway", {
      description: "AgentCore gateway fronting the robot and digital human Lambda tools",
      authorizerConfiguration: bedrockagentcore.GatewayAuthorizer.usingAwsIam(),
    });
    applyAgentCoreGatewayObservability(this, "RobotOnlyTools", this.gateway);

    this.gatewayTarget = this.gateway.addLambdaTarget("RobotToolLambdaTarget", {
      description: "Lambda target exposing only the robot tools through AgentCore",
      gatewayTargetName: "robot-only-mcp-lambda",
      lambdaFunction: this.robotToolFunction,
      toolSchema: bedrockagentcore.ToolSchema.fromLocalAsset(
        materializeRobotToolSchemaAsset()
      ),
    });

    this.digitalHumanGatewayTarget = this.gateway.addLambdaTarget("DigitalHumanToolLambdaTarget", {
      description: "Lambda target exposing only the digital human tools through AgentCore",
      gatewayTargetName: "digital-human-mcp-lambda",
      lambdaFunction: this.digitalHumanToolFunction,
      toolSchema: bedrockagentcore.ToolSchema.fromLocalAsset(
        materializeDigitalHumanToolSchemaAsset()
      ),
    });

    this.gatewayUrl = this.gateway.gatewayUrl ?? "";

    new CfnOutput(this, "RobotToolGatewayUrl", {
      value: this.gatewayUrl,
      description: "Robot and Digital Human AgentCore Gateway URL for speech runtime MCP access",
    });
  }

  public grantInvokeGateway(grantee: iam.IGrantable): void {
    this.gateway.grantInvoke(grantee);
  }
}
