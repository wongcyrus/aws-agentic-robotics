import { expect, test, type Browser } from '@playwright/test';
import {
  clearGestureQueue,
  closeArena,
  openArena,
  openRole,
  queueFrames,
  queueGesture,
  readClientId,
  startCameras,
  waitForFrames,
  type Arena
} from './browserHarness';

const activeArenas = new Set<Arena>();
const sanitizedRoomPrefix = (process.env.PLAYWRIGHT_ROOM_PREFIX ?? 'E2E')
  .toUpperCase()
  .replace(/[^A-Z0-9]/g, '');
if (!sanitizedRoomPrefix) {
  throw new Error('PLAYWRIGHT_ROOM_PREFIX must contain at least one ASCII letter or digit');
}
const roomPrefix = sanitizedRoomPrefix.slice(0, 6);
const room = (label: string) => {
  const scenario = label.replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 2);
  const suffix = Date.now().toString(36).slice(-4).toUpperCase();
  return `${roomPrefix}${scenario}${suffix}`;
};

test.afterEach(async () => {
  await Promise.all([...activeArenas].map((arena) => closeArena(arena)));
  activeArenas.clear();
});

async function arena(browser: Browser, label: string, overrides: Record<string, unknown> = {}) {
  const value = await openArena(browser, room(label), overrides);
  activeArenas.add(value);
  return value;
}

async function activateButton(page: Arena['viewer'], name: string) {
  const button = page.getByRole('button', { name });
  await expect(button).toBeVisible();
  await expect(button).toBeEnabled();
  await button.focus();
  await page.keyboard.press('Enter');
}

async function startBattle(value: Arena) {
  await activateButton(value.viewer, 'Start battle');
  await expect.poll(async () => value.viewer.evaluate(() => {
    const target = window as typeof window & {
      __e2eRoomState?: { phase: string };
      __e2eLastRejected?: string;
    };
    return {
      phase: target.__e2eRoomState?.phase ?? 'missing',
      rejection: target.__e2eLastRejected ?? ''
    };
  }), {
    message: 'authoritative room did not enter playing phase',
    timeout: 15_000
  }).toMatchObject({ phase: 'playing', rejection: '' });
  await Promise.all([
    expect(value.player1.locator('.hud strong')).not.toHaveText('Waiting for battle'),
    expect(value.player2.locator('.hud strong')).not.toHaveText('Waiting for battle')
  ]);
}

async function target(page: Arena['player1']) {
  return (await page.locator('.hud strong').textContent())!.trim();
}

async function finishCinematic(value: Arena, order: number[]) {
  const videos = value.viewer.locator('.cinematic video');
  await expect(videos).toHaveCount(order.length);
  for (const index of order) {
    await videos.nth(index).evaluate((video) => video.dispatchEvent(new Event('ended')));
  }
}

test('browser gesture fixtures reach every production recognizer branch', async ({ browser }) => {
  test.skip(
    process.env.E2E_MODE === 'aws',
    'Deployed Vite output does not expose source TypeScript modules'
  );
  const value = await arena(browser, 'fixtures');
  await expect(value.viewer.locator('.auth-page')).toHaveCount(0);
  await expect(value.player1.locator('.auth-page')).toHaveCount(0);
  await expect(value.player2.locator('.auth-page')).toHaveCount(0);
  const names = [
    'Unlimited Void',
    'Malevolent Shrine',
    'Self-Embodiment of Perfection',
    'Authentic Mutual Love',
    'Idle Death Gamble',
    'Yuji Itadori',
    'Chimera Shadow Garden',
    'Time Cell Moon Palace',
    'Lapse Blue',
    'Reversal Red',
    'Hollow Purple'
  ];
  const detected = await value.player1.evaluate(async (techniques) => {
    const { detectGesture } = await import('/src/adapters/gestureRecognizer.ts');
    const target = window as typeof window & {
      __e2eGestureFixture?: (name: string) => Parameters<typeof detectGesture>[0]
    };
    return techniques.map((name) => detectGesture(target.__e2eGestureFixture!(name)));
  }, names);
  expect(detected).toEqual(names);
});

