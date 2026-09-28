import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../services/settings';
import type { MatchState } from '../core/protocol';

const command = vi.fn();
const signal = vi.fn();
const subscribe = vi.fn(() => vi.fn());
let gameState: MatchState | null = null;
const api = {
  triggerTechnique: vi.fn(),
  registerRoom: vi.fn(),
  commentary: vi.fn(),
  uploadSnapshot: vi.fn(),
  getSnapshot: vi.fn(),
  enhancePortrait: vi.fn(),
  checkEnhancement: vi.fn()
};
const cameraStart = vi.fn();
const cameraStop = vi.fn();
const playerReady = vi.fn();
const viewerRequested = vi.fn();
const handleSignal = vi.fn();
const closePeers = vi.fn();

vi.mock('../services/useGameSession', () => ({
  useGameSession: () => ({
    state: gameState,
    status: 'connected',
    config: {
      apiBaseUrl: 'https://api.test',
      webSocketUrl: 'wss://socket.test',
      defaultSessionKey: 'key'
    },
    command,
    signal,
    subscribe
  })
}));
vi.mock('../services/apiClient', () => ({
  ApiClient: class {
    triggerTechnique = api.triggerTechnique;
    registerRoom = api.registerRoom;
    commentary = api.commentary;
    uploadSnapshot = api.uploadSnapshot;
    getSnapshot = api.getSnapshot;
    enhancePortrait = api.enhancePortrait;
    checkEnhancement = api.checkEnhancement;
  }
}));
vi.mock('../services/config', () => ({
  loadConfig: () => Promise.resolve({ apiBaseUrl: 'https://api.test' })
}));
vi.mock('../adapters/mediaPipeCamera', () => ({
  MediaPipeCameraAdapter: class { start = cameraStart; stop = cameraStop; }
}));
vi.mock('../adapters/vfx', () => ({
  CanvasVfxAdapter: class { initialize = vi.fn().mockResolvedValue(undefined); draw = vi.fn(); }
}));
vi.mock('../adapters/gestureRecognizer', () => ({
  StableGestureRecognizer: class { update = vi.fn(() => null); }
}));
vi.mock('../services/webrtcSession', () => ({
  WebRtcSessionService: class {
    playerReady = playerReady;
    viewerRequested = viewerRequested;
    handle = handleSignal;
    close = closePeers;
  }
}));

const makeState = (overrides: Partial<MatchState> = {}): MatchState => ({
  protocolVersion: '2.0',
  roomId: 'BTL1',
  matchId: 'match-123',
  revision: 1,
  phase: 'idle',
  config: {
    difficultySeconds: 8,
    challengeCount: 3,
    countdownSeconds: 3,
    scoreGraceMs: 1000,
    synchronizedGestures: false,
    captureSnapshots: true
  },
  players: {
    player1: {
      connected: true, clientId: 'p1', score: 1, attempted: 1, finished: false,
      challenge: { challengeId: 'c1', technique: 'Lapse Blue', startedAt: Date.now(), deadlineAt: Date.now() + 5000 }
    },
    player2: {
      connected: true, clientId: 'p2', score: 2, attempted: 2, finished: false,
      challenge: { challengeId: 'c2', technique: 'Reversal Red', startedAt: Date.now(), deadlineAt: Date.now() + 5000 }
    }
  },
  countdownEndsAt: null,
  resolution: null,
  cinematic: null,
  winner: null,
  pendingWinner: null,
  updatedAt: Date.now(),
  ...overrides
});

beforeEach(() => {
  localStorage.setItem('domain-expansion-v2.settings', JSON.stringify({ ...defaultSettings, language: 'en' }));
  gameState = null;
  command.mockReset();
  signal.mockReset();
  subscribe.mockClear();
  Object.values(api).forEach((mock) => mock.mockReset());
  cameraStart.mockReset().mockResolvedValue({ getTracks: () => [] });
  cameraStop.mockReset();
  playerReady.mockReset();
  viewerRequested.mockReset();
  handleSignal.mockReset();
  history.replaceState({}, '', '/');
  vi.stubGlobal('speechSynthesis', {
    getVoices: vi.fn(() => [{ name: 'Gojo' }]),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    cancel: vi.fn(),
    speak: vi.fn()
  });
  vi.stubGlobal('SpeechSynthesisUtterance', class {
    lang = ''; volume = 1; voice: SpeechSynthesisVoice | null = null;
    constructor(public text: string) {}
  });
});

