<?php

namespace App\Http\Controllers;

use App\Models\Generation;
use App\Models\InspirationPost;
use App\Models\ScheduledPost;
use App\Models\TrackedCreator;
use App\Services\ClaudeService;
use App\Services\PromptBuilder;
use App\Services\XPostingService;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Inertia\Inertia;
use Inertia\Response;
use RuntimeException;

class InspirationController extends Controller
{
    public function __construct(
        private readonly ClaudeService $claude,
        private readonly PromptBuilder $prompts,
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
            ->withCount('inspirationPosts')
            ->orderBy('username')
            ->get()
            ->map(fn (TrackedCreator $creator) => [
                'id' => $creator->id,
                'username' => $creator->username,
                'posts_count' => $creator->inspiration_posts_count,
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
     * Add a creator to track by @handle. No X API call is made — the handle is
     * the key, and the extension fills in the display name, avatar, follower
     * count and posts the first time it harvests that profile.
     */
    public function storeCreator(Request $request): RedirectResponse
    {
        $data = $request->validate([
            'handle' => ['required', 'string', 'max:20', 'regex:/^@?[A-Za-z0-9_]{1,15}$/'],
        ]);

        $handle = ltrim($data['handle'], '@');

        $request->user()->trackedCreators()->firstOrCreate(['username' => $handle]);

        return back()->with('toast', "Now tracking @{$handle}. Open their profile on X and click ✨ Harvest.");
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
        $account = $user->xAccount;

        if (! $account) {
            return back()->withErrors(['publish' => 'Connect your X account first to post.']);
        }

        $post = $user->scheduledPosts()->create([
            'content' => $data['content'],
            'platform' => ScheduledPost::PLATFORM_X,
            'social_account_id' => $account->id,
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

        $account = $user->xAccount;

        if (! $account) {
            return back()->withErrors(['time' => 'Connect your X account first to schedule a post.']);
        }

        $conflicts = $user->scheduledPosts()
            ->where('social_account_id', $account->id)
            ->where('scheduled_at', $scheduledAt)
            ->exists();

        if ($conflicts) {
            return back()->withErrors(['time' => 'Another post is already scheduled at that time. Pick a different slot.']);
        }

        $user->scheduledPosts()->create([
            'content' => $data['content'],
            'platform' => ScheduledPost::PLATFORM_X,
            'social_account_id' => $account->id,
            'status' => ScheduledPost::STATUS_SCHEDULED,
            'scheduled_at' => $scheduledAt,
            'timezone' => $timezone,
        ]);

        return back()->with('toast', 'Scheduled — it will publish automatically at its time.');
    }
}
