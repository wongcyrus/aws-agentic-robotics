import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

type Role = 'viewer' | 'player1' | 'player2';

export type Arena = {
  room: string;
  viewerContext: BrowserContext;
  player1Context: BrowserContext;
  player2Context: BrowserContext;
  viewer: Page;
  player1: Page;
  player2: Page;
};

const defaultSettings = {
  roomCode: 'BTL1',
  role: 'player1',
  playerMode: 'battle',
  cameraId: 'default',
  language: 'en',
  robotId: 'all',
  disableRobotApi: false,
  robotCooldownSeconds: 10,
  videoMode: 'integrated_silent',
  autoOpenPopup: false,
  difficulty: 3,
  gestureCount: 1,
  countdownSeconds: 1,
  scoreGraceMs: 5000,
  synchronizedGestures: false,
  layout: 'side-by-side',
  dynamicView: true,
  commentatorEnabled: false,
  commentaryEngine: 'openclaw',
  commentaryTtsMode: 'browser',
  commentaryVoice: 'auto',
  commentaryVolume: 0,
  commentatorWebcam: false,
  commentatorImagePolicy: 'never',
  foulLanguage: false,
  aiPortraitEnabled: false,
  avatarSize: 350
};

const browserMocks = ({ role, room, settings, token, tokenExpiry, stableClientId }: {
  role: Role;
  room: string;
  settings: Record<string, unknown>;
  token?: string;
  tokenExpiry: number;
  stableClientId?: string;
}) => {
  const makeHand = (
    wristX = .5,
    wristY = .8,
    states: ('extended' | 'closed' | 'neutral')[] = ['neutral', 'neutral', 'neutral', 'neutral']
  ) => {
    const hand = Array.from({ length: 21 }, () => ({ x: wristX, y: wristY, z: 0 }));
    hand[0] = { x: wristX, y: wristY, z: 0 };
    hand[4] = { x: wristX - .08, y: wristY - .1, z: 0 };
    const fingers = [[5, 6, 8], [9, 10, 12], [13, 14, 16], [17, 18, 20]];
    fingers.forEach(([mcp, pip, tip], index) => {
      const x = wristX + (index - 1.5) * .04;
      hand[mcp] = { x, y: wristY - .15, z: 0 };
      hand[pip] = { x, y: wristY - .25, z: 0 };
      hand[tip] = states[index] === 'extended'
        ? { x, y: wristY - .48, z: 0 }
        : states[index] === 'closed'
          ? { x, y: wristY - .1, z: 0 }
          : { x: x + .1, y: wristY - .15, z: 0 };
    });
    return hand;
  };

  const gestureHands = (name: string | null) => {
    if (!name) return [];
    if (name === 'Lapse Blue') return [makeHand(.5, .8, ['extended', 'closed', 'neutral', 'neutral'])];
    if (name === 'Reversal Red') return [makeHand(.5, .8, ['extended', 'extended', 'extended', 'neutral'])];
    if (name === 'Hollow Purple') return [
      makeHand(.35, .8, ['extended', 'closed', 'neutral', 'neutral']),
      makeHand(.65, .8, ['extended', 'extended', 'extended', 'neutral'])
    ];
    if (name === 'Unlimited Void') {
      const hand = makeHand(.5, .8, ['extended', 'neutral', 'neutral', 'neutral']);
      hand[12] = { ...hand[8], x: hand[8].x + .03 };
      return [hand];
    }
    if (name === 'Time Cell Moon Palace') {
      const timeHand = (x: number) => {
        const hand = makeHand(x, .8, ['extended', 'neutral', 'neutral', 'neutral']);
        hand[4] = { x: x - .08, y: .5, z: 0 };
        return hand;
      };
      return [timeHand(.42), timeHand(.58)];
    }
    if (name === 'Yuji Itadori') {
      return [
        makeHand(.44, .8, ['extended', 'neutral', 'neutral', 'neutral']),
        makeHand(.56, .82, ['extended', 'neutral', 'neutral', 'neutral'])
      ];
    }
    if (name === 'Chimera Shadow Garden') {
      return [makeHand(.44, .8), makeHand(.56, .82)];
    }
    if (name === 'Malevolent Shrine') {
      return [
        makeHand(.44, .8, ['neutral', 'extended', 'extended', 'neutral']),
        makeHand(.56, .82, ['neutral', 'extended', 'extended', 'neutral'])
      ];
    }
    if (name === 'Self-Embodiment of Perfection') {
      const shaped = (x: number) => {
        const hand = makeHand(x, .8);
        hand[12] = { x: x + .25, y: .98, z: 0 };
        hand[8] = { x: hand[5].x, y: .5, z: 0 };
        hand[16] = { x: hand[13].x, y: .98, z: 0 };
        hand[20] = { x: x, y: .5, z: 0 };
        hand[4] = { x, y: .62, z: 0 };
        return hand;
      };
      return [shaped(.48), shaped(.52)];
    }
    if (name === 'Authentic Mutual Love') {
      return [
        makeHand(.2, .8, ['closed', 'closed', 'closed', 'closed']),
        makeHand(.8, .8, ['extended', 'extended', 'extended', 'extended'])
      ];
    }
    if (name === 'Idle Death Gamble') {
      const upper = makeHand(.48, .35, ['neutral', 'extended', 'neutral', 'neutral']);
      upper[4] = { ...upper[8], x: upper[8].x + .02 };
      return [
        upper,
        makeHand(.52, .75, ['extended', 'extended', 'extended', 'extended'])
      ];
    }
    return [];
  };

  const windowRecord = window as typeof window & {
    __e2eGestureQueue?: (string | null)[];
    __e2eConsumedFrames?: number;
    __e2eGestureFixture?: (name: string | null) => unknown[][];
    __e2eRoomState?: {
      roomId: string;
      phase: string;
      revision: number;
      players: Record<string, { connected: boolean }>;
    };
    __e2eRoomHistory?: {
      roomId: string;
      phase: string;
      revision: number;
      player1Connected: boolean;
      player2Connected: boolean;
      receivedAt: number;
    }[];
    __e2eLastRejected?: string;
    Hands?: new () => {
      setOptions(options: object): void;
      onResults(callback: (result: { image: CanvasImageSource; multiHandLandmarks: unknown[] }) => void): void;
      send(input: { image: HTMLVideoElement }): Promise<void>;
      close(): Promise<void>;
    };
    DomainExpansionGame?: new () => { initVFX(): void; drawVFX(): void };
  };
  windowRecord.__e2eGestureQueue = [];
  windowRecord.__e2eConsumedFrames = 0;
  windowRecord.__e2eGestureFixture = gestureHands;
  windowRecord.__e2eRoomHistory = [];
  const browserNow = Date.now.bind(Date);
  let serverClockOffset = 0;
  Date.now = () => browserNow() + serverClockOffset;
  const NativeWebSocket = window.WebSocket;
  class ObservedWebSocket extends NativeWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      if (protocols === undefined) super(url);
      else super(url, protocols);
      this.addEventListener('message', (event) => {
        try {
          const message = JSON.parse(String(event.data)) as {
            sentAt?: number;
            messageType?: string;
            payload?: {
              reason?: string;
              state?: typeof windowRecord.__e2eRoomState;
            };
          };
          if (typeof message.sentAt === 'number') {
            serverClockOffset = message.sentAt - browserNow();
          }
          if (message.messageType === 'room.snapshot' && message.payload?.state) {
            const incoming = message.payload.state;
            if (!windowRecord.__e2eRoomState ||
              incoming.revision >= windowRecord.__e2eRoomState.revision) {
              windowRecord.__e2eRoomState = incoming;
            }
            windowRecord.__e2eRoomHistory?.push({
              roomId: incoming.roomId,
              phase: incoming.phase,
              revision: incoming.revision,
              player1Connected: Boolean(incoming.players.player1?.connected),
              player2Connected: Boolean(incoming.players.player2?.connected),
              receivedAt: browserNow()
            });
            if ((windowRecord.__e2eRoomHistory?.length ?? 0) > 20) {
              windowRecord.__e2eRoomHistory?.shift();
            }
          }
          if (message.messageType === 'command.rejected') {
            windowRecord.__e2eLastRejected = message.payload?.reason ?? 'Unknown rejection';
          }
        } catch {
          // Vite development WebSocket messages are not protocol envelopes.
        }
      });
    }
  }
  Object.defineProperty(window, 'WebSocket', {
    configurable: true,
    value: ObservedWebSocket
  });
  windowRecord.Hands = class {
    private callback?: (result: { image: CanvasImageSource; multiHandLandmarks: unknown[] }) => void;
    setOptions() {}
    onResults(callback: (result: { image: CanvasImageSource; multiHandLandmarks: unknown[] }) => void) {
      this.callback = callback;
    }
    async send({ image }: { image: HTMLVideoElement }) {
      const next = windowRecord.__e2eGestureQueue?.shift() ?? null;
      windowRecord.__e2eConsumedFrames = (windowRecord.__e2eConsumedFrames ?? 0) + 1;
      this.callback?.({ image, multiHandLandmarks: windowRecord.__e2eGestureFixture?.(next) ?? [] });
    }
    async close() {}
  };
  windowRecord.DomainExpansionGame = class {
    initVFX() {}
    drawVFX() {}
  };
  class MockPeerConnection {
    connectionState = 'connected';
    signalingState = 'stable';
    remoteDescription: RTCSessionDescriptionInit | null = null;
    onicecandidate: ((event: { candidate: null }) => void) | null = null;
    ontrack: ((event: { streams: MediaStream[] }) => void) | null = null;
    onconnectionstatechange: (() => void) | null = null;
    private senders: { track: MediaStreamTrack }[] = [];
    getSenders() { return this.senders; }
    addTrack(track: MediaStreamTrack) { this.senders.push({ track }); }
    async createOffer() { return { type: 'offer' as const, sdp: 'e2e-offer' }; }
    async createAnswer() { return { type: 'answer' as const, sdp: 'e2e-answer' }; }
    async setLocalDescription() {}
    async setRemoteDescription(description: RTCSessionDescriptionInit) {
      this.remoteDescription = description;
      this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable';
    }
    async addIceCandidate() {}
    close() { this.connectionState = 'closed'; }
  }
  Object.defineProperty(window, 'RTCPeerConnection', {
    configurable: true,
    value: MockPeerConnection
  });
  Object.defineProperty(window, 'speechSynthesis', {
    configurable: true,
    value: {
      getVoices: () => [],
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      cancel: () => undefined,
      speak: () => undefined
    }
  });

  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      enumerateDevices: async () => [{
        deviceId: 'e2e-camera',
        groupId: 'e2e',
        kind: 'videoinput',
        label: 'Playwright camera',
        toJSON: () => ({})
      }],
      getUserMedia: async () => new MediaStream()
    }
  });
  HTMLMediaElement.prototype.play = async () => undefined;
  HTMLMediaElement.prototype.pause = () => undefined;
  HTMLCanvasElement.prototype.captureStream = () => new MediaStream();

  localStorage.setItem('domain-expansion-v2.settings', JSON.stringify({
    ...settings,
    roomCode: room,
    ...(role === 'viewer' ? {} : { role })
  }));
  if (stableClientId) {
    sessionStorage.setItem(
      `domain-expansion-v2.client.${room}.${role}`,
      stableClientId
    );
  }
  if (token) {
    localStorage.setItem('cognito_id_token', token);
    localStorage.setItem('cognito_token_expiry', String(tokenExpiry));
    localStorage.setItem('cognito_username', 'playwright-temporary-token');
  }
};