describe('MediaApp', () => {
  it('enables the popup and responds to validated media messages', async () => {
    const opener = { postMessage: vi.fn() } as unknown as Window;
    Object.defineProperty(window, 'opener', { configurable: true, value: opener });
    const { MediaApp } = await import('../pages/MediaApp');
    const { container } = render(<MediaApp />);
    fireEvent.click(screen.getByText('Click to enable audio/video'));
    expect(opener.postMessage).toHaveBeenCalledWith({ type: 'PLAYER_READY' }, location.origin);
    const video = container.querySelector('video')!;
    window.dispatchEvent(new MessageEvent('message', {
      origin: location.origin,
      source: opener,
      data: { type: 'PLAY_VIDEO', videoSrc: '/clips/domain.mp4' }
    }));
    expect(video.src).toContain('/clips/domain.mp4');
    expect(await screen.findByText('domain.mp4')).toBeTruthy();
    window.dispatchEvent(new MessageEvent('message', {
      origin: location.origin,
      source: opener,
      data: { type: 'STOP_VIDEO' }
    }));
    expect(video.pause).toHaveBeenCalled();
  });
});

describe('PlayerApp', () => {
  it('renders online state, edits settings, auto-starts and stops the camera', async () => {
    gameState = makeState();
    const { PlayerApp } = await import('../pages/PlayerApp');
    render(<PlayerApp initialSettings={{ language: 'en' }} />);
    expect(screen.getByText('Lapse Blue')).toBeTruthy();
    expect(screen.getByText(/Score 1\/3/)).toBeTruthy();
    await waitFor(() => expect(cameraStart).toHaveBeenCalled());
    expect(playerReady).toHaveBeenCalled();
    expect(document.querySelector('.player-header p')).toBeNull();
    expect(document.querySelector('.settings-card .status-message')?.textContent).toContain('Camera + MediaPipe active');
    fireEvent.click(screen.getByRole('button', { name: 'Stop camera' }));
    expect(cameraStop).toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Room'), { target: { value: 'abcd' } });
    expect(screen.getByDisplayValue('ABCD')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'player2' } });
    expect(screen.getByDisplayValue('PLAYER 2')).toBeTruthy();
  });

  it('lists cameras and switches the active camera immediately', async () => {
    const mediaListeners = new Map<string, EventListener>();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        enumerateDevices: vi.fn().mockResolvedValue([
          { kind: 'videoinput', deviceId: 'camera-1', label: 'Front camera' },
          { kind: 'videoinput', deviceId: 'camera-2', label: 'USB camera' }
        ]),
        addEventListener: vi.fn((type: string, listener: EventListener) => mediaListeners.set(type, listener)),
        removeEventListener: vi.fn((type: string) => mediaListeners.delete(type))
      }
    });
    const { PlayerApp } = await import('../pages/PlayerApp');
    render(<PlayerApp initialSettings={{ language: 'en' }} />);
    await waitFor(() => expect(cameraStart).toHaveBeenCalled());
    const cameraSelect = await screen.findByLabelText('Camera');
    await waitFor(() => expect(screen.getByRole('option', { name: 'USB camera' })).toBeTruthy());
    fireEvent.change(cameraSelect, { target: { value: 'camera-2' } });
    await waitFor(() => expect(cameraStart).toHaveBeenLastCalledWith(
      expect.any(HTMLVideoElement),
      'camera-2',
      expect.any(Function)
    ));
    expect(mediaListeners.has('devicechange')).toBe(true);
  });

  it('shows phase status instead of the lobby placeholder during a battle', async () => {
    const players = makeState().players;
    gameState = makeState({
      phase: 'countdown',
      players: {
        player1: { ...players.player1, challenge: null },
        player2: { ...players.player2, challenge: null }
      },
      countdownEndsAt: Date.now() + 3000
    });
    const { PlayerApp } = await import('../pages/PlayerApp');
    render(<PlayerApp initialSettings={{ language: 'en' }} />);
    expect(screen.getByText('GET READY')).toBeTruthy();
    expect(screen.queryByText('Waiting for battle')).toBeNull();
  });

  it('renders player controls in the selected language', async () => {
    const { PlayerApp } = await import('../pages/PlayerApp');
    render(<PlayerApp initialSettings={{ language: 'zh-TW' }} />);
    expect(screen.getByRole('button', { name: '啟動相機' })).toBeTruthy();
    expect(screen.getByText('玩家設定')).toBeTruthy();
    expect(screen.getByText('等待對戰開始')).toBeTruthy();
  });

  it('runs solo controls and media popup behavior', async () => {
    localStorage.setItem('domain-expansion-v2.settings', JSON.stringify({
      ...defaultSettings, language: 'en', playerMode: 'solo', videoMode: 'popup', autoOpenPopup: false
    }));
    const popup = { focus: vi.fn(), closed: false, postMessage: vi.fn() } as unknown as Window;
    vi.spyOn(window, 'open').mockReturnValue(popup);
    const { PlayerApp } = await import('../pages/PlayerApp');
    const { container } = render(<PlayerApp initialSettings={{ language: 'en' }} />);
    fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'solo' } });
    fireEvent.click(screen.getByText('Start round'));
    expect(container.querySelector('.settings-card .status-message')?.textContent).toContain('Local solo round');
    fireEvent.click(screen.getByText('Quit'));
    expect(screen.getByText('ROUND STOPPED')).toBeTruthy();
    fireEvent.click(screen.getByText('Open media popup'));
    expect(window.open).toHaveBeenCalled();
    fireEvent.click(screen.getByText('Save & hide'));
    expect(localStorage.getItem('domain-expansion-v2.settings')).toContain('"playerMode":"solo"');
    expect(screen.queryByLabelText('Mode')).toBeNull();
    fireEvent.click(screen.getByText('Player settings'));
    expect(screen.getByLabelText('Mode')).toBeTruthy();
  });
});

