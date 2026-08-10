import { useCallback, useEffect, useMemo, useState } from 'react';
import { POST_CATEGORIES, type PostCategory } from '@/lib/ai/prompts';
import { bg } from '@/lib/messaging';
import { addDays, dateKey, dateOf, realInstant, timeOf, weekStart } from '@/lib/time';
import type { ScheduledPost } from '@/lib/types';
import { CATEGORY_KEYS, categoryColor, STATUS_META } from '@/lib/dashboard/meta';
import PostModal, { type PostModalTarget } from '@/lib/dashboard/screens/PostModal';
import { Banner, Button, cx, Field, Spinner } from '@/lib/dashboard/ui';

const WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

/** The week grid's hour rows, in px — the mockup's proportions. */
const ROW_HEIGHT = 56;

const inputClass =
  'rounded-lg border border-line-strong bg-ink-900 px-3 py-2 text-base text-fg ' +
  'outline-none transition-colors focus:border-brand focus:ring-2 focus:ring-brand-wash';

export default function Calendar() {
  const [posts, setPosts] = useState<ScheduledPost[] | null>(null);
  const [view, setView] = useState<'week' | 'month'>('month');
  const [anchor, setAnchor] = useState(() => new Date());
  const [modal, setModal] = useState<PostModalTarget | null>(null);
  const [generating, setGenerating] = useState(false);
  const [showGenerate, setShowGenerate] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // Generate-week form.
  const [perDay, setPerDay] = useState(2);
  const [rangeStart, setRangeStart] = useState('09:00');
  const [rangeEnd, setRangeEnd] = useState('20:00');
  const [categories, setCategories] = useState<PostCategory[]>(CATEGORY_KEYS);

  const refresh = useCallback(async () => {
    const res = await bg.schedule();

    if (res.ok) setPosts(res.data);
    else setError(res.error);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // "Today" is a client-only value; computing it during render was an SSR
  // hazard in the old dashboard and is simply a correctness question here —
  // recompute it when the view changes so a long-open overlay doesn't drift.
  const today = dateKey(new Date());

  const byDate = useMemo(() => {
    const map = new Map<string, ScheduledPost[]>();

    for (const post of posts ?? []) {
      const key = dateOf(post.scheduled_at);
      const list = map.get(key);

      if (list) list.push(post);
      else map.set(key, [post]);
    }

    for (const list of map.values()) {
      list.sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at));
    }

    return map;
  }, [posts]);

  const days = useMemo(
    () => (view === 'month' ? monthGrid(anchor) : weekGrid(anchor)),
    [view, anchor],
  );

  const visible = useMemo(
    () => days.filter((day) => day.inRange).flatMap((day) => byDate.get(day.key) ?? []),
    [days, byDate],
  );

  const queued = visible.filter((post) => post.status === 'scheduled').length;
  const posted = visible.filter((post) => post.status === 'posted').length;
  const failed = visible.filter((post) => post.status === 'failed').length;

  const currentWeek = weekStart(anchor);

  const step = (direction: number) => {
    const next = new Date(anchor);

    if (view === 'month') next.setMonth(next.getMonth() + direction);
    else next.setDate(next.getDate() + direction * 7);

    setAnchor(next);
  };

  const act = async (
    label: string,
    work: () => Promise<{ ok: boolean; error?: string }>,
    success?: string,
  ) => {
    setBusy(label);
    setError('');
    setNotice('');

    const res = await work();

    setBusy(null);

    if (res.ok) {
      await refresh();
      if (success) setNotice(success);
    } else {
      setError(res.error ?? 'Something went wrong.');
    }
  };

  const generateWeek = async () => {
    setGenerating(true);
    setError('');
    setNotice('');

    const res = await bg.generateWeek({
      weekStart: currentWeek,
      rangeStart,
      rangeEnd,
      perDay,
      categories,
    });

    setGenerating(false);

    if (res.ok) {
      await refresh();
      setShowGenerate(false);
      setNotice(`Wrote ${res.data} drafts for the week of ${currentWeek}.`);
    } else {
      setError(res.error);
    }
  };

  if (!posts) {
    return (
      <div className="flex items-center gap-3 text-fg-muted">
        <Spinner /> Loading your schedule…
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <header className="flex flex-wrap items-center gap-3">
        <div className="flex items-center rounded-full border border-line-strong">
          <button
            type="button"
            aria-label="Previous"
            onClick={() => step(-1)}
            className="flex size-9 items-center justify-center rounded-l-full text-fg-muted hover:bg-ink-800 hover:text-fg"
          >
            ←
          </button>
          <span className="h-5 w-px bg-line-strong" />
          <button
            type="button"
            aria-label="Next"
            onClick={() => step(1)}
            className="flex size-9 items-center justify-center rounded-r-full text-fg-muted hover:bg-ink-800 hover:text-fg"
          >
            →
          </button>
        </div>

        <h1 className="text-xl font-bold">{periodLabel(anchor, view)}</h1>

        <span className="flex items-center gap-3 text-sm text-fg-muted">
          <Legend color={STATUS_META.scheduled.color} label={`${queued} queued`} />
          <Legend color={STATUS_META.posted.color} label={`${posted} posted`} />
          {failed > 0 && (
            <Legend color={STATUS_META.failed.color} label={`${failed} failed`} />
          )}
        </span>

        <div className="ml-auto flex items-center gap-2">
          <div className="flex rounded-full border border-line-strong p-0.5">
            {(['week', 'month'] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setView(option)}
                className={cx(
                  'h-7 rounded-full px-3 text-sm font-bold capitalize transition-colors',
                  view === option
                    ? 'bg-ink-700 text-fg'
                    : 'text-fg-muted hover:text-fg',
                )}
              >
                {option}
              </button>
            ))}
          </div>

          <Button variant="ghost" onClick={() => setAnchor(new Date())}>
            Today
          </Button>
          <Button onClick={() => setShowGenerate((open) => !open)}>
            Generate week
          </Button>
        </div>
      </header>

      {error && <Banner tone="error">{error}</Banner>}
      {notice && <Banner tone="success">{notice}</Banner>}

      {queued > 0 && (
        <p className="text-sm text-fg-faint">
          Queued posts publish through X's own composer, so a small window will
          flash when one goes out. They only fire while Chrome is running — a
          post whose time passed while it was closed goes out late, not never.
        </p>
      )}

      {showGenerate && (
        <section className="rounded-xl border border-line bg-ink-850 p-5">
          <h2 className="text-base font-bold">
            Fill the week of {currentWeek}
          </h2>
          <p className="mt-1 mb-4 max-w-prose text-sm text-fg-muted">
            One OpenAI call writes the whole week. Existing drafts for this week
            are replaced; anything you already approved or posted is left alone.
          </p>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Posts per day">
              <select
                value={perDay}
                onChange={(e) => setPerDay(Number(e.target.value))}
                className={cx(inputClass, 'w-full')}
              >
                {[1, 2, 3, 4, 5, 6].map((n) => (
                  <option key={n} value={n}>
                    {n} per day ({n * 7} total)
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Earliest">
              <input
                type="time"
                value={rangeStart}
                onChange={(e) => setRangeStart(e.target.value)}
                className={cx(inputClass, 'w-full')}
              />
            </Field>
            <Field label="Latest">
              <input
                type="time"
                value={rangeEnd}
                onChange={(e) => setRangeEnd(e.target.value)}
                className={cx(inputClass, 'w-full')}
              />
            </Field>
          </div>

          <div className="mt-4">
            <Field label="Mix of styles">
              <div className="flex flex-wrap gap-2">
                {CATEGORY_KEYS.map((key) => {
                  const on = categories.includes(key);

                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() =>
                        setCategories((current) =>
                          on
                            ? current.filter((c) => c !== key)
                            : [...current, key],
                        )
                      }
                      className={cx(
                        'flex h-8 items-center gap-2 rounded-full border px-3 text-sm font-bold transition-colors',
                        on
                          ? 'border-transparent text-fg'
                          : 'border-line-strong text-fg-faint hover:bg-ink-800',
                      )}
                      style={on ? { background: `${categoryColor(key)}2e` } : undefined}
                    >
                      <span
                        className="size-2 rounded-full"
                        style={{
                          background: on ? categoryColor(key) : 'currentColor',
                        }}
                      />
                      {POST_CATEGORIES[key]}
                    </button>
                  );
                })}
              </div>
            </Field>
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <Button
              onClick={generateWeek}
              disabled={generating || categories.length === 0}
            >
              {generating ? <Spinner /> : null}
              {generating ? 'Writing the week…' : 'Generate'}
            </Button>
            <Button
              variant="ghost"
              disabled={busy !== null}
              onClick={() =>
                act(
                  'approve-week',
                  async () => {
                    const res = await bg.approveWeek(currentWeek);

                    if (res.ok) {
                      setNotice(
                        `Queued ${res.data.approved} posts` +
                          (res.data.skipped
                            ? `, skipped ${res.data.skipped} already in the past.`
                            : '.'),
                      );
                    }

                    return res;
                  },
                )
              }
            >
              {busy === 'approve-week' ? <Spinner /> : null}
              Approve the whole week
            </Button>
            <Button
              variant="danger"
              disabled={busy !== null}
              onClick={() =>
                act('empty-week', () => bg.emptyWeek(currentWeek), 'Drafts cleared.')
              }
            >
              Clear drafts
            </Button>
          </div>
        </section>
      )}

      <div className="xg-scroll min-h-0 flex-1 overflow-auto rounded-xl border border-line">
        {view === 'month' ? (
          <MonthGrid
            days={days}
            byDate={byDate}
            today={today}
            onOpen={setModal}
          />
        ) : (
          <WeekGrid days={days} byDate={byDate} today={today} onOpen={setModal} />
        )}
      </div>

      {modal && (
        <PostModal
          target={modal}
          onClose={() => setModal(null)}
          onChanged={refresh}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ views */

interface Day {
  key: string;
  date: Date;
  /** False for the leading/trailing days a month grid borrows from its neighbours. */
  inRange: boolean;
}

function MonthGrid({
  days,
  byDate,
  today,
  onOpen,
}: {
  days: Day[];
  byDate: Map<string, ScheduledPost[]>;
  today: string;
  onOpen: (target: PostModalTarget) => void;
}) {
  return (
    <div className="min-w-[720px]">
      <div className="grid grid-cols-7 border-b border-line">
        {WEEKDAYS.map((label) => (
          <div
            key={label}
            className="px-3 py-2.5 text-center text-xs font-bold tracking-widest text-fg-faint"
          >
            {label}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7">
        {days.map((day) => {
          const posts = byDate.get(day.key) ?? [];
          const isToday = day.key === today;
          // Days you can no longer schedule into. Faded as a whole rather than
          // just the number, so the usable part of the month is obvious.
          const isPast = day.key < today;

          return (
            <div
              key={day.key}
              className={cx(
                'min-h-[124px] border-r border-b border-line p-2 transition-opacity last:border-r-0',
                day.inRange ? 'bg-transparent' : 'bg-ink-950/60',
                isPast && 'opacity-40 hover:opacity-75',
              )}
              onDoubleClick={() =>
                onOpen({ mode: 'create', date: day.key, time: '09:00' })
              }
            >
              <span
                className={cx(
                  'mb-1.5 inline-flex size-6 items-center justify-center rounded-full text-sm',
                  isToday
                    ? 'bg-brand font-bold text-white'
                    : day.inRange
                      ? 'text-fg-muted'
                      : 'text-fg-faint',
                )}
              >
                {day.date.getDate()}
              </span>

              <div className="flex flex-col gap-1">
                {posts.map((post) => (
                  <Chip key={post.id} post={post} onOpen={onOpen} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The week view is an hour grid rather than seven lists: seeing that every post
 * lands at 9am is the whole reason to look at a week.
 */
function WeekGrid({
  days,
  byDate,
  today,
  onOpen,
}: {
  days: Day[];
  byDate: Map<string, ScheduledPost[]>;
  today: string;
  onOpen: (target: PostModalTarget) => void;
}) {
  const hours = Array.from({ length: 24 }, (_, i) => i);

  return (
    <div className="min-w-[820px]">
      <div className="sticky top-0 z-1 grid grid-cols-[56px_repeat(7,1fr)] border-b border-line bg-ink-900">
        <div />
        {days.map((day) => (
          <div key={day.key} className="px-2 py-2.5 text-center">
            <div className="text-xs font-bold tracking-widest text-fg-faint">
              {WEEKDAYS[(day.date.getDay() + 6) % 7]}
            </div>
            <div
              className={cx(
                'mt-1 inline-flex size-6 items-center justify-center rounded-full text-sm',
                day.key === today ? 'bg-brand font-bold text-white' : 'text-fg-muted',
              )}
            >
              {day.date.getDate()}
            </div>
          </div>
        ))}
      </div>

      <div className="relative grid grid-cols-[56px_repeat(7,1fr)]">
        <div>
          {hours.map((hour) => (
            <div
              key={hour}
              style={{ height: ROW_HEIGHT }}
              className="pr-2 text-right text-xs text-fg-faint"
            >
              {hour === 0 ? '' : `${String(hour).padStart(2, '0')}:00`}
            </div>
          ))}
        </div>

        {days.map((day) => (
          <div
            key={day.key}
            className={cx(
              'relative border-l border-line transition-opacity',
              day.key < today && 'opacity-40 hover:opacity-75',
            )}
          >
            {hours.map((hour) => (
              <div
                key={hour}
                style={{ height: ROW_HEIGHT }}
                className="border-b border-line/60 hover:bg-ink-850/60"
                onDoubleClick={() =>
                  onOpen({
                    mode: 'create',
                    date: day.key,
                    time: `${String(hour).padStart(2, '0')}:00`,
                  })
                }
              />
            ))}

            {(byDate.get(day.key) ?? []).map((post) => {
              const [h, m] = timeOf(post.scheduled_at).split(':').map(Number);

              return (
                <div
                  key={post.id}
                  className="absolute right-1 left-1"
                  style={{ top: (h + m / 60) * ROW_HEIGHT + 2 }}
                >
                  <Chip post={post} onOpen={onOpen} />
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function Chip({
  post,
  onOpen,
}: {
  post: ScheduledPost;
  onOpen: (target: PostModalTarget) => void;
}) {
  const status = STATUS_META[post.status];

  // A draft whose slot has gone can never be queued. Fading it says so at a
  // glance, instead of leaving it looking like everything else on the board.
  const stale =
    post.status === 'draft' &&
    realInstant(post.scheduled_at, post.timezone) <= Date.now();

  return (
    <button
      type="button"
      title={
        stale
          ? `Draft · that time has passed · ${post.content.slice(0, 140)}`
          : `${status.label} · ${post.content.slice(0, 140)}`
      }
      onClick={() => onOpen({ mode: 'edit', post })}
      className={cx(
        'flex w-full items-center gap-1.5 overflow-hidden rounded-md border border-line bg-ink-850 py-1 pr-2 pl-0 text-left transition-colors hover:bg-ink-800',
        stale && 'opacity-45',
      )}
    >
      <span
        className="h-4 w-[3px] shrink-0 rounded-full"
        style={{ background: categoryColor(post.category) }}
      />
      <span className="text-xs font-bold" style={{ color: status.color }}>
        {timeOf(post.scheduled_at)}
      </span>
      <span className="truncate text-xs text-fg-muted">{post.content}</span>
    </button>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="size-2 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}

/* ------------------------------------------------------------------ dates */

function monthGrid(anchor: Date): Day[] {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const offset = (first.getDay() + 6) % 7; // Monday-based
  const start = new Date(first);

  start.setDate(first.getDate() - offset);

  return Array.from({ length: 42 }, (_, i) => {
    const date = new Date(start);

    date.setDate(start.getDate() + i);

    return {
      key: dateKey(date),
      date,
      inRange: date.getMonth() === anchor.getMonth(),
    };
  });
}

function weekGrid(anchor: Date): Day[] {
  const monday = weekStart(anchor);

  return Array.from({ length: 7 }, (_, i) => {
    const key = addDays(monday, i);
    const [y, m, d] = key.split('-').map(Number);

    return { key, date: new Date(y, m - 1, d), inRange: true };
  });
}

function periodLabel(anchor: Date, view: 'week' | 'month'): string {
  if (view === 'month') {
    return anchor.toLocaleDateString(undefined, {
      month: 'long',
      year: 'numeric',
    });
  }

  const monday = weekGrid(anchor)[0].date;
  const sunday = weekGrid(anchor)[6].date;
  const sameMonth = monday.getMonth() === sunday.getMonth();

  const left = monday.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
  const right = sunday.toLocaleDateString(undefined, {
    month: sameMonth ? undefined : 'short',
    day: 'numeric',
    year: 'numeric',
  });

  return `${left} – ${right}`;
}
