import { useCallback, useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { bg } from '@/lib/messaging';
import type { SettingsState, XAccount } from '@/lib/types';
import { Banner, Button, Spinner } from '@/lib/dashboard/ui';

/**
 * The connect gate.
 *
 * There is no OAuth here on purpose: the extension already runs inside the
 * user's authenticated x.com session, so it can simply read who is signed in.
 * What the user agrees to is which account X-Grow writes for, not a token grant.
 *
 * Neither the popup nor the dashboard tab is on x.com, so the read is relayed
 * through an open x.com tab by the background worker.
 */
export default function Connect({
  onConnected,
}: {
  onConnected: (next: SettingsState) => void;
}) {
  const [detected, setDetected] = useState<XAccount | null | 'pending'>('pending');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const detect = useCallback(async () => {
    setDetected('pending');

    const res = await bg.detectAccount();

    setDetected(res.ok ? res.data : null);
  }, []);

  useEffect(() => {
    void detect();
  }, [detect]);

  const openX = () => {
    void browser.tabs.create({ url: 'https://x.com/home' });
  };

  const connect = async () => {
    if (detected === 'pending' || detected === null) return;

    setBusy(true);
    setError('');

    const res = await bg.connectAccount(detected);

    setBusy(false);

    if (res.ok) onConnected(res.data);
    else setError(res.error);
  };

  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-6 py-16 text-center">
      <div>
        <h1 className="text-2xl font-bold">Connect your X account</h1>
        <p className="mt-2 text-base text-fg-muted">
          X-Grow writes as you, from inside the session you're already signed in
          to. No password, no token, nothing sent to a server.
        </p>
      </div>

      {detected === 'pending' ? (
        <span className="flex items-center gap-3 text-fg-muted">
          <Spinner /> Looking for your X session…
        </span>
      ) : detected === null ? (
        <>
          <Banner tone="info">
            No signed-in X tab found. Open X, then check again.
          </Banner>
          <div className="flex gap-3">
            <Button onClick={openX}>Open X</Button>
            <Button variant="ghost" onClick={detect}>
              Check again
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="flex w-full items-center gap-3 rounded-full border border-line-strong bg-ink-850 p-2.5">
            {detected.avatar_url ? (
              <img
                src={detected.avatar_url}
                alt=""
                className="size-11 shrink-0 rounded-full object-cover"
              />
            ) : (
              <span className="size-11 shrink-0 rounded-full bg-ink-700" />
            )}
            <span className="min-w-0 flex-1 text-left">
              <span className="block truncate text-base font-bold">
                {detected.name ?? detected.handle}
              </span>
              <span className="block text-sm text-fg-muted">
                @{detected.handle}
              </span>
            </span>
          </div>

          {error && <Banner tone="error">{error}</Banner>}

          <Button onClick={connect} disabled={busy} className="w-full">
            {busy ? <Spinner /> : null}
            Continue as @{detected.handle}
          </Button>

          <button
            type="button"
            onClick={detect}
            className="text-sm text-fg-faint hover:text-fg-muted"
          >
            Not you? Switch accounts in X, then re-check.
          </button>
        </>
      )}
    </div>
  );
}