describe('BattleApp', () => {
  it('renders battle controls in the selected language', async () => {
    const { BattleApp } = await import('../pages/BattleApp');
    render(<BattleApp initialSettings={{ language: 'ja' }} />);
    expect(screen.getByText('設定を隠す')).toBeTruthy();
    expect(screen.getByText('バトル開始')).toBeTruthy();
    expect(screen.getAllByText('プレイヤー 1').length).toBeGreaterThan(0);
  });

  it('renders lobby controls and starts a configured battle', async () => {
    const { BattleApp } = await import('../pages/BattleApp');
    render(<BattleApp initialSettings={{ language: 'en' }} />);
    expect(screen.getByAltText('JJK Logo')).toBeTruthy();
    expect(screen.getByText('領域展開 AR')).toBeTruthy();
    expect(document.querySelector('.live2d-avatar')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Countdown/), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText(/Layout/), { target: { value: 'vertical-stack' } });
    fireEvent.click(screen.getByText('Start battle'));
    expect(command).toHaveBeenCalledWith('match.start', expect.objectContaining({
      config: expect.objectContaining({ countdownSeconds: 5, captureSnapshots: true })
    }));
    fireEvent.click(screen.getByText('Reset defaults'));
    expect(screen.getByText('Commentary is ready.')).toBeTruthy();
    fireEvent.click(screen.getByText('儲存並隱藏'));
    expect(screen.queryByLabelText(/Countdown/)).toBeNull();
    expect(screen.getByText('開始對決')).toBeTruthy();
    fireEvent.click(screen.getByText('戰局設定'));
    expect(screen.getByLabelText(/倒數時間/)).toBeTruthy();
  });

  it('handles an active battle, WebRTC viewers and a cinematic', async () => {
    gameState = makeState({
      phase: 'cinematic',
      cinematic: {
        cinematicId: 'cin-1',
        casts: [{ role: 'player1', technique: 'Lapse Blue', videoSrc: '/blue.mp4' }],
        startedAt: Date.now(),
        fallbackEndsAt: Date.now() + 60_000
      }
    });
    const { BattleApp } = await import('../pages/BattleApp');
    const { container } = render(<BattleApp initialSettings={{ language: 'en' }} />);
    await waitFor(() => expect(viewerRequested).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByText('Stop / reset'));
    expect(command).toHaveBeenCalledWith('match.reset');
    fireEvent.ended(container.querySelector('.cinematic video')!);
    expect(command).toHaveBeenCalledWith('cinematic.completed', { cinematicId: 'cin-1' });
  });

  it('waits for opening commentary playback before starting the countdown', async () => {
    let openingUtterance: { onend?: () => void } | undefined;
    vi.stubGlobal('speechSynthesis', {
      getVoices: vi.fn(() => [{ name: 'Gojo' }]),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      cancel: vi.fn(),
      speak: vi.fn((utterance) => { openingUtterance = utterance; })
    });
    api.registerRoom.mockResolvedValue(undefined);
    api.commentary.mockResolvedValue({ commentary: 'Prepare to expand your domains.' });
    gameState = makeState({
      phase: 'preparing',
      countdownEndsAt: null,
      config: { ...makeState().config, captureSnapshots: false }
    });
    const { BattleApp } = await import('../pages/BattleApp');
    render(<BattleApp initialSettings={{ language: 'en' }} />);
    await waitFor(() => expect(openingUtterance).toBeDefined());
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(command).not.toHaveBeenCalledWith('match.beginCountdown');
    openingUtterance?.onend?.();
    await waitFor(() => expect(command).toHaveBeenCalledWith('match.beginCountdown'));
  });

  it('does not let a stale introduction start a replacement match', async () => {
    let openingUtterance: { onend?: () => void } | undefined;
    vi.stubGlobal('speechSynthesis', {
      getVoices: vi.fn(() => [{ name: 'Gojo' }]),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      cancel: vi.fn(),
      speak: vi.fn((utterance) => { openingUtterance = utterance; })
    });
    api.registerRoom.mockResolvedValue(undefined);
    api.commentary.mockResolvedValue({ commentary: 'Prepare to expand your domains.' });
    gameState = makeState({
      phase: 'preparing',
      countdownEndsAt: null,
      config: { ...makeState().config, captureSnapshots: false }
    });
    const { BattleApp } = await import('../pages/BattleApp');
    const view = render(<BattleApp initialSettings={{ language: 'en' }} />);
    await waitFor(() => expect(openingUtterance).toBeDefined());
    gameState = makeState({ matchId: null, phase: 'idle', countdownEndsAt: null });
    view.rerender(<BattleApp initialSettings={{ language: 'en' }} />);
    openingUtterance?.onend?.();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(command).not.toHaveBeenCalledWith('match.beginCountdown');
  });

  it('shows results, skips video, and requests battle commentary', async () => {
    api.commentary.mockResolvedValue({ commentary: 'Player one dominates!' });
    api.getSnapshot.mockResolvedValue({ success: true });
    gameState = makeState({ phase: 'ended', winner: 'PLAYER 1' });
    const { BattleApp } = await import('../pages/BattleApp');
    const first = render(<BattleApp initialSettings={{ language: 'en' }} />);
    await waitFor(() => expect(api.commentary).toHaveBeenCalledWith(
      '/api/battle-result', expect.objectContaining({ winner: 'PLAYER 1' })
    ));
    expect(sessionStorage.getItem('domain-expansion-v2.result-video-played.match-123')).toBe('1');
    fireEvent.click(screen.getByText('Skip result video'));
    expect(screen.getByText('PLAYER 1 WINS')).toBeTruthy();
    expect(screen.getByText('VICTORY')).toBeTruthy();
    expect(screen.getByText('📜 Scroll of Honor (領域展影)')).toBeTruthy();
    expect(screen.queryByText('Open Scroll of Honor')).toBeNull();
    fireEvent.click(screen.getByText('Back to lobby'));
    expect(command).toHaveBeenCalledWith('match.reset');
    first.unmount();
    render(<BattleApp initialSettings={{ language: 'en' }} />);
    expect(screen.queryByText('Skip result video')).toBeNull();
    expect(screen.getByText('PLAYER 1 WINS')).toBeTruthy();
  });
});

