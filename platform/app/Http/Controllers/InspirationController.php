<?php

namespace App\Http\Controllers;

use App\Models\Generation;
use App\Models\InspirationPost;
use App\Models\ScheduledPost;
use App\Models\TrackedCreator;
use App\Services\ClaudeService;
use App\Services\PromptBuilder;
use App\Services\XPostingService;
use App\Services\XReaderService;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Inertia\Inertia;
use Inertia\Response;
use RuntimeException;

class InspirationController extends Controller
{
    /** How many recent tweets to pull per creator on each scan. */
    private const POSTS_PER_CREATOR = 50;

    public function __construct(
        private readonly ClaudeService $claude,
        private readonly PromptBuilder $prompts,
        private readonly XReaderService $reader,
        private readonly XPostingService $poster,
    ) {}

    /**
     * The Inspiration page: tracked creators and their viral posts (highest
     * baseline multiplier first).
     */
    public function index(Request $request): Response
    {
        $user = $request->user();

        $creators = $user->trackedCreators()
            ->orderBy('username')
            ->get()
            ->map(fn (TrackedCreator $creator) => [
                'id' => $creator->id,
                'x_user_id' => $creator->x_user_id,
                'username' => $creator->username,
                'name' => $creator->name,
                'avatar_url' => $creator->avatar_url,
                'followers_count' => $creator->followers_count,
                'last_scanned_at' => $creator->last_scanned_at?->toIso8601String(),
            ]);

        $posts = InspirationPost::query()
            ->whereIn('tracked_creator_id', $user->trackedCreators()->select('id'))
            ->with('creator')
            ->orderByDesc('baseline_multiplier')
            ->limit(300)
            ->get()
            ->map(fn (InspirationPost $post) => [
                'id' => $post->id,
                'creator_id' => $post->tracked_creator_id,
                'username' => $post->creator->username,
                'name' => $post->creator->name,
                'avatar_url' => $post->creator->avatar_url,
                'content' => $post->content,
                'url' => $post->url,
                'posted_at' => $post->posted_at?->toIso8601String(),
                'metrics' => $post->metrics,
                'baseline_multiplier' => $post->baseline_multiplier,
            ]);

        return Inertia::render('inspiration', [
            'creators' => $creators,
            'posts' => $posts,
            'hasXAccount' => $user->xAccount()->exists(),
        ]);
    }

    /**
     * Add a creator to track, resolving their @handle to an X user via the
     * connected account.
     */
    public function storeCreator(Request $request): RedirectResponse
    {
        $data = $request->validate([
            'handle' => ['required', 'string', 'max:20', 'regex:/^@?[A-Za-z0-9_]{1,15}$/'],
        ]);

        $user = $request->user();
        $account = $user->xAccount;

        if (! $account) {
            return back()->withErrors(['handle' => 'Connect your X account first to track creators.']);
        }

        $handle = ltrim($data['handle'], '@');
        $profile = $this->reader->lookupUser($account, $handle);

        if ($profile === null) {
            return back()->withErrors(['handle' => "Couldn't find @{$handle} on X (or your X app lacks read access)."]);
        }

        $user->trackedCreators()->updateOrCreate(
            ['x_user_id' => $profile['x_user_id']],
            [
                'username' => $profile['username'],
                'name' => $profile['name'],
                'avatar_url' => $profile['avatar_url'],
                'followers_count' => $profile['followers_count'],
            ],
        );

        return back()->with('toast', "Now tracking @{$profile['username']}.");
    }

    /**
     * Stop tracking a creator (also removes their inspiration posts via the
     * cascade).
     */
    public function destroyCreator(Request $request, TrackedCreator $creator): RedirectResponse
    {
        abort_unless($creator->user_id === $request->user()->id, 403);

        // Also drop the creator's stored viral posts. The FK cascade would do
        // this too, but deleting explicitly keeps the intent obvious and does
        // not rely on the DB engine enforcing the constraint.
        $creator->inspirationPosts()->delete();
        $creator->delete();

        return back()->with('toast', "Stopped tracking @{$creator->username}.");
    }

    /**
     * Fetch fresh tweets for every tracked creator, score them against each
     * creator's own baseline engagement, and replace that creator's stored
     * inspiration posts. Synchronous — no queue infra exists in this app.
     */
    public function scan(Request $request): RedirectResponse
    {
        $user = $request->user();
        $account = $user->xAccount;

        if (! $account) {
            return back()->withErrors(['scan' => 'Connect your X account first to fetch posts.']);
        }

        $creators = $user->trackedCreators()->get();

        if ($creators->isEmpty()) {
            return back()->withErrors(['scan' => 'Add at least one creator to track first.']);
        }

        // Pulling recent tweets for several creators, one request each, can
        // exceed PHP's default 30s execution limit.
        set_time_limit(180);

        $fetchedAny = false;

        foreach ($creators as $creator) {
            $tweets = $this->reader->fetchRecentPosts($account, $creator->x_user_id, self::POSTS_PER_CREATOR);

            if ($tweets === []) {
                continue;
            }

            $fetchedAny = true;

            $engagements = array_map(
                fn (array $tweet) => XReaderService::engagement($tweet['metrics']),
                $tweets,
            );
            $mean = max(1, array_sum($engagements) / count($engagements));

            DB::transaction(function () use ($creator, $tweets, $mean) {
                $creator->inspirationPosts()->delete();

                foreach ($tweets as $tweet) {
                    $creator->inspirationPosts()->create([
                        'x_tweet_id' => $tweet['x_tweet_id'],
                        'content' => $tweet['content'],
                        'url' => 'https://x.com/'.$creator->username.'/status/'.$tweet['x_tweet_id'],
                        'posted_at' => $tweet['created_at'] ? Carbon::parse($tweet['created_at']) : null,
                        'metrics' => $tweet['metrics'],
                        'baseline_multiplier' => round(XReaderService::engagement($tweet['metrics']) / $mean, 2),
                    ]);
                }

                $creator->update(['last_scanned_at' => now()]);
            });
        }

        if (! $fetchedAny) {
            return back()->withErrors([
                'scan' => 'Could not fetch posts from X. Check that your connected X app has read access.',
            ]);
        }

        return back()->with('toast', 'Viral posts updated.');
    }

