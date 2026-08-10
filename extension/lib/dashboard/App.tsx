import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { bg } from '@/lib/messaging';
import type { SettingsState } from '@/lib/types';
import { sparkSvg } from '@/lib/xtheme';
import {
  BoltIcon,
  CalendarIcon,
  ExpandIcon,
  HomeIcon,
  InspirationIcon,
  SettingsIcon,
  VoiceIcon,
} from '@/lib/dashboard/icons';
import Calendar from '@/lib/dashboard/screens/Calendar';
import Connect from '@/lib/dashboard/screens/Connect';
import Home from '@/lib/dashboard/screens/Home';
import Inspiration from '@/lib/dashboard/screens/Inspiration';
import Settings from '@/lib/dashboard/screens/Settings';
import Voice from '@/lib/dashboard/screens/Voice';
import { cx, Spinner } from '@/lib/dashboard/ui';

export type Screen = 'home' | 'voice' | 'calendar' | 'inspiration' | 'settings';

/**
 * Which document this instance is mounted in. The popup is capped by Chrome at
 * 800x600 and closes whenever it loses focus, so it offers a way out to the
 * tab; the tab is the same app with room to breathe.
 */
export type Surface = 'popup' | 'tab';

/**
 * Icon nav, matching the mockup. Screens land here as their phase ships —
 * History is still to come, and is left out rather than rendered as a dead
 * button.
 */
const NAV: { id: Screen; label: string; Icon: typeof HomeIcon }[] = [
  { id: 'home', label: 'Home', Icon: HomeIcon },
  { id: 'voice', label: 'Voice profile', Icon: VoiceIcon },
  { id: 'calendar', label: 'Schedule', Icon: CalendarIcon },
  { id: 'inspiration', label: 'Inspiration', Icon: InspirationIcon },
  { id: 'settings', label: 'Settings', Icon: SettingsIcon },
];

export default function App({ surface }: { surface: Surface }) {
  // "Open in tab" carries the current screen across in the hash, so you land
  // where you were rather than back on Home.
  const [screen, setScreen] = useState<Screen>(() => {
    const hash = location.hash.replace('#', '');

    return NAV.some((item) => item.id === hash) ? (hash as Screen) : 'home';
  });
  const [settings, setSettings] = useState<SettingsState | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void bg.getSettings().then((res) => {
      if (res.ok) {
        setSettings(res.data);
        // First run: send them straight to the one step that's still missing.
        if (res.data.account && !res.data.hasKey) setScreen('settings');
      } else {
        setError(res.error);
      }
    });
  }, []);

  /** Reopen the current screen in a full tab, and get out of the popup's way. */
  const openInTab = () => {
    void browser.tabs.create({
      url: `${browser.runtime.getURL('/dashboard.html')}#${screen}`,
    });
    window.close();
  };

  return (
    <div className="flex h-full flex-col bg-ink-900">
      <nav className="flex shrink-0 items-center gap-1 border-b border-line px-3 py-2.5">
        {/* The nav is meaningless until an account is connected. */}
        {settings?.account &&
          NAV.map(({ id, label, Icon }) => {
            const active = screen === id;

            return (
              <button
                key={id}
                type="button"
                title={label}
                aria-label={label}
                aria-current={active}
                onClick={() => setScreen(id)}
                className={cx(
                  'flex size-9 items-center justify-center rounded-lg transition-colors',
                  active
                    ? 'bg-brand-wash text-brand'
                    : 'text-fg-muted hover:bg-ink-800 hover:text-fg',
                )}
              >
                <Icon />
              </button>
            );
          })}

        <div className="ml-auto flex items-center gap-2">
          {settings?.account && (
            <>
              <span
                className="inline-flex h-8 items-center gap-1.5 rounded-full bg-ink-800 px-3 text-sm font-bold text-fg-muted"
                title="Generations today"
              >
                <BoltIcon className="text-brand" />
                {settings.usage.today}
              </span>

              <button
                type="button"
                title={`Posting as @${settings.account.handle}`}
                onClick={() => setScreen('settings')}
                className="flex items-center gap-2 rounded-full py-0.5 pr-3 pl-0.5 transition-colors hover:bg-ink-800"
              >
                {settings.account.avatar_url ? (
                  <img
                    src={settings.account.avatar_url}
                    alt=""
                    className="size-8 rounded-full object-cover"
                  />
                ) : (
                  <span className="size-8 rounded-full bg-ink-700" />
                )}
                <span className="text-sm font-bold text-fg-muted">
                  @{settings.account.handle}
                </span>
              </button>
            </>
          )}

          <span
            className="flex size-9 items-center justify-center rounded-full bg-brand text-white"
            aria-hidden="true"
            dangerouslySetInnerHTML={{ __html: sparkSvg(20) }}
          />

          {surface === 'popup' && (
            <button
              type="button"
              aria-label="Open in a full tab"
              title="Open in a full tab"
              onClick={openInTab}
              className="flex size-9 items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-ink-800 hover:text-fg"
            >
              <ExpandIcon />
            </button>
          )}
        </div>
      </nav>

      <main className="xg-scroll min-h-0 flex-1 overflow-y-auto px-6 py-6">
        {error ? (
          <p className="text-danger">{error}</p>
        ) : !settings ? (
          <div className="flex items-center gap-3 text-fg-muted">
            <Spinner /> Loading…
          </div>
        ) : !settings.account ? (
          <Connect
            onConnected={(next) => {
              setSettings(next);
              setScreen(next.hasKey ? 'home' : 'settings');
            }}
          />
        ) : screen === 'home' ? (
          <Home settings={settings} onGoTo={setScreen} />
        ) : screen === 'voice' ? (
          <Voice account={settings.account} />
        ) : screen === 'calendar' ? (
          <Calendar />
        ) : screen === 'inspiration' ? (
          <Inspiration />
        ) : (
          <Settings settings={settings} onChange={setSettings} />
        )}
      </main>
    </div>
  );
}
