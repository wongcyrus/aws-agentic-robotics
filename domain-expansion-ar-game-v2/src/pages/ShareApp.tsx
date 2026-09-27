import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PlayerRole } from '../core/protocol';
import { ApiClient } from '../services/apiClient';
import { LocalStorageTokenProvider } from '../services/auth';
import { loadConfig } from '../services/config';

type SnapshotState = Partial<Record<PlayerRole, string>>;
type PortraitStatus = 'idle' | 'loading' | 'complete' | 'error';

export function ShareApp() {
  const query = useMemo(() => new URLSearchParams(location.search), []);
  const sessionId = query.get('session') ?? '';
  const winner = query.get('winner') ?? 'draw';
  const autostart = query.get('autostart') === '1';
  const [api, setApi] = useState<ApiClient>();
  const [snapshots, setSnapshots] = useState<SnapshotState>({});
  const [snapshotMessage, setSnapshotMessage] = useState('Loading player captures…');
  const [portrait, setPortrait] = useState(query.get('portrait'));
  const [portraitStatus, setPortraitStatus] = useState<PortraitStatus>(portrait ? 'complete' : 'idle');
  const [portraitMessage, setPortraitMessage] = useState('Portrait enhancement ready.');
  const [templateId, setTemplateId] = useState('random');
  const startedAutomatically = useRef(false);

  useEffect(() => {
    void loadConfig().then((config) => setApi(new ApiClient(config.apiBaseUrl, new LocalStorageTokenProvider())));
  }, []);
  useEffect(() => {
    if (!api || !sessionId) {
      if (!sessionId) setSnapshotMessage('No match session was supplied.');
      return;
    }
    void Promise.all((['player1', 'player2'] as const).map(async (role) => {
      const result = await api.getSnapshot(sessionId, role);
      return [role, result.image || ''] as const;
    })).then((entries) => {
      const available = Object.fromEntries(entries.filter(([, image]) => image)) as SnapshotState;
      setSnapshots(available);
      setSnapshotMessage(Object.keys(available).length ? '' : 'Player captures are not available yet.');
    }).catch((error) => {
      console.error('Snapshot loading failed', error);
      setSnapshotMessage(error instanceof Error ? error.message : 'Unable to load player captures.');
    });
  }, [api, sessionId]);

  const pollEnhancement = useCallback(async () => {
    if (!api || !sessionId) return;
    const startedAt = Date.now();
    while (Date.now() - startedAt < 60_000) {
      const current = await api.checkEnhancement(sessionId);
      const imageUrl = current.url || current.imageUrl;
      if (current.status === 'COMPLETE' && imageUrl) {
        setPortrait(imageUrl);
        setPortraitStatus('complete');
        setPortraitMessage('AI portrait is ready.');
        return;
      }
      if (current.status.startsWith('ERROR:')) {
        setPortraitStatus('error');
        setPortraitMessage(current.status.replace('ERROR:', '').trim().replaceAll('_', ' '));
        return;
      }
      if (current.status === 'NONE') {
        setPortraitStatus('error');
        setPortraitMessage('No generated portrait is available. Original player captures can still be downloaded.');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    setPortraitStatus('error');
    setPortraitMessage('Portrait generation timed out. Original player captures remain available.');
  }, [api, sessionId]);

  const enhance = useCallback(async () => {
    if (!api || !sessionId || portraitStatus === 'loading') return;
    setPortraitStatus('loading');
    setPortraitMessage('Generating the Scroll of Honor…');
    try {
      const result = await api.enhancePortrait(
        sessionId,
        winner as PlayerRole | 'draw',
        undefined,
        templateId
      );
      const imageUrl = result.url || result.imageUrl;
      if (imageUrl) {
        setPortrait(imageUrl);
        setPortraitStatus('complete');
        setPortraitMessage('AI portrait is ready.');
        return;
      }
      if (result.status?.startsWith('ERROR:')) {
        setPortraitStatus('error');
        setPortraitMessage(result.status.replace('ERROR:', '').trim().replaceAll('_', ' '));
        return;
      }
      await pollEnhancement();
    } catch (error) {
      console.error('Portrait enhancement failed', error);
      setPortraitStatus('error');
      setPortraitMessage(error instanceof Error ? error.message : 'Portrait enhancement failed.');
    }
  }, [api, pollEnhancement, portraitStatus, sessionId, templateId, winner]);

  useEffect(() => {
    if (!autostart || !api || !sessionId || startedAutomatically.current) return;
    startedAutomatically.current = true;
    void enhance();
  }, [api, autostart, enhance, sessionId]);

  const download = async (url: string, filename: string) => {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}`);
      const objectUrl = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(objectUrl);
    } catch (error) {
      console.error('Download failed', error);
      location.href = url;
    }
  };
  const downloadAvailable = () => {
    if (portrait) {
      void download(portrait, `jjk_match_result_${sessionId}.jpg`);
      return;
    }
    (Object.entries(snapshots) as [PlayerRole, string][]).forEach(([role, url]) => {
      void download(url, `jjk_${role}_capture_${sessionId}.jpg`);
    });
  };
  const share = async () => {
    const data = {
      title: 'JJK Domain Clash Result',
      text: `${winner.toUpperCase()} · ${sessionId}`,
      url: location.href
    };
    if (navigator.share) {
      await navigator.share(data);
      return;
    }
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(location.href);
      setPortraitMessage('Share link copied to clipboard.');
      return;
    }
    window.prompt('Copy this result link:', location.href);
  };

  return <main className="share-page">
    <img className="share-logo" src="/static/img/jujutsu-kaisen-logo.png" alt="Jujutsu Kaisen" />
    <h1>DOMAIN CLASH RESULT</h1>
    <p>{winner.toUpperCase()} · {sessionId || 'No session supplied'}</p>
    <section className="snapshots">
      {(['player1', 'player2'] as const).map((role) => <figure key={role}>
        {snapshots[role]
          ? <img src={snapshots[role]} alt={`${role} match capture`} />
          : <div className="snapshot-placeholder">Waiting for {role}</div>}
        <figcaption>{role}</figcaption>
      </figure>)}
    </section>
    {snapshotMessage && <p className="status-message">{snapshotMessage}</p>}
    <section className={`portrait portrait-${portraitStatus}`}>
      {portrait
        ? <img src={portrait} alt="AI enhanced battle portrait" />
        : <><div className="orb" /><p>{portraitMessage}</p></>}
    </section>
    <div className="share-actions">
      <select value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
        <option value="random">Random style</option>
        <option value="cyberpunk">Cyberpunk</option>
        <option value="ink-wash">Ink shadow</option>
        <option value="neon-glow">Neon force</option>
      </select>
      <button className="primary" disabled={!api || !sessionId || portraitStatus === 'loading'} onClick={() => void enhance()}>
        {portraitStatus === 'loading' ? 'Generating…' : 'Generate AI portrait'}
      </button>
      <button disabled={!portrait && Object.keys(snapshots).length === 0} onClick={downloadAvailable}>Download images</button>
      <button onClick={() => void share()}>Share result</button>
    </div>
  </main>;
}
