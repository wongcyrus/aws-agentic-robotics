import { useEffect, useMemo, useState } from 'react';
import type { PlayerRole } from '../core/protocol';
import { uiText, type UiLanguage } from '../core/uiText';
import { ApiClient } from '../services/apiClient';
import { LocalStorageTokenProvider } from '../services/auth';
import { loadConfig } from '../services/config';

type SnapshotState = Partial<Record<PlayerRole, string>>;
type ShareAppProps = {
  sessionId?: string;
  winner?: string;
  embedded?: boolean;
  language?: UiLanguage;
};

export function ShareApp({
  sessionId: suppliedSessionId,
  winner: suppliedWinner,
  embedded = false,
  language = 'en'
}: ShareAppProps = {}) {
  const text = uiText(language);
  const query = useMemo(() => new URLSearchParams(location.search), []);
  const sessionId = suppliedSessionId ?? query.get('session') ?? '';
  const winner = suppliedWinner ?? query.get('winner') ?? 'draw';
  const [api, setApi] = useState<ApiClient>();
  const [snapshots, setSnapshots] = useState<SnapshotState>({});
  const [snapshotMessage, setSnapshotMessage] = useState(text.loadingCaptures);

  useEffect(() => {
    void loadConfig().then((config) => {
      if (config.apiBaseUrl) {
        setApi(new ApiClient(config.apiBaseUrl, new LocalStorageTokenProvider()));
      } else {
        setSnapshotMessage(text.capturesRequireApi);
      }
    });
  }, []);
  useEffect(() => {
    if (!api || !sessionId) {
      if (!sessionId) setSnapshotMessage(text.noMatchSession);
      return;
    }
    let cancelled = false;
    void (async () => {
      let lastError: unknown;
      for (let attempt = 0; attempt < 12 && !cancelled; attempt += 1) {
        try {
          const entries = await Promise.all((['player1', 'player2'] as const).map(async (role) => {
            const result = await api.getSnapshot(sessionId, role);
            return [role, result.image || ''] as const;
          }));
          const available = Object.fromEntries(entries.filter(([, image]) => image)) as SnapshotState;
          if (cancelled) return;
          setSnapshots(available);
          if (Object.keys(available).length === 2) {
            setSnapshotMessage('');
            return;
          }
          setSnapshotMessage(text.loadingCaptures);
        } catch (error) {
          lastError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
      if (cancelled) return;
      if (lastError) {
        console.error('Snapshot loading failed', lastError);
        setSnapshotMessage(lastError instanceof Error ? lastError.message : text.loadCapturesFailed);
      } else {
        setSnapshotMessage(text.capturesUnavailable);
      }
    })();
    return () => { cancelled = true; };
  }, [api, sessionId, text]);

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
      setSnapshotMessage(text.shareCopied);
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
    <div className="share-actions">
      <button disabled={Object.keys(snapshots).length === 0} onClick={downloadAvailable}>{text.downloadImages}</button>
      <button onClick={() => void share()}>{text.shareResult}</button>
    </div>
  </>;
  return embedded
    ? <section className="share-page embedded-share">{content}</section>
    : <main className="share-page">{content}</main>;
}
