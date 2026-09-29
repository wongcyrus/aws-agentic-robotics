const supportedEngines = new Set(['strands_local', 'agentcore_runtime', 'openclaw']);

const requiredEnvironment = (name, aliases = []) => {
  for (const key of [name, ...aliases]) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  throw new Error(`${[name, ...aliases].join(' or ')} is required`);
};

const selectedEngines = () => {
  const configured = process.env.COMMENTARY_ENGINES?.split(',').map((value) => value.trim()).filter(Boolean);
  const engines = configured?.length ? configured : [...supportedEngines];
  const invalid = engines.filter((engine) => !supportedEngines.has(engine));
  if (invalid.length) throw new Error(`Unsupported commentary engines: ${invalid.join(', ')}`);
  return engines;
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
  const baseUrl = requiredEnvironment('COMMENTARY_BASE_URL', [
    'PLAYWRIGHT_API_BASE_URL',
    'PLAYWRIGHT_BASE_URL'
  ]);
  const token = requiredEnvironment('COMMENTARY_ID_TOKEN', ['PLAYWRIGHT_COGNITO_ID_TOKEN']);
  const timeoutMs = Number(process.env.COMMENTARY_TIMEOUT_MS ?? 65_000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('COMMENTARY_TIMEOUT_MS must be a positive number');
  }

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
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCommentarySmoke().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
import { pathToFileURL } from 'node:url';
