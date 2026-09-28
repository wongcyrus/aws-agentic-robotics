import { act, fireEvent, render, screen } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GestureName } from '../core/catalog';
import type { Landmark } from '../adapters/gestureRecognizer';
import { InMemoryGameCoordinator, seededRandom } from './gameplayHarness';

let coordinator: InMemoryGameCoordinator;
const triggerTechnique = vi.fn().mockResolvedValue({});

class ScriptedCamera {
  static instances: ScriptedCamera[] = [];
  active = false;
  callback?: (image: CanvasImageSource, hands: Landmark[][]) => void;
  constructor() { ScriptedCamera.instances.push(this); }
  async start(
    _video: HTMLVideoElement,
    _cameraId: string,
    callback: (image: CanvasImageSource, hands: Landmark[][]) => void
  ) {
    this.active = true;
    this.callback = callback;
    return { getTracks: () => [] } as unknown as MediaStream;
  }
  stop() { this.active = false; }
  emit(hands: Landmark[][]) {
    if (this.active) this.callback?.(document.createElement('canvas'), hands);
  }
}

vi.mock('../services/useGameSession', () => ({
  useGameSession: (_roomId: string, role: 'player1' | 'player2' | 'viewer') => {
    useSyncExternalStore(coordinator.subscribe, coordinator.snapshot);
    return coordinator.session(role);
  }
}));
vi.mock('../adapters/mediaPipeCamera', () => ({ MediaPipeCameraAdapter: ScriptedCamera }));
vi.mock('../adapters/vfx', () => ({
  CanvasVfxAdapter: class {
    initialize = vi.fn().mockResolvedValue(undefined);
    draw = vi.fn();
  }
}));
vi.mock('../services/apiClient', () => ({
  ApiClient: class {
    triggerTechnique = triggerTechnique;
    registerRoom = vi.fn().mockResolvedValue({});
    commentary = vi.fn().mockResolvedValue({});
    uploadSnapshot = vi.fn().mockResolvedValue({});
  }
}));
vi.mock('../services/webrtcSession', () => ({
  WebRtcSessionService: class {
    playerReady = vi.fn();
    viewerRequested = vi.fn();
    handle = vi.fn();
    close = vi.fn();
  }
}));

const extendedHand = (technique: 'Lapse Blue' | 'Reversal Red'): Landmark[] => {
  const hand = Array.from({ length: 21 }, (_, index) => ({ x: index * .01, y: .5 }));
  const extendedTips = technique === 'Lapse Blue' ? [8] : [8, 12, 16];
  for (const [mcp, pip, tip] of [[5, 6, 8], [9, 10, 12], [13, 14, 16], [17, 18, 20]]) {
    hand[mcp] = { x: mcp * .01, y: .5 };
    hand[pip] = { x: mcp * .01, y: .4 };
    hand[tip] = extendedTips.includes(tip)
      ? { x: mcp * .01, y: .15 }
      : { x: mcp * .01, y: .48 };
  }
  return hand;
};
const timeCellHand = (x: number): Landmark[] => {
  const hand = Array.from({ length: 21 }, () => ({ x, y: .5 }));
  hand[0] = { x, y: .6 };
  hand[4] = { x: x - .08, y: .35 };
  hand[5] = { x: x + .02, y: .5 };
  hand[6] = { x: x + .02, y: .4 };
  hand[8] = { x: x + .02, y: .2 };
  for (const [mcp, pip, tip] of [[9, 10, 12], [13, 14, 16], [17, 18, 20]]) {
    hand[mcp] = { x: x + mcp * .002, y: .5 };
    hand[pip] = { x: x + mcp * .002, y: .48 };
    hand[tip] = { x: x + mcp * .002, y: .55 };
  }
  return hand;
};

const framesFor = (technique: GestureName) => {
  if (technique === 'Time Cell Moon Palace') {
    return [timeCellHand(.35), timeCellHand(.65)];
  }
  if (technique !== 'Lapse Blue' && technique !== 'Reversal Red') {
    throw new Error(`No scripted landmarks for ${technique}`);
  }
  return [extendedHand(technique)];
};

const config = {
  difficultySeconds: 3,
  challengeCount: 1,
  countdownSeconds: 1,
  scoreGraceMs: 1000,
  synchronizedGestures: false,
  captureSnapshots: false
};

