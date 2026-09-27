import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { DomainExpansionV2ServerlessConstruct } from "./construct/domain-expansion-v2-serverless";

export interface DomainExpansionV2StackProps extends cdk.StackProps {
  readonly userPoolId: string;
  readonly userPoolClientId: string;
  readonly commentatorRuntimeArn: string;
  readonly openClawRuntimeArn: string;
  readonly robotApiEndpoint: string;
  readonly robotGatewayUrl: string;
}

export class DomainExpansionV2Stack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    props: DomainExpansionV2StackProps
  ) {
    super(scope, id, props);

    const game = new DomainExpansionV2ServerlessConstruct(
      this,
      "DomainExpansionV2",
      props
    );

    new cdk.CfnOutput(this, "DomainExpansionV2Url", {
      value: `https://${game.serviceUrl}`,
      description: "Parallel Domain Expansion V2 website",
    });
    new cdk.CfnOutput(this, "DomainExpansionV2WebSocketUrl", {
      value: game.webSocketUrl,
      description: "Domain Expansion V2 WebSocket endpoint",
    });
    new cdk.CfnOutput(this, "DomainExpansionV2RestApiUrl", {
      value: game.restApiUrl,
      description: "Domain Expansion V2 REST API endpoint",
    });
    new cdk.CfnOutput(this, "DomainExpansionV2WebsiteBucket", {
      value: game.websiteBucket.bucketName,
      description: "Domain Expansion V2 website bucket",
    });
  }
}
