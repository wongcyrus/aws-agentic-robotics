import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../services/apiClient';
import {
  currentUsername,
  hasConfiguredAuthentication,
  LocalStorageTokenProvider,
  signIn,
  signOut
} from '../services/auth';
import { CommentaryPlayer } from '../services/commentary';
import { loadConfig, resolveApiBaseUrl } from '../services/config';
import { popupOrigin, postToPopup, readPopupMessage } from '../services/popupMessaging';
import { defaultSettings, loadSettings, roleLabel, saveSettings } from '../services/settings';
import { AuthGate } from '../components/AuthGate';

const configured = {
  protocolVersion: '2.0' as const,
  webSocketUrl: 'wss://example.test/control',
  apiBaseUrl: 'https://example.test',
  robotApiEndpoint: '',
  defaultRoomCode: 'BTL1',
  defaultSessionKey: 'key',
  cognitoUserPoolId: 'pool',
  cognitoUserPoolClientId: 'client',
  cognitoRegion: 'ap-southeast-1'
};

describe('settings and popup messaging', () => {
  it('loads, validates, saves and labels settings', () => {
    localStorage.setItem('domain-expansion-v2.settings', JSON.stringify({ language: 'en', difficulty: 5 }));
    expect(loadSettings({ role: 'player2' })).toMatchObject({ language: 'en', difficulty: 5, role: 'player2' });
    localStorage.setItem('domain-expansion-v2.settings', '{bad');
    expect(loadSettings()).toEqual(defaultSettings);
    expect(loadSettings({ roomCode: undefined, language: 'en' })).toMatchObject({
      roomCode: defaultSettings.roomCode,
      language: 'en'
    });
    saveSettings({ ...defaultSettings, roomCode: 'ROOM9' });
    expect(loadSettings().roomCode).toBe('ROOM9');
    expect(roleLabel('player1')).toBe('Player 1');
    expect(roleLabel('player2')).toBe('Player 2');
  });

  it('posts and validates same-origin popup messages', () => {
    const target = { postMessage: vi.fn() } as unknown as Window;
    postToPopup(target, { type: 'PLAY_VIDEO', videoSrc: '/clip.mp4' });
    expect(target.postMessage).toHaveBeenCalledWith(
      { type: 'PLAY_VIDEO', videoSrc: '/clip.mp4' },
      popupOrigin()
    );
    const source = {} as Window;
    expect(readPopupMessage(new MessageEvent('message', {
      origin: location.origin, source, data: { type: 'PLAYER_READY' }
    }), source)).toEqual({ type: 'PLAYER_READY' });
    expect(readPopupMessage(new MessageEvent('message', {
      origin: 'https://evil.test', data: { type: 'PLAYER_READY' }
    }))).toBeNull();
    expect(readPopupMessage(new MessageEvent('message', {
      origin: location.origin, data: { type: 'UNKNOWN' }
    }))).toBeNull();
  });
});

describe('authentication and API client', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));

  it('tracks valid and expired Cognito tokens', () => {
    expect(hasConfiguredAuthentication(configured)).toBe(true);
    expect(hasConfiguredAuthentication({ ...configured, cognitoRegion: '' })).toBe(false);
    localStorage.setItem('cognito_id_token', 'id-token');
    localStorage.setItem('cognito_token_expiry', String(Math.floor(Date.now() / 1000) + 30));
    expect(new LocalStorageTokenProvider().getIdToken()).toBe('id-token');
    localStorage.setItem('cognito_token_expiry', '1');
    expect(new LocalStorageTokenProvider().getIdToken()).toBeNull();
  });

  it('signs in, reports failures, and signs out', async () => {
    await expect(signIn({ ...configured, cognitoRegion: '' }, 'a', 'b'))
      .rejects.toThrow('not configured');
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      AuthenticationResult: { IdToken: 'id', AccessToken: 'access', ExpiresIn: 60 }
    }), { status: 200 }));
    await signIn(configured, 'sorcerer@example.com', 'secret');
    expect(currentUsername()).toBe('sorcerer@example.com');
    expect(localStorage.getItem('cognito_id_token')).toBe('id');
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ message: 'Denied' }), { status: 400 }));
    await expect(signIn(configured, 'bad', 'bad')).rejects.toThrow('Denied');
    signOut();
    expect(currentUsername()).toBeNull();
  });

  it('sends authenticated JSON requests and handles blobs and errors', async () => {
    const client = new ApiClient('https://api.test/', { getIdToken: () => 'token' });
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { 'content-type': 'application/json' }
      }))
      .mockResolvedValueOnce(new Response('image', {
        status: 200, headers: { 'content-type': 'image/jpeg' }
      }))
      .mockResolvedValueOnce(new Response('broken', { status: 503 }));
    await expect(client.triggerTechnique('robot_1', 'blue', 'key')).resolves.toEqual({ ok: true });
    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect((init?.headers as Headers).get('Authorization')).toBe('Bearer token');
    expect((init?.headers as Headers).get('Content-Type')).toBe('application/json');
    await expect(client.getSnapshot('match one', 'player1')).resolves.toBeInstanceOf(Blob);
    await expect(client.commentary('/api/live-status', {})).rejects.toThrow('API 503: broken');
  });

  it('covers every public API route', async () => {
    vi.mocked(fetch).mockImplementation(() => Promise.resolve(new Response('{}', {
      status: 200, headers: { 'content-type': 'application/json' }
    })));
    const client = new ApiClient('', { getIdToken: () => null });
    await client.registerRoom('s', 'ROOM', 'wss://socket');
    await client.commentary('/api/live-status', { eventType: 'RESET' });
    await client.uploadSnapshot('s', 'player2', 'END', 'image');
    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toEqual([
      '/api/register-room', '/api/live-status', '/api/webcam-upload'
    ]);
  });
});

