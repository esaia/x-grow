<?php

namespace App\Services;

use App\Models\ScheduledPost;

/**
 * Routes a due ScheduledPost to the posting service for its platform.
 * Used by App\Console\Commands\PublishDuePosts so the command doesn't need
 * to know which networks exist.
 */
class SocialPublisher
{
    public function __construct(
        private readonly XPostingService $x,
        private readonly LinkedInPostingService $linkedin,
    ) {}

    public function publish(ScheduledPost $post): void
    {
        match ($post->platform) {
            ScheduledPost::PLATFORM_LINKEDIN => $this->linkedin->publish($post),
            default => $this->x->publish($post),
        };
    }
}
