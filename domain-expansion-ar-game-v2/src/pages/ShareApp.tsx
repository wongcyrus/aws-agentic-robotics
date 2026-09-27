import { useEffect, useMemo, useState } from 'react';
import { ApiClient } from '../services/apiClient';
import { LocalStorageTokenProvider } from '../services/auth';
import { loadConfig } from '../services/config';

export function ShareApp() {
  const query = useMemo(() => new URLSearchParams(location.search), []);
  const sessionId = query.get('session') ?? '', winner = query.get('winner') ?? 'draw';
  const [api, setApi] = useState<ApiClient>();
  const [portrait, setPortrait] = useState(query.get('portrait'));
  useEffect(() => { void loadConfig().then((config) => setApi(new ApiClient(config.apiBaseUrl, new LocalStorageTokenProvider()))); }, []);
  const enhance = async () => {
    if (!api || !sessionId) return;
    const result = await api.enhancePortrait(sessionId, winner as 'player1' | 'player2' | 'draw');
    if (result.imageUrl) return setPortrait(result.imageUrl);
    const poll = setInterval(async () => {
      const current = await api.checkEnhancement(sessionId);
      if (current.imageUrl) { clearInterval(poll); setPortrait(current.imageUrl); }
    }, 3000);
  };
  return <main className="share-page"><img className="share-logo" src="/static/img/jujutsu-kaisen-logo.png" alt="Jujutsu Kaisen" /><h1>DOMAIN CLASH RESULT</h1><p>{winner.toUpperCase()} · {sessionId || 'No session supplied'}</p>
    <section className="snapshots">
      {(['player1', 'player2'] as const).map((role) => <figure key={role}><img src={api && sessionId ? api.snapshotUrl(sessionId, role) : '/static/img/unlimited-void.png'} alt={role} /><figcaption>{role}</figcaption></figure>)}
    </section>
    <section className="portrait">{portrait ? <img src={portrait} alt="AI enhanced battle portrait" /> : <><div className="orb" /><p>Portrait enhancement ready</p></>}</section>
    <button onClick={() => void enhance()}>Generate AI portrait</button>
  </main>;
}
