import { POST_CATEGORIES, type PostCategory } from '@/lib/ai/prompts';
import type { PostStatus } from '@/lib/types';

/**
 * UI metadata for the enums in lib/ai/prompts.ts.
 *
 * The labels live with the enum; only the colours live here, and they are plain
 * hex rather than Tailwind classes so a chip can be tinted with one inline
 * style instead of a lookup table of class names Tailwind would have to be told
 * about to avoid tree-shaking.
 */

export const CATEGORY_COLORS: Record<PostCategory, string> = {
  question: '#1d9bf0',
  story: '#a970ff',
  opinion: '#f4595b',
  tip: '#2fbe6f',
  promo: '#f6b44c',
  motivation: '#ff8ac4',
  news: '#4cc9d4',
};

/** Posts written before a category existed, or added by hand without one. */
export const UNCATEGORIZED_COLOR = '#6b7f99';

export function categoryColor(category: PostCategory | null): string {
  return category ? CATEGORY_COLORS[category] : UNCATEGORIZED_COLOR;
}

export function categoryLabel(category: PostCategory | null): string {
  return category ? POST_CATEGORIES[category] : 'No category';
}

export const STATUS_META: Record<
  PostStatus,
  { label: string; color: string; hint: string }
> = {
  draft: {
    label: 'Draft',
    color: '#6b7f99',
    hint: 'Not going anywhere until you approve it.',
  },
  scheduled: {
    label: 'Queued',
    color: '#1d9bf0',
    hint: 'Will post automatically at this time, if Chrome is running.',
  },
  posted: {
    label: 'Posted',
    color: '#2fbe6f',
    hint: 'Published to X.',
  },
  failed: {
    label: 'Failed',
    color: '#f4595b',
    hint: 'Something went wrong. Fix it and approve again — it will not retry on its own.',
  },
};

export const CATEGORY_KEYS = Object.keys(POST_CATEGORIES) as PostCategory[];
