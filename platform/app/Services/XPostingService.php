<?php

namespace App\Services;

use App\Models\ScheduledPost;
use App\Models\SocialAccount;
use Illuminate\Support\Facades\Http;

/**
 * Publishes an approved ScheduledPost to X on the user's behalf via the
 * X API v2, refreshing the account's OAuth2 token first if needed. Reached
 * through App\Services\SocialPublisher, never synchronously from a request.
 */
class XPostingService
{
    private const TOKEN_URL = 'https://api.x.com/2/oauth2/token';

    private const TWEETS_URL = 'https://api.x.com/2/tweets';

    /**
     * Publish the post's content to X as a single tweet, from the account
     * the post targets. Weekly-schedule content (see
     * PromptBuilder::weeklyBatchPrompt) is always one tweet under 280
     * characters, even when it uses blank lines internally for visual
     * pacing (e.g. the "Question / Poll" format) — that's never a signal
     * to split into a reply-chain thread. On failure the post is marked
     * failed with an error message.
     */
    public function publish(ScheduledPost $post): void
    {
        $account = $post->socialAccount;

        if (! $account) {
            $post->update([
                'status' => ScheduledPost::STATUS_FAILED,
                'error' => 'The X account this post targets is no longer connected.',
            ]);

            return;
        }

        if ($account->isExpired() && ! $this->refresh($account)) {
            $post->update([
                'status' => ScheduledPost::STATUS_FAILED,
                'error' => 'X token expired and could not be refreshed. Reconnect '.$account->label().'.',
            ]);

            return;
        }

        $response = Http::withToken($account->access_token)
            ->post(self::TWEETS_URL, ['text' => $post->content]);

        if ($response->failed()) {
            $post->update([
                'status' => ScheduledPost::STATUS_FAILED,
                'error' => 'X API error ('.$response->status().'): '.$response->body(),
            ]);

            return;
        }

        $post->update([
            'status' => ScheduledPost::STATUS_POSTED,
            'posted_at' => now(),
            'external_post_id' => $response->json('data.id'),
            'error' => null,
        ]);
    }

    /**
     * Refresh an expired access token. X rotates the refresh token on every
     * use, so the new one must be persisted or the next refresh will fail.
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
