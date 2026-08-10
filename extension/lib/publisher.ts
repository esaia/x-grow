import { browser } from 'wxt/browser';
import { scheduledPostsByStatus, updateScheduledPost } from '@/lib/db';
import { accountItem } from '@/lib/storage';
import { realInstant, timeOf } from '@/lib/time';
import type { ScheduledPost } from '@/lib/types';

/**
 * Auto-posting.
 *
 * Replaces the platform's cron + OAuth + X API stack with a `chrome.alarms`
 * tick that drives X's own composer. The trade is stated plainly in the UI: it
 * only fires while Chrome is running. A post whose time passed while the
 * browser was closed publishes late rather than being skipped, which is why the
 * tick asks "is it due?" and never "is it due *right now*?".
 *
 * Failures are terminal by design. A post that failed is left `failed` with the
 * reason stored, and the user retries by hand — silently retrying something
 * that publishes to a public timeline is how you end up posting twice.
 */

export const ALARM_NAME = 'xgrow-publish';

/**
 * Backstop for a publish that hangs. Deliberately longer than every timeout
 * inside the publish path (the tab-connect deadline and the composer waits), so
 * the inner code is always the one that reports a failure. If this fired first
 * we could mark a post `failed` while it was in fact going out — and the user
 * would repost it by hand.
 */
const PUBLISH_TIMEOUT_MS = 150_000;

/** Guards against a second tick starting while one is still working. */
let publishing = false;

export interface PublishDeps {
  /** Open a visible scratch window and run `work` against its tab. */
  inScratchWindow: <T>(url: string, work: (tabId: number) => Promise<T>) => Promise<T>;
  /** Send a message to a tab, retrying until its content script answers. */
  askTab: <T>(tabId: number, request: { type: 'publish:run'; content: string; handle: string }) => Promise<T>;
}

/** Posts whose time has come (or went, while Chrome was closed). */
export async function duePosts(now = Date.now()): Promise<ScheduledPost[]> {
  const scheduled = await scheduledPostsByStatus('scheduled');

  return scheduled
    .filter((post) => realInstant(post.scheduled_at, post.timezone) <= now)
    .sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at));
}

/**
 * Publish everything that is due, one at a time.
 *
 * Sequential on purpose: each publish takes over a visible window, and two of
 * those racing would fight over focus and over X's composer.
 */
export async function publishDue(deps: PublishDeps): Promise<number> {
  if (publishing) return 0;

  publishing = true;

  try {
    const due = await duePosts();

    if (due.length === 0) return 0;

    const account = await accountItem.getValue();

    if (!account) {
      // No connected account: hold the posts rather than failing them. The user
      // has not withdrawn approval, they have just disconnected.
      console.warn('[X-Grow] Posts are due but no X account is connected.');
      return 0;
    }

    let published = 0;

    for (const post of due) {
      try {
        const result = await withTimeout(
          deps.inScratchWindow('https://x.com/compose/post', (tabId) =>
            deps.askTab<{ external_post_id: string | null }>(tabId, {
              type: 'publish:run',
              content: post.content,
              handle: account.handle,
            }),
          ),
          PUBLISH_TIMEOUT_MS,
        );

        await updateScheduledPost(post.id, {
          status: 'posted',
          posted_at: new Date().toISOString(),
          external_post_id: result.external_post_id,
          error: null,
        });

        published++;
        notify('Posted to X', `“${preview(post.content)}” went out.`);
      } catch (error) {
        const reason = (error as Error)?.message ?? 'Publishing failed.';

        await updateScheduledPost(post.id, { status: 'failed', error: reason });

        notify(
          'X-Grow could not post',
          `${timeOf(post.scheduled_at)} — ${reason}`,
        );
      }
    }

    return published;
  } finally {
    publishing = false;
  }
}

/** Publish one post immediately, ignoring its scheduled time. */
export async function publishNow(
  post: ScheduledPost,
  deps: PublishDeps,
): Promise<ScheduledPost> {
  const account = await accountItem.getValue();

  if (!account) throw new Error('Connect your X account first.');

  try {
    const result = await withTimeout(
      deps.inScratchWindow('https://x.com/compose/post', (tabId) =>
        deps.askTab<{ external_post_id: string | null }>(tabId, {
          type: 'publish:run',
          content: post.content,
          handle: account.handle,
        }),
      ),
      PUBLISH_TIMEOUT_MS,
    );

    const updated = await updateScheduledPost(post.id, {
      status: 'posted',
      posted_at: new Date().toISOString(),
      external_post_id: result.external_post_id,
      error: null,
    });

    if (!updated) throw new Error('That post no longer exists.');

    return updated;
  } catch (error) {
    const reason = (error as Error)?.message ?? 'Publishing failed.';

    await updateScheduledPost(post.id, { status: 'failed', error: reason });

    throw new Error(reason);
  }
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Publishing timed out.')), ms),
    ),
  ]);
}

function preview(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim();

  return flat.length > 60 ? `${flat.slice(0, 57)}…` : flat;
}

/**
 * With no server there is no email, so a notification is the only way the user
 * learns that a post failed while they were in another tab.
 */
function notify(title: string, message: string): void {
  void browser.notifications
    ?.create({
      type: 'basic',
      iconUrl: browser.runtime.getURL('/icon/128.png'),
      title,
      message,
    })
    .catch(() => {
      // Notifications can be blocked at the OS level; never let that break a
      // publish that otherwise succeeded.
    });
}
