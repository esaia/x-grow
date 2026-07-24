<?php

namespace App\Services;

use App\Models\ScheduledPost;
use App\Models\SocialAccount;
use Illuminate\Support\Facades\Http;

/**
 * Publishes an approved ScheduledPost to LinkedIn on the user's behalf via
 * the versioned LinkedIn REST API — as the member themselves, or as a
 * company page they administer — the only difference is the author URN, see
 * SocialAccount::authorUrn().
 * Mirrors XPostingService's shape and is reached through SocialPublisher.
 */
class LinkedInPostingService
{
    private const TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';

    private const POSTS_URL = 'https://api.linkedin.com/rest/posts';

    /**
     * Publish the post's content as a single LinkedIn share. Content comes
     * from the same generator as X posts (see PromptBuilder::weeklyBatchPrompt),
     * so it's always a short single post — blank lines inside it are visual
     * pacing, never a split signal.
     */
    public function publish(ScheduledPost $post): void
    {
        $account = $post->socialAccount;

        if (! $account) {
            $post->update([
                'status' => ScheduledPost::STATUS_FAILED,
                'error' => 'The LinkedIn account this post targets is no longer connected.',
            ]);

            return;
        }

        if ($account->isExpired() && ! $this->refresh($account)) {
            $post->update([
                'status' => ScheduledPost::STATUS_FAILED,
                'error' => 'LinkedIn token expired and could not be refreshed. Reconnect '.$account->label().'.',
            ]);

            return;
        }

        $response = Http::withToken($account->access_token)
            ->withHeaders([
                'LinkedIn-Version' => config('services.linkedin.version'),
                'X-Restli-Protocol-Version' => '2.0.0',
            ])
            ->post(self::POSTS_URL, [
                'author' => $account->authorUrn(),
                'commentary' => $post->content,
                'visibility' => 'PUBLIC',
                'distribution' => [
                    'feedDistribution' => 'MAIN_FEED',
                    'targetEntities' => [],
                    'thirdPartyDistributionChannels' => [],
                ],
                'lifecycleState' => 'PUBLISHED',
                'isReshareDisabledByAuthor' => false,
            ]);

        if ($response->failed()) {
            $post->update([
                'status' => ScheduledPost::STATUS_FAILED,
                'error' => 'LinkedIn API error ('.$response->status().'): '.$response->body(),
            ]);

            return;
        }

        $post->update([
            'status' => ScheduledPost::STATUS_POSTED,
            'posted_at' => now(),
            // The created post's URN comes back in a header, not the body.
            'external_post_id' => $response->header('x-restli-id') ?: null,
            'error' => null,
        ]);
    }

    /**
     * Refresh an expired access token. Refresh tokens are only issued to
     * approved LinkedIn apps, so this legitimately returns false for most
     * connections — the user then has to reconnect by hand.
     */
    private function refresh(SocialAccount $account): bool
    {
        if (! $account->refresh_token) {
            return false;
        }

        // Page tokens are issued by the separate pages app (see
        // ConnectLinkedInPagesController), so they must be refreshed with
        // that app's credentials, not the member app's.
        $credentials = $account->kind === SocialAccount::KIND_ORGANIZATION
            ? config('services.linkedin.pages')
            : config('services.linkedin');

        $response = Http::asForm()->post(self::TOKEN_URL, [
            'grant_type' => 'refresh_token',
            'refresh_token' => $account->refresh_token,
            'client_id' => $credentials['client_id'] ?? null,
            'client_secret' => $credentials['client_secret'] ?? null,
        ]);

        if ($response->failed()) {
            return false;
        }

        $tokens = $response->json();

        $account->update([
            'access_token' => $tokens['access_token'],
            'refresh_token' => $tokens['refresh_token'] ?? $account->refresh_token,
            'expires_at' => now()->addSeconds((int) ($tokens['expires_in'] ?? 5184000)),
        ]);

        return true;
    }
}
