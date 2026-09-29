import { useEffect, useMemo, useRef, useState } from 'react';
import { Branding } from '../components/Branding';
import { gestureLabel, getGesture, shuffledGestures, type GestureName } from '../core/catalog';
import { deadlineFor, remainingSeconds, targetFor } from '../core/match';
import { WebRtcSignalTypeSchema, type PlayerRole } from '../core/protocol';
import { uiText } from '../core/uiText';
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
  const text = uiText(settings.language);
  const { state, status, config, command, signal, subscribe, serverTime } = useGameSession(settings.roomCode, settings.role);
  const connectionStatus = status in text
    ? text[status as 'loading' | 'connecting' | 'connected' | 'disconnected']
    : status;
  const videoRef = useRef<HTMLVideoElement>(null), canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | undefined>(undefined), popupRef = useRef<Window | null>(null), webrtcRef = useRef<WebRtcSessionService | undefined>(undefined);
  const cameraRef = useRef<MediaPipeCameraAdapter | null>(null);
  const cameraStarting = useRef(false);
  const autoStartedCamera = useRef(false);
  const lastRobotActionAt = useRef(0);
  const pendingPopupMedia = useRef<string | null>(null);
  const detectedRef = useRef<GestureName | null>(null);
  const detectedAt = useRef<number | null>(null);
  const [cameraStatus, setCameraStatus] = useState(text.cameraStopped);
  const [cameraActive, setCameraActive] = useState(false);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [detected, setDetected] = useState<GestureName | null>(null);
  const [mediaSrc, setMediaSrc] = useState<string | null>(null);
  const [mediaMuted, setMediaMuted] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [now, setNow] = useState(Date.now());
  const [solo, setSolo] = useState<SoloRound>(emptySoloRound);
  const [showSettings, setShowSettings] = useState(false);
  const submittedChallenge = useRef<string | null>(null);
  const submittedSoloTarget = useRef<string | null>(null);
  const capturedPhase = useRef<string | null>(null);
  const capturingPhase = useRef<string | null>(null);
  const player = state?.players[settings.role] ?? null;
  const battleTarget = state ? targetFor(state, settings.role) : null;
  const battleDeadline = state ? deadlineFor(state, settings.role) : null;
  const target = settings.playerMode === 'solo' ? solo.target : battleTarget;
  const deadline = settings.playerMode === 'solo' ? solo.deadlineAt : battleDeadline;
  const score = settings.playerMode === 'solo' ? solo.score : player?.score ?? 0;
  const total = settings.playerMode === 'solo' ? settings.gestureCount : state?.config.challengeCount ?? settings.gestureCount;
  const targetLabel = (() => {
    const gesture = gestureLabel(target, settings.language);
    if (gesture) return gesture;
    if (settings.playerMode === 'solo') return solo.active ? text.prepareNext : text.startSoloRound;
    if (!state || state.phase === 'idle') return text.waitingBattle;
    if (state.phase === 'preparing' || state.phase === 'countdown') return text.getReady;
    if (state.phase === 'resolving') return text.scoreLocked;
    if (state.phase === 'cinematic') return text.techniqueActivated;
    if (state.phase === 'ended') return text.battleComplete;
    return player?.finished ? text.finished : text.prepareNext;
  })();
  const api = useMemo(
    () => config?.apiBaseUrl ? new ApiClient(config.apiBaseUrl, new LocalStorageTokenProvider()) : null,
    [config]
  );

  const refreshCameras = async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices() ?? [];
    const videoDevices = devices.filter(({ kind }) => kind === 'videoinput');
    setCameras(videoDevices);
    return videoDevices;
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

  const startCamera = async (requestedCameraId = settings.cameraId) => {
    const video = videoRef.current, canvas = canvasRef.current;
    if (!video || !canvas || cameraStarting.current) return;
    cameraStarting.current = true;
    const recognizer = new StableGestureRecognizer(), vfx = new CanvasVfxAdapter(), camera = new MediaPipeCameraAdapter();
    try {
      cameraRef.current?.stop();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = undefined;
      await vfx.initialize();
      const onFrame = (image: CanvasImageSource, hands: Parameters<StableGestureRecognizer['update']>[0]) => {
        const stable = recognizer.update(hands);
        if (stable !== detectedRef.current) {
          detectedRef.current = stable;
          detectedAt.current = stable ? Date.now() : null;
          setDetected(stable);
        }
        vfx.draw(canvas, image, hands, stable);
      };
      try {
        await camera.start(video, requestedCameraId, onFrame);
      } catch (error) {
        const unavailableSelection = requestedCameraId !== 'default' &&
          error instanceof DOMException &&
          ['NotFoundError', 'OverconstrainedError'].includes(error.name);
        if (!unavailableSelection) throw error;
        await camera.start(video, 'default', onFrame);
        setSettings((current) => ({ ...current, cameraId: 'default' }));
      }
      cameraRef.current = camera;
      streamRef.current = canvas.captureStream(30);
      setCameraActive(true);
      setCameraStatus(text.cameraActive);
      await refreshCameras();
    } catch (error) {
      camera.stop();
      console.error('Camera startup failed', error);
      setCameraActive(false);
      setCameraStatus(error instanceof Error ? error.message : text.cameraFailed);
    } finally {
      cameraStarting.current = false;
    }
  };
  const stopCamera = () => {
    cameraRef.current?.stop();
    cameraRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = undefined;
    setCameraActive(false);
    setCameraStatus(text.cameraStopped);
  };
  useEffect(() => {
    if (autoStartedCamera.current) return;
    autoStartedCamera.current = true;
    void startCamera();
  }, []);
  useEffect(() => {
    if (status !== 'connected' || !cameraActive) return;
    try {
      webrtcRef.current?.playerReady();
    } catch (error) {
      console.warn('Unable to announce camera readiness', error);
    }
  }, [cameraActive, status]);
  useEffect(() => {
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.addEventListener) return;
    const handleDeviceChange = async () => {
      try {
        const available = await refreshCameras();
        if (settings.cameraId === 'default' || available.some(({ deviceId }) => deviceId === settings.cameraId)) return;
        setSettings((current) => ({ ...current, cameraId: 'default' }));
        if (cameraActive) await startCamera('default');
      } catch (error) {
        console.warn('Unable to refresh cameras after device change', error);
      }
    };
    mediaDevices.addEventListener('devicechange', handleDeviceChange);
    return () => mediaDevices.removeEventListener('devicechange', handleDeviceChange);
  }, [cameraActive, settings.cameraId]);
  useEffect(() => stopCamera, []);

  const triggerRobot = (gesture: GestureName) => {
    if (settings.disableRobotApi || !api || !config) return;
    const elapsed = Date.now() - lastRobotActionAt.current;
    if (elapsed < settings.robotCooldownSeconds * 1000) {
      setCameraStatus(text.robotCooldownRemaining(Math.ceil((settings.robotCooldownSeconds * 1000 - elapsed) / 1000)));
      return;
    }
    const catalogEntry = getGesture(gesture);
    if (!catalogEntry) return;
    lastRobotActionAt.current = Date.now();
    void api.triggerTechnique(settings.robotId, catalogEntry.robotTechnique, config.defaultSessionKey).catch((error) => {
      console.error('Robot technique failed', error);
      setCameraStatus(error instanceof Error ? error.message : text.robotFailed);
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
        setCameraStatus(text.popupRequired);
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
      setSolo({ active: false, score, attempted, queue: [], target: null, deadlineAt: null, result: score === settings.gestureCount ? text.perfect : text.roundComplete });
      setMediaMuted(false);
      setMediaSrc(score === settings.gestureCount ? '/static/video/win/onepunch.mp4' : '/static/video/lose/shiba1.mp4');
      return;
    }
    submittedSoloTarget.current = null;
    setSolo({ active: true, score, attempted, queue: remaining, target: next, deadlineAt: Date.now() + settings.difficulty * 1000, result: null });
  };
  const startSolo = () => advanceSolo(shuffledGestures(settings.gestureCount), 0, 0);
  const stopSolo = () => setSolo({ ...emptySoloRound, result: text.roundStopped });

  useEffect(() => {
    if (settings.playerMode === 'solo') {
      if (!solo.active || !solo.target || detected !== solo.target || submittedSoloTarget.current === solo.target) return;
      submittedSoloTarget.current = solo.target;
      const gesture = getGesture(solo.target);
      if (!gesture) return;
      const nextScore = solo.score + 1;
      const nextAttempted = solo.attempted + 1;
      setFeedback(text.success);
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
    const recognizedAt = detectedAt.current == null ? null : serverTime(detectedAt.current);
    if (!recognizedAt || recognizedAt < challenge.startedAt || (challenge.deadlineAt && recognizedAt > challenge.deadlineAt)) return;
    const gesture = getGesture(battleTarget);
    if (!gesture) return;
    submittedChallenge.current = challenge.challengeId;
    setFeedback(text.success);
    setTimeout(() => setFeedback(''), 900);
    command('challenge.succeeded', {
      challengeId: challenge.challengeId,
      technique: battleTarget,
      videoSrc: gesture.video,
      recognizedAt
    });
    triggerRobot(battleTarget);
  }, [battleTarget, command, detected, now, player?.challenge, serverTime, settings.playerMode, solo, state]);

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
    const phase = state.phase === 'preparing' ? 'START' : state.phase === 'ended' ? 'END' : null;
    const captureKey = phase ? `${state.matchId}:${phase}` : null;
    if (!phase || capturedPhase.current === captureKey || capturingPhase.current === captureKey) return;
    const matchId = state.matchId;
    capturingPhase.current = captureKey;
    const image = canvasRef.current.toDataURL('image/jpeg', .82);
    void (async () => {
      let lastError: unknown;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          await api.uploadSnapshot(matchId, settings.role, phase, image);
          capturedPhase.current = captureKey;
          capturingPhase.current = null;
          return;
        } catch (error) {
          lastError = error;
          if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
      capturingPhase.current = null;
      console.warn('Snapshot upload failed', lastError);
      setCameraStatus(lastError instanceof Error ? lastError.message : text.snapshotFailed);
    })();
  }, [api, settings.role, state?.config.captureSnapshots, state?.matchId, state?.phase, text.snapshotFailed]);

  useEffect(() => {
    if (settings.playerMode === 'battle') setMediaSrc(null);
  }, [settings.playerMode]);

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (readPopupMessage(event, popupRef.current)?.type !== 'PLAYER_READY') return;
      setCameraStatus((value) => `${value}; ${text.popupReady}`);
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
      <span className="role-pill">{settings.playerMode === 'solo' ? text.solo : `${text.playerLabel(settings.role === 'player1' ? 1 : 2)} · ${settings.roomCode}`}</span>
      <h1>領域展開 AR</h1>
    </header>
    <section className="hud">
      <small>{text.target}</small><strong style={{ color: getGesture(target)?.color }}>{targetLabel}</strong>
      <div><span>{text.score} {score}/{total}</span><span>{remainingSeconds(deadline, now)}s</span></div>
      <em>{text.detected}: {gestureLabel(detected, settings.language) ?? '—'}</em>
    </section>
    {feedback && <div className="success-feedback">{feedback}</div>}
    <button
      className={`camera-toggle ${cameraActive ? 'active' : ''}`}
      aria-label={cameraActive ? text.stopCamera : text.startCamera}
      title={cameraActive ? text.stopCamera : text.startCamera}
      onClick={() => cameraActive ? stopCamera() : void startCamera()}
    >📷</button>
    <button
      className={`panel-toggle settings-toggle player-panel-toggle ${showSettings ? 'active' : ''}`}
      aria-label={showSettings ? text.hideSettings : text.playerSettings}
      title={showSettings ? text.hideSettings : text.playerSettings}
      onClick={() => setShowSettings((visible) => !visible)}
    >⚙</button>
    {showSettings && <aside className="settings-card">
      <button className="panel-close" aria-label={text.hideSettings} onClick={() => setShowSettings(false)}>×</button>
      <p className="status-message">{settings.playerMode === 'solo' ? text.localSoloRound : connectionStatus} · {cameraStatus}</p>
      <label>{text.camera}<select value={settings.cameraId} onChange={(event) => {
        const cameraId = event.target.value;
        setSettings({ ...settings, cameraId });
        if (cameraActive) void startCamera(cameraId);
      }}><option value="default">{text.defaultCamera}</option>{cameras.map((camera, index) => <option key={camera.deviceId} value={camera.deviceId}>{camera.label || `${text.camera} ${index + 1}`}</option>)}</select></label>
      <label>{text.mode}<select value={settings.playerMode} onChange={(event) => setSettings({ ...settings, playerMode: event.target.value as typeof settings.playerMode })}><option value="battle">{text.onlineBattle}</option><option value="solo">{text.soloGame}</option></select></label>
      {settings.playerMode === 'solo'
        ? <div className="button-row"><button className="primary" onClick={startSolo}>{text.startRound}</button><button onClick={stopSolo}>{text.quit}</button></div>
        : <>
          <label>{text.room}<input value={settings.roomCode} onChange={(event) => setSettings({ ...settings, roomCode: event.target.value.toUpperCase() })} /></label>
          <label>{text.role}<select value={settings.role} onChange={(event) => setSettings({ ...settings, role: event.target.value as PlayerRole })}><option value="player1">{text.playerLabel(1)}</option><option value="player2">{text.playerLabel(2)}</option></select></label>
        </>}
      <section className="player-settings-section">
        <h3>{text.playerSettings}</h3>
        <label>{text.language}<select value={settings.language} onChange={(event) => setSettings({ ...settings, language: event.target.value as typeof settings.language })}><option value="zh-HK">廣東話</option><option value="zh-TW">繁體中文</option><option value="en">English</option><option value="ja">日本語</option></select></label>
        <label>{text.video}<select value={settings.videoMode} onChange={(event) => setSettings({ ...settings, videoMode: event.target.value as typeof settings.videoMode })}><option value="integrated">{text.integratedSound}</option><option value="integrated_silent">{text.integratedSilent}</option><option value="popup">{text.popupTab}</option><option value="none">{text.noVideo}</option></select></label>
        <label><input type="checkbox" checked={settings.autoOpenPopup} onChange={(event) => setSettings({ ...settings, autoOpenPopup: event.target.checked })} /> {text.autoOpenPopup}</label>
        <button onClick={openPopup}>{text.openMediaPopup}</button>
        <label>{text.roundSeconds} <input type="range" min="3" max="15" value={settings.difficulty} onChange={(event) => setSettings({ ...settings, difficulty: Number(event.target.value) })} />{settings.difficulty}s</label>
        <label>{text.techniques} <input type="range" min="1" max="11" value={settings.gestureCount} onChange={(event) => setSettings({ ...settings, gestureCount: Number(event.target.value) })} />{settings.gestureCount}</label>
        <label>{text.robot}<select value={settings.robotId} onChange={(event) => setSettings({ ...settings, robotId: event.target.value })}><option value="all">{text.allRobots}</option>{[1,2,3,4,5,6].map((number) => <option key={number} value={`robot_${number}`}>{text.robot} {number}</option>)}</select></label>
        <label>{text.robotCooldown} <input type="range" min="1" max="30" value={settings.robotCooldownSeconds} onChange={(event) => setSettings({ ...settings, robotCooldownSeconds: Number(event.target.value) })} />{settings.robotCooldownSeconds}s</label>
        <label><input type="checkbox" checked={settings.disableRobotApi} onChange={(event) => setSettings({ ...settings, disableRobotApi: event.target.checked })} /> {text.disableRobotApi}</label>
      </section>
      <button onClick={() => {
        saveSettings(settings);
        setShowSettings(false);
      }}>{text.saveHide}</button>
      <a href={`/battle.html?room=${settings.roomCode}`}>{text.openBattleViewer}</a>
    </aside>}
    {settings.playerMode === 'solo' && mediaSrc && <div className="player-media-overlay">
      <video className="integrated-media" src={mediaSrc} autoPlay muted={mediaMuted} playsInline controls onEnded={() => setMediaSrc(null)} />
      <button onClick={() => setMediaSrc(null)}>{text.close}</button>
    </div>}
    {solo.result && <section className="result"><h2>{solo.result}</h2><p>{text.finalScore}: {solo.score}/{settings.gestureCount}</p><button onClick={startSolo}>{text.playAgain}</button><button onClick={() => setSolo(emptySoloRound)}>{text.close}</button></section>}
  </main>;
}
