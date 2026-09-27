import { useEffect, useMemo, useRef, useState } from 'react';
import { Branding } from '../components/Branding';
import { getGesture } from '../core/catalog';
import { remainingSeconds } from '../core/match';
import { WebRtcSignalTypeSchema, type PlayerRole } from '../core/protocol';
import { ApiClient } from '../services/apiClient';
import { LocalStorageTokenProvider } from '../services/auth';
import { loadSettings, saveSettings } from '../services/settings';
import { useGameSession } from '../services/useGameSession';
import { WebRtcSessionService } from '../services/webrtcSession';

export function BattleApp() {
  const query = new URLSearchParams(location.search);
  const [settings, setSettings] = useState(() => loadSettings({ roomCode: (query.get('room') ?? undefined)?.toUpperCase() }));
  const { state, status, config, command, signal, subscribe } = useGameSession(settings.roomCode, 'viewer');
  const [streams, setStreams] = useState<Partial<Record<PlayerRole, MediaStream>>>({});
  const [commentary, setCommentary] = useState('Commentary is ready.');
  const [now, setNow] = useState(Date.now());
  const peers = useRef<WebRtcSessionService | undefined>(undefined);
  const requestedPlayers = useRef(new Set<string>());
  const completedCountdown = useRef<string | null>(null);
  const completedResolution = useRef<string | null>(null);
  const completedCinematic = useRef<string | null>(null);
  const api = useMemo(() => config ? new ApiClient(config.apiBaseUrl, new LocalStorageTokenProvider()) : null, [config]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 200); return () => clearInterval(timer); }, []);
  useEffect(() => {
    peers.current = new WebRtcSessionService('viewer', signal, (role, stream) => {
      if (role !== 'viewer') setStreams((current) => ({ ...current, [role]: stream }));
    });
    const unsubscribe = subscribe((message) => {
      if (message.messageType.startsWith('webrtc.')) {
        const signalType = WebRtcSignalTypeSchema.safeParse(message.messageType.slice('webrtc.'.length));
        if (signalType.success) {
          const payload = message.payload as { from: string; role: 'player1' | 'player2' | 'viewer'; data: Parameters<NonNullable<typeof peers.current>['handle']>[1] };
          void peers.current?.handle(signalType.data, payload.data, payload.from, payload.role);
        }
      }
    });
    return () => { unsubscribe(); peers.current?.close(); };
  }, [signal, subscribe]);

  const start = async () => {
    command('match.start', { config: { difficultySeconds: settings.difficulty, challengeCount: settings.gestureCount, countdownSeconds: 3, scoreGraceMs: 1000, synchronizedGestures: true } });
    if (api) {
      try {
        const result = await api.commentary('/api/live-status', { event: 'match_start', roomCode: settings.roomCode, sessionId: state?.matchId });
        if (result.commentary) setCommentary(result.commentary);
      } catch { setCommentary('Battle preparation started.'); }
    }
  };
  useEffect(() => {
    if (state?.phase === 'countdown' && state.matchId && state.countdownEndsAt && now >= state.countdownEndsAt && completedCountdown.current !== state.matchId) {
      completedCountdown.current = state.matchId;
      command('match.countdownCompleted');
    }
  }, [command, now, state?.countdownEndsAt, state?.matchId, state?.phase]);
  useEffect(() => {
    const resolution = state?.resolution;
    if (state?.phase === 'resolving' && resolution && now >= resolution.acceptUntil && completedResolution.current !== resolution.resolutionId) {
      completedResolution.current = resolution.resolutionId;
      command('resolution.complete', { expectedDurationMs: 15_000 });
    }
  }, [command, now, state?.phase, state?.resolution]);
  useEffect(() => {
    const playerIds = [state?.players.player1.clientId, state?.players.player2.clientId].filter(Boolean) as string[];
    playerIds.forEach((clientId) => {
      if (!requestedPlayers.current.has(clientId)) {
        requestedPlayers.current.add(clientId);
        peers.current?.viewerRequested(clientId);
      }
    });
  }, [state?.players.player1.clientId, state?.players.player2.clientId]);
  const cinematic = state?.cinematic?.casts.find((cast) => cast.videoSrc)?.videoSrc ?? null;
  const completeCinematic = () => {
    if (!state?.cinematic || completedCinematic.current === state.cinematic.cinematicId) return;
    completedCinematic.current = state.cinematic.cinematicId;
    command('cinematic.completed', { cinematicId: state.cinematic.cinematicId });
  };
  useEffect(() => {
    if (state?.phase === 'cinematic' && state.cinematic && (!cinematic || now >= state.cinematic.fallbackEndsAt)) completeCinematic();
  }, [cinematic, now, state?.cinematic, state?.phase]);

  const playerCard = (role: PlayerRole) => {
    const player = state?.players[role];
    return <article className={`fighter ${role}`}>
      <VideoStream stream={streams[role]} label={role} />
      <div className="fighter-info"><b>{role === 'player1' ? 'PLAYER 1' : 'PLAYER 2'}</b><strong>{player?.score ?? 0}</strong>
        <span>{remainingSeconds(player?.challenge?.deadlineAt, now)}s</span><em style={{ color: getGesture(player?.challenge?.technique)?.color }}>{player?.challenge?.technique ?? 'waiting'}</em>
      </div>
    </article>;
  };
  return <main className="battle-page">
    <Branding /><header className="battle-header"><h1>DOMAIN CLASH <b>V2</b></h1><span>{settings.roomCode} · {status}</span></header>
    <section className="arena">{playerCard('player1')}<div className="versus">VS</div>{playerCard('player2')}</section>
    <section className="commentary"><img src="/static/img/commentator_avatar.png" alt="" /><p>{commentary}</p></section>
    <aside className="battle-controls">
      <input value={settings.roomCode} onChange={(e) => setSettings({ ...settings, roomCode: e.target.value.toUpperCase() })} />
      <label>Seconds <input type="range" min="3" max="15" value={settings.difficulty} onChange={(e) => setSettings({ ...settings, difficulty: Number(e.target.value) })} />{settings.difficulty}</label>
      <label>Techniques <input type="range" min="1" max="11" value={settings.gestureCount} onChange={(e) => setSettings({ ...settings, gestureCount: Number(e.target.value) })} />{settings.gestureCount}</label>
      <button onClick={() => { saveSettings(settings); location.search = `?room=${settings.roomCode}`; }}>Reconnect</button>
      <button className="primary" onClick={start}>Start battle</button>
      <button onClick={() => command('match.reset')}>Reset</button>
    </aside>
    {state?.winner && <section className="result"><h2>{state.winner === 'DRAW' ? 'DRAW' : `${state.winner} WINS`}</h2><a href={`/share.html?session=${state.matchId}&winner=${encodeURIComponent(state.winner)}`}>Open result gallery</a></section>}
    {cinematic && <section className="cinematic"><video src={cinematic} autoPlay playsInline onEnded={completeCinematic} /></section>}
  </main>;
}

function VideoStream({ stream, label }: { stream?: MediaStream; label: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => { if (ref.current) ref.current.srcObject = stream ?? null; }, [stream]);
  return <div className="stream-frame"><video ref={ref} autoPlay muted playsInline />{!stream && <span>Waiting for {label} stream</span>}</div>;
}