async function configureContext(
  browser: Browser,
  role: Role,
  room: string,
  overrides: Record<string, unknown>,
  stableClientId?: string
) {
  const context = await browser.newContext();
  const token = process.env.PLAYWRIGHT_COGNITO_ID_TOKEN;
  const tokenExpiry = Number(process.env.PLAYWRIGHT_COGNITO_TOKEN_EXPIRY) ||
    Math.floor(Date.now() / 1000) + 3600;
  await context.addInitScript(browserMocks, {
    role,
    room,
    settings: { ...defaultSettings, ...overrides },
    token,
    tokenExpiry,
    stableClientId
  });
  await context.route('https://cdn.jsdelivr.net/npm/@mediapipe/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/javascript', body: '' })
  );
  await context.route('**/api/**', (route) => {
    if (route.request().resourceType() === 'websocket') return route.continue();
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/webcam-upload' || pathname === '/api/get-snapshot') {
      return route.continue();
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true })
    });
  });
  await context.route('**/config.json', async (route) => {
    if (process.env.E2E_MODE === 'aws') {
      const original = await route.fetch();
      const config = await original.json() as Record<string, unknown>;
      await route.fulfill({
        response: original,
        json: {
          ...config,
          webSocketUrl: process.env.PLAYWRIGHT_WS_URL,
          apiBaseUrl: process.env.PLAYWRIGHT_API_BASE_URL ?? process.env.PLAYWRIGHT_BASE_URL
        }
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      json: {
        protocolVersion: '2.0',
        webSocketUrl: 'ws://127.0.0.1:4173/control',
        apiBaseUrl: 'http://127.0.0.1:4173',
        robotApiEndpoint: '',
        defaultRoomCode: 'BTL1',
        defaultSessionKey: 'e2e',
        cognitoUserPoolId: '',
        cognitoUserPoolClientId: '',
        cognitoRegion: ''
      }
    });
  });
  return context;
}