    /**
     * "Use this idea": generate fresh drafts in the owner's voice inspired by a
     * viral post. Logged as a Generation; the options come back as a flash prop
     * (mirrors ScheduleController::generateOne).
     */
    public function useIdea(Request $request, InspirationPost $post): RedirectResponse
    {
        $post->load('creator');
        abort_unless($post->creator->user_id === $request->user()->id, 403);

        $data = $request->validate([
            'closeness' => ['nullable', 'string', 'in:'.implode(',', array_keys(PromptBuilder::REMIX_CLOSENESS))],
            'instructions' => ['nullable', 'string', 'max:1000'],
        ]);

        $closeness = $data['closeness'] ?? 'balanced';

        $user = $request->user();
        $system = $this->prompts->systemPrompt($user->voiceProfile);
        $prompt = $this->prompts->inspirationPrompt($post->content, $closeness, $data['instructions'] ?? null);

        try {
            $result = $this->claude->generateOptions($system, $prompt, 3, 512);
        } catch (RuntimeException $e) {
            return back()->withErrors(['use' => $e->getMessage()]);
        }

        $user->generations()->create([
            'type' => Generation::TYPE_POST,
            'input_context' => $post->content,
            'meta' => [
                'inspiration' => true,
                'closeness' => $closeness,
                'source_tweet_id' => $post->x_tweet_id,
                'source_username' => $post->creator->username,
            ],
            'output' => $result['options'],
            'model' => $result['model'],
            'tokens_in' => $result['input_tokens'],
            'tokens_out' => $result['output_tokens'],
        ]);

        return back()->with('generatedDraft', [
            'options' => $result['options'],
            'source' => $post->content,
        ]);
    }

    /**
     * Publish an edited remix straight to X now. Reuses XPostingService (token
     * refresh + posting) by recording the tweet as a ScheduledPost; the row is
     * removed again if publishing fails so it doesn't linger as a dead draft.
     */
    public function publish(Request $request): RedirectResponse
    {
        $data = $request->validate([
            'content' => ['required', 'string', 'max:280'],
            'timezone' => ['nullable', 'string', 'timezone'],
        ]);

        $user = $request->user();

        if (! $user->xAccount) {
            return back()->withErrors(['publish' => 'Connect your X account first to post.']);
        }

        $post = $user->scheduledPosts()->create([
            'content' => $data['content'],
            'status' => ScheduledPost::STATUS_DRAFT,
            'scheduled_at' => now(),
            'timezone' => $data['timezone'] ?? config('app.timezone'),
        ]);

        $this->poster->publish($post);
        $post->refresh();

        if ($post->status === ScheduledPost::STATUS_FAILED) {
            $error = $post->error;
            $post->delete();

            return back()->withErrors(['publish' => $error ?? 'Could not post to X.']);
        }

        return back()->with('toast', 'Posted to X.');
    }

    /**
     * Schedule an edited remix for a chosen time. Created already-approved
     * (STATUS_SCHEDULED) since the user explicitly picked a slot, so it will
     * auto-publish via PublishDuePosts when its time arrives.
     */
    public function schedule(Request $request): RedirectResponse
    {
        $data = $request->validate([
            'content' => ['required', 'string', 'max:280'],
            'date' => ['required', 'date'],
            'time' => ['required', 'date_format:H:i'],
            'timezone' => ['nullable', 'string', 'timezone'],
        ]);

        $user = $request->user();
        $timezone = $data['timezone'] ?? config('app.timezone');
        $scheduledAt = Carbon::parse($data['date'])->setTimeFromTimeString($data['time']);

        // Compare against real "now" in the chosen timezone (scheduled_at is a
        // naive wall-clock value — see CLAUDE.md).
        if (Carbon::parse($data['date'].' '.$data['time'], $timezone)->isPast()) {
            return back()->withErrors(['time' => 'That time is already in the past. Pick a later slot.']);
        }

        if ($user->scheduledPosts()->where('scheduled_at', $scheduledAt)->exists()) {
            return back()->withErrors(['time' => 'Another post is already scheduled at that time. Pick a different slot.']);
        }

        $user->scheduledPosts()->create([
            'content' => $data['content'],
            'status' => ScheduledPost::STATUS_SCHEDULED,
            'scheduled_at' => $scheduledAt,
            'timezone' => $timezone,
        ]);

        return back()->with('toast', 'Scheduled — it will publish automatically at its time.');
    }
}
