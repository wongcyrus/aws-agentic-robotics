import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PlayerRole } from '../core/protocol';
import { uiText, type UiLanguage } from '../core/uiText';
import { ApiClient } from '../services/apiClient';
import { LocalStorageTokenProvider } from '../services/auth';
import { loadConfig } from '../services/config';

type SnapshotState = Partial<Record<PlayerRole, string>>;
type PortraitStatus = 'idle' | 'loading' | 'complete' | 'error';

type ShareAppProps = {
  sessionId?: string;
  winner?: string;
  autostart?: boolean;
  embedded?: boolean;
  language?: UiLanguage;
};

export function ShareApp({
  sessionId: suppliedSessionId,
  winner: suppliedWinner,
  autostart: suppliedAutostart,
  embedded = false,
  language = 'en'
}: ShareAppProps = {}) {
  const text = uiText(language);
  const query = useMemo(() => new URLSearchParams(location.search), []);
  const sessionId = suppliedSessionId ?? query.get('session') ?? '';
  const winner = suppliedWinner ?? query.get('winner') ?? 'draw';
  const autostart = suppliedAutostart ?? query.get('autostart') === '1';
  const [api, setApi] = useState<ApiClient>();
  const [snapshots, setSnapshots] = useState<SnapshotState>({});
  const [snapshotMessage, setSnapshotMessage] = useState(text.loadingCaptures);
  const [portrait, setPortrait] = useState(query.get('portrait'));
  const [portraitStatus, setPortraitStatus] = useState<PortraitStatus>(portrait ? 'complete' : 'idle');
  const [portraitMessage, setPortraitMessage] = useState(text.portraitAvailable);
  const [templateId, setTemplateId] = useState('random');
  const startedAutomatically = useRef(false);

  useEffect(() => {
    void loadConfig().then((config) => {
      if (config.apiBaseUrl) {
        setApi(new ApiClient(config.apiBaseUrl, new LocalStorageTokenProvider()));
      } else {
        setSnapshotMessage(text.capturesRequireApi);
        setPortraitMessage(text.portraitRequiresApi);
      }
    });
  }, []);
  useEffect(() => {
    if (!api || !sessionId) {
      if (!sessionId) setSnapshotMessage(text.noMatchSession);
      return;
    }
    void Promise.all((['player1', 'player2'] as const).map(async (role) => {
      const result = await api.getSnapshot(sessionId, role);
      return [role, result.image || ''] as const;
    })).then((entries) => {
      const available = Object.fromEntries(entries.filter(([, image]) => image)) as SnapshotState;
      setSnapshots(available);
      setSnapshotMessage(Object.keys(available).length ? '' : text.capturesUnavailable);
    }).catch((error) => {
      console.error('Snapshot loading failed', error);
      setSnapshotMessage(error instanceof Error ? error.message : text.loadCapturesFailed);
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
        setPortraitMessage(text.portraitReady);
        return;
      }
      if (current.status.startsWith('ERROR:')) {
        setPortraitStatus('error');
        setPortraitMessage(current.status.replace('ERROR:', '').trim().replaceAll('_', ' '));
        return;
      }
      if (current.status === 'NONE') {
        setPortraitStatus('error');
        setPortraitMessage(text.portraitUnavailable);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    setPortraitStatus('error');
    setPortraitMessage(text.portraitTimedOut);
  }, [api, sessionId, text]);

  const enhance = useCallback(async () => {
    if (!api || !sessionId || portraitStatus === 'loading') return;
    setPortraitStatus('loading');
    setPortraitMessage(text.generatingScroll);
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
        setPortraitMessage(text.portraitReady);
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
      setPortraitMessage(error instanceof Error ? error.message : text.portraitFailed);
    }
  }, [api, pollEnhancement, portraitStatus, sessionId, templateId, text, winner]);

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
      title: text.resultTitle,
      text: `${winner.toUpperCase()} · ${sessionId}`,
      url: location.href
    };
    if (navigator.share) {
      await navigator.share(data);
      return;
    }
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(location.href);
      setPortraitMessage(text.shareCopied);
      return;
    }
    window.prompt(text.copyResultLink, location.href);
  };

  const content = <>
    {embedded
      ? <h3 className="scroll-title">{text.scrollTitle}</h3>
      : <>
        <img className="share-logo" src="/static/img/jujutsu-kaisen-logo.png" alt="Jujutsu Kaisen" />
        <h1>{text.resultTitle}</h1>
        <p>{winner.toUpperCase()} · {sessionId || text.noSession}</p>
      </>}
    <section className="snapshots">
      {(['player1', 'player2'] as const).map((role, index) => <figure key={role}>
        {snapshots[role]
          ? <img src={snapshots[role]} alt={text.playerCaptureAlt(index + 1)} />
          : <div className="snapshot-placeholder">{text.waitingForPlayer(index + 1)}</div>}
        <figcaption>{text.playerLabel(index + 1)}</figcaption>
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
        <option value="random">{text.randomStyle}</option>
        <option value="cyberpunk">{text.cyberpunk}</option>
        <option value="ink-wash">{text.inkShadow}</option>
        <option value="neon-glow">{text.neonForce}</option>
      </select>
      <button className="primary" disabled={!api || !sessionId || portraitStatus === 'loading'} onClick={() => void enhance()}>
        {portraitStatus === 'loading' ? text.generating : text.generatePortrait}
      </button>
      <button disabled={!portrait && Object.keys(snapshots).length === 0} onClick={downloadAvailable}>{text.downloadImages}</button>
      <button onClick={() => void share()}>{text.shareResult}</button>
    </div>
  </>;
  return embedded
    ? <section className="share-page embedded-share">{content}</section>
    : <main className="share-page">{content}</main>;
}
