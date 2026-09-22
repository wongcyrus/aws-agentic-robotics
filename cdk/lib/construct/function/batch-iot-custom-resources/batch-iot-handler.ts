// Use require for AWS SDK v3 (available in Lambda runtime)
const {
  IoTClient,
  CreateThingCommand,
  DeleteThingCommand,
  CreateKeysAndCertificateCommand,
  DeleteCertificateCommand,
  UpdateCertificateCommand,
  CreatePolicyCommand,
  DeletePolicyCommand,
  AttachPrincipalPolicyCommand,
  DetachPrincipalPolicyCommand,
  AttachThingPrincipalCommand,
  DetachThingPrincipalCommand,
  ListThingPrincipalsCommand,
} = require("@aws-sdk/client-iot");
const {
  SSMClient,
  PutParameterCommand,
  DeleteParameterCommand,
} = require("@aws-sdk/client-ssm");
const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");

interface ThingResult {
  thingName: string;
  thingArn: string;
  certId: string;
  certPem: string;
  privKey: string;
  certS3Path?: string;
  privKeyS3Path?: string;
}

const iotClient = new IoTClient({});
const ssmClient = new SSMClient({});
const s3Client = new S3Client({});

const PARAM_PREFIX = process.env.PARAM_PREFIX || "iot/things";
const SAVE_TO_PARAM_STORE = process.env.SAVE_TO_PARAM_STORE === "true";
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || "";
const SAVE_TO_S3 = process.env.SAVE_TO_S3 === "true";

export async function handler(event: any): Promise<any> {
  console.log("Event:", JSON.stringify(event, null, 2));

  const { RequestType, LogicalResourceId, RequestId, StackId } = event;
  const thingNames: string[] = event.ResourceProperties.ThingNames;

  try {
    if (RequestType === "Create") {
      const results = await createThings(thingNames);
      console.log("Create operation completed, formatting results...");
      const formattedData = formatResults(results, thingNames);
      console.log("Formatted data:", JSON.stringify(formattedData, null, 2));
      return {
        Status: "SUCCESS",
        PhysicalResourceId: `batch-iot-things-${Date.now()}`,
        LogicalResourceId,
        RequestId,
        StackId,
        Data: formattedData,
      };
    } else if (RequestType === "Delete") {
      await deleteThings(thingNames);
      return {
        Status: "SUCCESS",
        PhysicalResourceId: event.PhysicalResourceId,
        LogicalResourceId,
        RequestId,
        StackId,
      };
    } else if (RequestType === "Update") {
      // For updates, we'll recreate everything
      // First delete old things (if they exist)
      const oldThingNames: string[] =
        event.OldResourceProperties?.ThingNames || [];
      if (oldThingNames.length > 0) {
        await deleteThings(oldThingNames);
      }

      // Then create new ones
      const results = await createThings(thingNames);
      console.log("Update operation completed, formatting results...");
      const formattedData = formatResults(results, thingNames);
      console.log("Formatted data:", JSON.stringify(formattedData, null, 2));
      return {
        Status: "SUCCESS",
        PhysicalResourceId: event.PhysicalResourceId,
        LogicalResourceId,
        RequestId,
        StackId,
        Data: formattedData,
      };
    } else {
      throw new Error("Invalid request type");
    }
  } catch (error) {
    console.error("Error:", error);
    return {
      Status: "FAILED",
      Reason: error instanceof Error ? error.message : "Unknown error",
      PhysicalResourceId: event.PhysicalResourceId || LogicalResourceId,
      LogicalResourceId,
      RequestId,
      StackId,
    };
  }
}