async function expectAuthoritativeRoom(
  page: Page,
  room: string,
  options: {
    phase?: string;
    player1Connected?: boolean;
    player2Connected?: boolean;
    label: string;
  }
) {
  await expect.poll(async () => page.evaluate(() => {
    const target = window as typeof window & {
      __e2eRoomState?: {
        roomId: string;
        phase: string;
        revision: number;
        players: Record<string, { connected: boolean; clientId?: string | null }>;
      };
      __e2eRoomHistory?: unknown[];
      __e2eLastRejected?: string;
    };
    const state = target.__e2eRoomState;
    return {
      roomId: state?.roomId ?? 'missing',
      phase: state?.phase ?? 'missing',
      revision: state?.revision ?? -1,
      player1Connected: Boolean(state?.players.player1?.connected),
      player2Connected: Boolean(state?.players.player2?.connected),
      player1ClientId: state?.players.player1?.clientId ?? null,
      player2ClientId: state?.players.player2?.clientId ?? null,
      rejection: target.__e2eLastRejected ?? '',
      history: target.__e2eRoomHistory ?? []
    };
  }), {
    message: options.label,
    timeout: 15_000
  }).toMatchObject({
    roomId: room,
    ...(options.phase ? { phase: options.phase } : {}),
    ...(options.player1Connected === undefined
      ? {}
      : { player1Connected: options.player1Connected }),
    ...(options.player2Connected === undefined
      ? {}
      : { player2Connected: options.player2Connected }),
    rejection: ''
  });
}