const playerSettings = (role: 'player1' | 'player2') => ({
  roomCode: 'SIM1',
  role,
  language: 'en' as const,
  playerMode: 'battle' as const,
  disableRobotApi: false,
  robotCooldownSeconds: 10,
  commentatorEnabled: false
});

async function flush() {
  await act(async () => { await Promise.resolve(); });
}

async function advance(milliseconds: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
}

async function startCameras() {
  screen.queryAllByRole('button', { name: 'Start camera' }).forEach((button) => fireEvent.click(button));
  await flush();
  expect(ScriptedCamera.instances.filter(({ active }) => active)).toHaveLength(2);
}

async function emitStable(camera: ScriptedCamera, technique: GestureName) {
  for (let frame = 0; frame < 6; frame += 1) {
    await act(async () => camera.emit(framesFor(technique)));
  }
}

async function emitStableTogether(
  first: ScriptedCamera,
  firstTechnique: GestureName,
  second: ScriptedCamera,
  secondTechnique: GestureName
) {
  for (let frame = 0; frame < 6; frame += 1) {
    await act(async () => {
      first.emit(framesFor(firstTechnique));
      second.emit(framesFor(secondTechnique));
    });
  }
}

async function mountFullGame(options: { challengeCount?: number; synchronizedGestures?: boolean } = {}) {
  const { BattleApp } = await import('../pages/BattleApp');
  const { PlayerApp } = await import('../pages/PlayerApp');
  const view = render(<>
    <BattleApp initialSettings={{
      roomCode: 'SIM1',
      countdownSeconds: config.countdownSeconds,
      difficulty: config.difficultySeconds,
      gestureCount: options.challengeCount ?? config.challengeCount,
      scoreGraceMs: config.scoreGraceMs,
      synchronizedGestures: options.synchronizedGestures ?? false,
      commentatorEnabled: false,
      language: 'en',
      videoMode: 'integrated'
    }} />
    <PlayerApp initialSettings={playerSettings('player1')} />
    <PlayerApp initialSettings={playerSettings('player2')} />
  </>);
  fireEvent.click(screen.getByText('Start battle'));
  expect(coordinator.state?.phase).toBe('countdown');
  await advance(1000);
  expect(coordinator.state?.phase).toBe('playing');
  await startCameras();
  return view;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  coordinator = new InMemoryGameCoordinator({
    player1: [['Lapse Blue'], ['Reversal Red'], ['Lapse Blue']],
    player2: [['Reversal Red'], ['Lapse Blue'], ['Reversal Red']]
  });
  ScriptedCamera.instances = [];
  triggerTechnique.mockReset().mockResolvedValue({});
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { enumerateDevices: vi.fn().mockResolvedValue([]) }
  });
  vi.stubGlobal('speechSynthesis', {
    getVoices: vi.fn(() => []),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    cancel: vi.fn(),
    speak: vi.fn()
  });
});

