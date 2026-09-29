import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminInitiateAuthCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient
} from '@aws-sdk/client-cognito-identity-provider';

const supportedEngines = new Set(['strands_local', 'agentcore_runtime', 'openclaw']);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));

const resolveBaseUrl = async () => {
  for (const key of ['COMMENTARY_BASE_URL', 'PLAYWRIGHT_API_BASE_URL', 'PLAYWRIGHT_BASE_URL']) {
    const configured = process.env[key]?.trim();
    if (configured) return configured;
  }

  const outputPath = process.env.COMMENTARY_CDK_OUTPUT?.trim() ||
    resolve(scriptDirectory, '../../cdk/output-domain-v2.json');
  let output;
  try {
    output = JSON.parse(await readFile(outputPath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read CDK output ${outputPath}`, { cause: error });
  }
  const stackOutput = Object.values(output).find(
    (value) => value && typeof value === 'object' && typeof value.DomainExpansionV2Url === 'string'
  );
  if (!stackOutput) {
    throw new Error(`DomainExpansionV2Url is missing from CDK output ${outputPath}`);
  }
  return stackOutput.DomainExpansionV2Url;
};

const selectedEngines = () => {
  const configured = process.env.COMMENTARY_ENGINES?.split(',').map((value) => value.trim()).filter(Boolean);
  const engines = configured?.length ? configured : [...supportedEngines];
  const invalid = engines.filter((engine) => !supportedEngines.has(engine));
  if (invalid.length) throw new Error(`Unsupported commentary engines: ${invalid.join(', ')}`);
  return engines;
};

const loadCognitoConfig = async (baseUrl) => {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/config.json`, {
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) {
    throw new Error(`Unable to load deployed Cognito config: HTTP ${response.status}`);
  }
  const config = await response.json();
  const region = process.env.COMMENTARY_COGNITO_REGION?.trim() || config.cognitoRegion;
  const userPoolId = process.env.COMMENTARY_USER_POOL_ID?.trim() || config.cognitoUserPoolId;
  const clientId = process.env.COMMENTARY_USER_POOL_CLIENT_ID?.trim() || config.cognitoUserPoolClientId;
  if (!region || !userPoolId || !clientId) {
    throw new Error('Deployed config is missing Cognito region, user pool ID, or client ID');
  }
  return { region, userPoolId, clientId };
};

const createTemporaryAuthentication = async (baseUrl) => {
  const { region, userPoolId, clientId } = await loadCognitoConfig(baseUrl);
  const cognito = new CognitoIdentityProviderClient({ region, maxAttempts: 3 });
  const suffix = `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`;
  const username = `commentary-e2e+${suffix}@example.invalid`;
  const password = `Commentary-${randomBytes(18).toString('base64url')}Aa1!`;
  let created = false;

  try {
    await cognito.send(new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: username,
      MessageAction: 'SUPPRESS',
      UserAttributes: [
        { Name: 'email', Value: username },
        { Name: 'email_verified', Value: 'true' }
      ]
    }));
    created = true;
    await cognito.send(new AdminSetUserPasswordCommand({
      UserPoolId: userPoolId,
      Username: username,
      Password: password,
      Permanent: true
    }));
    const authentication = await cognito.send(new AdminInitiateAuthCommand({
      UserPoolId: userPoolId,
      ClientId: clientId,
      AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
      AuthParameters: {
        USERNAME: username,
        PASSWORD: password
      }
    }));
    const token = authentication.AuthenticationResult?.IdToken;
    if (!token) throw new Error('Cognito did not return an ID token');
    return {
      token,
      cleanup: () => cognito.send(new AdminDeleteUserCommand({
        UserPoolId: userPoolId,
        Username: username
      }))
    };
  } catch (error) {
    if (created) {
      await cognito.send(new AdminDeleteUserCommand({
        UserPoolId: userPoolId,
        Username: username
      }));
    }
    throw error;
  }
};

const invokeCommentary = async ({ baseUrl, token, engine, timeoutMs }) => {
  const sessionId = `aws-commentary-${engine}-${Date.now().toString(36)}`;
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/live-status`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      sessionId,
      roomCode: 'E2ECOMMENT',
      text: `AWS integration test event for ${engine}`,
      eventType: 'INTEGRATION_TEST',
      p1Score: 1,
      p2Score: 0,
      agentImagePolicy: 'never',
      agent_type: engine,
      ttsMode: 'browser',
      lang: 'en'
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const elapsedMs = Math.round(performance.now() - startedAt);
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`${engine} returned HTTP ${response.status} after ${elapsedMs}ms: ${responseText}`);
  }

  let payload;
  try {
    payload = JSON.parse(responseText);
  } catch {
    throw new Error(`${engine} returned non-JSON after ${elapsedMs}ms`);
  }
  if (typeof payload.commentary !== 'string' || !payload.commentary.trim()) {
    throw new Error(`${engine} returned empty commentary after ${elapsedMs}ms`);
  }
  if (payload.debugImageContext?.agentEngine !== engine) {
    throw new Error(`${engine} response reported engine ${payload.debugImageContext?.agentEngine ?? 'missing'}`);
  }
  if (elapsedMs >= timeoutMs) {
    throw new Error(`${engine} exceeded ${timeoutMs}ms`);
  }

  return {
    engine,
    elapsedMs,
    commentary: payload.commentary.replace(/\s+/g, ' ').trim()
  };
};

export const runCommentarySmoke = async () => {
  const baseUrl = await resolveBaseUrl();
  const configuredToken =
    process.env.COMMENTARY_ID_TOKEN?.trim() ||
    process.env.PLAYWRIGHT_COGNITO_ID_TOKEN?.trim();
  const timeoutMs = Number(process.env.COMMENTARY_TIMEOUT_MS ?? 65_000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('COMMENTARY_TIMEOUT_MS must be a positive number');
  }

  const temporaryAuthentication = configuredToken
    ? null
    : await createTemporaryAuthentication(baseUrl);
  const token = configuredToken || temporaryAuthentication.token;
  try {
    const failures = [];
    for (const engine of selectedEngines()) {
      try {
        const result = await invokeCommentary({ baseUrl, token, engine, timeoutMs });
        console.log(`PASS ${result.engine} ${result.elapsedMs}ms: ${result.commentary.slice(0, 120)}`);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
        console.error(`FAIL ${engine}: ${failures.at(-1)}`);
      }
    }
    if (failures.length) {
      throw new Error(`${failures.length} commentary integration test(s) failed`);
    }
  } finally {
    await temporaryAuthentication?.cleanup();
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCommentarySmoke().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