describe('ShareApp', () => {
  it('loads captures, generates, downloads, and shares a portrait', async () => {
    history.replaceState({}, '', '/share.html?session=match-1&winner=player1');
    api.getSnapshot
      .mockResolvedValueOnce({ success: true, image: 'https://img.test/p1.jpg' })
      .mockResolvedValueOnce({ success: true, image: 'https://img.test/p2.jpg' });
    api.enhancePortrait.mockResolvedValue({ imageUrl: 'https://img.test/portrait.jpg' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('image', { status: 200 })));
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) }
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const { ShareApp } = await import('../pages/ShareApp');
    render(<ShareApp />);
    await screen.findByAltText('Player 1 match capture');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'ink-wash' } });
    fireEvent.click(screen.getByText('Generate AI portrait'));
    await screen.findByAltText('AI enhanced battle portrait');
    expect(api.enhancePortrait).toHaveBeenCalledWith('match-1', 'player1', undefined, 'ink-wash');
    fireEvent.click(screen.getByText('Download images'));
    await waitFor(() => expect(click).toHaveBeenCalled());
    fireEvent.click(screen.getByText('Share result'));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(location.href));
  });

  it('reports a missing session without calling the API', async () => {
    const { ShareApp } = await import('../pages/ShareApp');
    render(<ShareApp />);
    expect(await screen.findByText('No match session was supplied.')).toBeTruthy();
    expect(screen.getByText(/No session supplied/)).toBeTruthy();
  });

  it('retries result snapshots until both player images are available', async () => {
    history.replaceState({}, '', '/share.html?session=match-retry&winner=draw');
    api.getSnapshot
      .mockResolvedValueOnce({ success: false })
      .mockResolvedValueOnce({ success: false })
      .mockResolvedValueOnce({ success: true, image: 'https://img.test/retry-p1.jpg' })
      .mockResolvedValueOnce({ success: true, image: 'https://img.test/retry-p2.jpg' });
    const { ShareApp } = await import('../pages/ShareApp');
    render(<ShareApp />);
    expect(await screen.findByText('Loading player captures…')).toBeTruthy();
    expect(await screen.findByAltText('Player 1 match capture', {}, { timeout: 2000 })).toBeTruthy();
    expect(screen.getByAltText('Player 2 match capture')).toBeTruthy();
  });
});

