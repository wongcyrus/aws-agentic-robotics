import { useEffect, useMemo, useRef, useState } from 'react';
import { Branding } from '../components/Branding';
import { gestureLabel, getGesture, shuffledGestures, type GestureName } from '../core/catalog';
import { deadlineFor, remainingSeconds, targetFor } from '../core/match';
import { WebRtcSignalTypeSchema, type PlayerRole } from '../core/protocol';
import { MediaPipeCameraAdapter } from '../adapters/mediaPipeCamera';
import { StableGestureRecognizer } from '../adapters/gestureRecognizer';
import { CanvasVfxAdapter } from '../adapters/vfx';
import { ApiClient } from '../services/apiClient';
import { LocalStorageTokenProvider } from '../services/auth';
import { loadSettings, saveSettings, type Settings } from '../services/settings';
import { useGameSession } from '../services/useGameSession';
import { WebRtcSessionService } from '../services/webrtcSession';
import { postToPopup, readPopupMessage } from '../services/popupMessaging';

interface SoloRound {
  active: boolean;
  score: number;
  attempted: number;
  queue: GestureName[];
  target: GestureName | null;
  deadlineAt: number | null;
  result: string | null;
}

const emptySoloRound: SoloRound = {
  active: false, score: 0, attempted: 0, queue: [], target: null, deadlineAt: null, result: null
};