describe('configuration, commentary and auth gate', () => {
  it('loads remote config and caches it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(configured), {
      status: 200, headers: { 'content-type': 'application/json' }
    })));
    const first = await loadConfig();
    const second = await loadConfig();
    expect(first.webSocketUrl).toBe(configured.webSocketUrl);
    expect(first.apiBaseUrl).toBe(configured.apiBaseUrl);
    expect(second).toBe(first);
  });

  it('uses the current origin when the configured API URL is empty', () => {
    expect(resolveApiBaseUrl('')).toBe(location.origin);
  });

  it('falls back to browser speech when AWS audio fails', async () => {
    const cancel = vi.fn(), speak = vi.fn(), getVoices = vi.fn(() => [{ name: 'Gojo' }]);
    vi.stubGlobal('speechSynthesis', { cancel, speak, getVoices });
    vi.stubGlobal('SpeechSynthesisUtterance', class {
      lang = ''; volume = 0; voice: unknown = null;
      constructor(public text: string) {}
    });
    const play = vi.fn().mockRejectedValue(new Error('autoplay'));
    vi.stubGlobal('Audio', class {
      volume = 0; play = play; pause = vi.fn(); removeAttribute = vi.fn(); load = vi.fn();
    });
    const player = new CommentaryPlayer();
    await player.play({ commentary: 'Domain!', ttsMode: 'aws', audioUrl: '/speech.mp3' }, {
      ...defaultSettings, language: 'en', commentaryVoice: 'Gojo', commentaryVolume: 50
    });
    expect(play).toHaveBeenCalled();
    expect(speak).toHaveBeenCalledWith(expect.objectContaining({ text: 'Domain!', lang: 'en', volume: .5 }));
    player.stop();
    expect(cancel).toHaveBeenCalled();
    await player.play({}, defaultSettings);
    await player.play({ commentary: 'ignored' }, { ...defaultSettings, commentatorEnabled: false });
  });

  it('starts browser lip sync without waiting for the speech onstart event', async () => {
    const speakingChanges: boolean[] = [];
    vi.stubGlobal('speechSynthesis', {
      cancel: vi.fn(),
      speak: vi.fn(),
      getVoices: vi.fn(() => [])
    });
    vi.stubGlobal('SpeechSynthesisUtterance', class {
      lang = ''; volume = 0; voice: unknown = null;
      constructor(public text: string) {}
    });
    const player = new CommentaryPlayer((speaking) => speakingChanges.push(speaking));

    await player.play({ commentary: 'Opening message' }, defaultSettings);

    expect(speakingChanges.at(-1)).toBe(true);
  });

  it('exposes the active AWS audio clock and clears it when playback ends', async () => {
    vi.stubGlobal('speechSynthesis', { cancel: vi.fn() });
    let audioInstance: {
      onplay?: () => void;
      onended?: () => void;
      onerror?: () => void;
    } | undefined;
    vi.stubGlobal('Audio', class {
      volume = 0; paused = false; ended = false; currentTime = 0;
      onplay?: () => void; onended?: () => void; onerror?: () => void;
      pause = vi.fn(); removeAttribute = vi.fn(); load = vi.fn();
      play = vi.fn(async () => {
        this.onplay?.();
      });
      constructor() {
        audioInstance = this;
      }
    });
    const speakingChanges: boolean[] = [];
    const audioChanges: Array<HTMLAudioElement | undefined> = [];
    const player = new CommentaryPlayer(
      (speaking) => speakingChanges.push(speaking),
      (audio) => audioChanges.push(audio)
    );
    await player.play({ commentary: 'Domain!', ttsMode: 'aws', audioUrl: '/speech.mp3' }, defaultSettings);
    expect(audioChanges.at(-1)).toBeDefined();
    expect(speakingChanges.at(-1)).toBe(true);
    let playbackFinished = false;
    void player.waitForPlayback().then(() => { playbackFinished = true; });
    await Promise.resolve();
    expect(playbackFinished).toBe(false);
    audioInstance?.onended?.();
    await player.waitForPlayback();
    expect(playbackFinished).toBe(true);
    expect(audioChanges.at(-1)).toBeUndefined();
    expect(speakingChanges.at(-1)).toBe(false);
  });

  it('finishes playback on AWS audio errors and cleans up active audio when stopped', async () => {
    vi.stubGlobal('speechSynthesis', { cancel: vi.fn() });
    let audioInstance: {
      onerror?: () => void;
      pause: ReturnType<typeof vi.fn>;
      removeAttribute: ReturnType<typeof vi.fn>;
      load: ReturnType<typeof vi.fn>;
    } | undefined;
    vi.stubGlobal('Audio', class {
      volume = 0; paused = false; ended = false; currentTime = 0;
      onplay?: () => void; onended?: () => void; onerror?: () => void;
      pause = vi.fn(); removeAttribute = vi.fn(); load = vi.fn();
      play = vi.fn().mockResolvedValue(undefined);
      constructor() { audioInstance = this; }
    });
    const player = new CommentaryPlayer();
    await player.play({ commentary: 'Status', ttsMode: 'aws', audioUrl: '/speech.mp3' }, defaultSettings);
    audioInstance?.onerror?.();
    await player.waitForPlayback();
    await player.play({ commentary: 'Status', ttsMode: 'aws', audioUrl: '/speech.mp3' }, defaultSettings);
    const activeAudio = audioInstance;
    player.stop();
    expect(activeAudio?.pause).toHaveBeenCalled();
    expect(activeAudio?.removeAttribute).toHaveBeenCalledWith('src');
    expect(activeAudio?.load).toHaveBeenCalled();
  });

  it('resolves browser speech playback on completion and error', async () => {
    let utterance: {
      onstart?: () => void;
      onend?: () => void;
      onerror?: () => void;
    } | undefined;
    vi.stubGlobal('speechSynthesis', {
      cancel: vi.fn(),
      speak: vi.fn(),
      getVoices: vi.fn(() => [])
    });
    vi.stubGlobal('SpeechSynthesisUtterance', class {
      lang = ''; volume = 0; voice: unknown = null;
      onstart?: () => void; onend?: () => void; onerror?: () => void;
      constructor(public text: string) { utterance = this; }
    });
    const speakingChanges: boolean[] = [];
    const player = new CommentaryPlayer((speaking) => speakingChanges.push(speaking));

    await player.play({ commentary: 'First' }, defaultSettings);
    utterance?.onstart?.();
    utterance?.onend?.();
    await player.waitForPlayback();
    expect(speakingChanges.at(-1)).toBe(false);

    await player.play({ commentary: 'Second' }, defaultSettings);
    utterance?.onerror?.();
    await player.waitForPlayback();
    expect(speakingChanges.at(-1)).toBe(false);
  });

  it('authenticates through the gate and renders children', async () => {
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        AuthenticationResult: { IdToken: 'id', AccessToken: 'access' }
      }), { status: 200 })));
    render(<AuthGate><div>Protected arena</div></AuthGate>);
    expect(screen.getByText(/Loading Domain/)).toBeTruthy();
    await screen.findByText('Release Domain');
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'user@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByText('Release Domain'));
    await screen.findByText('Protected arena');
    expect(screen.getByText('user@example.com')).toBeTruthy();
  });
});
