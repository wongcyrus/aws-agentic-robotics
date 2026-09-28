import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { InvokeCommand, LambdaClient, ListFunctionsCommand } from '@aws-sdk/client-lambda';
import { PollyClient, SynthesizeSpeechCommand } from '@aws-sdk/client-polly';
import { createServer as createViteServer } from 'vite';
import { WebSocketServer } from 'ws';

const port = Number(process.env.PORT || 5173);
const e2eTestMode = process.env.E2E_TEST_MODE === '1';
const bedrockRegion = process.env.BEDROCK_REGION || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const bedrockModelId = process.env.BEDROCK_MODEL_ID || 'global.moonshotai.kimi-k3';
const commentaryMaxTokens = Number(process.env.COMMENTARY_MAX_TOKENS || (bedrockModelId.includes('kimi') ? 1600 : 400));
const pollyRegion = process.env.POLLY_REGION || bedrockRegion;
const bedrock = new BedrockRuntimeClient({
  region: bedrockRegion,
  maxAttempts: 5,
  retryMode: 'adaptive'
});
const polly = new PollyClient({
  region: pollyRegion,
  maxAttempts: 1,
  retryMode: 'adaptive'
});
const lambda = new LambdaClient({
  region: bedrockRegion,
  maxAttempts: 3,
  retryMode: 'adaptive'
});
let commentaryLambdaName = process.env.LOCAL_COMMENTARY_LAMBDA || '';
let directPollyUnavailableUntil = 0;
const explicitCert = process.env.VITE_HTTPS_CERT;
const explicitKey = process.env.VITE_HTTPS_KEY;
if (Boolean(explicitCert) !== Boolean(explicitKey)) {
  throw new Error('VITE_HTTPS_CERT and VITE_HTTPS_KEY must be provided together');
}
const automaticTlsCandidates = process.env.E2E_TEST_MODE === '1' ? [] : [
  [resolve('cert.pem'), resolve('key.pem')],
  [resolve('../domain-expansion-ar-game/cert.pem'), resolve('../domain-expansion-ar-game/key.pem')]
];
const tlsFiles = explicitCert && explicitKey
  ? [resolve(explicitCert), resolve(explicitKey)]
  : automaticTlsCandidates.find(([cert, key]) => existsSync(cert) && existsSync(key));
const tls = tlsFiles
  ? { cert: readFileSync(tlsFiles[0]), key: readFileSync(tlsFiles[1]) }
  : null;
