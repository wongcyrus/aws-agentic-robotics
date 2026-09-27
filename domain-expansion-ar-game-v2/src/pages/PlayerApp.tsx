import { useEffect, useMemo, useRef, useState } from 'react';
import { Branding } from '../components/Branding';
import { getGesture, type GestureName } from '../core/catalog';
import { deadlineFor, remainingSeconds, targetFor } from '../core/match';
import { WebRtcSignalTypeSchema, type PlayerRole } from '../core/protocol';
import { MediaPipeCameraAdapter } from '../adapters/mediaPipeCamera';
import { StableGestureRecognizer } from '../adapters/gestureRecognizer';
import { CanvasVfxAdapter } from '../adapters/vfx';
import { ApiClient } from '../services/apiClient';
import { LocalStorageTokenProvider } from '../services/auth';
import { loadSettings, saveSettings } from '../services/settings';
import { useGameSession } from '../services/useGameSession';
import { WebRtcSessionService } from '../services/webrtcSession';
import { postToPopup, readPopupMessage } from '../services/popupMessaging';

export function PlayerApp() {
  const query = new URLSearchParams(location.search);
  const [settings, setSettings] = useState(() => loadSettings({
    roomCode: (query.get('room') ?? undefined)?.toUpperCase(),
    role: (query.get('role') as PlayerRole | null) ?? undefined
  }));
  const { state, status, config, command, signal, subscribe } = useGameSession(settings.roomCode, settings.role);
  const videoRef = useRef<HTMLVideoElement>(null), canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | undefined>(undefined), popupRef = useRef<Window | null>(null), webrtcRef = useRef<WebRtcSessionService | undefined>(undefined);
  const cameraRef = useRef<MediaPipeCameraAdapter | null>(null);
  const [cameraStatus, setCameraStatus] = useState('Camera stopped');
  const [detected, setDetected] = useState<GestureName | null>(null);
  const [mediaSrc, setMediaSrc] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const submittedChallenge = useRef<string | null>(null);
  const capturedPhase = useRef<string | null>(null);
  const player = state?.players[settings.role] ?? null;
  const target = state ? targetFor(state, settings.role) : null;
  const deadline = state ? deadlineFor(state, settings.role) : null;
  const api = useMemo(() => config ? new ApiClient(config.apiBaseUrl, new LocalStorageTokenProvider()) : null, [config]);

  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 200); return () => clearInterval(timer); }, []);
  useEffect(() => {
    webrtcRef.current = new WebRtcSessionService(settings.role, signal, () => undefined);
    return subscribe((message) => {
      if (message.messageType.startsWith('webrtc.')) {
        const signalType = WebRtcSignalTypeSchema.safeParse(message.messageType.slice('webrtc.'.length));
        if (signalType.success) {
          const payload = message.payload as { from: string; role: 'player1' | 'player2' | 'viewer'; data: Parameters<NonNullable<typeof webrtcRef.current>['handle']>[1] };
          void webrtcRef.current?.handle(signalType.data, payload.data, payload.from, payload.role, streamRef.current);
        }
      }
    });
  }, [settings.role, signal, subscribe]);

  const startCamera = async () => {
    const video = videoRef.current, canvas = canvasRef.current;
    if (!video || !canvas) return;
    const recognizer = new StableGestureRecognizer(), vfx = new CanvasVfxAdapter(), camera = new MediaPipeCameraAdapter();
    try {
      cameraRef.current?.stop();
      await vfx.initialize();
      await camera.start(video, settings.cameraId, (image, hands) => {
        const stable = recognizer.update(hands); setDetected(stable); vfx.draw(canvas, image, hands, stable);
      });
      cameraRef.current = camera;
      streamRef.current = canvas.captureStream(30);
      setCameraStatus('Camera + MediaPipe active');
      webrtcRef.current?.playerReady();
    } catch (error) { setCameraStatus(error instanceof Error ? error.message : 'Camera failed'); }
  };
  useEffect(() => () => {
    cameraRef.current?.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  useEffect(() => {
    const challenge = player?.challenge;
    const acceptingScore = state?.phase === 'playing' || (state?.phase === 'resolving' && now <= (state.resolution?.acceptUntil ?? 0));
    if (!state || !acceptingScore || !target || detected !== target || !challenge || submittedChallenge.current === challenge.challengeId) return;
    const gesture = getGesture(target); if (!gesture) return;
    submittedChallenge.current = challenge.challengeId;
    command('challenge.succeeded', { challengeId: challenge.challengeId, technique: target, videoSrc: gesture.video });
    if (!settings.disableRobotApi && api && config) void api.triggerTechnique(settings.robotId, gesture.robotTechnique, config.defaultSessionKey).catch(console.warn);
  }, [api, command, config, detected, now, player?.challenge, settings, state, target]);

  useEffect(() => {
    const challenge = player?.challenge;
    if (state?.phase === 'playing' && challenge?.deadlineAt && remainingSeconds(challenge.deadlineAt, now) === 0 && submittedChallenge.current !== challenge.challengeId) {
      submittedChallenge.current = challenge.challengeId;
      command('challenge.timedOut', { challengeId: challenge.challengeId });
    }
  }, [command, now, player?.challenge, state?.phase]);

  useEffect(() => {
    if (!state?.matchId || !canvasRef.current || !api) return;
    const phase = state.phase === 'countdown' ? 'START' : state.phase === 'ended' ? 'END' : null;
    const captureKey = phase ? `${state.matchId}:${phase}` : null;
    if (!phase || capturedPhase.current === captureKey) return;
    capturedPhase.current = captureKey;
    void api.uploadSnapshot(state.matchId, settings.role, phase, canvasRef.current.toDataURL('image/jpeg', .82)).catch(console.warn);
  }, [api, settings.role, state?.matchId, state?.phase]);

  useEffect(() => {
    const cast = state?.cinematic?.casts.find(({ role }) => role === settings.role) ?? state?.cinematic?.casts[0];
    if (cast?.videoSrc) playMedia(cast.videoSrc);
  }, [settings.role, state?.cinematic?.cinematicId]);

  const playMedia = (src: string) => {
    if (settings.videoMode === 'none') return;
    if (settings.videoMode === 'integrated') {
      setMediaSrc(src);
      return;
    }
    if (settings.videoMode === 'popup') {
      popupRef.current ??= window.open(`/player.html?openerOrigin=${encodeURIComponent(location.origin)}`, 'domain-v2-media');
      if (popupRef.current) postToPopup(popupRef.current, { type: 'PLAY_VIDEO', videoSrc: src });
    }
  };
  useEffect(() => {
    const listener = (event: MessageEvent) => { if (readPopupMessage(event, popupRef.current)?.type === 'PLAYER_READY') setCameraStatus((value) => `${value}; popup ready`); };
    addEventListener('message', listener); return () => removeEventListener('message', listener);
  }, []);

  return <main className="player-page">
    <Branding />
    <video ref={videoRef} className="source-video" playsInline muted />
    <canvas ref={canvasRef} className="camera-canvas" />
    <header className="player-header">
      <img src="/static/img/jujutsu-kaisen-logo.png" alt="Jujutsu Kaisen" />
      <span className="role-pill">{settings.role} · {settings.roomCode}</span>
      <h1>領域展開 AR <b>V2</b></h1>
      <p>{status} · {cameraStatus}</p>
    </header>
    <section className="hud">
      <small>TARGET</small><strong style={{ color: getGesture(target)?.color }}>{target ?? 'Waiting for battle'}</strong>
      <div><span>Score {player?.score ?? 0}/{state?.config.challengeCount ?? settings.gestureCount}</span><span>{remainingSeconds(deadline, now)}s</span></div>
      <em>Detected: {detected ?? '—'}</em>
    </section>
    <aside className="settings-card">
      <button onClick={startCamera}>Start camera</button>
      <label>Room<input value={settings.roomCode} onChange={(e) => setSettings({ ...settings, roomCode: e.target.value.toUpperCase() })} /></label>
      <label>Role<select value={settings.role} onChange={(e) => setSettings({ ...settings, role: e.target.value as PlayerRole })}><option value="player1">Player 1</option><option value="player2">Player 2</option></select></label>
      <label>Robot<select value={settings.robotId} onChange={(e) => setSettings({ ...settings, robotId: e.target.value })}><option value="all">All robots</option>{[1,2,3,4,5,6].map((n) => <option key={n} value={`robot_${n}`}>Robot {n}</option>)}</select></label>
      <label><input type="checkbox" checked={settings.disableRobotApi} onChange={(e) => setSettings({ ...settings, disableRobotApi: e.target.checked })} /> Disable robot API</label>
      <button onClick={() => { saveSettings(settings); location.search = `?room=${settings.roomCode}&role=${settings.role}`; }}>Save & reconnect</button>
      <a href={`/battle.html?room=${settings.roomCode}`}>Open battle viewer</a>
    </aside>
    {settings.videoMode === 'integrated' && mediaSrc && <video className="integrated-media" src={mediaSrc} autoPlay muted playsInline onEnded={() => setMediaSrc(null)} />}
  </main>;
}
