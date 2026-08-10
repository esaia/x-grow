import { useCallback, useEffect, useMemo, useState } from 'react';
import { bg } from '@/lib/messaging';
import type { CreatorSummary, HarvestRun, InspirationPost } from '@/lib/types';
import RemixModal from '@/lib/dashboard/screens/RemixModal';
import {
  Banner,
  Button,
  cx,
  EmptyState,
  Spinner,
  TextInput,
} from '@/lib/dashboard/ui';

/** Ported from InspirationController::DATE_RANGES. */
const DATE_RANGES = [
  { value: 'all', label: 'Any time' },
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: '2', label: 'Last 2 days' },
  { value: '3', label: 'Last 3 days' },
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
];

const THRESHOLDS = [
  { value: 'all', label: 'All' },
  { value: '1.5', label: '≥1.5x' },
  { value: '2', label: '≥2x' },
  { value: '3', label: '≥3x' },
];

/** Baseline multiplier badge tiers — bigger outperformance, hotter colour. */
function baselineColor(multiplier: number): { bg: string; fg: string } {
  if (multiplier >= 3) return { bg: '#f4595b', fg: '#fff' };
  if (multiplier >= 2) return { bg: '#f6803c', fg: '#fff' };
  if (multiplier >= 1.5) return { bg: '#a970ff', fg: '#fff' };

  return { bg: 'rgb(255 255 255 / 10%)', fg: '#8b97a8' };
}

const inputClass =
  'rounded-lg border border-line-strong bg-ink-900 px-3 py-2 text-sm text-fg ' +
  'outline-none transition-colors focus:border-brand focus:ring-2 focus:ring-brand-wash';

