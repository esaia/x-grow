import { useState } from 'react';
import { POST_CATEGORIES, type PostCategory } from '@/lib/ai/prompts';
import { MAX_TWEET } from '@/lib/config';
import { bg } from '@/lib/messaging';
import { dateOf, localTimezone, naive, realInstant, timeOf } from '@/lib/time';
import type { ScheduledPost } from '@/lib/types';
import { CATEGORY_KEYS, categoryColor, STATUS_META } from '@/lib/dashboard/meta';
import { Banner, Button, cx, Field, Spinner, TextArea } from '@/lib/dashboard/ui';

/** Creating a post at a slot, or editing one that already exists. */
export type PostModalTarget =
  | { mode: 'create'; date: string; time: string }
  | { mode: 'edit'; post: ScheduledPost };

const inputClass =
  'rounded-lg border border-line-strong bg-ink-900 px-3 py-2 text-base text-fg ' +
  'outline-none transition-colors focus:border-brand focus:ring-2 focus:ring-brand-wash';

export default function PostModal({
  target,
  onClose,
  onChanged,
}: {
  target: PostModalTarget;
  onClose: () => void;
  onChanged: () => void;
}) {
  const editing = target.mode === 'edit' ? target.post : null;

  const [content, setContent] = useState(editing?.content ?? '');
  const [category, setCategory] = useState<PostCategory | null>(
    editing?.category ?? null,
  );
  const [date, setDate] = useState(
    editing ? dateOf(editing.scheduled_at) : target.mode === 'create' ? target.date : '',
  );
  const [time, setTime] = useState(
    editing ? timeOf(editing.scheduled_at) : target.mode === 'create' ? target.time : '09:00',
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const over = content.length > MAX_TWEET;
  const status = editing ? STATUS_META[editing.status] : null;

  // A draft in the past is allowed — "Generate week" fills all seven days, so
  // generating mid-week necessarily writes drafts into days that have gone. It
  // just can't be *queued*, since the alarm would never reach it. Say so here
  // rather than letting the user find out by clicking Approve.
  const isPast =
    date !== '' &&
    realInstant(naive(date, time), editing?.timezone ?? localTimezone()) <=
      Date.now();

  /** Run an action, surface its error, and refresh the board if it worked. */
  const act = async (
    label: string,
    work: () => Promise<{ ok: boolean; error?: string }>,
    close = true,
  ) => {
    setBusy(label);
    setError('');

    const res = await work();

    setBusy(null);

    if (!res.ok) {
      setError(res.error ?? 'Something went wrong.');
      return;
    }

    onChanged();
    if (close) onClose();
  };

  const save = () =>
    act('save', async () => {
      if (content.trim() === '') {
        return { ok: false, error: 'Write something first.' };
      }

      return editing
        ? bg.updatePost({ id: editing.id, content, category, date, time })
        : bg.createPost({ content, category, date, time });
    });

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
        className="xg-anim-rise flex max-h-full w-full max-w-xl flex-col overflow-hidden rounded-xl border border-line-strong bg-ink-850"
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="text-lg font-bold">
            {editing ? 'Edit post' : 'New post'}
          </h2>
          {status && (
            <span
              className="rounded-full px-2.5 py-1 text-xs font-bold"
              style={{ color: status.color, background: `${status.color}22` }}
              title={status.hint}
            >
              {status.label}
            </span>
          )}
        </header>

        <div className="xg-scroll flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
          {error && <Banner tone="error">{error}</Banner>}

          {editing?.error && editing.status === 'failed' && (
            <Banner tone="error">{editing.error}</Banner>
          )}

          <Field label="Post">
            <TextArea
              rows={5}
              value={content}
              placeholder="What goes out at this time?"
              onChange={(e) => setContent(e.target.value)}
            />
          </Field>

          <div className="-mt-2 flex items-center justify-between">
            <span className={cx('text-sm', over ? 'text-danger' : 'text-fg-faint')}>
              {content.length} / {MAX_TWEET}
              {over && ' — too long for one post'}
            </span>

            {/*
              Editing rewrites the saved row (and resets it to draft); creating
              just fills the box, since there is no row yet. Both need a
              category — it's what the prompt is built around.
            */}
            {!category ? (
              // Shown rather than hidden, so the absence of an AI button reads
              // as "do this first" instead of "there isn't one".
              <span className="text-sm text-fg-faint">
                Pick a category to write it with AI
              </span>
            ) : editing ? (
                <Button
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() =>
                    act(
                      'regenerate',
                      async () => {
                        const res = await bg.regeneratePost(editing.id, category);

                        if (res.ok) setContent(res.data.content);

                        return res;
                      },
                      false,
                    )
                  }
                >
                  {busy === 'regenerate' ? <Spinner /> : null}
                  Rewrite with AI
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() =>
                    act(
                      'write',
                      async () => {
                        const res = await bg.generateOnePost(category);

                        if (res.ok) setContent(res.data);

                        return res;
                      },
                      false,
                    )
                  }
                >
                  {busy === 'write' ? <Spinner /> : null}
                  Write with AI
                </Button>
              )}
          </div>

          <Field label="Category">
            <div className="flex flex-wrap gap-2">
              {CATEGORY_KEYS.map((key) => {
                const active = category === key;

                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setCategory(active ? null : key)}
                    className={cx(
                      'flex h-8 items-center gap-2 rounded-full border px-3 text-sm font-bold transition-colors',
                      active
                        ? 'border-transparent text-fg'
                        : 'border-line-strong text-fg-muted hover:bg-ink-800',
                    )}
                    style={
                      active
                        ? { background: `${categoryColor(key)}2e` }
                        : undefined
                    }
                  >
                    <span
                      className="size-2 rounded-full"
                      style={{ background: categoryColor(key) }}
                    />
                    {POST_CATEGORIES[key]}
                  </button>
                );
              })}
            </div>
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Date">
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className={cx(inputClass, 'w-full')}
              />
            </Field>
            <Field label="Time">
              <input
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className={cx(inputClass, 'w-full')}
              />
            </Field>
          </div>

          {isPast && editing?.status !== 'posted' && (
            <Banner tone="info">
              That time has already passed, so this can't be queued — move it to
              a future slot, or use <strong>Post now</strong>.
            </Banner>
          )}

          {editing?.status === 'posted' && editing.external_post_id && (
            <a
              href={`https://x.com/i/status/${editing.external_post_id}`}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-brand hover:underline"
            >
              View on X →
            </a>
          )}
        </div>

        <footer className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-4">
          <Button onClick={save} disabled={busy !== null || over}>
            {busy === 'save' ? <Spinner /> : null}
            Save
          </Button>

          {editing && editing.status === 'draft' && (
            <Button
              variant="ghost"
              disabled={busy !== null || isPast}
              onClick={() => act('approve', () => bg.approvePost(editing.id))}
            >
              {busy === 'approve' ? <Spinner /> : null}
              Approve &amp; queue
            </Button>
          )}

          {editing && editing.status === 'scheduled' && (
            <Button
              variant="ghost"
              disabled={busy !== null}
              onClick={() => act('unapprove', () => bg.unapprovePost(editing.id))}
            >
              Move back to draft
            </Button>
          )}

          {editing && editing.status !== 'posted' && (
            <Button
              variant="ghost"
              disabled={busy !== null}
              onClick={() => act('now', () => bg.publishNow(editing.id))}
            >
              {busy === 'now' ? <Spinner /> : null}
              Post now
            </Button>
          )}

          <span className="ml-auto" />

          {editing && (
            <Button
              variant="danger"
              disabled={busy !== null}
              onClick={() => act('delete', () => bg.deletePost(editing.id))}
            >
              Delete
            </Button>
          )}

          <Button variant="ghost" onClick={onClose} disabled={busy !== null}>
            Close
          </Button>
        </footer>
      </div>
    </div>
  );
}