const server = tls ? createHttpsServer(tls) : createHttpServer();
const vite = await createViteServer({
  server: {
    middlewareMode: true,
    hmr: { server }
  },
  appType: 'mpa'
});
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(
    request.url ?? '/',
    `http://${request.headers.host ?? 'localhost'}`
  ).pathname;
  if (pathname !== '/control') return;
  wss.handleUpgrade(request, socket, head, (webSocket) => {
    wss.emit('connection', webSocket, request);
  });
});
const clients = new Map(), rooms = new Map(), snapshots = new Map();
const json = (response, status, body) => {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
};
const readJson = (request) => new Promise((resolveBody, reject) => {
  let body = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => {
    body += chunk;
    if (body.length > 10_000_000) reject(new Error('Request body exceeds 10 MB'));
  });
  request.on('end', () => {
    try { resolveBody(body ? JSON.parse(body) : {}); } catch (error) { reject(error); }
  });
  request.on('error', reject);
});
const score = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
const snapshotPhaseForCommentary = (body, path) => {
  if (path === '/api/battle-result') return 'END';
  if (body.isReset || body.eventType === 'RESET') return 'START';
  return null;
};
const shouldAttachCommentaryImages = (body, path) => {
  const policy = body.agentImagePolicy || 'always';
  return policy === 'always' || Boolean(policy === 'start_end' && snapshotPhaseForCommentary(body, path));
};
const parseImageDataUrl = (image) => {
  if (typeof image !== 'string') return null;
  const match = /^data:image\/(jpeg|jpg|png|gif|webp);base64,(.+)$/i.exec(image);
  if (!match) return null;
  return {
    format: match[1].toLowerCase() === 'jpg' ? 'jpeg' : match[1].toLowerCase(),
    bytes: Buffer.from(match[2], 'base64')
  };
};
const commentarySnapshots = async (body, path) => {
  if (!shouldAttachCommentaryImages(body, path) || !body.sessionId) return [];
  const preferredPhase = snapshotPhaseForCommentary(body, path);
  const findSnapshots = () => ['player1', 'player2'].flatMap((role) => {
    const image = preferredPhase
      ? snapshots.get(`${body.sessionId}:${role}:${preferredPhase}`)
      : snapshots.get(`${body.sessionId}:${role}:END`) ?? snapshots.get(`${body.sessionId}:${role}:START`);
    const parsed = parseImageDataUrl(image);
    return parsed ? [{ role, image, ...parsed }] : [];
  });
  let found = findSnapshots();
  if (preferredPhase) {
    for (let attempt = 0; attempt < 10 && found.length < 2; attempt += 1) {
      await delay(300);
      found = findSnapshots();
    }
  }
  return found;
};
const pollyVoices = {
  'zh-HK': { voiceId: 'Hiujin', engine: 'neural', languageCode: 'yue-CN' },
  'zh-TW': { voiceId: 'Zhiyu', engine: 'neural', languageCode: 'cmn-CN' },
  en: { voiceId: 'Joanna', engine: 'neural', languageCode: 'en-US' },
  ja: { voiceId: 'Mizuki', engine: 'standard', languageCode: 'ja-JP' }
};
const pollyVoice = (language) => {
  if (language === 'zh-HK' || language === 'zh-TW' || language === 'ja') return pollyVoices[language];
  return pollyVoices.en;
};
const plainSpeechText = (text) => text
  .replace(/<[^>]*>/g, ' ')
  .replace(/[*_`#>~]/g, '')
  .replace(/\s+/g, ' ')
  .trim();
const synthesizePollyAudio = async (text, language) => {
  if (Date.now() < directPollyUnavailableUntil) {
    throw new Error('Direct Polly is temporarily unavailable');
  }
  const voice = pollyVoice(language);
  const synthesize = (engine) => polly.send(new SynthesizeSpeechCommand({
    Text: plainSpeechText(text),
    OutputFormat: 'mp3',
    VoiceId: voice.voiceId,
    Engine: engine,
    LanguageCode: voice.languageCode
  }));
  let result;
  try {
    result = await synthesize(voice.engine);
  } catch (error) {
    if (voice.engine === 'standard') {
      directPollyUnavailableUntil = Date.now() + 5 * 60_000;
      throw error;
    }
    console.warn(`Polly neural synthesis failed for ${voice.voiceId}; retrying standard`, error);
    try {
      result = await synthesize('standard');
    } catch (standardError) {
      directPollyUnavailableUntil = Date.now() + 5 * 60_000;
      throw standardError;
    }
  }
  const bytes = await result.AudioStream?.transformToByteArray();
  if (!bytes?.length) {
    directPollyUnavailableUntil = Date.now() + 5 * 60_000;
    throw new Error('Polly returned an empty audio stream');
  }
  return {
    audioUrl: `data:audio/mpeg;base64,${Buffer.from(bytes).toString('base64')}`,
    voiceId: voice.voiceId,
    ttsMode: 'aws'
  };
};
const resolveCommentaryLambda = async () => {
  if (commentaryLambdaName) return commentaryLambdaName;
  let marker;
  do {
    const page = await lambda.send(new ListFunctionsCommand({ Marker: marker, MaxItems: 50 }));
    const match = page.Functions?.find(({ FunctionName }) =>
      FunctionName?.includes('DomainExpansionV2BackendFuncti')
    );
    if (match?.FunctionName) {
      commentaryLambdaName = match.FunctionName;
      return commentaryLambdaName;
    }
    marker = page.NextMarker;
  } while (marker);
  throw new Error('Unable to find the deployed Domain Expansion V2 backend Lambda');
};
const invokeLambdaHttp = async (functionName, path, body) => {
  const event = {
    path,
    httpMethod: 'POST',
    body: JSON.stringify(body)
  };
  const result = await lambda.send(new InvokeCommand({
    FunctionName: functionName,
    InvocationType: 'RequestResponse',
    Payload: Buffer.from(JSON.stringify(event))
  }));
  if (result.FunctionError) throw new Error(`Deployed commentary Lambda failed: ${result.FunctionError}`);
  const lambdaResponse = JSON.parse(Buffer.from(result.Payload ?? []).toString('utf8'));
  const responseBody = JSON.parse(lambdaResponse.body || '{}');
  if (lambdaResponse.statusCode < 200 || lambdaResponse.statusCode >= 300) {
    throw new Error(responseBody.message || responseBody.error || `Lambda returned ${lambdaResponse.statusCode}`);
  }
  return responseBody;
};
const invokeDeployedCommentary = async (body, path) => {
  const functionName = await resolveCommentaryLambda();
  const attachedSnapshots = await commentarySnapshots(body, path);
  await Promise.all(attachedSnapshots.map(({ role, image }) =>
    invokeLambdaHttp(functionName, '/api/webcam-upload', {
      sessionId: body.sessionId,
      role,
      image
    })
  ));
  const responseBody = await invokeLambdaHttp(functionName, path, {
    ...body,
    agent_type: 'local_direct',
    agentImagePolicy: attachedSnapshots.length ? 'always' : 'never',
    ttsMode: 'aws'
  });
  if (responseBody.ttsMode !== 'aws' || !responseBody.audioUrl) {
    throw new Error('Deployed commentary Lambda did not return Polly audio');
  }
  return responseBody;
};
const invokeDeployedTts = async (body, commentary) => {
  const functionName = await resolveCommentaryLambda();
  const responseBody = await invokeLambdaHttp(functionName, '/api/live-status', {
    ...body,
    agent_type: 'local_tts',
    agentImagePolicy: 'never',
    commentaryText: commentary,
    ttsMode: 'aws'
  });
  if (responseBody.ttsMode !== 'aws' || !responseBody.audioUrl) {
    throw new Error('Deployed commentary Lambda did not return Polly audio');
  }
  return responseBody;
};
const buildCommentaryPrompt = (body, path) => {
  const language = typeof body.lang === 'string' ? body.lang : 'en';
  const languageRule = {
    'zh-HK': 'Respond in energetic Hong Kong Cantonese using Traditional Chinese, with occasional English or Japanese JJK terms.',
    'zh-TW': 'Respond in energetic Taiwan Traditional Chinese. Do not use Simplified Chinese.',
    ja: 'Respond in natural, energetic Japanese with standard JJK terms.',
    en: 'Respond in natural, energetic English.'
  }[language] || 'Respond in natural, energetic English.';
  const cleanLanguageRule = body.foulLanguage
    ? 'Sharp competitive trash-talk is allowed, but do not target protected characteristics.'
    : 'Keep all language clean, family-friendly, and free of profanity or abusive insults.';
  const eventText = typeof body.text === 'string'
    ? body.text
    : typeof body.detail === 'string'
      ? body.detail
      : typeof body.eventType === 'string'
        ? body.eventType
        : '';
  let event;
  if (path === '/api/battle-result') {
    event = `Conclude the battle. Player 1 scored ${score(body.p1Score)} and Player 2 scored ${score(body.p2Score)}. Latest event: ${eventText || 'battle completed'}. Clearly announce the winner or draw.`;
  } else if (body.isReset || body.eventType === 'RESET') {
    event = `Introduce the competitors starting a duel in room ${String(body.roomCode || 'BTL1').slice(0, 24)}. Build excitement before the countdown.`;
  } else {
    event = `React to this live battle event: ${eventText || 'the battle continues'}. Current score is Player 1 ${score(body.p1Score)}, Player 2 ${score(body.p2Score)}.`;
  }
  return `${event}\n${languageRule}\n${cleanLanguageRule}\nOutput only Kugisaki Nobara's direct, high-energy commentary in no more than two short sentences.`;
};
const generateCommentary = async (body, path) => {
  const attachedSnapshots = await commentarySnapshots(body, path);
  const content = attachedSnapshots.flatMap(({ role, format, bytes }) => [
    { text: `${role === 'player1' ? 'Player 1' : 'Player 2'} webcam snapshot:` },
    { image: { format, source: { bytes } } }
  ]);
  content.push({ text: buildCommentaryPrompt(body, path) });
  const result = await bedrock.send(new ConverseCommand({
    modelId: bedrockModelId,
    system: [{
      text: 'You are Kugisaki Nobara acting as a confident, fashionable Jujutsu Kaisen battle commentator. Be punchy, dramatic, and specific to the supplied event. Never include analysis, labels, or preamble.'
    }],
    messages: [{ role: 'user', content }],
    inferenceConfig: { maxTokens: commentaryMaxTokens }
  }));
  if (result.stopReason === 'max_tokens') throw new Error(`Bedrock commentary reached ${commentaryMaxTokens} output tokens`);
  const commentary = result.output?.message?.content
    ?.find((block) => typeof block.text === 'string')
    ?.text?.trim();
  if (!commentary) throw new Error('Bedrock response did not contain commentary text');
  const response = {
    commentary,
    ttsMode: 'browser',
    requestedTtsMode: body.ttsMode === 'aws' ? 'aws' : 'browser',
    debugImageContext: {
      shouldAttachImage: shouldAttachCommentaryImages(body, path),
      hasImageP1: attachedSnapshots.some(({ role }) => role === 'player1'),
      hasImageP2: attachedSnapshots.some(({ role }) => role === 'player2'),
      phase: snapshotPhaseForCommentary(body, path)
    }
  };
  if (body.ttsMode !== 'aws') return response;
  try {
    return { ...response, ...await synthesizePollyAudio(commentary, body.lang) };
  } catch (directError) {
    console.warn('Direct local Polly synthesis failed; trying deployed Lambda', directError);
    try {
      return await invokeDeployedTts(body, commentary);
    } catch (lambdaError) {
      console.error('Deployed Polly fallback failed', lambdaError);
      const directName = directError instanceof Error && directError.name ? directError.name : 'PollyError';
      const lambdaName = lambdaError instanceof Error && lambdaError.name ? lambdaError.name : 'LambdaError';
      return {
        ...response,
        ttsError: `Amazon Polly failed locally (${directName}) and through Lambda (${lambdaName}); using browser speech.`
      };
    }
  }
};
const handleApi = async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (!url.pathname.startsWith('/api/')) return false;
  try {
    if (request.method === 'POST' && url.pathname === '/api/webcam-upload') {
      const { sessionId, role, phase, image } = await readJson(request);
      if (!sessionId || !['player1', 'player2'].includes(role) || !['START', 'END'].includes(phase) ||
          typeof image !== 'string' || !image.startsWith('data:image/')) {
        json(response, 400, { success: false, message: 'Invalid snapshot payload' });
        return true;
      }
      snapshots.set(`${sessionId}:${role}:${phase}`, image);
      json(response, 200, { success: true });
      return true;
    }
    if (request.method === 'GET' && url.pathname === '/api/get-snapshot') {
      const sessionId = url.searchParams.get('sessionId');
      const role = url.searchParams.get('role');
      if (!sessionId || !['player1', 'player2'].includes(role ?? '')) {
        json(response, 400, { success: false, message: 'Invalid snapshot request' });
        return true;
      }
      const image = snapshots.get(`${sessionId}:${role}:END`) ?? snapshots.get(`${sessionId}:${role}:START`);
      json(response, 200, image
        ? { success: true, image }
        : { success: false, message: 'Snapshot not available yet' });
      return true;
    }
    if (request.method === 'POST' && ['/api/register-room', '/api/trigger-technique'].includes(url.pathname)) {
      await readJson(request);
      json(response, 200, { success: true });
      return true;
    }
    if (request.method === 'POST' && ['/api/live-status', '/api/battle-result'].includes(url.pathname)) {
      const body = await readJson(request);
      if (e2eTestMode) {
        json(response, 200, { commentary: 'Commentary is ready.', ttsMode: 'browser' });
        return true;
      }
      try {
        json(response, 200, await generateCommentary(body, url.pathname));
      } catch (localError) {
        console.warn('Local Bedrock commentary failed; trying deployed Lambda', localError);
        try {
          json(response, 200, await invokeDeployedCommentary(body, url.pathname));
        } catch (lambdaError) {
          console.error('Deployed commentary fallback failed', lambdaError);
          const localName = localError instanceof Error && localError.name ? localError.name : 'BedrockError';
          const lambdaName = lambdaError instanceof Error && lambdaError.name ? lambdaError.name : 'LambdaError';
          json(response, 502, {
            success: false,
            message: `Local AI commentary failed through Bedrock (${localName}) and Lambda (${lambdaName}). Check AWS credentials and model access.`
          });
        }
      }
      return true;
    }
    json(response, 404, { success: false, message: 'Unknown local API route' });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Local API request failed';
    json(response, message.includes('10 MB') ? 413 : 400, { success: false, message });
    return true;
  }
};
server.on('request', (request, response) => {
  void handleApi(request, response).then((handled) => {
    if (!handled) vite.middlewares(request, response);
  }).catch((error) => {
    console.error('Local API handler failed', error);
    if (!response.headersSent) json(response, 500, { success: false, message: 'Local API handler failed' });
  });
});
const techniques = [
  'Unlimited Void', 'Malevolent Shrine', 'Self-Embodiment of Perfection', 'Authentic Mutual Love',
  'Idle Death Gamble', 'Yuji Itadori', 'Chimera Shadow Garden', 'Time Cell Moon Palace',
  'Lapse Blue', 'Reversal Red', 'Hollow Purple'
];
let e2eShuffleIndex = 0;
const id = (prefix) => `${prefix}_${crypto.randomUUID()}`;
const emptyPlayer = () => ({ connected: false, clientId: null, score: 0, attempted: 0, finished: false, challenge: null });
const newState = (roomId) => ({
  protocolVersion: '2.0', roomId, matchId: null, revision: 0, phase: 'idle',
  config: {
    difficultySeconds: 8,
    challengeCount: 11,
    countdownSeconds: 3,
    scoreGraceMs: 1000,
    synchronizedGestures: false,
    captureSnapshots: true
  },
  players: { player1: emptyPlayer(), player2: emptyPlayer() },
  challengeLists: { player1: [], player2: [] },
  controllerClientId: null,
  countdownEndsAt: null, resolution: null, cinematic: null, winner: null, pendingWinner: null,
  processedCommands: new Set(), updatedAt: Date.now()
});
const roomState = (roomId) => {
  if (!rooms.has(roomId)) rooms.set(roomId, newState(roomId));
  return rooms.get(roomId);
};
const send = (client, message) => client.ws.readyState === 1 && client.ws.send(JSON.stringify(message));
const roomClients = (roomId) => [...clients.values()].filter((client) => client.roomId === roomId);
const publicState = (state) => {
  const { challengeLists, controllerClientId, processedCommands, ...result } = state;
  return result;
};
const envelope = (state, messageType, payload, correlationId) => ({
  protocolVersion: '2.0', messageId: id('event'), messageType, roomId: state.roomId,
  matchId: state.matchId, revision: state.revision, sentAt: Date.now(),
  ...(correlationId ? { correlationId } : {}), payload
});
const publish = (state, correlationId) => {
  state.revision += 1; state.updatedAt = Date.now();
  const message = envelope(state, 'room.snapshot', { state: publicState(state) }, correlationId);
  roomClients(state.roomId).forEach((client) => send(client, message));
};
const shuffle = () => {
  if (!e2eTestMode) return [...techniques].sort(() => Math.random() - .5);
  const first = e2eShuffleIndex++ % 2 === 0 ? 'Lapse Blue' : 'Reversal Red';
  const second = first === 'Lapse Blue' ? 'Reversal Red' : 'Lapse Blue';
  return Array.from({ length: techniques.length }, (_, index) => index % 2 === 0 ? first : second);
};
const assignChallenge = (state, role) => {
  const player = state.players[role];
  if (player.attempted >= state.config.challengeCount) {
    player.finished = true; player.challenge = null; return;
  }
  player.challenge = {
    challengeId: id('challenge'), technique: state.challengeLists[role][player.attempted],
    startedAt: Date.now(), deadlineAt: Date.now() + state.config.difficultySeconds * 1000, pausedRemainingMs: null
  };
};
const evaluateWinner = (state) => {
  const { player1, player2 } = state.players, count = state.config.challengeCount;
  player1.finished = player1.attempted >= count; player2.finished = player2.attempted >= count;
  if (!player1.finished || !player2.finished) return null;
  return player1.score === player2.score ? 'DRAW' : player1.score > player2.score ? 'PLAYER 1' : 'PLAYER 2';
};
const pauseChallenges = (state) => Object.values(state.players).forEach((player) => {
  if (player.challenge) {
    player.challenge.pausedRemainingMs = Math.max(0, player.challenge.deadlineAt - Date.now());
    player.challenge.deadlineAt = null;
  }
});
const resumeChallenges = (state) => Object.entries(state.players).forEach(([role, player]) => {
  if (player.challenge) {
    player.challenge.deadlineAt = Date.now() + (player.challenge.pausedRemainingMs ?? state.config.difficultySeconds * 1000);
    player.challenge.pausedRemainingMs = null;
  } else if (!player.finished) assignChallenge(state, role);
});

