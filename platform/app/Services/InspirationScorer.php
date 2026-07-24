<?php

namespace App\Services;

use App\Models\InspirationPost;
use App\Models\TrackedCreator;

/**
 * Scores a creator's harvested posts against that creator's *own* average
 * engagement, so a 100k-follower account and a 2k-follower account are both
 * measured by how far a post outperformed their normal.
 *
 * Scoring lives server-side (not in the extension) because the baseline is
 * computed over everything stored for a creator, not just the batch that
 * happened to be scraped in one visit.
 */
class InspirationScorer
{
    /** Keep at most this many posts per creator — newest first. */
    public const KEEP_PER_CREATOR = 150;

    /**
     * Total engagement for a post's metrics. Impression/view counts are not
     * included: they are missing or unreliable for other people's posts.
     *
     * @param  array<string, int>|null  $metrics
     */
    public static function engagement(?array $metrics): int
    {
        return (int) (($metrics['like'] ?? 0)
            + ($metrics['reply'] ?? 0)
            + ($metrics['retweet'] ?? 0)
            + ($metrics['quote'] ?? 0));
    }

    /**
     * Recompute every stored post's baseline multiplier for one creator, then
     * trim the collection back to KEEP_PER_CREATOR newest posts.
     */
    public function rescore(TrackedCreator $creator): void
    {
        $this->trim($creator);

        $posts = $creator->inspirationPosts()->get();

        if ($posts->isEmpty()) {
            return;
        }

        $mean = max(1.0, $posts->avg(
            fn (InspirationPost $post) => self::engagement($post->metrics),
        ));

        foreach ($posts as $post) {
            $post->update([
                'baseline_multiplier' => round(self::engagement($post->metrics) / $mean, 2),
            ]);
        }
    }

    /**
     * Drop the creator's oldest posts beyond the retention cap. Posts without a
     * timestamp sort last, so a malformed harvest is trimmed before real data.
     */
    private function trim(TrackedCreator $creator): void
    {
        $keepIds = $creator->inspirationPosts()
            ->orderByRaw('posted_at is null')
            ->orderByDesc('posted_at')
            ->limit(self::KEEP_PER_CREATOR)
            ->pluck('id');

        $creator->inspirationPosts()->whereNotIn('id', $keepIds)->delete();
    }
}