test('three isolated browsers complete dual-success gameplay and reset', async ({ browser }) => {
  const value = await arena(browser, 'full', {
    synchronizedGestures: false,
    aiPortraitEnabled: true
  });
  await expect(value.viewer.locator('.fighter.player1')).toContainText('Waiting for player 1 stream');
  await expect(value.player1.locator('.role-pill')).toContainText(`PLAYER 1 · ${value.room}`);
  await expect(value.player2.locator('.role-pill')).toContainText(`PLAYER 2 · ${value.room}`);
  await startCameras(value);
  await startBattle(value);

  const [p1Target, p2Target] = await Promise.all([target(value.player1), target(value.player2)]);
  if (process.env.E2E_MODE !== 'aws') {
    expect(p1Target).toBe('Lapse Blue');
    expect(p2Target).toBe('Reversal Red');
  }
  await Promise.all([
    queueGesture(value.player1, p1Target),
    queueGesture(value.player2, p2Target)
  ]);
  await Promise.all([waitForFrames(value.player1), waitForFrames(value.player2)]);
  await expect(value.viewer.locator('.fighter.player1 .fighter-info strong')).toHaveText('1');
  await expect(value.viewer.locator('.fighter.player2 .fighter-info strong')).toHaveText('1');
  await finishCinematic(value, [1, 0]);
  await expect(value.viewer.locator('.result')).toBeVisible();
  await expect(value.player1.locator('.hud')).toContainText('Score 1/1');
  await expect(value.player2.locator('.hud')).toContainText('Score 1/1');

  await value.viewer.getByRole('button', { name: 'Skip result video' }).click();
  await expect(value.viewer.locator('.result')).toContainText('DRAW');
  await expect(value.viewer.getByAltText('Player 1 match capture')).toBeVisible();
  await expect(value.viewer.getByAltText('Player 2 match capture')).toBeVisible();
  await value.viewer.getByRole('button', { name: 'Back to lobby' }).click();
  await expect(value.player1.locator('.hud strong')).toHaveText('Waiting for battle');
  await expect(value.player2.locator('.hud')).toContainText('Score 0/1');
});

test('grace window accepts the second player, rejects late scoring, and falls back cinematic', async ({ browser }) => {
  const value = await arena(browser, 'grace', { scoreGraceMs: 5000 });
  await startCameras(value);
  await startBattle(value);
  const [p1Target, p2Target] = await Promise.all([target(value.player1), target(value.player2)]);
  await queueGesture(value.player1, p1Target);
  await waitForFrames(value.player1);
  await expect(value.viewer.locator('.fighter.player1 .fighter-info strong')).toHaveText('1');
  await value.player2.waitForTimeout(400);
  await queueGesture(value.player2, p2Target);
  await waitForFrames(value.player2);
  await expect(value.viewer.locator('.fighter.player2 .fighter-info strong')).toHaveText('1');
  await expect(value.viewer.locator('.cinematic')).toBeVisible();
  await expect(value.viewer.locator('.result')).toBeVisible({ timeout: 20_000 });

  await value.viewer.getByRole('button', { name: 'Skip result video' }).click();
  await value.viewer.getByRole('button', { name: 'Back to lobby' }).click();
  await startBattle(value);
  const [nextP1, nextP2] = await Promise.all([target(value.player1), target(value.player2)]);
  await Promise.all([clearGestureQueue(value.player1), clearGestureQueue(value.player2)]);
  await queueGesture(value.player1, nextP1);
  await waitForFrames(value.player1);
  await value.player2.waitForTimeout(5500);
  await queueGesture(value.player2, nextP2);
  await waitForFrames(value.player2);
  await expect(value.viewer.locator('.fighter.player2 .fighter-info strong')).toHaveText('0');
  await expect(value.player2.locator('.hud')).toContainText('Score 0/1');
  await queueFrames(value.player2, Array.from({ length: 10 }, () => null));
  await waitForFrames(value.player2);
  await finishCinematic(value, [0]);
  await expect(value.viewer.locator('.result')).toBeVisible({ timeout: 5000 });
});

