import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import {
  currentUsername,
  hasConfiguredAuthentication,
  LocalStorageTokenProvider,
  signIn,
  signOut
} from '../services/auth';
import { loadConfig, type AppConfig } from '../services/config';

export function AuthGate({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void loadConfig().then((loaded) => {
      setConfig(loaded);
      setAuthenticated(
        !hasConfiguredAuthentication(loaded) ||
        Boolean(new LocalStorageTokenProvider().getIdToken())
      );
    });
  }, []);

  if (!config) {
    return <main className="auth-loading">Loading Domain Expansion…</main>;
  }

  if (!authenticated) {
    const submit = async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      setBusy(true);
      setError('');
      try {
        await signIn(
          config,
          String(data.get('username') ?? '').trim(),
          String(data.get('password') ?? '')
        );
        setAuthenticated(true);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Authentication failed');
      } finally {
        setBusy(false);
      }
    };
    return <main className="auth-page">
      <form className="auth-card" onSubmit={(event) => void submit(event)}>
        <img src="/static/img/jujutsu-kaisen-logo.png" alt="Jujutsu Kaisen" />
        <h1>Domain Expansion</h1>
        <p>Authenticate to enter the online battle.</p>
        <label>Email<input name="username" type="email" autoComplete="username" required /></label>
        <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
        {error && <strong className="auth-error">{error}</strong>}
        <button className="primary" disabled={busy}>{busy ? 'Authenticating…' : 'Release Domain'}</button>
      </form>
    </main>;
  }

  return <>
    {hasConfiguredAuthentication(config) && <div className="auth-badge">
      <span>{currentUsername() ?? 'Sorcerer'}</span>
      <button onClick={() => { signOut(); location.reload(); }}>Logout</button>
    </div>}
    {children}
  </>;
}
