import { useEffect, useMemo, useRef, useState } from 'react';
import { Branding } from '../components/Branding';
import { getGesture } from '../core/catalog';
import { remainingSeconds } from '../core/match';
import { WebRtcSignalTypeSchema, type PlayerRole } from '../core/protocol';
import { ApiClient } from '../services/apiClient';
import { LocalStorageTokenProvider } from '../services/auth';
import { CommentaryPlayer } from '../services/commentary';
import { defaultSettings, loadSettings, saveSettings } from '../services/settings';
import { useGameSession } from '../services/useGameSession';
import { WebRtcSessionService } from '../services/webrtcSession';

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const winVideos = import.meta.env.DEV
  ? ['onepunch.mp4']
  : ['heroacademy.mp4', 'solo-leveling.mp4', 'onepunchman.mp4', '8-gate.mp4', 'escanor.mp4', 'onepunch.mp4', 'onepunch2.mp4', 'demon-slayer-s2.mp4', 'demon-slayer-s1.mp4'];
const loseVideos = import.meta.env.DEV
  ? ['shiba1.mp4']
  : Array.from({ length: 9 }, (_, index) => `shiba${index + 1}.mp4`);

export function BattleApp() {
  const query = new URLSearchParams(location.search);
  const [settings, setSettings] = useState(() => loadSettings({ roomCode: (query.get('room') ?? undefined)?.toUpperCase() }));
  const { state, status, config, command, signal, subscribe } = useGameSession(settings.roomCode, 'viewer');
  const [streams, setStreams] = useState<Partial<Record<PlayerRole, MediaStream>>>({});
  const [commentary, setCommentary] = useState('Commentary is ready.');
  const [commentaryError, setCommentaryError] = useState('');
  const [now, setNow] = useState(Date.now());
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [ticker, setTicker] = useState<string[]>([]);
  const [showResultVideo, setShowResultVideo] = useState(true);
  const peers = useRef<WebRtcSessionService | undefined>(undefined);
  const commentaryPlayer = useRef(new CommentaryPlayer());
  const requestedPlayers = useRef(new Set<string>());
  const completedCountdown = useRef<string | null>(null);
  const completedResolution = useRef<string | null>(null);
  const completedCinematic = useRef<string | null>(null);
  const completedCastVideos = useRef(new Set<string>());
  const introducedMatches = useRef(new Set<string>());
  const narratedResolutions = useRef(new Set<string>());
  const narratedResults = useRef(new Set<string>());
  const criticalMarks = useRef(new Set<string>());
  const lastPeriodicCommentary = useRef(0);
  const commentaryInFlight = useRef(false);
  const commentaryBusyUntil = useRef(0);
  const api = useMemo(() => config ? new ApiClient(config.apiBaseUrl, new LocalStorageTokenProvider()) : null, [config]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const refresh = () => setVoices(speechSynthesis.getVoices());
    refresh();
    speechSynthesis.addEventListener('voiceschanged', refresh);
    return () => speechSynthesis.removeEventListener('voiceschanged', refresh);
  }, []);
  useEffect(() => {
    peers.current = new WebRtcSessionService('viewer', signal, (role, stream) => {
      if (role !== 'viewer') setStreams((current) => ({ ...current, [role]: stream }));
    });
    const unsubscribe = subscribe((message) => {
      if (!message.messageType.startsWith('webrtc.')) return;
      const signalType = WebRtcSignalTypeSchema.safeParse(message.messageType.slice('webrtc.'.length));
      if (!signalType.success) return;
      const payload = message.payload as {
        from: string;
        role: 'player1' | 'player2' | 'viewer';
        data: Parameters<NonNullable<typeof peers.current>['handle']>[1];
      };
      void peers.current?.handle(signalType.data, payload.data, payload.from, payload.role);
    });
    return () => {
      unsubscribe();
      peers.current?.close();
      commentaryPlayer.current.stop();
    };
  }, [signal, subscribe]);

  const commentaryBody = (extra: Record<string, unknown>) => ({
    sessionId: state?.matchId,
    roomCode: settings.roomCode,
    p1Score: state?.players.player1.score ?? 0,
    p2Score: state?.players.player2.score ?? 0,
    p1Total: state?.config.challengeCount ?? settings.gestureCount,
    p2Total: state?.config.challengeCount ?? settings.gestureCount,
    lang: settings.language,
    foulLanguage: settings.foulLanguage,
    agentImagePolicy: settings.commentatorImagePolicy,
    agent_type: settings.commentaryEngine,
    ttsMode: settings.commentaryTtsMode,
    ...extra
  });

  const requestCommentary = async (
    path: '/api/live-status' | '/api/battle-result',
    extra: Record<string, unknown>
  ) => {
    if (!api || !settings.commentatorEnabled) return;
    const isPriority = path === '/api/battle-result' || extra.eventType === 'RESET';
    if (!isPriority && (commentaryInFlight.current || Date.now() < commentaryBusyUntil.current)) return;
    commentaryInFlight.current = true;
    try {
      const response = await api.commentary(path, commentaryBody(extra));
      const text = response.commentary || response.welcomeMessage;
      if (text) {
        setCommentary(text);
        commentaryBusyUntil.current = Date.now() + Math.max(4500, text.length * 65);
      }
      setCommentaryError('');
      await commentaryPlayer.current.play(response, settings);
    } catch (error) {
      console.warn('Commentary request failed', error);
      setCommentaryError(error instanceof Error ? error.message : 'Commentary request failed');
    } finally {
      commentaryInFlight.current = false;
    }
  };

  const start = () => {
    if (state && !['idle', 'ended'].includes(state.phase)) {
      command('match.reset');
      return;
    }
    command('match.start', {
      config: {
        difficultySeconds: settings.difficulty,
        challengeCount: settings.gestureCount,
        countdownSeconds: settings.countdownSeconds,
        scoreGraceMs: settings.scoreGraceMs,
        synchronizedGestures: settings.synchronizedGestures,
        captureSnapshots: settings.commentatorEnabled && settings.commentatorWebcam && settings.commentatorImagePolicy !== 'never'
      }
    });
  };

  useEffect(() => {
    if (!api || state?.phase !== 'countdown' || !state.matchId || introducedMatches.current.has(state.matchId)) return;
    introducedMatches.current.add(state.matchId);
    void (async () => {
      try {
        await api.registerRoom(state.matchId!, settings.roomCode, config?.webSocketUrl ?? '');
        if (state.config.captureSnapshots) await delay(1200);
        await requestCommentary('/api/live-status', { eventType: 'RESET', isReset: true });
      } catch (error) {
        console.warn('Match introduction setup failed', error);
        setCommentaryError(error instanceof Error ? error.message : 'Match introduction failed');
      }
    })();
  }, [api, config?.webSocketUrl, settings.roomCode, state?.matchId, state?.phase]);

  useEffect(() => {
    if (state?.phase === 'countdown' && state.matchId && state.countdownEndsAt && now >= state.countdownEndsAt && completedCountdown.current !== state.matchId) {
      completedCountdown.current = state.matchId;
      command('match.countdownCompleted');
    }
  }, [command, now, state?.countdownEndsAt, state?.matchId, state?.phase]);

  useEffect(() => {
    const resolution = state?.resolution;
    if (state?.phase !== 'resolving' || !resolution || now < resolution.acceptUntil || completedResolution.current === resolution.resolutionId) return;
    completedResolution.current = resolution.resolutionId;
    if (!narratedResolutions.current.has(resolution.resolutionId)) {
      narratedResolutions.current.add(resolution.resolutionId);
      const detail = resolution.casts.map(({ role, technique }) => `${role === 'player1' ? 'Player 1' : 'Player 2'} activated ${technique}`).join('; ');
      setTicker((current) => [...current.slice(-4), detail]);
      void requestCommentary('/api/live-status', { eventType: 'CAST', detail });
    }
    command('resolution.complete', { expectedDurationMs: 15_000 });
  }, [command, now, state?.phase, state?.resolution]);

  useEffect(() => {
    if (state?.phase !== 'playing' || !state.matchId) return;
    const remaining = Math.max(
      remainingSeconds(state.players.player1.challenge?.deadlineAt, now),
      remainingSeconds(state.players.player2.challenge?.deadlineAt, now)
    );
    const criticalKey = `${state.matchId}:${remaining}`;
    if ([10, 5, 3].includes(remaining) && !criticalMarks.current.has(criticalKey)) {
      criticalMarks.current.add(criticalKey);
      void requestCommentary('/api/live-status', {
        eventType: 'TIME_CRITICAL',
        detail: `Only ${remaining} seconds remain for the active techniques.`,
        timeLeft: remaining
      });
      lastPeriodicCommentary.current = now;
    } else if (now - lastPeriodicCommentary.current >= 35_000) {
      lastPeriodicCommentary.current = now;
      void requestCommentary('/api/live-status', { eventType: 'PERIODIC', timeLeft: remaining });
    }
  }, [now, state?.matchId, state?.phase, state?.players.player1.challenge?.deadlineAt, state?.players.player2.challenge?.deadlineAt]);

  useEffect(() => {
    if (state?.phase !== 'ended' || !state.matchId || !state.winner || narratedResults.current.has(state.matchId)) return;
    narratedResults.current.add(state.matchId);
    setShowResultVideo(true);
    void requestCommentary('/api/battle-result', { winner: state.winner });
  }, [state?.matchId, state?.phase, state?.winner]);

  useEffect(() => {
    const playerIds = [state?.players.player1.clientId, state?.players.player2.clientId].filter(Boolean) as string[];
    playerIds.forEach((clientId) => {
      if (requestedPlayers.current.has(clientId)) return;
      requestedPlayers.current.add(clientId);
      peers.current?.viewerRequested(clientId);
    });
  }, [state?.players.player1.clientId, state?.players.player2.clientId]);

  const cinematicCasts = state?.cinematic?.casts.filter((cast) => cast.videoSrc) ?? [];
  const completeCinematic = () => {
    if (!state?.cinematic || completedCinematic.current === state.cinematic.cinematicId) return;
    completedCinematic.current = state.cinematic.cinematicId;
    command('cinematic.completed', { cinematicId: state.cinematic.cinematicId });
  };
  useEffect(() => {
    completedCastVideos.current.clear();
  }, [state?.cinematic?.cinematicId]);
  useEffect(() => {
    if (state?.phase === 'cinematic' && state.cinematic && (cinematicCasts.length === 0 || now >= state.cinematic.fallbackEndsAt)) completeCinematic();
  }, [cinematicCasts.length, now, state?.cinematic, state?.phase]);
  const completeCastVideo = (key: string) => {
    completedCastVideos.current.add(key);
    if (completedCastVideos.current.size >= cinematicCasts.length) completeCinematic();
  };

  const playerCard = (role: PlayerRole) => {
    const player = state?.players[role];
    return <article className={`fighter ${role}`}>
      <VideoStream stream={streams[role]} label={role} />
      <div className="fighter-info">
        <b>{role === 'player1' ? 'PLAYER 1' : 'PLAYER 2'}</b>
        <strong>{player?.score ?? 0}</strong>
        <span>{player?.finished ? 'FINISHED' : `${remainingSeconds(player?.challenge?.deadlineAt, now)}s`}</span>
        <em style={{ color: getGesture(player?.challenge?.technique)?.color }}>{player?.challenge?.technique ?? 'waiting'}</em>
      </div>
    </article>;
  };
  const winnerSlug = state?.winner === 'PLAYER 1' ? 'player1' : state?.winner === 'PLAYER 2' ? 'player2' : 'draw';
  const matchActive = Boolean(state && !['idle', 'ended'].includes(state.phase));
  const countdown = state?.phase === 'countdown' ? remainingSeconds(state.countdownEndsAt, now) : 0;
  const p1Score = state?.players.player1.score ?? 0;
  const p2Score = state?.players.player2.score ?? 0;
  const scoreTotal = Math.max(1, p1Score + p2Score);
  const resultVideo = state?.winner
    ? (() => {
      const won = Math.max(p1Score, p2Score) >= Math.ceil((state.config.challengeCount || 1) / 2);
      const choices = won ? winVideos : loseVideos;
      return `/static/video/${won ? 'win' : 'lose'}/${choices[(state.matchId?.length ?? 0) % choices.length]}`;
    })()
    : null;

  return <main className={`battle-page layout-${settings.layout} ${settings.dynamicView ? 'dynamic-view' : ''}`}>
    <Branding />
    <header className="battle-header"><h1>DOMAIN CLASH <b>V2</b></h1><span>{settings.roomCode} · {status}</span></header>
    <section className="arena">{playerCard('player1')}<div className="versus">VS</div>{playerCard('player2')}</section>
    <div className="power-bar"><span style={{ width: `${p1Score / scoreTotal * 100}%` }} /><span style={{ width: `${p2Score / scoreTotal * 100}%` }} /></div>
    <div className="battle-ticker">{ticker.slice(-3).map((entry, index) => <span key={`${entry}-${index}`}>{entry}</span>)}</div>
    <section className="commentary" style={{ '--avatar-size': `${settings.avatarSize}px` } as React.CSSProperties}>
      <img src="/static/img/commentator_avatar.png" alt="AI commentator" />
      <div><p>{settings.commentatorEnabled ? commentary : 'Commentator disabled.'}</p>{commentaryError && <small>{commentaryError}</small>}</div>
    </section>
    <aside className="battle-controls">
      <label>Room<input value={settings.roomCode} onChange={(event) => setSettings({ ...settings, roomCode: event.target.value.toUpperCase() })} /></label>
      <label>Countdown <input type="range" min="0" max="10" value={settings.countdownSeconds} onChange={(event) => setSettings({ ...settings, countdownSeconds: Number(event.target.value) })} />{settings.countdownSeconds}s</label>
      <label>Seconds <input type="range" min="3" max="15" value={settings.difficulty} onChange={(event) => setSettings({ ...settings, difficulty: Number(event.target.value) })} />{settings.difficulty}s</label>
      <label>Techniques <input type="range" min="1" max="11" value={settings.gestureCount} onChange={(event) => setSettings({ ...settings, gestureCount: Number(event.target.value) })} />{settings.gestureCount}</label>
      <label>Score grace <input type="range" min="0" max="5000" step="500" value={settings.scoreGraceMs} onChange={(event) => setSettings({ ...settings, scoreGraceMs: Number(event.target.value) })} />{(settings.scoreGraceMs / 1000).toFixed(1)}s</label>
      <label><input type="checkbox" checked={settings.synchronizedGestures} onChange={(event) => setSettings({ ...settings, synchronizedGestures: event.target.checked })} /> Same gesture for both players</label>
      <label>Layout<select value={settings.layout} onChange={(event) => setSettings({ ...settings, layout: event.target.value as typeof settings.layout })}><option value="side-by-side">Side-by-side</option><option value="vertical-stack">Vertical stack</option></select></label>
      <label><input type="checkbox" checked={settings.dynamicView} onChange={(event) => setSettings({ ...settings, dynamicView: event.target.checked })} /> Dynamic cinematic view</label>
      <details>
        <summary>AI commentator</summary>
        <label><input type="checkbox" checked={settings.commentatorEnabled} onChange={(event) => setSettings({ ...settings, commentatorEnabled: event.target.checked })} /> Enabled</label>
        <label>Language<select value={settings.language} onChange={(event) => setSettings({ ...settings, language: event.target.value as typeof settings.language })}><option value="zh-HK">廣東話</option><option value="zh-TW">繁體中文</option><option value="en">English</option><option value="ja">日本語</option></select></label>
        <label>Engine<select value={settings.commentaryEngine} onChange={(event) => setSettings({ ...settings, commentaryEngine: event.target.value as typeof settings.commentaryEngine })}><option value="strands_local">Strands Local</option><option value="agentcore_runtime">AgentCore Runtime</option><option value="openclaw">OpenClaw</option></select></label>
        <label>TTS<select value={settings.commentaryTtsMode} onChange={(event) => setSettings({ ...settings, commentaryTtsMode: event.target.value as typeof settings.commentaryTtsMode })}><option value="browser">Browser</option><option value="aws">AWS Polly</option></select></label>
        <label>Voice<select value={settings.commentaryVoice} onChange={(event) => setSettings({ ...settings, commentaryVoice: event.target.value })}><option value="auto">Auto</option>{voices.map(({ name }) => <option key={name} value={name}>{name}</option>)}</select></label>
        <label>Volume <input type="range" min="0" max="100" value={settings.commentaryVolume} onChange={(event) => setSettings({ ...settings, commentaryVolume: Number(event.target.value) })} />{settings.commentaryVolume}%</label>
        <label><input type="checkbox" checked={settings.commentatorWebcam} onChange={(event) => setSettings({ ...settings, commentatorWebcam: event.target.checked })} /> Capture start/end snapshots</label>
        <label>Image policy<select value={settings.commentatorImagePolicy} onChange={(event) => setSettings({ ...settings, commentatorImagePolicy: event.target.value as typeof settings.commentatorImagePolicy })}><option value="always">Always</option><option value="start_end">Start/end</option><option value="never">Never</option></select></label>
        <label><input type="checkbox" checked={settings.foulLanguage} onChange={(event) => setSettings({ ...settings, foulLanguage: event.target.checked })} /> Trash talk</label>
        <label><input type="checkbox" checked={settings.aiPortraitEnabled} onChange={(event) => setSettings({ ...settings, aiPortraitEnabled: event.target.checked })} /> AI portrait</label>
        <label>Avatar size <input type="range" min="150" max="700" step="10" value={settings.avatarSize} onChange={(event) => setSettings({ ...settings, avatarSize: Number(event.target.value) })} />{settings.avatarSize}px</label>
      </details>
      <button onClick={() => { saveSettings(settings); location.search = `?room=${settings.roomCode}`; }}>Save & reconnect</button>
      <button onClick={() => setSettings(defaultSettings)}>Reset defaults</button>
      <button className="primary" onClick={start}>{matchActive ? 'Stop / reset' : 'Start battle'}</button>
    </aside>
    {countdown > 0 && <section className="countdown-overlay"><strong>{countdown}</strong></section>}
    {state?.winner && <section className="result">
      {showResultVideo && resultVideo
        ? <div className="result-video"><video src={resultVideo} autoPlay playsInline controls onEnded={() => setShowResultVideo(false)} /><button onClick={() => setShowResultVideo(false)}>Skip result video</button></div>
        : <>
          <h2>{state.winner === 'DRAW' ? 'DRAW' : `${state.winner} WINS`}</h2>
          <p>PLAYER 1 {state.players.player1.score} · {state.players.player2.score} PLAYER 2</p>
          <a href={`/share.html?session=${state.matchId}&winner=${winnerSlug}${settings.aiPortraitEnabled ? '&autostart=1' : ''}`}>Open Scroll of Honor</a>
          <button onClick={() => command('match.reset')}>Back to lobby</button>
        </>}
    </section>}
    {cinematicCasts.length > 0 && <section className={`cinematic ${cinematicCasts.length > 1 ? 'cinematic-grid' : ''}`}>
      {cinematicCasts.map((cast, index) => {
        const key = `${cast.role}:${cast.videoSrc}:${index}`;
        return <video key={key} src={cast.videoSrc ?? ''} autoPlay playsInline onEnded={() => completeCastVideo(key)} />;
      })}
      <button onClick={completeCinematic}>Skip cinematic</button>
    </section>}
  </main>;
}

function VideoStream({ stream, label }: { stream?: MediaStream; label: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => { if (ref.current) ref.current.srcObject = stream ?? null; }, [stream]);
  return <div className="stream-frame"><video ref={ref} autoPlay muted playsInline />{!stream && <span>Waiting for {label} stream</span>}</div>;
}