export async function openRole(
  browser: Browser,
  role: Role,
  room: string,
  overrides: Record<string, unknown> = {},
  expectedPhase?: string,
  stableClientId?: string
) {
  const context = await configureContext(browser, role, room, overrides, stableClientId);
  const page = await context.newPage();
  await page.goto(role === 'viewer'
    ? `/battle.html?room=${room}`
    : `/?room=${room}&role=${role}`);
  await expect(page.locator(role === 'viewer' ? '.battle-header' : '.settings-card .status-message'))
    .toContainText('connected');
  await expectAuthoritativeRoom(page, room, {
    phase: expectedPhase,
    ...(role === 'player1' ? { player1Connected: true } : {}),
    ...(role === 'player2' ? { player2Connected: true } : {}),
    label: `replacement ${role} did not recover authoritative ${expectedPhase ?? 'room'} state`
  });
  return { context, page };
}

export async function readClientId(page: Page, room: string, role: Role) {
  return page.evaluate(({ roomId, clientRole }) =>
    sessionStorage.getItem(`domain-expansion-v2.client.${roomId}.${clientRole}`),
  { roomId: room, clientRole: role });
}

export async function openArena(
  browser: Browser,
  room: string,
  overrides: Record<string, unknown> = {}
): Promise<Arena> {
  const [viewerContext, player1Context, player2Context] = await Promise.all([
    configureContext(browser, 'viewer', room, overrides),
    configureContext(browser, 'player1', room, overrides),
    configureContext(browser, 'player2', room, overrides)
  ]);
  const [viewer, player1, player2] = await Promise.all([
    viewerContext.newPage(),
    player1Context.newPage(),
    player2Context.newPage()
  ]);
  await viewer.goto(`/battle.html?room=${room}`);
  await expect(viewer.locator('.battle-header')).toContainText(`${room} · connected`);
  await expectAuthoritativeRoom(viewer, room, {
    label: 'viewer did not receive its initial authoritative room snapshot'
  });

  await player1.goto(`/?room=${room}&role=player1`);
  await expect(player1.locator('.settings-card .status-message')).toContainText('connected');
  await expectAuthoritativeRoom(viewer, room, {
    player1Connected: true,
    label: 'viewer did not observe Player 1 joining'
  });

  await player2.goto(`/?room=${room}&role=player2`);
  await expect(player2.locator('.settings-card .status-message')).toContainText('connected');
  await expectAuthoritativeRoom(viewer, room, {
    player1Connected: true,
    player2Connected: true,
    label: 'viewer did not observe both players joining'
  });
  if (process.env.E2E_MODE === 'aws') {
    await Promise.all([
      expect(viewer.locator('.auth-badge')).toContainText('playwright-temporary-token'),
      expect(player1.locator('.auth-badge')).toContainText('playwright-temporary-token'),
      expect(player2.locator('.auth-badge')).toContainText('playwright-temporary-token')
    ]);
    const tokenPresent = await Promise.all([
      viewer.evaluate(() => Boolean(localStorage.getItem('cognito_id_token'))),
      player1.evaluate(() => Boolean(localStorage.getItem('cognito_id_token'))),
      player2.evaluate(() => Boolean(localStorage.getItem('cognito_id_token')))
    ]);
    expect(tokenPresent).toEqual([true, true, true]);
  }
  return { room, viewerContext, player1Context, player2Context, viewer, player1, player2 };
}

