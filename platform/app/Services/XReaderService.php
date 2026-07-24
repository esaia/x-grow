<?php

namespace App\Services;

use App\Models\SocialAccount;
use Illuminate\Support\Facades\Http;

/**
 * Reads *public* X data (a creator's profile and recent tweets) using the
 * connected user's own OAuth2 token — the same `tweet.read`/`users.read`
 * scopes ConnectXController already requests. Mirrors XPostingService's shape
 * (Http facade, no SDK; expired-token guard + refresh). Used synchronously by
 * InspirationController to source viral posts for tracked creators.
 *
 * Reading other creators' timelines requires the user's X app to have paid
 * read access; without it the X API returns an error which callers surface to
 * the user. On any failure the read methods return null/[] rather than throw.
 */
class XReaderService
{
    private const TOKEN_URL = 'https://api.x.com/2/oauth2/token';

    private const API_BASE = 'https://api.x.com/2';

    /**
     * Look up a creator by @handle. Returns null if the account has no valid
     * token, the handle doesn't exist, or the X API errors.
     *
     * @return array{x_user_id: string, username: string, name: ?string, avatar_url: ?string, followers_count: ?int}|null
     */
    public function lookupUser(SocialAccount $account, string $handle): ?array
    {
        $token = $this->authorizedToken($account);

        if ($token === null) {
            return null;
        }

        $response = Http::withToken($token)->get(self::API_BASE."/users/by/username/{$handle}", [
            'user.fields' => 'profile_image_url,name,public_metrics',
        ]);

        if ($response->failed() || $response->json('data') === null) {
            return null;
        }

        $data = $response->json('data');

        return [
            'x_user_id' => (string) $data['id'],
            'username' => (string) $data['username'],
            'name' => $data['name'] ?? null,
            'avatar_url' => $data['profile_image_url'] ?? null,
            'followers_count' => $data['public_metrics']['followers_count'] ?? null,
        ];
    }

    /**
     * Fetch a creator's recent original tweets (no retweets/replies) with
     * public metrics. Returns [] on any failure.
     *
     * @return array<int, array{x_tweet_id: string, content: string, created_at: ?string, metrics: array<string, int>}>
     */
    public function fetchRecentPosts(SocialAccount $account, string $xUserId, int $max = 50): array
    {
        $token = $this->authorizedToken($account);

        if ($token === null) {
            return [];
        }

        $response = Http::withToken($token)->get(self::API_BASE."/users/{$xUserId}/tweets", [
            'max_results' => max(5, min(100, $max)),
            'exclude' => 'retweets,replies',
            'tweet.fields' => 'public_metrics,created_at',
        ]);

        if ($response->failed()) {
            return [];
        }

        return collect($response->json('data') ?? [])
            ->map(fn (array $tweet) => [
                'x_tweet_id' => (string) $tweet['id'],
                'content' => (string) ($tweet['text'] ?? ''),
                'created_at' => $tweet['created_at'] ?? null,
                'metrics' => [
                    'like' => (int) ($tweet['public_metrics']['like_count'] ?? 0),
                    'reply' => (int) ($tweet['public_metrics']['reply_count'] ?? 0),
                    'retweet' => (int) ($tweet['public_metrics']['retweet_count'] ?? 0),
                    'quote' => (int) ($tweet['public_metrics']['quote_count'] ?? 0),
                ],
            ])
            ->all();
    }

    /**
     * Total engagement for a tweet's metrics — the basis for the baseline
     * multiplier. Impression counts are unreliable for other users' tweets so
     * they are not included.
     *
     * @param  array<string, int>  $metrics
     */
    public static function engagement(array $metrics): int
    {
        return ($metrics['like'] ?? 0)
            + ($metrics['reply'] ?? 0)
            + ($metrics['retweet'] ?? 0)
            + ($metrics['quote'] ?? 0);
    }

    /**
     * Return a usable bearer token for the account, refreshing first if it has
     * expired. Null if there is no way to obtain one.
     */
    private function authorizedToken(SocialAccount $account): ?string
    {
        if ($account->isExpired() && ! $this->refresh($account)) {
            return null;
        }

        return $account->access_token;
    }

    /**
     * Refresh an expired access token. X rotates the refresh token on every
     * use, so the new one must be persisted or the next refresh will fail.
     * (Mirrors XPostingService::refresh.)
     */
    private function refresh(SocialAccount $account): bool
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
}
