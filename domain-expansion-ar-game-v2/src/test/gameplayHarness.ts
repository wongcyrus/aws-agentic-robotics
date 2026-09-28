import type {
  CommandType,
  MatchState,
  PlayerRole,
  Role,
  WebRtcPayload,
  WebRtcSignalType
} from '../core/protocol';
import type { GestureName } from '../core/catalog';

type RecordedCommand = {
  role: Role;
  type: CommandType;
  at: number;
  payload: Record<string, unknown>;
  accepted: boolean;
};

const player = () => ({
  connected: true,
  clientId: null,
  score: 0,
  attempted: 0,
  finished: false,
  challenge: null
});

export class InMemoryGameCoordinator {
  state: MatchState | null = null;
  readonly commands: RecordedCommand[] = [];
  readonly signals: { role: Role; type: WebRtcSignalType; payload: WebRtcPayload; to?: string }[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly terminalChallenges = new Set<string>();
  private readonly commandFunctions = new Map<Role, (type: CommandType, payload?: Record<string, unknown>) => void>();
  private readonly signalFunctions = new Map<Role, (type: WebRtcSignalType, payload?: WebRtcPayload, to?: string) => void>();
  private queues: Record<PlayerRole, GestureName[][]> = { player1: [], player2: [] };
  private round = 0;
  private revision = 0;
  private matchSequence = 0;
  private version = 0;

  constructor(
    private readonly gestureSets: Record<PlayerRole, GestureName[][]> = {
      player1: [['Lapse Blue']],
      player2: [['Reversal Red']]
    }
  ) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = () => this.version;

  session(role: Role) {
    if (!this.commandFunctions.has(role)) {
      this.commandFunctions.set(role, (type, payload = {}) => this.command(role, type, payload));
      this.signalFunctions.set(role, (type, payload = {}, to) => {
        this.signals.push({ role, type, payload, ...(to ? { to } : {}) });
      });
    }
    return {
      state: this.state,
      status: 'connected',
      config: {
        protocolVersion: '2.0' as const,
        webSocketUrl: 'wss://memory.test/control',
        apiBaseUrl: 'https://memory.test',
        robotApiEndpoint: '',
        defaultRoomCode: 'SIM1',
        defaultSessionKey: 'simulation',
        cognitoUserPoolId: '',
        cognitoUserPoolClientId: '',
        cognitoRegion: ''
      },
      command: this.commandFunctions.get(role)!,
      signal: this.signalFunctions.get(role)!,
      subscribe: () => () => undefined,
      serverTime: (clientTime = Date.now()) => clientTime
    };
  }

  command(role: Role, type: CommandType, payload: Record<string, unknown> = {}) {
    const record: RecordedCommand = { role, type, payload, at: Date.now(), accepted: false };
    this.commands.push(record);
    if (type === 'match.start') {
      record.accepted = this.start(payload.config as MatchState['config']);
      return;
    }
    if (type === 'match.reset') {
      record.accepted = true;
      this.reset();
      return;
    }
    if (!this.state || this.state.phase === 'idle' || this.state.phase === 'ended') return;
    if (type === 'match.beginCountdown') {
      if (this.state.phase !== 'preparing') return;
      record.accepted = true;
      this.update({
        phase: 'countdown',
        countdownEndsAt: Date.now() + this.state.config.countdownSeconds * 1000
      });
      return;
    }
    if (type === 'match.countdownCompleted') {
      if (this.state.phase !== 'countdown' || Date.now() < (this.state.countdownEndsAt ?? Infinity)) return;
      record.accepted = true;
      this.beginRound();
      return;
    }
    if (type === 'challenge.succeeded') {
      record.accepted = this.terminal(role, type, payload);
      return;
    }
    if (type === 'challenge.timedOut') {
      record.accepted = this.terminal(role, type, payload);
      return;
    }
    if (type === 'challenge.expire') {
      const expiredRole = payload.role;
      if (role !== 'viewer' || (expiredRole !== 'player1' && expiredRole !== 'player2')) return;
      record.accepted = this.timeout(expiredRole, payload);
      return;
    }
    if (type === 'resolution.complete') {
      if (this.state.phase !== 'resolving' || Date.now() < (this.state.resolution?.acceptUntil ?? Infinity)) return;
      record.accepted = true;
      this.beginCinematic();
      return;
    }
    if (type === 'cinematic.completed') {
      if (this.state.phase !== 'cinematic' ||
        payload.cinematicId !== this.state.cinematic?.cinematicId) return;
      record.accepted = true;
      this.finishCinematic();
    }
  }

  private start(config: MatchState['config']) {
    if (this.state && !['idle', 'ended'].includes(this.state.phase)) return false;
    this.round = 0;
    this.terminalChallenges.clear();
    this.queues = {
      player1: this.gestureSets.player1.slice(0, config.challengeCount),
      player2: config.synchronizedGestures
        ? this.gestureSets.player1.slice(0, config.challengeCount)
        : this.gestureSets.player2.slice(0, config.challengeCount)
    };
    this.state = {
      protocolVersion: '2.0',
      roomId: 'SIM1',
      matchId: `sim-${++this.matchSequence}`,
      revision: ++this.revision,
      phase: 'preparing',
      config,
      players: { player1: player(), player2: player() },
      countdownEndsAt: null,
      resolution: null,
      cinematic: null,
      winner: null,
      pendingWinner: null,
      updatedAt: Date.now()
    };
    this.publish();
    return true;
  }

  private beginRound() {
    if (!this.state) return;
    const startedAt = Date.now();
    const challengeFor = (role: PlayerRole) => {
      const technique = this.queues[role][this.round]?.[0];
      return technique ? {
        challengeId: `${this.state!.matchId}:${this.round}:${role}`,
        technique,
        startedAt,
        deadlineAt: startedAt + this.state!.config.difficultySeconds * 1000,
        pausedRemainingMs: null
      } : null;
    };
    this.update({
      phase: 'playing',
      countdownEndsAt: null,
      resolution: null,
      cinematic: null,
      players: {
        player1: { ...this.state.players.player1, challenge: challengeFor('player1') },
        player2: { ...this.state.players.player2, challenge: challengeFor('player2') }
      }
    });
  }

  private terminal(role: Role, type: 'challenge.succeeded' | 'challenge.timedOut', payload: Record<string, unknown>) {
    if (!this.state || role === 'viewer' || !['playing', 'resolving'].includes(this.state.phase)) return false;
    const challenge = this.state.players[role].challenge;
    if (!challenge || payload.challengeId !== challenge.challengeId || this.terminalChallenges.has(challenge.challengeId)) return false;
    const success = type === 'challenge.succeeded';
    if (success && (
      Date.now() > (challenge.deadlineAt ?? Infinity) ||
      (this.state.phase === 'resolving' && Date.now() > (this.state.resolution?.acceptUntil ?? -Infinity))
    )) return false;
    this.terminalChallenges.add(challenge.challengeId);
    const updatedPlayer = {
      ...this.state.players[role],
      score: this.state.players[role].score + (success ? 1 : 0),
      attempted: this.state.players[role].attempted + 1
    };
    const casts = this.state.resolution?.casts.slice() ?? [];
    if (success) casts.push({
      role,
      technique: challenge.technique,
      videoSrc: String(payload.videoSrc ?? `/video/${challenge.technique}.mp4`)
    });
    const resolution = this.state.resolution ?? {
      resolutionId: `${this.state.matchId}:resolution:${this.round}`,
      acceptUntil: Date.now() + this.state.config.scoreGraceMs,
      casts: []
    };
    this.update({
      phase: 'resolving',
      resolution: { ...resolution, casts },
      players: { ...this.state.players, [role]: updatedPlayer }
    });
    return true;
  }

  private timeout(role: Role, payload: Record<string, unknown>) {
    if (!this.state || role === 'viewer' || this.state.phase !== 'playing') return false;
    const challenge = this.state.players[role].challenge;
    if (!challenge || payload.challengeId !== challenge.challengeId ||
      this.terminalChallenges.has(challenge.challengeId) ||
      Date.now() < (challenge.deadlineAt ?? Infinity)) return false;
    this.terminalChallenges.add(challenge.challengeId);
    const attempted = this.state.players[role].attempted + 1;
    const count = this.state.config.challengeCount;
    const players = {
      ...this.state.players,
      [role]: {
        ...this.state.players[role],
        attempted,
        finished: attempted >= count,
        challenge: null
      }
    };
    const p1Max = players.player1.score + Math.max(0, count - players.player1.attempted);
    const p2Max = players.player2.score + Math.max(0, count - players.player2.attempted);
    const winner = players.player1.finished && players.player2.finished
      ? players.player1.score === players.player2.score
        ? 'DRAW'
        : players.player1.score > players.player2.score ? 'PLAYER 1' : 'PLAYER 2'
      : players.player1.score > p2Max
        ? 'PLAYER 1'
        : players.player2.score > p1Max ? 'PLAYER 2' : null;
    if (winner) {
      this.update({ players, winner, phase: 'ended' });
      return true;
    }
    const technique = this.queues[role][attempted]?.[0];
    if (technique) {
      const startedAt = Date.now();
      players[role].challenge = {
        challengeId: `${this.state.matchId}:${attempted}:${role}`,
        technique,
        startedAt,
        deadlineAt: startedAt + this.state.config.difficultySeconds * 1000,
        pausedRemainingMs: null
      };
    }
    this.update({ players });
    return true;
  }

  private beginCinematic() {
    if (!this.state?.resolution) return;
    const players = { ...this.state.players };
    (['player1', 'player2'] as const).forEach((role) => {
      const challenge = players[role].challenge;
      if (challenge && !this.terminalChallenges.has(challenge.challengeId)) {
        this.terminalChallenges.add(challenge.challengeId);
        players[role] = { ...players[role], attempted: players[role].attempted + 1 };
      }
    });
    this.update({
      phase: 'cinematic',
      players,
      cinematic: {
        cinematicId: `${this.state.matchId}:cinematic:${this.round}`,
        casts: this.state.resolution.casts,
        startedAt: Date.now(),
        fallbackEndsAt: Date.now() + 15_000
      }
    });
  }

  private finishCinematic() {
    if (!this.state) return;
    this.round += 1;
    if (this.round < this.state.config.challengeCount) {
      this.beginRound();
      return;
    }
    const p1 = this.state.players.player1.score;
    const p2 = this.state.players.player2.score;
    const winner = p1 === p2 ? 'DRAW' : p1 > p2 ? 'PLAYER 1' : 'PLAYER 2';
    this.update({
      phase: 'ended',
      winner,
      cinematic: null,
      resolution: null,
      players: {
        player1: { ...this.state.players.player1, finished: true, challenge: null },
        player2: { ...this.state.players.player2, finished: true, challenge: null }
      }
    });
  }

  private reset() {
    if (!this.state) return;
    this.terminalChallenges.clear();
    this.update({
      matchId: null,
      phase: 'idle',
      players: { player1: player(), player2: player() },
      countdownEndsAt: null,
      resolution: null,
      cinematic: null,
      winner: null,
      pendingWinner: null
    });
  }

  private update(changes: Partial<MatchState>) {
    if (!this.state) return;
    this.state = {
      ...this.state,
      ...changes,
      revision: ++this.revision,
      updatedAt: Date.now()
    };
    this.publish();
  }

  private publish() {
    this.version += 1;
    this.listeners.forEach((listener) => listener());
  }
}

export function seededRandom(seed: number) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x1_0000_0000;
  };
}
