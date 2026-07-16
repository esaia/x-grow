import { type FormEvent, useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { dashboardUrl } from '@/lib/config';
import { bg } from '@/lib/messaging';
import type { AuthState } from '@/lib/types';
import './App.css';

function App() {
  const [state, setState] = useState<AuthState | null>(null);
  const [loading, setLoading] = useState(true);
  const [apiUrl, setApiUrl] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const refresh = async () => {
    const res = await bg.getAuth();
    if (res.ok) {
      setState(res.data);
      setApiUrl(res.data.apiBaseUrl);
    } else {
      setError(res.error);
    }
    setLoading(false);
  };

  useEffect(() => {
    refresh();
  }, []);

  const connect = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setSaving(true);
    const res = await bg.saveAuth(token.trim(), apiUrl.trim());
    setSaving(false);
    if (res.ok) {
      setState(res.data);
      setToken('');
    } else {
      setError(res.error);
    }
  };

  const disconnect = async () => {
    const res = await bg.logout();
    if (res.ok) setState(res.data);
  };

  const openDashboard = (path: string) => {
    const base = dashboardUrl(state?.apiBaseUrl ?? apiUrl);
    browser.tabs.create({ url: base + path });
  };

  return (
    <div className="xg-popup">
      <header className="xg-header">
        <span className="xg-logo" aria-hidden>
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2C12.5 7 17 11.5 22 12C17 12.5 12.5 17 12 22C11.5 17 7 12.5 2 12C7 11.5 12.5 7 12 2Z" />
          </svg>
        </span>
        <div>
          <h1>X-Grow</h1>
          <p>AI replies &amp; posts in your voice</p>
        </div>
      </header>

      {loading ? (
        <p className="xg-muted">Loading…</p>
      ) : state?.connected && state.me ? (
        <div className="xg-connected">
          <div className="xg-status">
            <span className="xg-dot" /> Connected as{' '}
            <strong>{state.me.user.email}</strong>
          </div>

          <div className="xg-stats">
            <div>
              <span className="xg-stat-num">{state.me.usage.today}</span>
              <span className="xg-stat-label">today</span>
            </div>
            <div>
              <span className="xg-stat-num">{state.me.usage.total}</span>
              <span className="xg-stat-label">total</span>
            </div>
            <div>
              <span className="xg-stat-num xg-tone">
                {state.me.voice_profile?.tone ?? 'balanced'}
              </span>
              <span className="xg-stat-label">tone</span>
            </div>
          </div>

          {!state.me.voice_profile?.sample_posts && (
            <div className="xg-tip">
              Tip: add a few of your real posts in your Voice profile so replies
              sound like you.
            </div>
          )}

          <div className="xg-actions">
            <button onClick={() => openDashboard('/voice')}>
              Edit voice profile
            </button>
            <button onClick={() => openDashboard('/history')} className="xg-ghost">
              History
            </button>
          </div>

          <p className="xg-hint">
            Open <strong>x.com</strong> and use the ✨ buttons on replies and the
            composer.
          </p>

          <button onClick={disconnect} className="xg-link">
            Disconnect
          </button>
        </div>
      ) : (
        <form className="xg-form" onSubmit={connect}>
          <p className="xg-muted">
            Paste a token from your dashboard to connect this browser.
          </p>

          <label>
            API URL
            <input
              type="text"
              value={apiUrl}
              onChange={(e) => setApiUrl(e.target.value)}
              placeholder="http://localhost:8000/api"
              spellCheck={false}
            />
          </label>

          <label>
            Token
            <textarea
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="1|abc123…"
              rows={3}
              spellCheck={false}
            />
          </label>

          {error && <p className="xg-error">{error}</p>}

          <button type="submit" disabled={saving || !token.trim()}>
            {saving ? 'Connecting…' : 'Connect'}
          </button>

          <button
            type="button"
            className="xg-link"
            onClick={() => openDashboard('/connect')}
          >
            Get a token from the dashboard →
          </button>
        </form>
      )}
    </div>
  );
}

export default App;
