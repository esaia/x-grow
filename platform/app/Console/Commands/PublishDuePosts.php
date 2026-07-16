<?php

namespace App\Console\Commands;

use App\Models\ScheduledPost;
use App\Services\XPostingService;
use Illuminate\Console\Command;
use Throwable;

/**
 * Publishes every Scheduled post whose time has arrived to X. Run every
 * minute by the scheduler (see routes/console.php). Only ever touches
 * posts the user explicitly approved via ScheduleController::schedule() —
 * drafts are never auto-posted.
 */
class PublishDuePosts extends Command
{
    protected $signature = 'schedule:publish-due-posts';

    protected $description = 'Publish scheduled posts whose time has arrived to X.';

    public function __construct(private readonly XPostingService $x)
    {
        parent::__construct();
    }

    public function handle(): int
    {
        // scheduled_at is a naive wall-clock value (see CLAUDE.md /
        // ScheduledPost::realScheduledAt) — the server's own timezone can
        // differ from the timezone the post was scheduled in, so "due" is
        // computed per-row in PHP rather than in the query itself.
        ScheduledPost::query()
            ->where('status', ScheduledPost::STATUS_SCHEDULED)
            ->orderBy('scheduled_at')
            ->chunkById(20, function ($posts) {
                foreach ($posts as $post) {
                    if ($post->realScheduledAt()->isFuture()) {
                        continue;
                    }

                    try {
                        $this->x->publish($post);
                    } catch (Throwable $e) {
                        $post->update(['status' => ScheduledPost::STATUS_FAILED, 'error' => $e->getMessage()]);
                        report($e);
                    }
                }
            });

        return self::SUCCESS;
    }
}