export function PlayerApp({ initialSettings = {} }: { initialSettings?: Partial<Settings> } = {}) {
  const query = new URLSearchParams(location.search);
  const [settings, setSettings] = useState(() => loadSettings({
    roomCode: (query.get('room') ?? undefined)?.toUpperCase(),
    role: (query.get('role') as PlayerRole | null) ?? undefined,
    ...initialSettings
  }));
  const { state, status, config, command, signal, subscribe } = useGameSession(settings.roomCode, settings.role);
  const videoRef = useRef<HTMLVideoElement>(null), canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | undefined>(undefined), popupRef = useRef<Window | null>(null), webrtcRef = useRef<WebRtcSessionService | undefined>(undefined);
  const cameraRef = useRef<MediaPipeCameraAdapter | null>(null);
  const lastRobotActionAt = useRef(0);
  const pendingPopupMedia = useRef<string | null>(null);
  const [cameraStatus, setCameraStatus] = useState('Camera stopped');
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [detected, setDetected] = useState<GestureName | null>(null);
  const [mediaSrc, setMediaSrc] = useState<string | null>(null);
  const [mediaMuted, setMediaMuted] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [now, setNow] = useState(Date.now());
  const [solo, setSolo] = useState<SoloRound>(emptySoloRound);
  const submittedChallenge = useRef<string | null>(null);
  const submittedSoloTarget = useRef<string | null>(null);
  const capturedPhase = useRef<string | null>(null);
  const player = state?.players[settings.role] ?? null;
  const battleTarget = state ? targetFor(state, settings.role) : null;
  const battleDeadline = state ? deadlineFor(state, settings.role) : null;
  const target = settings.playerMode === 'solo' ? solo.target : battleTarget;
  const deadline = settings.playerMode === 'solo' ? solo.deadlineAt : battleDeadline;
  const score = settings.playerMode === 'solo' ? solo.score : player?.score ?? 0;
  const total = settings.playerMode === 'solo' ? settings.gestureCount : state?.config.challengeCount ?? settings.gestureCount;
  const api = useMemo(() => config ? new ApiClient(config.apiBaseUrl, new LocalStorageTokenProvider()) : null, [config]);

  const refreshCameras = async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    setCameras(devices.filter(({ kind }) => kind === 'videoinput'));
  };
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 200);
    void refreshCameras().catch((error) => console.warn('Unable to enumerate cameras', error));
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    webrtcRef.current = new WebRtcSessionService(settings.role, signal, () => undefined);
    const unsubscribe = subscribe((message) => {
      if (!message.messageType.startsWith('webrtc.')) return;
      const signalType = WebRtcSignalTypeSchema.safeParse(message.messageType.slice('webrtc.'.length));
      if (!signalType.success) return;
      const payload = message.payload as {
        from: string;
        role: 'player1' | 'player2' | 'viewer';
        data: Parameters<NonNullable<typeof webrtcRef.current>['handle']>[1];
      };
      void webrtcRef.current?.handle(signalType.data, payload.data, payload.from, payload.role, streamRef.current);
    });
    return () => {
      unsubscribe();
      webrtcRef.current?.close();
    };
  }, [settings.role, signal, subscribe]);

  const startCamera = async () => {
    const video = videoRef.current, canvas = canvasRef.current;
    if (!video || !canvas) return;
    const recognizer = new StableGestureRecognizer(), vfx = new CanvasVfxAdapter(), camera = new MediaPipeCameraAdapter();
    try {
      cameraRef.current?.stop();
      await vfx.initialize();
      await camera.start(video, settings.cameraId, (image, hands) => {
        const stable = recognizer.update(hands);
        setDetected(stable);
        vfx.draw(canvas, image, hands, stable);
      });
      cameraRef.current = camera;
      streamRef.current = canvas.captureStream(30);
      setCameraStatus('Camera + MediaPipe active');
      await refreshCameras();
      webrtcRef.current?.playerReady();
    } catch (error) {
      console.error('Camera startup failed', error);
      setCameraStatus(error instanceof Error ? error.message : 'Camera failed');
    }
  };
  const stopCamera = () => {
    cameraRef.current?.stop();
    cameraRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = undefined;
    setCameraStatus('Camera stopped');
  };
  useEffect(() => stopCamera, []);

  const triggerRobot = (gesture: GestureName) => {
    if (settings.disableRobotApi || !api || !config) return;
    const elapsed = Date.now() - lastRobotActionAt.current;
    if (elapsed < settings.robotCooldownSeconds * 1000) {
      setCameraStatus(`Robot cooldown ${Math.ceil((settings.robotCooldownSeconds * 1000 - elapsed) / 1000)}s`);
      return;
    }
    const catalogEntry = getGesture(gesture);
    if (!catalogEntry) return;
    lastRobotActionAt.current = Date.now();
    void api.triggerTechnique(settings.robotId, catalogEntry.robotTechnique, config.defaultSessionKey).catch((error) => {
      console.error('Robot technique failed', error);
      setCameraStatus(error instanceof Error ? error.message : 'Robot technique failed');
    });
  };

  const openPopup = () => {
    popupRef.current ??= window.open(`/player.html?openerOrigin=${encodeURIComponent(location.origin)}`, 'domain-v2-media');
    popupRef.current?.focus();
  };
  const playMedia = (src: string) => {
    if (settings.videoMode === 'none') return;
    if (settings.videoMode === 'integrated' || settings.videoMode === 'integrated_silent') {
      setMediaMuted(settings.videoMode === 'integrated_silent');
      setMediaSrc(src);
      return;
    }
    pendingPopupMedia.current = src;
    if (!popupRef.current || popupRef.current.closed) {
      if (!settings.autoOpenPopup) {
        setCameraStatus('Open the media popup to play the technique');
        return;
      }
      openPopup();
      return;
    }
    postToPopup(popupRef.current, { type: 'PLAY_VIDEO', videoSrc: src });
  };

  const advanceSolo = (queue: GestureName[], score: number, attempted: number) => {
    const [next, ...remaining] = queue;
    if (!next) {
      setSolo({ active: false, score, attempted, queue: [], target: null, deadlineAt: null, result: score === settings.gestureCount ? 'PERFECT!' : 'ROUND COMPLETE' });
      setMediaMuted(false);
      setMediaSrc(score === settings.gestureCount ? '/static/video/win/onepunch.mp4' : '/static/video/lose/shiba1.mp4');
      return;
    }
    submittedSoloTarget.current = null;
    setSolo({ active: true, score, attempted, queue: remaining, target: next, deadlineAt: Date.now() + settings.difficulty * 1000, result: null });
  };
  const startSolo = () => advanceSolo(shuffledGestures(settings.gestureCount), 0, 0);
  const stopSolo = () => setSolo({ ...emptySoloRound, result: 'ROUND STOPPED' });

  useEffect(() => {
    if (settings.playerMode === 'solo') {
      if (!solo.active || !solo.target || detected !== solo.target || submittedSoloTarget.current === solo.target) return;
      submittedSoloTarget.current = solo.target;
      const gesture = getGesture(solo.target);
      if (!gesture) return;
      const nextScore = solo.score + 1;
      const nextAttempted = solo.attempted + 1;
      setFeedback('SUCCESS!');
      setTimeout(() => setFeedback(''), 900);
      playMedia(gesture.video);
      triggerRobot(solo.target);
      setSolo((current) => ({ ...current, target: null, deadlineAt: null, score: nextScore, attempted: nextAttempted }));
      setTimeout(() => advanceSolo(solo.queue, nextScore, nextAttempted), 850);
      return;
    }

    const challenge = player?.challenge;
    const acceptingScore = state?.phase === 'playing' || (state?.phase === 'resolving' && now <= (state.resolution?.acceptUntil ?? 0));
    if (!state || !acceptingScore || !battleTarget || detected !== battleTarget || !challenge || submittedChallenge.current === challenge.challengeId) return;
    const gesture = getGesture(battleTarget);
    if (!gesture) return;
    submittedChallenge.current = challenge.challengeId;
    setFeedback('SUCCESS!');
    setTimeout(() => setFeedback(''), 900);
    command('challenge.succeeded', { challengeId: challenge.challengeId, technique: battleTarget, videoSrc: gesture.video });
    triggerRobot(battleTarget);
  }, [battleTarget, command, detected, now, player?.challenge, settings.playerMode, solo, state]);

  useEffect(() => {
    if (settings.playerMode === 'solo') {
      if (solo.active && solo.target && solo.deadlineAt && now >= solo.deadlineAt && submittedSoloTarget.current !== solo.target) {
        submittedSoloTarget.current = solo.target;
        const attempted = solo.attempted + 1;
        advanceSolo(solo.queue, solo.score, attempted);
      }
      return;
    }
    const challenge = player?.challenge;
    if (state?.phase === 'playing' && challenge?.deadlineAt && remainingSeconds(challenge.deadlineAt, now) === 0 && submittedChallenge.current !== challenge.challengeId) {
      submittedChallenge.current = challenge.challengeId;
      command('challenge.timedOut', { challengeId: challenge.challengeId });
    }
  }, [command, now, player?.challenge, settings.playerMode, solo, state?.phase]);

  useEffect(() => {
    if (!state?.matchId || !canvasRef.current || !cameraRef.current || !api || !state.config.captureSnapshots) return;
    const phase = state.phase === 'countdown' ? 'START' : state.phase === 'ended' ? 'END' : null;
    const captureKey = phase ? `${state.matchId}:${phase}` : null;
    if (!phase || capturedPhase.current === captureKey) return;
    capturedPhase.current = captureKey;
    void api.uploadSnapshot(state.matchId, settings.role, phase, canvasRef.current.toDataURL('image/jpeg', .82)).catch((error) => {
      console.warn('Snapshot upload failed', error);
      setCameraStatus(error instanceof Error ? error.message : 'Snapshot upload failed');
    });
  }, [api, cameraStatus, settings.role, state?.config.captureSnapshots, state?.matchId, state?.phase]);

  useEffect(() => {
    const cast = state?.cinematic?.casts.find(({ role }) => role === settings.role) ?? state?.cinematic?.casts[0];
    if (cast?.videoSrc) playMedia(cast.videoSrc);
  }, [settings.role, state?.cinematic?.cinematicId]);

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (readPopupMessage(event, popupRef.current)?.type !== 'PLAYER_READY') return;
      setCameraStatus((value) => `${value}; popup ready`);
      if (popupRef.current && pendingPopupMedia.current) {
        postToPopup(popupRef.current, { type: 'PLAY_VIDEO', videoSrc: pendingPopupMedia.current });
        pendingPopupMedia.current = null;
      }
    };
    addEventListener('message', listener);
    return () => removeEventListener('message', listener);
  }, []);

  return <main className="player-page">
    <Branding />
    <video ref={videoRef} className="source-video" playsInline muted />
    <canvas ref={canvasRef} className="camera-canvas" />
    <header className="player-header">
      <img src="/static/img/jujutsu-kaisen-logo.png" alt="Jujutsu Kaisen" />
      <span className="role-pill">{settings.playerMode === 'solo' ? 'SOLO' : `${settings.role} · ${settings.roomCode}`}</span>
      <h1>領域展開 AR <b>V2</b></h1>
      <p>{settings.playerMode === 'solo' ? 'Local solo round' : status} · {cameraStatus}</p>
    </header>
    <section className="hud">
      <small>TARGET</small><strong style={{ color: getGesture(target)?.color }}>{gestureLabel(target, settings.language) ?? 'Waiting for battle'}</strong>
      <div><span>Score {score}/{total}</span><span>{remainingSeconds(deadline, now)}s</span></div>
      <em>Detected: {gestureLabel(detected, settings.language) ?? '—'}</em>
    </section>
    {feedback && <div className="success-feedback">{feedback}</div>}
    <aside className="settings-card">
      <div className="button-row"><button onClick={() => void startCamera()}>Start camera</button><button onClick={stopCamera}>Stop</button></div>
      <label>Mode<select value={settings.playerMode} onChange={(event) => setSettings({ ...settings, playerMode: event.target.value as typeof settings.playerMode })}><option value="battle">Online battle</option><option value="solo">Solo mini-game</option></select></label>
      {settings.playerMode === 'solo'
        ? <div className="button-row"><button className="primary" onClick={startSolo}>Start round</button><button onClick={stopSolo}>Quit</button></div>
        : <>
          <label>Room<input value={settings.roomCode} onChange={(event) => setSettings({ ...settings, roomCode: event.target.value.toUpperCase() })} /></label>
          <label>Role<select value={settings.role} onChange={(event) => setSettings({ ...settings, role: event.target.value as PlayerRole })}><option value="player1">Player 1</option><option value="player2">Player 2</option></select></label>
        </>}
      <details>
        <summary>Player settings</summary>
        <label>Camera<select value={settings.cameraId} onChange={(event) => setSettings({ ...settings, cameraId: event.target.value })}><option value="default">Default camera</option>{cameras.map((camera, index) => <option key={camera.deviceId} value={camera.deviceId}>{camera.label || `Camera ${index + 1}`}</option>)}</select></label>
        <label>Language<select value={settings.language} onChange={(event) => setSettings({ ...settings, language: event.target.value as typeof settings.language })}><option value="zh-HK">廣東話</option><option value="zh-TW">繁體中文</option><option value="en">English</option><option value="ja">日本語</option></select></label>
        <label>Video<select value={settings.videoMode} onChange={(event) => setSettings({ ...settings, videoMode: event.target.value as typeof settings.videoMode })}><option value="integrated">Integrated with sound</option><option value="integrated_silent">Integrated silent</option><option value="popup">Popup tab</option><option value="none">No video</option></select></label>
        <label><input type="checkbox" checked={settings.autoOpenPopup} onChange={(event) => setSettings({ ...settings, autoOpenPopup: event.target.checked })} /> Auto-open popup</label>
        <button onClick={openPopup}>Open media popup</button>
        <label>Round seconds <input type="range" min="3" max="15" value={settings.difficulty} onChange={(event) => setSettings({ ...settings, difficulty: Number(event.target.value) })} />{settings.difficulty}s</label>
        <label>Techniques <input type="range" min="1" max="11" value={settings.gestureCount} onChange={(event) => setSettings({ ...settings, gestureCount: Number(event.target.value) })} />{settings.gestureCount}</label>
        <label>Robot<select value={settings.robotId} onChange={(event) => setSettings({ ...settings, robotId: event.target.value })}><option value="all">All robots</option>{[1,2,3,4,5,6].map((number) => <option key={number} value={`robot_${number}`}>Robot {number}</option>)}</select></label>
        <label>Robot cooldown <input type="range" min="1" max="30" value={settings.robotCooldownSeconds} onChange={(event) => setSettings({ ...settings, robotCooldownSeconds: Number(event.target.value) })} />{settings.robotCooldownSeconds}s</label>
        <label><input type="checkbox" checked={settings.disableRobotApi} onChange={(event) => setSettings({ ...settings, disableRobotApi: event.target.checked })} /> Disable robot API</label>
      </details>
      <button onClick={() => {
        saveSettings(settings);
        location.search = settings.playerMode === 'battle' ? `?room=${settings.roomCode}&role=${settings.role}` : '';
      }}>Save settings</button>
      <a href={`/battle.html?room=${settings.roomCode}`}>Open battle viewer</a>
    </aside>
    {mediaSrc && <video className="integrated-media" src={mediaSrc} autoPlay muted={mediaMuted} playsInline controls onEnded={() => setMediaSrc(null)} />}
    {solo.result && <section className="result"><h2>{solo.result}</h2><p>Final score: {solo.score}/{settings.gestureCount}</p><button onClick={startSolo}>Play again</button><button onClick={() => setSolo(emptySoloRound)}>Close</button></section>}
  </main>;
}