wss.on('connection', (ws) => {
  const connectionId = id('connection');
  const client = { connectionId, clientId: null, ws, role: null, roomId: null };
  clients.set(connectionId, client);
  ws.on('message', (raw) => {
    let message;
    try { message = JSON.parse(String(raw)); } catch { return; }
    if (message.action === 'ping') return;
    if (message.action === 'join') {
      client.roomId = String(message.roomId || 'BTL1').toUpperCase();
      client.role = message.role; client.clientId = message.clientId;
      const state = roomState(client.roomId);
      if (client.role === 'player1' || client.role === 'player2') {
        Object.assign(state.players[client.role], { connected: true, clientId: client.clientId });
      }
      return publish(state);
    }
    if (!client.roomId) return;
    const state = roomState(client.roomId);
    if (message.action === 'signal') {
      const outbound = envelope(state, `webrtc.${message.signalType}`, {
        from: client.clientId, role: client.role, data: message.payload ?? {}
      });
      roomClients(client.roomId).filter((target) => target.connectionId !== connectionId && (!message.to || target.clientId === message.to)).forEach((target) => send(target, outbound));
      return;
    }
    if (message.action !== 'command' || message.envelope?.protocolVersion !== '2.0') return;
    const command = message.envelope;
    if (state.processedCommands.has(command.messageId)) {
      return send(client, envelope(state, 'command.acknowledged', { duplicate: true }, command.messageId));
    }
    state.processedCommands.add(command.messageId);
    const payload = command.payload ?? {};
    if (command.messageType === 'match.start' && client.role === 'viewer') {
      const revision = state.revision;
      const currentConnections = Object.fromEntries(Object.entries(state.players).map(([role, player]) => [role, { connected: player.connected, clientId: player.clientId }]));
      const config = payload.config ?? {};
      Object.assign(state, newState(state.roomId));
      state.revision = revision;
      state.players.player1 = { ...emptyPlayer(), ...currentConnections.player1 };
      state.players.player2 = { ...emptyPlayer(), ...currentConnections.player2 };
      state.matchId = id('match'); state.phase = 'preparing'; state.controllerClientId = client.clientId;
      state.config = {
        difficultySeconds: Math.max(1, Math.min(120, Number(config.difficultySeconds) || 8)),
        challengeCount: Math.max(1, Math.min(100, Number(config.challengeCount) || 11)),
        countdownSeconds: Math.max(0, Math.min(30, Number(config.countdownSeconds) || 0)),
        scoreGraceMs: Math.max(0, Math.min(5000, Number(config.scoreGraceMs) || 0)),
        synchronizedGestures: Boolean(config.synchronizedGestures),
        captureSnapshots: config.captureSnapshots !== false
      };
      const shared = Array.from({ length: Math.ceil(state.config.challengeCount / techniques.length) }, shuffle).flat().slice(0, state.config.challengeCount);
      state.challengeLists.player1 = shared;
      state.challengeLists.player2 = state.config.synchronizedGestures ? [...shared] : Array.from({ length: Math.ceil(state.config.challengeCount / techniques.length) }, shuffle).flat().slice(0, state.config.challengeCount);
      state.countdownEndsAt = null;
    } else if (command.messageType === 'match.beginCountdown' && client.role === 'viewer' &&
      state.phase === 'preparing' && state.controllerClientId === client.clientId) {
      state.phase = 'countdown';
      state.countdownEndsAt = Date.now() + state.config.countdownSeconds * 1000;
    } else if (command.messageType === 'match.countdownCompleted' && client.role === 'viewer' &&
      state.controllerClientId === client.clientId && state.phase === 'countdown' && Date.now() >= state.countdownEndsAt) {
      state.phase = 'playing'; state.countdownEndsAt = null; assignChallenge(state, 'player1'); assignChallenge(state, 'player2');
    } else if (command.messageType === 'challenge.succeeded' && (client.role === 'player1' || client.role === 'player2') && (state.phase === 'playing' || state.phase === 'resolving')) {
      const player = state.players[client.role];
      if (state.phase === 'resolving' && Date.now() > state.resolution.acceptUntil) return;
      if (player.challenge?.challengeId !== payload.challengeId || player.challenge.technique !== payload.technique || (player.challenge.deadlineAt && Date.now() > player.challenge.deadlineAt)) return;
      if (state.phase === 'playing') {
        pauseChallenges(state); state.phase = 'resolving';
        state.resolution = { resolutionId: id('resolution'), acceptUntil: Date.now() + state.config.scoreGraceMs, casts: [] };
      }
      player.score += 1; player.attempted += 1; player.challenge = null;
      state.resolution.casts.push({ role: client.role, technique: payload.technique, videoSrc: payload.videoSrc ?? null });
    } else if (command.messageType === 'challenge.timedOut' && (client.role === 'player1' || client.role === 'player2') && state.phase === 'playing') {
      const player = state.players[client.role];
      if (player.challenge?.challengeId !== payload.challengeId || Date.now() < player.challenge.deadlineAt) return;
      player.attempted += 1; player.challenge = null;
      const winner = evaluateWinner(state);
      if (winner) { state.winner = winner; state.phase = 'ended'; } else assignChallenge(state, client.role);
    } else if (command.messageType === 'resolution.complete' && client.role === 'viewer' && state.phase === 'resolving' && Date.now() >= state.resolution.acceptUntil) {
      state.pendingWinner = evaluateWinner(state);
      state.cinematic = {
        cinematicId: id('cinematic'), casts: state.resolution.casts, startedAt: Date.now(),
        fallbackEndsAt: Date.now() + Math.max(5000, Number(payload.expectedDurationMs || 15000) + 1000)
      };
      state.resolution = null; state.phase = 'cinematic';
    } else if (command.messageType === 'cinematic.completed' && client.role === 'viewer' && state.phase === 'cinematic' && state.cinematic?.cinematicId === payload.cinematicId) {
      state.cinematic = null;
      if (state.pendingWinner) {
        state.winner = state.pendingWinner; state.pendingWinner = null; state.phase = 'ended';
      } else { state.phase = 'playing'; resumeChallenges(state); }
    } else if (command.messageType === 'match.reset' && client.role === 'viewer') {
      const revision = state.revision;
      const currentConnections = Object.fromEntries(Object.entries(state.players).map(([role, player]) => [role, { connected: player.connected, clientId: player.clientId }]));
      Object.assign(state, newState(state.roomId));
      state.revision = revision;
      state.players.player1 = { ...emptyPlayer(), ...currentConnections.player1 };
      state.players.player2 = { ...emptyPlayer(), ...currentConnections.player2 };
    } else return;
    publish(state, command.messageId);
    send(client, envelope(state, 'command.acknowledged', { duplicate: false }, command.messageId));
  });
  ws.on('close', () => {
    clients.delete(connectionId);
    if (!client.roomId || !client.role) return;
    const state = roomState(client.roomId);
    if (client.role === 'player1' || client.role === 'player2') Object.assign(state.players[client.role], { connected: false, clientId: null });
    publish(state);
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Domain Expansion V2: ${tls ? 'https' : 'http'}://localhost:${port}`);
  console.log(`Protocol 2.0 WebSocket: ${tls ? 'wss' : 'ws'}://localhost:${port}/control`);
});
