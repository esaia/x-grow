<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\TrackedCreator;
use App\Services\InspirationScorer;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * Receives posts the Chrome extension harvested from a creator's x.com profile
 * using the user's own logged-in session.
 *
 * This replaces the metered X API read path: the same data costs nothing here
 * because the browser is already loading it. The extension is trusted only as
 * far as the authenticated user — everything is scoped to their own tracked
 * creators, and the baseline scoring is done here, not client-side.
 */
class InspirationIngestController extends Controller
{
    public function __construct(private readonly InspirationScorer $scorer) {}

    /**
     * The handles the extension should harvest — used both to drive "harvest
     * all" and to decide whether the profile the user is looking at is one we
     * collect from.
     */
    public function creators(Request $request): JsonResponse
    {
        $creators = $request->user()->trackedCreators()
            ->withCount('inspirationPosts')
            ->orderBy('username')
            ->get()
            ->map(fn (TrackedCreator $creator) => [
                'username' => $creator->username,
                'posts_count' => $creator->inspiration_posts_count,
                'last_scanned_at' => $creator->last_scanned_at?->toIso8601String(),
            ]);

        return response()->json(['creators' => $creators]);
    }

    /**
     * Upsert a creator and the batch of posts scraped from their profile.
     * Upsert rather than replace: a harvest only ever sees whatever the page
     * had loaded, so it must add to what is stored, never wipe it.
     */
    public function store(Request $request): JsonResponse
    {
        $data = $request->validate([
            'handle' => ['required', 'string', 'regex:/^@?[A-Za-z0-9_]{1,15}$/'],
            'profile.name' => ['nullable', 'string', 'max:100'],
            'profile.avatar_url' => ['nullable', 'url', 'max:500'],
            'profile.followers_count' => ['nullable', 'integer', 'min:0'],
            'posts' => ['required', 'array', 'min:1', 'max:200'],
            'posts.*.x_tweet_id' => ['required', 'string', 'max:32'],
            'posts.*.content' => ['required', 'string', 'max:5000'],
            'posts.*.url' => ['nullable', 'url', 'max:500'],
            'posts.*.posted_at' => ['nullable', 'date'],
            'posts.*.metrics.like' => ['nullable', 'integer', 'min:0'],
            'posts.*.metrics.reply' => ['nullable', 'integer', 'min:0'],
            'posts.*.metrics.retweet' => ['nullable', 'integer', 'min:0'],
            'posts.*.metrics.quote' => ['nullable', 'integer', 'min:0'],
        ]);

        $handle = ltrim($data['handle'], '@');
        $user = $request->user();

        $creator = DB::transaction(function () use ($user, $handle, $data) {
            /** @var TrackedCreator $creator */
            $creator = $user->trackedCreators()->firstOrNew(['username' => $handle]);

            // Only overwrite profile fields the harvest actually found, so a
            // page that hadn't rendered the avatar yet doesn't blank it out.
            $creator->fill(array_filter([
                'name' => $data['profile']['name'] ?? null,
                'avatar_url' => $data['profile']['avatar_url'] ?? null,
                'followers_count' => $data['profile']['followers_count'] ?? null,
            ], fn ($value) => $value !== null));

            $creator->last_scanned_at = now();
            $creator->save();

            foreach ($data['posts'] as $post) {
                $creator->inspirationPosts()->updateOrCreate(
                    ['x_tweet_id' => $post['x_tweet_id']],
                    [
                        'content' => $post['content'],
                        'url' => $post['url'] ?? "https://x.com/{$handle}/status/{$post['x_tweet_id']}",
                        'posted_at' => isset($post['posted_at']) ? Carbon::parse($post['posted_at']) : null,
                        'metrics' => [
                            'like' => (int) ($post['metrics']['like'] ?? 0),
                            'reply' => (int) ($post['metrics']['reply'] ?? 0),
                            'retweet' => (int) ($post['metrics']['retweet'] ?? 0),
                            'quote' => (int) ($post['metrics']['quote'] ?? 0),
                        ],
                    ],
                );
            }

            $this->scorer->rescore($creator);

            return $creator;
        });

        return response()->json([
            'creator' => [
                'id' => $creator->id,
                'username' => $creator->username,
                'name' => $creator->name,
            ],
            'received' => count($data['posts']),
            'stored' => $creator->inspirationPosts()->count(),
        ]);
    }
}
