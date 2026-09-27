import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { createServer as createViteServer } from 'vite';
import { WebSocketServer } from 'ws';

const port = Number(process.env.PORT || 5173);
const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'mpa' });
const tls = process.env.VITE_HTTPS_CERT && process.env.VITE_HTTPS_KEY
  ? { cert: readFileSync(process.env.VITE_HTTPS_CERT), key: readFileSync(process.env.VITE_HTTPS_KEY) }
  : null;
const server = tls ? createHttpsServer(tls, vite.middlewares) : createHttpServer(vite.middlewares);
const wss = new WebSocketServer({ server, path: '/control' });
const clients = new Map(), rooms = new Map();
const techniques = [
  'Unlimited Void', 'Malevolent Shrine', 'Self-Embodiment of Perfection', 'Authentic Mutual Love',
  'Idle Death Gamble', 'Yuji Itadori', 'Chimera Shadow Garden', 'Time Cell Moon Palace',
  'Lapse Blue', 'Reversal Red', 'Hollow Purple'
];
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
  const { challengeLists, processedCommands, ...result } = state;
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
const shuffle = () => [...techniques].sort(() => Math.random() - .5);
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
      const currentConnections = Object.fromEntries(Object.entries(state.players).map(([role, player]) => [role, { connected: player.connected, clientId: player.clientId }]));
      const config = payload.config ?? {};
      Object.assign(state, newState(state.roomId));
      state.players.player1 = { ...emptyPlayer(), ...currentConnections.player1 };
      state.players.player2 = { ...emptyPlayer(), ...currentConnections.player2 };
      state.matchId = id('match'); state.phase = 'countdown';
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
      state.countdownEndsAt = Date.now() + state.config.countdownSeconds * 1000;
    } else if (command.messageType === 'match.countdownCompleted' && state.phase === 'countdown' && Date.now() >= state.countdownEndsAt) {
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
      const currentConnections = Object.fromEntries(Object.entries(state.players).map(([role, player]) => [role, { connected: player.connected, clientId: player.clientId }]));
      Object.assign(state, newState(state.roomId));
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