async function createThings(thingNames: string[]): Promise<ThingResult[]> {
  const results: ThingResult[] = [];
  const errors: string[] = [];

  console.log(`Creating ${thingNames.length} IoT things...`);

  for (const thingName of thingNames) {
    console.log(`Creating thing: ${thingName}`);

    try {
      // Create the IoT thing
      const createThingResponse = await iotClient.send(
        new CreateThingCommand({
          thingName,
        })
      );

      // Create keys and certificate
      const createCertResponse = await iotClient.send(
        new CreateKeysAndCertificateCommand({
          setAsActive: true,
        })
      );

      if (
        !createCertResponse.certificateId ||
        !createCertResponse.certificatePem ||
        !createCertResponse.keyPair?.PrivateKey
      ) {
        throw new Error(`Failed to create certificate for ${thingName}`);
      }

      // Create IoT policy for this thing
      const policyDocument = {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["iot:Connect"],
            Resource: [`arn:aws:iot:*:*:client/${thingName}`],
          },
          {
            Effect: "Allow",
            Action: ["iot:Publish", "iot:Subscribe"],
            Resource: [`arn:aws:iot:*:*:topic/${thingName}/*`],
          },
          {
            Effect: "Allow",
            Action: ["iot:Receive"],
            Resource: [`arn:aws:iot:*:*:topic/${thingName}/*`],
          },
        ],
      };

      await iotClient.send(
        new CreatePolicyCommand({
          policyName: thingName,
          policyDocument: JSON.stringify(policyDocument),
        })
      );

      // Attach policy to certificate
      await iotClient.send(
        new AttachPrincipalPolicyCommand({
          policyName: thingName,
          principal: createCertResponse.certificateArn!,
        })
      );

      // Attach certificate to thing
      await iotClient.send(
        new AttachThingPrincipalCommand({
          thingName,
          principal: createCertResponse.certificateArn!,
        })
      );

      const result: ThingResult = {
        thingName,
        thingArn: createThingResponse.thingArn!,
        certId: createCertResponse.certificateId,
        certPem: createCertResponse.certificatePem,
        privKey: createCertResponse.keyPair.PrivateKey,
      };

      // Save to SSM if enabled
      if (SAVE_TO_PARAM_STORE) {
        await saveCertificateToSSM(result);
      }

      // Save to S3 if enabled
      if (SAVE_TO_S3 && S3_BUCKET_NAME) {
        await saveCertificateToS3(result);
      }

      results.push(result);
      console.log(`Successfully created thing: ${thingName}`);
    } catch (error) {
      const errorMsg = `Failed to create thing ${thingName}: ${
        error instanceof Error ? error.message : "Unknown error"
      }`;
      console.error(errorMsg);
      errors.push(errorMsg);

      // Clean up any partial resources for this thing
      try {
        await cleanupThingResources(thingName);
      } catch (cleanupError) {
        console.error(
          `Failed to cleanup resources for ${thingName}:`,
          cleanupError
        );
      }

      // Continue with next thing instead of failing the entire batch
    }
  }

  console.log(
    `Batch creation completed: ${results.length}/${thingNames.length} successful`
  );

  // If no things were created successfully, we should fail
  if (results.length === 0) {
    throw new Error(
      `Failed to create any IoT things. Errors: ${errors.join("; ")}`
    );
  }

  // If some failed, log warnings but continue
  if (errors.length > 0) {
    console.warn(`Some things failed to create: ${errors.join("; ")}`);
  }

  return results;
}

async function deleteThings(thingNames: string[]): Promise<void> {
  console.log(`Deleting ${thingNames.length} IoT things...`);

  for (const thingName of thingNames) {
    console.log(`Deleting thing: ${thingName}`);
    try {
      await cleanupThingResources(thingName);
      console.log(`Successfully deleted thing: ${thingName}`);
    } catch (error) {
      console.error(`Error deleting thing ${thingName}:`, error);
      // Continue with other deletions even if one fails
    }
  }
}

async function cleanupThingResources(thingName: string): Promise<void> {
  try {
    // List and detach principals
    const principalsResponse = await iotClient.send(
      new ListThingPrincipalsCommand({ thingName })
    );

    if (principalsResponse.principals) {
      for (const principal of principalsResponse.principals) {
        try {
          // Detach policy from principal
          await iotClient.send(
            new DetachPrincipalPolicyCommand({
              policyName: thingName,
              principal,
            })
          );

          // Detach principal from thing
          await iotClient.send(
            new DetachThingPrincipalCommand({
              thingName,
              principal,
            })
          );

          // Extract certificate ID from ARN
          const certId = principal.split("/")[1];

          // Deactivate and delete certificate
          await iotClient.send(
            new UpdateCertificateCommand({
              certificateId: certId,
              newStatus: "INACTIVE",
            })
          );

          await iotClient.send(
            new DeleteCertificateCommand({
              certificateId: certId,
            })
          );
        } catch (error) {
          console.error(`Error cleaning up principal ${principal}:`, error);
        }
      }
    }

    // Delete the policy
    try {
      await iotClient.send(new DeletePolicyCommand({ policyName: thingName }));
    } catch (error) {
      console.error(`Error deleting policy ${thingName}:`, error);
    }

    // Delete the thing
    try {
      await iotClient.send(new DeleteThingCommand({ thingName }));
    } catch (error) {
      console.error(`Error deleting thing ${thingName}:`, error);
    }

    // Delete SSM parameters if they exist
    if (SAVE_TO_PARAM_STORE) {
      try {
        await ssmClient.send(
          new DeleteParameterCommand({
            Name: `/${PARAM_PREFIX}/${thingName}/certPem`,
          })
        );
      } catch {
        // Parameter might not exist, continue
      }

      try {
        await ssmClient.send(
          new DeleteParameterCommand({
            Name: `/${PARAM_PREFIX}/${thingName}/privKey`,
          })
        );
      } catch {
        // Parameter might not exist, continue
      }
    }

    // Delete S3 objects if they exist
    if (SAVE_TO_S3 && S3_BUCKET_NAME) {
      try {
        const certS3Path = `iot-certificates/${thingName}/${thingName}.cert.pem`;
        const privKeyS3Path = `iot-certificates/${thingName}/${thingName}.private.key`;

        await Promise.all([
          s3Client.send(
            new DeleteObjectCommand({
              Bucket: S3_BUCKET_NAME,
              Key: certS3Path,
            })
          ),
          s3Client.send(
            new DeleteObjectCommand({
              Bucket: S3_BUCKET_NAME,
              Key: privKeyS3Path,
            })
          ),
        ]);

        console.log(`Deleted S3 objects: ${certS3Path}, ${privKeyS3Path}`);
      } catch (error) {
        console.error(`Error deleting S3 objects for ${thingName}:`, error);
        // Continue with cleanup even if S3 deletion fails
      }
    }
  } catch (error) {
    console.error(`Error in cleanup for ${thingName}:`, error);
    throw error;
  }
}

