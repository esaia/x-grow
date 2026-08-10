import { useMemo, useState } from 'react';
import { REMIX_CLOSENESS, type RemixCloseness } from '@/lib/ai/prompts';
import { MAX_TWEET } from '@/lib/config';
import { bg } from '@/lib/messaging';
import { dateKey, localTimezone, timeKey } from '@/lib/time';
import type { InspirationPost } from '@/lib/types';
import { Banner, Button, cx, Field, Spinner, TextArea } from '@/lib/dashboard/ui';

/** Ported from the platform's CLOSENESS_OPTIONS. */
const CLOSENESS: {
  value: RemixCloseness;
  label: string;
  description: string;
}[] = [
  {
    value: 'build',
    label: REMIX_CLOSENESS.build,
    description: 'Keep it close, lightly polished',
  },
  {
    value: 'balanced',
    label: REMIX_CLOSENESS.balanced,
    description: 'Same shape, your words',
  },
  {
    value: 'mine',
    label: REMIX_CLOSENESS.mine,
    description: 'Same idea, rewritten fully',
  },
];

const inputClass =
  'rounded-lg border border-line-strong bg-ink-900 px-3 py-2 text-base text-fg ' +
  'outline-none transition-colors focus:border-brand focus:ring-2 focus:ring-brand-wash';

interface Slot {
  ms: number;
  time: string;
  sub: string;
}

/**
 * A few suggested posting times for the rest of today: rounded up to the next
 * half hour (with a little lead time), then spaced ~2.5h apart until late.
 * Ported from the platform's buildTodaySlots.
 */
function buildTodaySlots(nowMs: number): Slot[] {
  const earliest = new Date(nowMs + 20 * 60_000);

  earliest.setSeconds(0, 0);
  earliest.setMinutes(earliest.getMinutes() <= 30 ? 30 : 60);

  const endOfDay = new Date(nowMs);

  endOfDay.setHours(23, 30, 0, 0);

  const slots: Slot[] = [];

  for (let i = 0; i < 4; i++) {
    const at = new Date(earliest.getTime() + i * 150 * 60_000);

    if (at.getTime() > endOfDay.getTime()) break;

    const hours = Math.round((at.getTime() - nowMs) / 3_600_000);

    slots.push({
      ms: at.getTime(),
      time: timeKey(at),
      sub: hours <= 0 ? 'soon' : `in ${hours}h`,
    });
  }

  return slots;
}

