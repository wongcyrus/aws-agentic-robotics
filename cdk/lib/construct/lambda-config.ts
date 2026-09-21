import * as os from "os";
import * as path from "path";
import { DockerImage, RemovalPolicy } from "aws-cdk-lib";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import { BundlingOptions } from "@aws-cdk/aws-lambda-python-alpha";
import { Construct } from "constructs";

/**
 * Single source of truth for the Python Runtime across all Lambdas.
 * Changing this single line will safely update the compiler version,
 * the SAM build Docker image, and partition the pip cache directories!
 */
export const SHARED_PYTHON_RUNTIME = Runtime.PYTHON_3_12;

export function createDestroyableLambdaLogGroup(
  scope: Construct,
  id: string
): logs.LogGroup {
  return new logs.LogGroup(scope, id, {
    retention: logs.RetentionDays.THREE_DAYS,
    removalPolicy: RemovalPolicy.DESTROY,
  });
}

// Dynamically extract version name (e.g. "python3.12" or "python3.13")
const pythonVersionName = SHARED_PYTHON_RUNTIME.name;

// Partition the host pip cache by Python version to prevent cross-version conflicts
const hostCachePath = path.join(os.homedir(), ".cache", "pip", pythonVersionName);

// Dynamically target the corresponding AWS SAM build image
const samDockerImageUri = `public.ecr.aws/sam/build-${pythonVersionName}`;

/**
 * Shared Python bundling options with partitioned pip cache mount.
 */
export const SHARED_PYTHON_BUNDLING: BundlingOptions = {
  assetExcludes: [".venv", "__pycache__", "tests"],
  image: DockerImage.fromRegistry(samDockerImageUri),
  volumes: [
    {
      hostPath: hostCachePath,
      containerPath: "/cache",
    }
  ],
  environment: {
    PIP_CACHE_DIR: "/cache",
  }
};