describe('Live2DCommentator', () => {
  it('loads the model, animates speech, follows focus, and cleans up', async () => {
    vi.stubGlobal('WebGLRenderingContext', class {});
    const scriptUrls = [
      'https://cdn.jsdelivr.net/npm/pixi.js@6.5.10/dist/browser/pixi.min.js',
      'https://cdn.jsdelivr.net/gh/dylanNew/live2d/webgl/Live2D/lib/live2d.min.js',
      'https://cdn.jsdelivr.net/npm/pixi-live2d-display/dist/cubism2.min.js'
    ];
    const scripts = scriptUrls.map((src) => {
      const script = document.createElement('script');
      script.src = src;
      script.dataset.loaded = 'true';
      document.head.appendChild(script);
      return script;
    });
    const setMouth = vi.fn();
    const focus = vi.fn();
    const model = {
      autoUpdate: true,
      anchor: { set: vi.fn() },
      focus,
      getLocalBounds: () => ({ x: 0, y: 0, width: 200, height: 400 }),
      height: 400,
      internalModel: {
        coreModel: { setParameterValueById: setMouth },
        update: vi.fn()
      },
      scale: { set: vi.fn() },
      update: vi.fn(),
      width: 200,
      x: 0,
      y: 0
    };
    const addChild = vi.fn();
    const destroy = vi.fn();
    class Application {
      stage = { addChild };
      destroy = destroy;
    }
    window.PIXI = {
      Application,
      live2d: { Live2DModel: { from: vi.fn().mockResolvedValue(model) } }
    };
    const { Live2DCommentator } = await import('../components/Live2DCommentator');
    const audioState = {
      paused: false,
      ended: false,
      currentTime: 1.25
    };
    const audio = audioState as HTMLAudioElement;
    const view = render(<Live2DCommentator audioElement={audio} speaking size={350} />);
    await waitFor(() => expect(addChild).toHaveBeenCalledWith(model));
    await waitFor(() => expect(setMouth).toHaveBeenCalled());
    expect(model.autoUpdate).toBe(false);
    expect(model.update).toHaveBeenCalled();
    const openValues = () => setMouth.mock.calls
      .filter(([id]) => id === 'ParamMouthOpenY')
      .map(([, value]) => value as number);
    await waitFor(() => expect(openValues().at(-1)).toBeGreaterThan(.5));
    const speakingValue = openValues().at(-1) ?? 0;
    audioState.paused = true;
    view.rerender(<Live2DCommentator audioElement={audio} speaking={false} size={350} />);
    await waitFor(() => expect(openValues().at(-1)).toBeLessThan(speakingValue));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 12, clientY: 34 }));
    expect(focus).toHaveBeenCalledWith(12, 34);
    view.unmount();
    expect(destroy).toHaveBeenCalled();
    scripts.forEach((script) => script.remove());
    delete window.PIXI;
  });
});
