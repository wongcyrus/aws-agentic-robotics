#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import * as fs from 'fs';
import * as path from 'path';
import { AwsAgenticRoboticsStack } from '../lib/cdk-stack';

// Load .env file from the cdk folder manually
try {
  const envPath = path.join(__dirname, '../.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    envContent.split(/\r?\n/).forEach(line => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const parts = trimmed.split('=');
        if (parts.length >= 2) {
          const key = parts[0].trim();
          const val = parts.slice(1).join('=').trim().replace(/^['"]|['"]$/g, '');
          process.env[key] = val;
        }
      }
    });
    console.log('✅ Loaded environment variables from cdk/.env');
  }
} catch (err) {
  console.warn('⚠️ Failed to load cdk/.env:', err);
}

const app = new cdk.App();
const getContext = (key: string): unknown => app.node?.tryGetContext?.(key);
const onlyDomainV2 = getContext("OnlyDomainV2") === "true";
if (!onlyDomainV2) {
  new AwsAgenticRoboticsStack(app, 'AwsAgenticRobotics', {
    stackName: 'aws-agentic-robotics',
    /* If you don't specify 'env', this stack will be environment-agnostic.
     * Account/Region-dependent features and context lookups will not work,
     * but a single synthesized template can be deployed anywhere. */

    /* Uncomment the next line to specialize this stack for the AWS Account
     * and Region that are implied by the current CLI configuration. */
    // env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },

    /* Uncomment the next line if you know exactly what Account and Region you
     * want to deploy the stack to. */
    // env: { account: '123456789012', region: 'us-east-1' },

    /* For more information, see https://docs.aws.amazon.com/cdk/latest/guide/environments.html */
  });
}

if (onlyDomainV2 || getContext("EnableDomainV2") === "true") {
  const { DomainExpansionV2Stack } = require("../lib/domain-expansion-v2-stack") as typeof import("../lib/domain-expansion-v2-stack");
  const requiredContext = (key: string): string => {
    const value = getContext(key);
    if (!value || typeof value !== "string") {
      throw new Error(`Missing required CDK context: ${key}`);
    }
    return value;
  };

  new DomainExpansionV2Stack(app, "DomainExpansionV2", {
    stackName: "domain-expansion-v2",
    env: {
      account: process.env.CDK_DEFAULT_ACCOUNT,
      region: process.env.CDK_DEFAULT_REGION,
    },
    userPoolId: requiredContext("DomainV2UserPoolId"),
    userPoolClientId: requiredContext("DomainV2UserPoolClientId"),
    commentatorRuntimeArn: requiredContext("DomainV2CommentatorRuntimeArn"),
    openClawRuntimeArn: requiredContext("DomainV2OpenClawRuntimeArn"),
    robotApiEndpoint: requiredContext("DomainV2RobotApiEndpoint"),
    robotGatewayUrl: requiredContext("DomainV2RobotGatewayUrl"),
  });
}

app.synth();