async function saveCertificateToSSM(result: ThingResult): Promise<void> {
  const basePath = `/${PARAM_PREFIX}/${result.thingName}`;

  await Promise.all([
    ssmClient.send(
      new PutParameterCommand({
        Name: `${basePath}/certPem`,
        Value: result.certPem,
        Type: "String",
        Description: `IoT certificate PEM for ${result.thingName}`,
        Overwrite: true,
      })
    ),
    ssmClient.send(
      new PutParameterCommand({
        Name: `${basePath}/privKey`,
        Value: result.privKey,
        Type: "String",
        Description: `IoT private key for ${result.thingName}`,
        Overwrite: true,
      })
    ),
  ]);
}

async function saveCertificateToS3(result: ThingResult): Promise<void> {
  if (!S3_BUCKET_NAME) {
    throw new Error("S3_BUCKET_NAME environment variable is not set");
  }

  const certS3Path = `iot-certificates/${result.thingName}/${result.thingName}.cert.pem`;
  const privKeyS3Path = `iot-certificates/${result.thingName}/${result.thingName}.private.key`;

  await Promise.all([
    s3Client.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET_NAME,
        Key: certS3Path,
        Body: result.certPem,
        ContentType: "application/x-pem-file",
        Metadata: {
          thingName: result.thingName,
          certId: result.certId,
        },
      })
    ),
    s3Client.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET_NAME,
        Key: privKeyS3Path,
        Body: result.privKey,
        ContentType: "application/x-pem-file",
        Metadata: {
          thingName: result.thingName,
          certId: result.certId,
        },
      })
    ),
  ]);

  // Update the result with S3 paths
  result.certS3Path = certS3Path;
  result.privKeyS3Path = privKeyS3Path;

  console.log(`Saved certificates to S3: ${certS3Path}, ${privKeyS3Path}`);
}

function formatResults(
  results: ThingResult[],
  allThingNames: string[]
): Record<string, any> {
  const data: Record<string, any> = {};

  // Add summary information only
  data["TotalThings"] = allThingNames.length;
  data["SuccessfulThings"] = results.length;
  data["FailedThings"] = allThingNames.length - results.length;

  // Store successful thing names as a comma-separated string to save space
  data["SuccessfulThingNames"] = results.map((r) => r.thingName).join(",");

  // Add S3 storage information if enabled
  if (SAVE_TO_S3 && S3_BUCKET_NAME) {
    data["CertificatesStoredInS3"] = "true";
    data["S3Bucket"] = S3_BUCKET_NAME;
    data["S3Prefix"] = "iot-certificates/";
  }

  // Add SSM storage information if enabled
  if (SAVE_TO_PARAM_STORE) {
    data["CertificatesStoredInSSM"] = "true";
    data["SSMPrefix"] = `/${PARAM_PREFIX}/`;
  }

  console.log(
    `Formatted minimal results for ${allThingNames.length} things (${results.length} successful)`
  );
  console.log("Response data size:", JSON.stringify(data).length, "characters");
  return data;
}