export async function startCameras(arena: Arena) {
  await Promise.all([
    expect(arena.player1.getByRole('button', { name: 'Stop camera' })).toBeVisible(),
    expect(arena.player2.getByRole('button', { name: 'Stop camera' })).toBeVisible()
  ]);
  await Promise.all([
    expect(arena.player1.locator('.settings-card .status-message')).toContainText('Camera + MediaPipe active'),
    expect(arena.player2.locator('.settings-card .status-message')).toContainText('Camera + MediaPipe active')
  ]);
}

export async function queueGesture(page: Page, name: string, frames = 6) {
  await page.evaluate(({ gesture, count }) => {
    const target = window as typeof window & { __e2eGestureQueue?: (string | null)[] };
    target.__e2eGestureQueue?.push(...Array.from({ length: count }, () => gesture));
  }, { gesture: name, count: frames });
}

export async function queueFrames(page: Page, frames: (string | null)[]) {
  await page.evaluate((values) => {
    const target = window as typeof window & { __e2eGestureQueue?: (string | null)[] };
    target.__e2eGestureQueue?.push(...values);
  }, frames);
}

export async function waitForFrames(page: Page) {
  await page.waitForFunction(() => {
    const target = window as typeof window & { __e2eGestureQueue?: unknown[] };
    return target.__e2eGestureQueue?.length === 0;
  });
}

export async function clearGestureQueue(page: Page) {
  await page.evaluate(() => {
    const target = window as typeof window & { __e2eGestureQueue?: unknown[] };
    if (target.__e2eGestureQueue) target.__e2eGestureQueue.length = 0;
  });
}

export async function closeArena(arena: Arena) {
  const reset = arena.viewer.getByRole('button', { name: 'Stop / reset' });
  if (!arena.viewer.isClosed() && await reset.isVisible().catch(() => false)) {
    await reset.focus().catch(() => undefined);
    await arena.viewer.keyboard.press('Enter').catch(() => undefined);
  }
  await Promise.allSettled([
    arena.viewerContext.close(),
    arena.player1Context.close(),
    arena.player2Context.close()
  ]);
}
