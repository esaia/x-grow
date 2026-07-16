<?php

namespace App\Services;

use App\Models\ScheduledPost;
use App\Models\XAccount;
use Illuminate\Support\Facades\Http;

/**
 * Publishes an approved ScheduledPost to X on the user's behalf via the
 * X API v2, refreshing the user's OAuth2 token first if needed. Called by
 * App\Console\Commands\PublishDuePosts, never synchronously from a request.
 */
class XPostingService
{
    private const TOKEN_URL = 'https://api.x.com/2/oauth2/token';

    private const TWEETS_URL = 'https://api.x.com/2/tweets';

    /**
     * Publish the post's content to X, splitting it into a reply chain if it
     * contains multiple blank-line-separated segments (thread format). On
     * any failure the post is marked failed with an error message and no
     * further segments are attempted.
     */
    public function publish(ScheduledPost $post): void
    {
        $account = $post->user->xAccount;

        if (! $account) {
            $post->update(['status' => ScheduledPost::STATUS_FAILED, 'error' => 'No connected X account.']);

            return;
        }

        if ($account->isExpired()) {
            if (! $this->refresh($account)) {
                $post->update([
                    'status' => ScheduledPost::STATUS_FAILED,
                    'error' => 'X token expired and could not be refreshed. Reconnect your X account.',
                ]);

                return;
            }
        }

        $segments = $this->splitIntoTweets($post->content);

        $previousId = null;
        $rootId = null;

        foreach ($segments as $segment) {
            $body = ['text' => $segment];

            if ($previousId !== null) {
                $body['reply'] = ['in_reply_to_tweet_id' => $previousId];
            }

            $response = Http::withToken($account->access_token)->post(self::TWEETS_URL, $body);

            if ($response->failed()) {
                $post->update([
                    'status' => ScheduledPost::STATUS_FAILED,
                    'error' => 'X API error ('.$response->status().'): '.$response->body(),
                ]);

                return;
            }

            $tweetId = $response->json('data.id');
            $rootId ??= $tweetId;
            $previousId = $tweetId;
        }

        $post->update([
            'status' => ScheduledPost::STATUS_POSTED,
            'posted_at' => now(),
            'x_tweet_id' => $rootId,
            'error' => null,
        ]);
    }

    /**
     * Refresh an expired access token. X rotates the refresh token on every
     * use, so the new one must be persisted or the next refresh will fail.
     */
    private function refresh(XAccount $account): bool
    {
        if (! $account->refresh_token) {
            return false;
        }

        $response = Http::asForm()
            ->withBasicAuth(config('services.x.client_id'), config('services.x.client_secret'))
            ->post(self::TOKEN_URL, [
                'grant_type' => 'refresh_token',
                'refresh_token' => $account->refresh_token,
                'client_id' => config('services.x.client_id'),
            ]);

        if ($response->failed()) {
            return false;
        }

        $tokens = $response->json();

        $account->update([
            'access_token' => $tokens['access_token'],
            'refresh_token' => $tokens['refresh_token'] ?? $account->refresh_token,
            'expires_at' => now()->addSeconds((int) ($tokens['expires_in'] ?? 7200)),
        ]);

        return true;
    }

    /**
     * Splits a weekly-schedule post's content into one or more tweet-sized
     * chunks for thread posting (blank-line-separated, matching the format
     * PromptBuilder already uses for thread-format content).
     *
     * @return array<int, string>
     */
    private function splitIntoTweets(string $content): array
    {
        $segments = array_values(array_filter(array_map('trim', preg_split('/\n\s*\n/', $content) ?: [])));

        return $segments === [] ? [$content] : $segments;
    }
}