describe('deterministic React gameplay simulation', () => {
  it('scores Time Cell Moon Palace after its effect stabilizes', async () => {
    coordinator = new InMemoryGameCoordinator({
      player1: [['Time Cell Moon Palace']],
      player2: [['Reversal Red']]
    });
    await mountFullGame();
    const [p1Camera] = ScriptedCamera.instances;
    await emitStable(p1Camera, 'Time Cell Moon Palace');
    expect(coordinator.state?.players.player1.score).toBe(1);
    expect(coordinator.commands.filter(({ type, accepted }) =>
      type === 'challenge.succeeded' && accepted
    )).toHaveLength(1);
  });

  it('runs countdown through dual cinematic, ending, and clean reset with same-frame detections', async () => {
    const { container } = await mountFullGame();
    const [p1Camera, p2Camera] = ScriptedCamera.instances;
    expect(coordinator.state?.players.player1.challenge?.technique).toBe('Lapse Blue');
    expect(coordinator.state?.players.player2.challenge?.technique).toBe('Reversal Red');

    await emitStableTogether(p1Camera, 'Lapse Blue', p2Camera, 'Reversal Red');
    expect(coordinator.state?.phase).toBe('resolving');
    expect(coordinator.state?.resolution?.casts.map(({ role }) => role).sort())
      .toEqual(['player1', 'player2']);
    await advance(1000);
    expect(coordinator.state?.phase).toBe('cinematic');

    const videos = container.querySelectorAll('.cinematic video');
    expect(container.querySelectorAll('.integrated-media')).toHaveLength(0);
    fireEvent.ended(videos[1]);
    expect(coordinator.state?.phase).toBe('cinematic');
    fireEvent.ended(videos[0]);
    expect(coordinator.state?.phase).toBe('ended');
    expect(coordinator.state?.winner).toBe('DRAW');

    fireEvent.click(screen.getByText('Skip result video'));
    fireEvent.click(screen.getByText('Back to lobby'));
    expect(coordinator.state).toMatchObject({
      phase: 'idle',
      matchId: null,
      winner: null,
      players: {
        player1: { score: 0, attempted: 0, challenge: null },
        player2: { score: 0, attempted: 0, challenge: null }
      }
    });
  });

  it('accepts the second player inside grace, rejects it after grace, and uses cinematic fallback', async () => {
    await mountFullGame();
    const [p1Camera, p2Camera] = ScriptedCamera.instances;
    await emitStable(p1Camera, 'Lapse Blue');
    await advance(800);
    await emitStable(p2Camera, 'Reversal Red');
    expect(coordinator.state?.players.player2.score).toBe(1);
    await advance(200);
    expect(coordinator.state?.phase).toBe('cinematic');
    await advance(15_000);
    expect(coordinator.state?.phase).toBe('ended');

    const lateRoom = new InMemoryGameCoordinator({
      player1: [['Lapse Blue']],
      player2: [['Reversal Red']]
    });
    lateRoom.command('viewer', 'match.start', { config });
    lateRoom.command('viewer', 'match.beginCountdown');
    vi.setSystemTime(Date.now() + 1000);
    lateRoom.command('viewer', 'match.countdownCompleted');
    const p2Challenge = lateRoom.state!.players.player2.challenge!;
    lateRoom.command('player1', 'challenge.succeeded', {
      challengeId: lateRoom.state!.players.player1.challenge!.challengeId,
      videoSrc: '/blue.mp4'
    });
    vi.setSystemTime(Date.now() + 1001);
    lateRoom.command('player2', 'challenge.succeeded', {
      challengeId: p2Challenge.challengeId,
      videoSrc: '/red.mp4'
    });
    expect(lateRoom.commands.at(-1)?.accepted).toBe(false);
    expect(lateRoom.state?.players.player2.score).toBe(0);
  });

  it('completes a dual cinematic when the first video finishes before the second', async () => {
    const { container } = await mountFullGame();
    const [p1Camera, p2Camera] = ScriptedCamera.instances;
    await emitStableTogether(p1Camera, 'Lapse Blue', p2Camera, 'Reversal Red');
    await advance(1000);
    const videos = container.querySelectorAll('.cinematic video');
    fireEvent.ended(videos[0]);
    expect(coordinator.state?.phase).toBe('cinematic');
    fireEvent.ended(videos[1]);
    expect(coordinator.state?.phase).toBe('ended');
  });

  it.each([
    ['before', -1, 1],
    ['at', 0, 1],
    ['after', 1, 0]
  ] as const)('handles recognition %s the deadline', async (_label, offset, expectedScore) => {
    const { PlayerApp } = await import('../pages/PlayerApp');
    act(() => coordinator.command('viewer', 'match.start', { config: { ...config, countdownSeconds: 0 } }));
    act(() => coordinator.command('viewer', 'match.beginCountdown'));
    act(() => coordinator.command('viewer', 'match.countdownCompleted'));
    render(<PlayerApp initialSettings={playerSettings('player1')} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start camera' }));
    await flush();
    const camera = ScriptedCamera.instances[0];
    for (let frame = 0; frame < 5; frame += 1) camera.emit(framesFor('Lapse Blue'));
    const deadline = coordinator.state!.players.player1.challenge!.deadlineAt!;
    vi.setSystemTime(deadline + offset);
    await act(async () => camera.emit(framesFor('Lapse Blue')));
    expect(coordinator.state?.players.player1.score).toBe(expectedScore);
    const success = coordinator.commands.filter(({ type }) => type === 'challenge.succeeded').at(-1);
    if (expectedScore === 1) expect(success?.accepted).toBe(true);
    else expect(success).toBeUndefined();
  });

  it('expires challenges from the battle viewer when player tabs do not run timers', async () => {
    const { BattleApp } = await import('../pages/BattleApp');
    act(() => coordinator.command('viewer', 'match.start', { config: { ...config, countdownSeconds: 0 } }));
    act(() => coordinator.command('viewer', 'match.beginCountdown'));
    act(() => coordinator.command('viewer', 'match.countdownCompleted'));
    render(<BattleApp initialSettings={{ roomCode: 'SIM1', commentatorEnabled: false, language: 'en' }} />);

    await advance(config.difficultySeconds * 1000);

    const expirations = coordinator.commands.filter(({ type, accepted }) =>
      type === 'challenge.expire' && accepted
    );
    expect(expirations).toHaveLength(2);
    expect(coordinator.state?.phase).toBe('ended');
    expect(coordinator.state?.players.player1.attempted).toBe(1);
    expect(coordinator.state?.players.player2.attempted).toBe(1);
  });

  it('turns flicker and a timeout/recognition same tick into one terminal outcome', async () => {
    const { PlayerApp } = await import('../pages/PlayerApp');
    act(() => coordinator.command('viewer', 'match.start', { config: { ...config, countdownSeconds: 0 } }));
    act(() => coordinator.command('viewer', 'match.beginCountdown'));
    act(() => coordinator.command('viewer', 'match.countdownCompleted'));
    render(<PlayerApp initialSettings={playerSettings('player1')} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start camera' }));
    await flush();
    const camera = ScriptedCamera.instances[0];
    for (const target of [true, false, true, false, true, false, true, false, true]) {
      await act(async () => camera.emit(target ? framesFor('Lapse Blue') : []));
    }
    expect(coordinator.commands.filter(({ type }) => type === 'challenge.succeeded')).toHaveLength(0);
    const deadline = coordinator.state!.players.player1.challenge!.deadlineAt!;
    const challengeId = coordinator.state!.players.player1.challenge!.challengeId;
    vi.setSystemTime(deadline - 200);
    await act(async () => {
      camera.emit(framesFor('Lapse Blue'));
      await vi.advanceTimersByTimeAsync(200);
    });
    const acceptedTerminal = coordinator.commands.filter(({ type, payload, accepted }) =>
      accepted && payload.challengeId === challengeId &&
      (type === 'challenge.succeeded' || type === 'challenge.timedOut')
    );
    expect(acceptedTerminal).toHaveLength(1);
    camera.emit(framesFor('Lapse Blue'));
    expect(coordinator.commands.filter(({ type, accepted }) =>
      type === 'challenge.succeeded' && accepted
    )).toHaveLength(1);
  });

  it('preserves phase through reconnect and makes reset win a recognition race', async () => {
    const { PlayerApp } = await import('../pages/PlayerApp');
    const { BattleApp } = await import('../pages/BattleApp');
    act(() => coordinator.command('viewer', 'match.start', { config: { ...config, countdownSeconds: 0 } }));
    act(() => coordinator.command('viewer', 'match.beginCountdown'));
    act(() => coordinator.command('viewer', 'match.countdownCompleted'));
    const player = render(<PlayerApp initialSettings={playerSettings('player1')} />);
    expect(screen.getByText('Lapse Blue')).toBeTruthy();
    player.unmount();
    const viewer = render(<BattleApp initialSettings={{ roomCode: 'SIM1', commentatorEnabled: false, language: 'en' }} />);
    expect(coordinator.state?.phase).toBe('playing');
    expect(screen.getByText('Lapse Blue')).toBeTruthy();
    viewer.unmount();
    const reconnectedViewer = render(<BattleApp initialSettings={{ roomCode: 'SIM1', commentatorEnabled: false, language: 'en' }} />);
    expect(coordinator.state?.phase).toBe('playing');
    expect(screen.getByText('Lapse Blue')).toBeTruthy();
    reconnectedViewer.unmount();

    render(<PlayerApp initialSettings={playerSettings('player1')} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start camera' }));
    await flush();
    const camera = ScriptedCamera.instances.at(-1)!;
    for (let frame = 0; frame < 5; frame += 1) camera.emit(framesFor('Lapse Blue'));
    await act(async () => {
      camera.emit(framesFor('Lapse Blue'));
      coordinator.command('viewer', 'match.reset');
    });
    expect(coordinator.state?.phase).toBe('idle');
    expect(coordinator.state?.players.player1.score).toBe(0);
    expect(coordinator.commands.filter(({ type, accepted }) =>
      type === 'challenge.succeeded' && accepted && coordinator.state?.phase === 'idle'
    )).toHaveLength(0);
  });

  it('does not duplicate callbacks after camera restart and robot cooldown never blocks scoring', async () => {
    await mountFullGame({ challengeCount: 2 });
    const firstCamera = ScriptedCamera.instances[0];
    await emitStable(firstCamera, 'Lapse Blue');
    expect(coordinator.state?.players.player1.score).toBe(1);
    await advance(1000);
    fireEvent.click(screen.getAllByText('Skip cinematic')[0]);
    expect(coordinator.state?.phase).toBe('playing');

    const playerStopButtons = screen.getAllByRole('button', { name: 'Stop camera' });
    fireEvent.click(playerStopButtons[0]);
    fireEvent.click(screen.getAllByRole('button', { name: 'Start camera' })[0]);
    await flush();
    const restarted = ScriptedCamera.instances.at(-1)!;
    firstCamera.emit(framesFor('Reversal Red'));
    await emitStable(restarted, 'Reversal Red');
    expect(coordinator.state?.players.player1.score).toBe(2);
    expect(coordinator.commands.filter(({ type, accepted, role }) =>
      type === 'challenge.succeeded' && accepted && role === 'player1'
    )).toHaveLength(2);
    expect(triggerTechnique).toHaveBeenCalledTimes(1);
  });
});

describe('seeded authoritative match invariants', () => {
  it('holds terminal, scoring, ended-state, winner, and reset invariants', () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      vi.setSystemTime(2_000_000 + seed * 100_000);
      const random = seededRandom(seed);
      const room = new InMemoryGameCoordinator({
        player1: [['Lapse Blue'], ['Reversal Red'], ['Lapse Blue']],
        player2: [['Reversal Red'], ['Lapse Blue'], ['Reversal Red']]
      });
      room.command('viewer', 'match.start', { config: { ...config, countdownSeconds: 0, challengeCount: 3 } });
      room.command('viewer', 'match.beginCountdown');
      room.command('viewer', 'match.countdownCompleted');
      for (let step = 0; step < 12 && room.state?.phase !== 'ended'; step += 1) {
        const roles = random() < .5
          ? ['player1', 'player2'] as const
          : ['player2', 'player1'] as const;
        roles.forEach((role) => {
          const challenge = room.state?.players[role].challenge;
          if (!challenge) return;
          const type = random() < .65 ? 'challenge.succeeded' : 'challenge.timedOut';
          if (type === 'challenge.timedOut' && challenge.deadlineAt) {
            vi.setSystemTime(challenge.deadlineAt);
          }
          room.command(role, type, {
            challengeId: challenge.challengeId,
            videoSrc: `/video/${challenge.technique}.mp4`
          });
          room.command(role, type, { challengeId: challenge.challengeId });
        });
        if (room.state?.phase === 'resolving' && room.state.resolution) {
          vi.setSystemTime(room.state.resolution.acceptUntil);
          room.command('viewer', 'resolution.complete');
        }
        if (room.state?.phase === 'cinematic' && room.state.cinematic) {
          room.command('viewer', 'cinematic.completed', {
            cinematicId: room.state.cinematic.cinematicId
          });
        }
      }
      expect(room.state?.phase).toBe('ended');
      expect(room.state?.winner).toMatch(/^(PLAYER 1|PLAYER 2|DRAW)$/);
      for (const role of ['player1', 'player2'] as const) {
        expect(room.state!.players[role].attempted).toBeLessThanOrEqual(3);
        expect(room.state!.players[role].score).toBeLessThanOrEqual(room.state!.players[role].attempted);
      }
      const acceptedTerminals = room.commands.filter(({ accepted, type }) =>
        accepted && (type === 'challenge.succeeded' || type === 'challenge.timedOut')
      );
      expect(new Set(acceptedTerminals.map(({ payload }) => payload.challengeId)).size)
        .toBe(acceptedTerminals.length);
      room.command('player1', 'challenge.succeeded', { challengeId: 'ended' });
      expect(room.commands.at(-1)?.accepted).toBe(false);
      room.command('viewer', 'match.reset');
      expect(room.state).toMatchObject({
        phase: 'idle',
        winner: null,
        players: {
          player1: { score: 0, attempted: 0 },
          player2: { score: 0, attempted: 0 }
        }
      });
    }
  });
});