function formatCount(n: number): string {
  if (n >= 1000) {
    return (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'K';
  }

  return String(n);
}

function initials(creator: { name: string | null; username: string }): string {
  return (creator.name || creator.username).slice(0, 2).toUpperCase();
}

function relativeTime(iso: string | null, now: number): string {
  if (!iso) return '';

  const then = new Date(iso).getTime();
  const days = Math.floor((now - then) / 86_400_000);

  if (days <= 0) {
    const hours = Math.floor((now - then) / 3_600_000);

    return hours <= 0 ? 'just now' : `${hours}h ago`;
  }

  if (days < 30) return `${days}d ago`;

  const months = Math.floor(days / 30);

  return months < 12 ? `${months}mo ago` : `${Math.floor(months / 12)}y ago`;
}

/**
 * The lower bound of a date filter, as epoch ms. Day boundaries are the
 * browser's local ones — this used to be computed server-side from a timezone
 * the frontend sent along, which is now simply where the user is.
 */
function dateFloor(range: string, now: number): number | null {
  if (range === 'all') return null;

  const start = new Date(now);

  start.setHours(0, 0, 0, 0);

  if (range === 'today') return start.getTime();
  if (range === 'yesterday') return start.getTime() - 86_400_000;

  const days = Number(range);

  return Number.isFinite(days) ? start.getTime() - (days - 1) * 86_400_000 : null;
}

export default function Inspiration() {
  const [creators, setCreators] = useState<CreatorSummary[] | null>(null);
  const [posts, setPosts] = useState<InspirationPost[]>([]);
  const [handle, setHandle] = useState('');
  const [creatorFilter, setCreatorFilter] = useState('all');
  const [range, setRange] = useState('all');
  const [threshold, setThreshold] = useState('all');
  const [managing, setManaging] = useState(false);
  const [remixing, setRemixing] = useState<InspirationPost | null>(null);
  const [harvest, setHarvest] = useState<HarvestRun | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // "Now" only needs to be fixed for the lifetime of a render pass; recomputing
  // it per row would make relative times drift within one list.
  const now = useMemo(() => Date.now(), [posts]);

  const refresh = useCallback(async () => {
    const [creatorRes, postRes] = await Promise.all([
      bg.creators(),
      bg.inspirationPosts(),
    ]);

    if (creatorRes.ok) setCreators(creatorRes.data.creators);
    else setError(creatorRes.error);

    if (postRes.ok) setPosts(postRes.data);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A harvest runs in its own window; poll so the board updates when it lands.
  useEffect(() => {
    const poll = async () => {
      const res = await bg.harvestStatus();

      if (!res.ok) return;

      setHarvest((previous) => {
        // Finished since the last tick — pull in what it collected.
        if (previous?.running && !res.data.running) void refresh();

        return res.data;
      });
    };

    void poll();
    const interval = setInterval(poll, 1500);

    return () => clearInterval(interval);
  }, [refresh]);

  const minMultiplier = threshold === 'all' ? 0 : Number(threshold);
  const floor = dateFloor(range, now);

  const visible = useMemo(
    () =>
      posts.filter((post) => {
        if (creatorFilter !== 'all' && post.username !== creatorFilter) return false;
        if (post.baseline_multiplier < minMultiplier) return false;

        if (floor !== null) {
          if (!post.posted_at) return false;

          const at = new Date(post.posted_at).getTime();

          if (at < floor) return false;
          // "Yesterday" is that day only, not everything since.
          if (range === 'yesterday' && at >= floor + 86_400_000) return false;
        }

        return true;
      }),
    [posts, creatorFilter, minMultiplier, floor, range],
  );

  const addCreator = async () => {
    const clean = handle.trim().replace(/^@/, '');

    if (!/^[A-Za-z0-9_]{1,15}$/.test(clean)) {
      setError('That does not look like an X handle.');
      return;
    }

    setBusy('add');
    setError('');

    const res = await bg.addCreator(clean);

    setBusy(null);

    if (res.ok) {
      setHandle('');
      setNotice(
        `Tracking @${clean}. Open their profile on X, or hit "Update data", to collect their posts.`,
      );
      await refresh();
    } else {
      setError(res.error);
    }
  };

  const removeCreator = async (username: string) => {
    setBusy(username);
    setError('');

    const res = await bg.removeCreator(username);

    setBusy(null);

    if (res.ok) {
      if (creatorFilter === username) setCreatorFilter('all');
      await refresh();
    } else {
      setError(res.error);
    }
  };

  const updateData = async () => {
    setError('');
    setNotice('');

    // `replace` on: this run is meant to become the whole of what we hold, and
    // it is applied per creator inside the ingest transaction, never upfront.
    const res = await bg.harvestAll(true);

    if (res.ok) setHarvest(res.data);
    else setError(res.error);
  };

  if (!creators) {
    return (
      <div className="flex items-center gap-3 text-fg-muted">
        <Spinner /> Loading the inspiration board…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 pb-12">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">Inspiration</h1>
          <p className="mt-1 max-w-prose text-sm text-fg-muted">
            The posts that beat each creator's own average. Ranked against their
            baseline, not raw likes, so a big account doesn't drown out a small
            one.
          </p>
        </div>

        <Button onClick={updateData} disabled={harvest?.running}>
          {harvest?.running ? <Spinner /> : null}
          {harvest?.running
            ? `Reading ${harvest.done + 1}/${harvest.total}…`
            : 'Update data'}
        </Button>
      </header>

      {error && <Banner tone="error">{error}</Banner>}
      {notice && <Banner tone="success">{notice}</Banner>}

      {harvest?.running ? (
        <Banner tone="info">
          A window is open{harvest.current ? ` on @${harvest.current}` : ''}.
          Leave it alone until it closes — X only loads a timeline it can see.
        </Banner>
      ) : harvest?.finishedAt ? (
        <p className="text-sm text-fg-faint">
          Last run: {harvest.harvested} posts from {harvest.total} creators
          {harvest.error ? ` (${harvest.error})` : ''}.
        </p>
      ) : null}

      <section className="rounded-xl border border-line bg-ink-850 p-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-base font-bold">
            Creators{creators.length > 0 && ` (${creators.length})`}
          </h2>
          {creators.length > 0 && (
            <Button variant="ghost" onClick={() => setManaging((on) => !on)}>
              {managing ? 'Done' : 'Manage'}
            </Button>
          )}
        </div>

        <div className="mb-4 flex gap-2">
          <TextInput
            value={handle}
            placeholder="@handle"
            spellCheck={false}
            onChange={(e) => setHandle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void addCreator();
            }}
          />
          <Button onClick={addCreator} disabled={busy !== null || !handle.trim()}>
            {busy === 'add' ? <Spinner /> : null}
            Track
          </Button>
        </div>

        {creators.length === 0 ? (
          <p className="text-sm text-fg-muted">
            No creators yet. Add anyone whose posts you want to learn from — no X
            API needed, the extension reads their profile as you would.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setCreatorFilter('all')}
              className={cx(
                'h-9 rounded-full border px-3.5 text-sm font-bold transition-colors',
                creatorFilter === 'all'
                  ? 'border-brand bg-brand-wash text-brand'
                  : 'border-line-strong text-fg-muted hover:bg-ink-800',
              )}
            >
              Everyone
            </button>

            {creators.map((creator) => {
              const active = creatorFilter === creator.username;

              return (
                <span
                  key={creator.username}
                  className={cx(
                    'flex h-9 items-center gap-2 rounded-full border pr-3 pl-1 transition-colors',
                    active
                      ? 'border-brand bg-brand-wash'
                      : 'border-line-strong hover:bg-ink-800',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => setCreatorFilter(active ? 'all' : creator.username)}
                    className="flex items-center gap-2"
                    title={
                      creator.last_scanned_at
                        ? `Last read ${relativeTime(creator.last_scanned_at, now)}`
                        : 'Never read yet'
                    }
                  >
                    {creator.avatar_url ? (
                      <img
                        src={creator.avatar_url}
                        alt=""
                        className="size-7 rounded-full object-cover"
                      />
                    ) : (
                      <span className="flex size-7 items-center justify-center rounded-full bg-ink-700 text-xs font-bold text-fg-muted">
                        {initials(creator)}
                      </span>
                    )}
                    <span
                      className={cx(
                        'text-sm font-bold',
                        active ? 'text-brand' : 'text-fg',
                      )}
                    >
                      @{creator.username}
                    </span>
                    <span className="text-xs text-fg-faint">
                      {creator.posts_count}
                      {creator.followers_count
                        ? ` · ${formatCount(creator.followers_count)} followers`
                        : ''}
                    </span>
                  </button>

                  {managing && (
                    <button
                      type="button"
                      aria-label={`Stop tracking @${creator.username}`}
                      title={`Stop tracking @${creator.username} and delete their posts`}
                      disabled={busy !== null}
                      onClick={() => removeCreator(creator.username)}
                      className="ml-1 text-danger hover:opacity-70"
                    >
                      ×
                    </button>
                  )}
                </span>
              );
            })}
          </div>
        )}
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <select
          value={range}
          onChange={(e) => setRange(e.target.value)}
          className={inputClass}
        >
          {DATE_RANGES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <select
          value={threshold}
          onChange={(e) => setThreshold(e.target.value)}
          className={inputClass}
        >
          {THRESHOLDS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label} baseline
            </option>
          ))}
        </select>

        <span className="text-sm text-fg-faint">
          {visible.length} of {posts.length} posts
        </span>
      </div>

      {visible.length === 0 ? (
        <EmptyState
          title={posts.length === 0 ? 'Nothing collected yet' : 'Nothing matches'}
        >
          {posts.length === 0
            ? 'Add a creator, then hit "Update data" — or just browse their profile on X and the extension collects what it sees.'
            : 'Loosen the date range or the baseline filter.'}
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-3">
          {visible.map((post) => {
            const tone = baselineColor(post.baseline_multiplier);

            return (
              <article
                key={`${post.username}-${post.x_tweet_id}`}
                className="rounded-xl border border-line bg-ink-850 p-4"
              >
                <header className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="text-sm font-bold">@{post.username}</span>
                  <span
                    className="rounded-full px-2 py-0.5 text-xs font-bold"
                    style={{ background: tone.bg, color: tone.fg }}
                  >
                    {post.baseline_multiplier}x baseline
                  </span>
                  {post.posted_at && (
                    <span className="text-xs text-fg-faint">
                      {relativeTime(post.posted_at, now)}
                    </span>
                  )}
                </header>

                <p className="text-base leading-relaxed whitespace-pre-wrap">
                  {post.content}
                </p>

                <footer className="mt-3 flex flex-wrap items-center gap-4">
                  <span className="flex gap-3 text-sm text-fg-faint">
                    <span title="Likes">♥ {formatCount(post.metrics.like)}</span>
                    <span title="Replies">↩ {formatCount(post.metrics.reply)}</span>
                    <span title="Reposts">⇄ {formatCount(post.metrics.retweet)}</span>
                  </span>

                  <span className="ml-auto flex items-center gap-3">
                    <a
                      href={post.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sm text-fg-muted hover:text-fg hover:underline"
                    >
                      Original
                    </a>
                    <Button onClick={() => setRemixing(post)}>Remix</Button>
                  </span>
                </footer>
              </article>
            );
          })}
        </div>
      )}

      {remixing && (
        <RemixModal
          post={remixing}
          onClose={() => setRemixing(null)}
          onScheduled={refresh}
        />
      )}
    </div>
  );
}