export default function RemixModal({
  post,
  onClose,
  onScheduled,
}: {
  post: InspirationPost;
  onClose: () => void;
  onScheduled: () => void;
}) {
  const [closeness, setCloseness] = useState<RemixCloseness>('balanced');
  const [instructions, setInstructions] = useState('');
  const [options, setOptions] = useState<string[]>([]);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const now = useMemo(() => Date.now(), []);
  const slots = useMemo(() => buildTodaySlots(now), [now]);

  const [date, setDate] = useState(() => dateKey(new Date(now)));
  const [time, setTime] = useState(() => slots[0]?.time ?? '18:00');

  const over = (draft?.length ?? 0) > MAX_TWEET;

  const generate = async () => {
    setBusy('generate');
    setError('');
    setNotice('');

    const res = await bg.remix({
      content: post.content,
      closeness,
      instructions: instructions.trim() || null,
      source_tweet_id: post.x_tweet_id,
      source_username: post.username,
    });

    setBusy(null);

    if (res.ok) {
      setOptions(res.data.options);
      setDraft(res.data.options[0] ?? null);
    } else {
      setError(res.error);
    }
  };

  /** Save the draft into the schedule, optionally publishing it right away. */
  const commit = async (mode: 'now' | 'schedule' | 'draft') => {
    if (!draft || draft.trim() === '') return;

    setBusy(mode);
    setError('');
    setNotice('');

    const target =
      mode === 'now'
        ? { date: dateKey(new Date()), time: timeKey(new Date()) }
        : { date, time };

    const created = await bg.createPost({
      content: draft,
      category: null,
      ...target,
      timezone: localTimezone(),
    });

    if (!created.ok) {
      setBusy(null);
      setError(created.error);
      return;
    }

    if (mode === 'draft') {
      setBusy(null);
      onScheduled();
      onClose();
      return;
    }

    if (mode === 'schedule') {
      const approved = await bg.approvePost(created.data);

      setBusy(null);

      if (!approved.ok) {
        setError(approved.error);
        return;
      }

      onScheduled();
      onClose();
      return;
    }

    // Post now: the row already exists, so a failure leaves something visible
    // and retryable on the calendar rather than vanishing.
    const published = await bg.publishNow(created.data);

    setBusy(null);

    if (published.ok) {
      onScheduled();
      onClose();
    } else {
      setError(published.error);
      onScheduled();
    }
  };

  return (
    <div
      className="xg-anim-fade fixed inset-0 z-10 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="xg-anim-rise flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-line-strong bg-ink-850"
      >
        <header className="border-b border-line px-5 py-4">
          <h2 className="text-lg font-bold">Remix this post</h2>
          <p className="mt-0.5 text-sm text-fg-muted">
            Rewritten in your voice. @{post.username} is never mentioned.
          </p>
        </header>

        <div className="xg-scroll flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
          {error && <Banner tone="error">{error}</Banner>}
          {notice && <Banner tone="success">{notice}</Banner>}

          <blockquote className="rounded-lg border border-line bg-ink-900 p-3 text-sm leading-relaxed whitespace-pre-wrap text-fg-muted">
            {post.content}
          </blockquote>

          <Field label="How close to the original">
            <div className="grid gap-2 sm:grid-cols-3">
              {CLOSENESS.map((option) => {
                const active = closeness === option.value;

                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setCloseness(option.value)}
                    className={cx(
                      'rounded-lg border p-3 text-left transition-colors',
                      active
                        ? 'border-brand bg-brand-wash'
                        : 'border-line-strong hover:bg-ink-800',
                    )}
                  >
                    <span
                      className={cx(
                        'block text-sm font-bold',
                        active ? 'text-brand' : 'text-fg',
                      )}
                    >
                      {option.label}
                    </span>
                    <span className="mt-0.5 block text-xs text-fg-muted">
                      {option.description}
                    </span>
                  </button>
                );
              })}
            </div>
          </Field>

          <Field label="Anything to steer it" hint="Optional.">
            <TextArea
              rows={2}
              value={instructions}
              placeholder="Make it about my own launch. Keep it under two lines."
              onChange={(e) => setInstructions(e.target.value)}
            />
          </Field>

          {options.length === 0 ? (
            <Button onClick={generate} disabled={busy !== null}>
              {busy === 'generate' ? <Spinner /> : null}
              {busy === 'generate' ? 'Writing…' : 'Write 3 versions'}
            </Button>
          ) : (
            <>
              <Field label="Pick one">
                <div className="flex flex-col gap-2">
                  {options.map((option, index) => (
                    <button
                      key={index}
                      type="button"
                      onClick={() => setDraft(option)}
                      className={cx(
                        'rounded-lg border p-3 text-left text-base leading-relaxed whitespace-pre-wrap transition-colors',
                        draft === option
                          ? 'border-brand bg-brand-wash'
                          : 'border-line-strong hover:bg-ink-800',
                      )}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              </Field>

              <Field label="Edit before it goes out">
                <TextArea
                  rows={4}
                  value={draft ?? ''}
                  onChange={(e) => setDraft(e.target.value)}
                />
              </Field>

              <div className="-mt-2 flex items-center justify-between">
                <span
                  className={cx('text-sm', over ? 'text-danger' : 'text-fg-faint')}
                >
                  {draft?.length ?? 0} / {MAX_TWEET}
                </span>
                <Button variant="ghost" onClick={generate} disabled={busy !== null}>
                  {busy === 'generate' ? <Spinner /> : null}
                  Try again
                </Button>
              </div>

              <Field label="When">
                <div className="flex flex-wrap gap-2">
                  {slots.map((slot) => (
                    <button
                      key={slot.ms}
                      type="button"
                      onClick={() => {
                        setDate(dateKey(new Date(slot.ms)));
                        setTime(slot.time);
                      }}
                      className={cx(
                        'rounded-lg border px-3 py-2 text-left transition-colors',
                        time === slot.time && date === dateKey(new Date(slot.ms))
                          ? 'border-brand bg-brand-wash text-brand'
                          : 'border-line-strong text-fg-muted hover:bg-ink-800',
                      )}
                    >
                      <span className="block text-sm font-bold">{slot.time}</span>
                      <span className="block text-xs opacity-70">{slot.sub}</span>
                    </button>
                  ))}

                  <input
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    className={inputClass}
                  />
                  <input
                    type="time"
                    value={time}
                    onChange={(e) => setTime(e.target.value)}
                    className={inputClass}
                  />
                </div>
              </Field>
            </>
          )}
        </div>

        <footer className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-4">
          {draft && (
            <>
              <Button
                onClick={() => commit('schedule')}
                disabled={busy !== null || over}
              >
                {busy === 'schedule' ? <Spinner /> : null}
                Queue it
              </Button>
              <Button
                variant="ghost"
                onClick={() => commit('now')}
                disabled={busy !== null || over}
              >
                {busy === 'now' ? <Spinner /> : null}
                Post now
              </Button>
              <Button
                variant="ghost"
                onClick={() => commit('draft')}
                disabled={busy !== null || over}
              >
                Save as draft
              </Button>
            </>
          )}

          <span className="ml-auto" />

          <a
            href={post.url}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-fg-muted hover:text-fg hover:underline"
          >
            See the original →
          </a>

          <Button variant="ghost" onClick={onClose} disabled={busy !== null}>
            Close
          </Button>
        </footer>
      </div>
    </div>
  );
}