test('flicker, duplicate frames, and camera restart stay idempotent', async ({ browser }) => {
  const value = await arena(browser, 'edge');
  await startCameras(value);
  await startBattle(value);
  const p1Target = await target(value.player1);
  await queueFrames(value.player1, [
    p1Target, null, p1Target, null, p1Target,
    null, p1Target, null, p1Target, null
  ]);
  await waitForFrames(value.player1);
  await expect(value.viewer.locator('.fighter.player1 .fighter-info strong')).toHaveText('0');

  await value.player1.getByRole('button', { name: 'Stop camera' }).click();
  await queueGesture(value.player1, p1Target);
  await value.player1.waitForTimeout(300);
  await expect(value.viewer.locator('.fighter.player1 .fighter-info strong')).toHaveText('0');
  await clearGestureQueue(value.player1);
  await value.player1.getByRole('button', { name: 'Start camera' }).click();
  await expect(value.player1.locator('.settings-card .status-message')).toContainText('Camera + MediaPipe active');
  await queueGesture(value.player1, p1Target);
  await waitForFrames(value.player1);
  await expect(value.viewer.locator('.fighter.player1 .fighter-info strong')).toHaveText('1');
  await queueGesture(value.player1, p1Target, 12);
  await waitForFrames(value.player1);
  await expect(value.viewer.locator('.fighter.player1 .fighter-info strong')).toHaveText('1');

  const p2Target = await target(value.player2);
  await queueGesture(value.player2, p2Target);
  await waitForFrames(value.player2);
  await expect(value.viewer.locator('.fighter.player2 .fighter-info strong')).toHaveText('1');
  await finishCinematic(value, [1, 0]);
  await expect(value.viewer.locator('.result')).toBeVisible();
});

test('deadline expiry produces one timeout outcome and rejects late recognition', async ({ browser }) => {
  const value = await arena(browser, 'timeout');
  await startCameras(value);
  await startBattle(value);
  const [p1Target, p2Target] = await Promise.all([target(value.player1), target(value.player2)]);
  await expect(value.player1.locator('.hud')).toContainText(/1s/, { timeout: 4000 });
  await expect(value.player1.locator('.hud')).toContainText(/0s/, { timeout: 2000 });
  await expect(value.viewer.locator('.result')).toBeVisible();
  await expect(value.viewer.locator('.fighter.player1 .fighter-info strong')).toHaveText('0');
  await expect(value.viewer.locator('.fighter.player2 .fighter-info strong')).toHaveText('0');
  await Promise.all([
    queueGesture(value.player1, p1Target),
    queueGesture(value.player2, p2Target)
  ]);
  await Promise.all([waitForFrames(value.player1), waitForFrames(value.player2)]);
  await expect(value.player1.locator('.hud')).toContainText('Score 0/1');
  await expect(value.player2.locator('.hud')).toContainText('Score 0/1');
});

test('player and viewer reconnect preserve live phase before viewer reset', async ({ browser }) => {
  const value = await arena(browser, 'reconnect', { difficulty: 15 });
  await startBattle(value);
  const expectedTarget = await target(value.player1);
  const playerClientId = await readClientId(value.player1, value.room, 'player1');
  const viewerClientId = await readClientId(value.viewer, value.room, 'viewer');
  expect(playerClientId).toBeTruthy();
  expect(viewerClientId).toBeTruthy();

  await value.player1Context.close();
  await value.viewer.waitForFunction(() => {
    const target = window as typeof window & {
      __e2eRoomState?: { players: { player1: { connected: boolean } } };
    };
    return target.__e2eRoomState?.players.player1.connected === false;
  });
  const replacementPlayer = await openRole(
    browser,
    'player1',
    value.room,
    { difficulty: 15 },
    'playing',
    playerClientId!
  );
  value.player1Context = replacementPlayer.context;
  value.player1 = replacementPlayer.page;
  await expect(value.player1.locator('.hud strong')).toHaveText(expectedTarget);
  await expect(value.viewer.locator('.fighter.player1')).toContainText('0');

  await value.viewerContext.close();
  const replacementViewer = await openRole(
    browser,
    'viewer',
    value.room,
    { difficulty: 15 },
    'playing',
    viewerClientId!
  );
  value.viewerContext = replacementViewer.context;
  value.viewer = replacementViewer.page;
  await expect(value.viewer.getByRole('button', { name: 'Stop / reset' })).toBeVisible();
  await expect(value.viewer.locator('.fighter.player1')).toContainText(expectedTarget);
  await activateButton(value.viewer, 'Stop / reset');
  await expect(value.player1.locator('.hud strong')).toHaveText('Waiting for battle');
  await expect(value.player2.locator('.hud strong')).toHaveText('Waiting for battle');
});
