import type { InspirationPost, PostMetrics } from '@/lib/types';

/**
 * Scores a creator's posts against that creator's *own* mean engagement, so a
 * 500-like post from someone who averages 50 outranks a 2k-like post from
 * someone who averages 5k. Ported from InspirationScorer.
 */

/** How many posts we keep per creator. */
export const KEEP_PER_CREATOR = 150;

/**
 * Impressions/views are deliberately excluded: X only shows them reliably on
 * your own posts, so including them would score other people's posts on a
 * number that is often missing or wrong.
 */
export function engagement(metrics: PostMetrics | null | undefined): number {
  if (!metrics) {
    return 0;
  }

  return (
    (metrics.like || 0) +
    (metrics.reply || 0) +
    (metrics.retweet || 0) +
    (metrics.quote || 0)
  );
}

/**
 * Trim to the newest KEEP_PER_CREATOR, then recompute every multiplier against
 * the mean of what survives. Returns the posts to keep, mutated in place.
 */
export function rescore(posts: InspirationPost[]): InspirationPost[] {
  const kept = trim(posts);

  if (kept.length === 0) {
    return kept;
  }

  const total = kept.reduce((sum, post) => sum + engagement(post.metrics), 0);
  const mean = Math.max(1, total / kept.length);

  for (const post of kept) {
    post.baseline_multiplier =
      Math.round((engagement(post.metrics) / mean) * 100) / 100;
  }

  return kept;
}

/** Newest first, undated last — matching the platform's ordering. */
export function trim(posts: InspirationPost[]): InspirationPost[] {
  return [...posts]
    .sort((a, b) => {
      if (!a.posted_at && !b.posted_at) return 0;
      if (!a.posted_at) return 1;
      if (!b.posted_at) return -1;

      return b.posted_at.localeCompare(a.posted_at);
    })
    .slice(0, KEEP_PER_CREATOR);
}
