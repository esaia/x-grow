<?php

namespace App\Http\Controllers;

use App\Models\Generation;
use App\Models\ScheduledPost;
use App\Models\SocialAccount;
use App\Models\User;
use App\Services\ClaudeService;
use App\Services\PromptBuilder;
use Carbon\CarbonInterface;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Inertia\Inertia;
use Inertia\Response;
use RuntimeException;

class ScheduleController extends Controller
{
    /** Minimum minutes between two randomly-generated posts on the same day, so their calendar chips never overlap. */
    private const MIN_GAP_MINUTES = 60;

    public function __construct(
        private readonly ClaudeService $claude,
        private readonly PromptBuilder $prompts,
    ) {}

    /**
     * Show the weekly schedule for the week containing ?week= (default: this week).
     */
    public function index(Request $request): Response
    {
        $weekStart = $this->resolveWeekStart($request->query('week'));
        $weekEnd = $weekStart->copy()->endOfWeek(Carbon::SUNDAY);

        $posts = $request->user()->scheduledPosts()
            ->whereBetween('scheduled_at', [$weekStart, $weekEnd])
            ->orderBy('scheduled_at')
            ->get()
            ->map(fn (ScheduledPost $post) => [
                'id' => $post->id,
                'content' => $post->content,
                'category' => $post->category,
                'platform' => $post->platform,
                'social_account_id' => $post->social_account_id,
                'status' => $post->status,
                'error' => $post->error,
                'scheduled_at' => $post->scheduled_at->toIso8601String(),
            ]);

        return Inertia::render('schedule', [
            'weekStart' => $weekStart->toDateString(),
            'posts' => $posts,
            'categories' => collect(PromptBuilder::POST_CATEGORIES)
                ->map(fn (string $label, string $slug) => ['slug' => $slug, 'label' => $label])
                ->values(),
            'statuses' => ScheduledPost::STATUSES,
            'platforms' => ScheduledPost::PLATFORMS,
            // Every connected destination the user can target. An empty list
            // means nothing can be scheduled until they connect an account.
            'accounts' => $this->accountOptions($request->user()),
        ]);
    }

    /**
     * Generate a full week of draft posts and replace any existing drafts
     * for that week.
     */
    public function generate(Request $request): RedirectResponse
    {
        $data = $request->validate([
            'week_start' => ['required', 'date'],
            'range_start' => ['required', 'date_format:H:i'],
            'range_end' => ['required', 'date_format:H:i', 'after:range_start'],
            'per_day' => ['required', 'integer', 'min:1', 'max:6'],
            'categories' => ['sometimes', 'array', 'min:1'],
            'categories.*' => ['string', 'in:'.implode(',', array_keys(PromptBuilder::POST_CATEGORIES))],
            // The browser's IANA timezone (e.g. "Asia/Dubai") — scheduled_at
            // is stored as a naive wall-clock value, so this is required to
            // later compute the real due instant for auto-posting.
            'timezone' => ['nullable', 'string', 'timezone'],
            // Which connected account the whole week is written for.
            'account_id' => ['nullable', 'integer'],
        ]);

        $timezone = $data['timezone'] ?? config('app.timezone');

        $user = $request->user();

        $account = $user->socialAccounts()
            ->active()
            ->when($data['account_id'] ?? null, fn ($query, $id) => $query->whereKey($id))
            ->orderByRaw('provider = ? desc', [SocialAccount::PROVIDER_X])
            ->orderBy('id')
            ->first();

        if (! $account) {
            return back()->withErrors([
                'generate' => 'Connect an account on the Connect page before generating a week of posts.',
            ]);
        }

        $weekStart = $this->resolveWeekStart($data['week_start']);
        $weekEnd = $weekStart->copy()->endOfWeek(Carbon::SUNDAY);
        $perDay = (int) $data['per_day'];
        $total = $perDay * 7;

        $rangeStartMinutes = $this->toMinutes($data['range_start']);
        $rangeEndMinutes = $this->toMinutes($data['range_end']);

        if (intdiv($rangeEndMinutes - $rangeStartMinutes, 15) + 1 < $perDay) {
            return back()->withErrors([
                'per_day' => 'The time range is too narrow to fit that many posts per day without overlapping.',
            ]);
        }

        $categoryKeys = $data['categories'] ?? array_keys(PromptBuilder::POST_CATEGORIES);
        $categories = array_map(
            fn (int $i) => $categoryKeys[$i % count($categoryKeys)],
            range(0, $total - 1),
        );

        $system = $this->prompts->systemPrompt($user->voiceProfile);
        $prompt = $this->prompts->weeklyBatchPrompt($categories, $this->recentPostContents($user, $weekStart, $weekEnd));

        // A full week's batch (up to 42 posts) can take longer than PHP's
        // default 30s execution limit to generate in one OpenAI call.
        set_time_limit(180);

        try {
            $result = $this->claude->generateOptions($system, $prompt, $total, min(4096, 200 * $total));
        } catch (RuntimeException $e) {
            return back()->withErrors(['generate' => $e->getMessage()]);
        }

        DB::transaction(function () use (
            $user, $weekStart, $weekEnd, $perDay, $rangeStartMinutes, $rangeEndMinutes, $data, $result, $categories, $timezone, $account
        ) {
            $user->scheduledPosts()
                ->whereBetween('scheduled_at', [$weekStart, $weekEnd])
                ->delete();

            $generation = $user->generations()->create([
                'type' => Generation::TYPE_POST,
                'input_context' => null,
                'meta' => [
                    'weekly_schedule' => true,
                    'week_start' => $weekStart->toDateString(),
                    'per_day' => $perDay,
                    'range_start' => $data['range_start'],
                    'range_end' => $data['range_end'],
                ],
                'output' => $result['options'],
                'model' => $result['model'],
                'tokens_in' => $result['input_tokens'],
                'tokens_out' => $result['output_tokens'],
            ]);

            $options = $result['options'];

            foreach (range(0, 6) as $day) {
                $times = $this->randomTimesInRange($rangeStartMinutes, $rangeEndMinutes, $perDay);

                foreach ($times as $slot => $minutes) {
                    $index = $day * $perDay + $slot;

                    if (! isset($options[$index])) {
                        continue;
                    }

                    $scheduledAt = $weekStart->copy()
                        ->addDays($day)
                        ->startOfDay()
                        ->addMinutes($minutes);

                    ScheduledPost::create([
                        'user_id' => $user->id,
                        'generation_id' => $generation->id,
                        'content' => $options[$index],
                        'category' => $categories[$index] ?? null,
                        // A generated week is written for one account; other
                        // accounts are filled per-slot, or by retargeting a
                        // draft in the edit modal.
                        'platform' => $account->provider,
                        'social_account_id' => $account->id,
                        'status' => ScheduledPost::STATUS_DRAFT,
                        'scheduled_at' => $scheduledAt,
                        'timezone' => $timezone,
                    ]);
                }
            }
        });

        return back()->with('toast', 'Weekly schedule generated.');
    }

    /**
     * Create a draft post manually (empty-slot "Add post" flow) — one row per
     * selected platform, so each target account can then be edited, approved
     * and published independently.
     */
    public function store(Request $request): RedirectResponse
    {
        $data = $request->validate([
            'content' => ['required', 'string'],
            'category' => ['required', 'string', 'in:'.implode(',', array_keys(PromptBuilder::POST_CATEGORIES))],
            'accounts' => ['required', 'array', 'min:1'],
            'accounts.*' => ['integer'],
            'date' => ['required', 'date'],
            'time' => ['required', 'date_format:H:i'],
            'timezone' => ['nullable', 'string', 'timezone'],
        ]);

        $user = $request->user();
        $scheduledAt = Carbon::parse($data['date'])->setTimeFromTimeString($data['time']);
        $accounts = $this->ownedAccounts($user, $data['accounts']);

        if (count($accounts) !== count(array_unique($data['accounts']))) {
            return back()->withErrors(['accounts' => 'One of the selected accounts is paused or no longer connected.']);
        }

        // Check every account up front so a partial batch is never created.
        foreach ($accounts as $accountId => $provider) {
            if ($this->hasConflict($user, $scheduledAt, (int) $accountId)) {
                return back()->withErrors([
                    'time' => 'That account already has a post scheduled at that time on this day. Pick a different time.',
                ]);
            }
        }

        DB::transaction(function () use ($user, $data, $scheduledAt, $accounts) {
            foreach ($accounts as $accountId => $provider) {
                $user->scheduledPosts()->create([
                    'content' => $data['content'],
                    'category' => $data['category'],
                    'platform' => $provider,
                    'social_account_id' => $accountId,
                    'status' => ScheduledPost::STATUS_DRAFT,
                    'scheduled_at' => $scheduledAt,
                    'timezone' => $data['timezone'] ?? config('app.timezone'),
                ]);
            }
        });

        return back()->with('toast', count($accounts) > 1
            ? 'Posts added to schedule.'
            : 'Post added to schedule.');
    }

    /**
     * AI-generate content for a single new empty-slot post, without saving
     * it — the "Generate with AI" option in the "Add post" modal, which
     * fills the content field for review/editing. The user still has to
     * click "Add post" (store()) to actually create it.
     */
    public function generateOne(Request $request): RedirectResponse
    {
        $data = $request->validate([
            'category' => ['required', 'string', 'in:'.implode(',', array_keys(PromptBuilder::POST_CATEGORIES))],
            'accounts' => ['required', 'array', 'min:1'],
            'accounts.*' => ['integer'],
            'date' => ['required', 'date'],
            'time' => ['required', 'date_format:H:i'],
            'timezone' => ['nullable', 'string', 'timezone'],
        ]);

        $user = $request->user();
        $scheduledAt = Carbon::parse($data['date'])->setTimeFromTimeString($data['time']);

        foreach (array_keys($this->ownedAccounts($user, $data['accounts'])) as $accountId) {
            if ($this->hasConflict($user, $scheduledAt, (int) $accountId)) {
                return back()->withErrors([
                    'time' => 'That account already has a post scheduled at that time on this day. Pick a different time.',
                ]);
            }
        }

        try {
            $generated = $this->generateSingle($user, $data['category']);
        } catch (RuntimeException $e) {
            return back()->withErrors(['generate' => $e->getMessage()]);
        }

        return back()->with('generatedDraft', [
            'content' => $generated['content'],
            'category' => $data['category'],
        ]);
    }

    /**
     * The user's most recent post content (excluding the given date range, if
     * any — used to leave out the week currently being (re)generated), most
     * recent first. Fed back into the prompt so the model doesn't repeat
     * topics/angles/structures it already used.
     *
     * @return array<int, string>
     */
    private function recentPostContents(User $user, ?Carbon $excludeStart = null, ?Carbon $excludeEnd = null): array
    {
        return $user->scheduledPosts()
            ->when(
                $excludeStart && $excludeEnd,
                fn ($query) => $query->whereNotBetween('scheduled_at', [$excludeStart, $excludeEnd]),
            )
            ->orderByDesc('scheduled_at')
            ->limit(40)
            ->pluck('content')
            ->all();
    }

    /**
     * True if the user already has a post for this account at exactly this
     * instant (optionally excluding one post's own row, for in-place edits).
     * Scoped per account so posts to different accounts — even two X ones —
     * can legitimately share a slot, while one account can't be double-booked.
     */
    private function hasConflict(User $user, CarbonInterface $scheduledAt, int $accountId, ?int $excludePostId = null): bool
    {
        return $user->scheduledPosts()
            ->when($excludePostId, fn ($query) => $query->where('id', '!=', $excludePostId))
            ->where('social_account_id', $accountId)
            ->where('scheduled_at', $scheduledAt)
            ->exists();
    }

    /**
     * The user's connected destinations, as the frontend's "Post to" pills.
     *
     * @return array<int, array<string, mixed>>
     */
    private function accountOptions(User $user): array
    {
        return $user->socialAccounts()
            ->orderBy('provider')
            ->orderBy('kind')
            ->orderBy('id')
            ->get()
            ->map(fn (SocialAccount $account) => [
                'id' => $account->id,
                'provider' => $account->provider,
                'kind' => $account->kind,
                'label' => $account->label(),
                // Paused accounts are still listed so a post already aimed at
                // one shows its target, but they can't be picked.
                'is_active' => $account->is_active,
            ])
            ->all();
    }

    /**
     * The given account ids that actually belong to this user, mapped to
     * their provider — the authorization check for every targeting request.
     *
     * @param  array<int, int|string>  $ids
     * @return array<int, string>
     */
    private function ownedAccounts(User $user, array $ids): array
    {
        return $user->socialAccounts()
            ->active()
            ->whereIn('id', $ids)
            ->pluck('provider', 'id')
            ->all();
    }

    /**
     * One OpenAI call for a single post in the given category, logged as a
     * Generation. Shared by regenerate() (existing post) and generateOne()
     * (brand-new post).
     *
     * @return array{content: string, generation_id: int}
     */
    private function generateSingle(User $user, string $category): array
    {
        $system = $this->prompts->systemPrompt($user->voiceProfile);
        $prompt = $this->prompts->weeklyBatchPrompt([$category], $this->recentPostContents($user));

        $result = $this->claude->generateOptions($system, $prompt, 1, 512);

        $generation = $user->generations()->create([
            'type' => Generation::TYPE_POST,
            'input_context' => null,
            'meta' => ['weekly_schedule' => true, 'regenerate' => true, 'category' => $category],
            'output' => $result['options'],
            'model' => $result['model'],
            'tokens_in' => $result['input_tokens'],
            'tokens_out' => $result['output_tokens'],
        ]);

        return [
            'content' => $result['options'][0] ?? '',
            'generation_id' => $generation->id,
        ];
    }

    private function toMinutes(string $time): int
    {
        [$hours, $minutes] = explode(':', $time);

        return ((int) $hours * 60) + (int) $minutes;
    }

    /**
     * Pick $count random times (in minutes-from-midnight) between
     * $startMinutes and $endMinutes, at least MIN_GAP_MINUTES apart so
     * their calendar chips never visually overlap. Shrinks the gap (down to
     * one 15-minute slot) only if the range is too narrow to fit $count
     * posts at the full minimum gap.
     *
     * @return array<int, int>
     */
    private function randomTimesInRange(int $startMinutes, int $endMinutes, int $count): array
    {
        $minGap = self::MIN_GAP_MINUTES;

        while ($count > 1 && ($count - 1) * $minGap > $endMinutes - $startMinutes && $minGap > 15) {
            $minGap -= 15;
        }

        $slackUnits = $count > 1
            ? intdiv(($endMinutes - $startMinutes) - ($count - 1) * $minGap, 15)
            : intdiv($endMinutes - $startMinutes, 15);

        $offsets = [];

        for ($i = 0; $i < $count; $i++) {
            $offsets[] = random_int(0, max(0, $slackUnits));
        }

        sort($offsets);

        return array_map(
            fn (int $offsetUnits, int $i) => $startMinutes + ($offsetUnits * 15) + ($i * $minGap),
            $offsets,
            array_keys($offsets),
        );
    }

    /**
     * Update a single scheduled post's content, category, and/or time.
     */
    public function update(Request $request, ScheduledPost $post): RedirectResponse
    {
        abort_unless($post->user_id === $request->user()->id, 403);

        $data = $request->validate([
            'content' => ['required', 'string'],
            'category' => ['required', 'string', 'in:'.implode(',', array_keys(PromptBuilder::POST_CATEGORIES))],
            // A row targets exactly one account — posting to several is
            // several rows.
            'social_account_id' => ['required', 'integer'],
            'time' => ['required', 'date_format:H:i'],
            'timezone' => ['nullable', 'string', 'timezone'],
        ]);

        $accounts = $this->ownedAccounts($request->user(), [$data['social_account_id']]);

        if ($accounts === []) {
            return back()->withErrors(['social_account_id' => 'That account is paused or no longer connected.']);
        }

        $scheduledAt = $post->scheduled_at->copy()->setTimeFromTimeString($data['time']);

        if ($this->hasConflict($request->user(), $scheduledAt, (int) $data['social_account_id'], $post->id)) {
            return back()->withErrors([
                'time' => 'That account already has a post scheduled at that time on this day. Pick a different time.',
            ]);
        }

        // Editing content/category on an already-approved post requires
        // re-approval before it's eligible to auto-post again — an in-place
        // edit right before the scheduled time should never silently publish
        // unreviewed content. Retargeting it to another account counts too:
        // approval was given for one specific account. A pure time change
        // doesn't alter the reviewed content, so it keeps the post scheduled
        // (just moves when it posts). Only revert if something actually
        // changed — otherwise clicking Schedule and then Save with no edits
        // would needlessly bounce the post straight back to Draft.
        $contentChanged = $data['content'] !== $post->content
            || $data['category'] !== $post->category
            || (int) $data['social_account_id'] !== (int) $post->social_account_id;

        $revertedToDraft = $post->status === ScheduledPost::STATUS_SCHEDULED && $contentChanged;

        $post->update([
            'content' => $data['content'],
            'category' => $data['category'],
            'social_account_id' => $data['social_account_id'],
            'platform' => $accounts[$data['social_account_id']],
            'scheduled_at' => $scheduledAt,
            'timezone' => $data['timezone'] ?? $post->timezone,
            'status' => $revertedToDraft ? ScheduledPost::STATUS_DRAFT : $post->status,
        ]);

        return $revertedToDraft
            ? back()->with('toast', 'Saved — moved back to Draft since it was already Scheduled. Click Schedule again to re-approve.')
            : back();
    }

    /**
     * Regenerate a single post's content in its assigned (or newly chosen)
     * category, keeping its scheduled time.
     */
    public function regenerate(Request $request, ScheduledPost $post): RedirectResponse
    {
        abort_unless($post->user_id === $request->user()->id, 403);

        $data = $request->validate([
            'category' => ['required', 'string', 'in:'.implode(',', array_keys(PromptBuilder::POST_CATEGORIES))],
        ]);

        $user = $request->user();

        try {
            $generated = $this->generateSingle($user, $data['category']);
        } catch (RuntimeException $e) {
            return back()->withErrors(['regenerate' => $e->getMessage()]);
        }

        $post->update([
            'content' => $generated['content'] !== '' ? $generated['content'] : $post->content,
            'category' => $data['category'],
            'generation_id' => $generated['generation_id'],
            // Regenerated content has never been reviewed, so it can't stay
            // Scheduled — otherwise unreviewed text could get auto-posted.
            'status' => ScheduledPost::STATUS_DRAFT,
            'error' => null,
        ]);

        return back();
    }

    /**
     * Delete a single scheduled post.
     */
    public function destroy(Request $request, ScheduledPost $post): RedirectResponse
    {
        abort_unless($post->user_id === $request->user()->id, 403);

        $post->delete();

        return back();
    }

    /**
     * Approve a draft post so it's eligible to auto-publish to X once its
     * scheduled time arrives (see App\Console\Commands\PublishDuePosts).
     */
    public function schedule(Request $request, ScheduledPost $post): RedirectResponse
    {
        abort_unless($post->user_id === $request->user()->id, 403);

        if ($post->realScheduledAt()->isPast()) {
            return back()->withErrors([
                'schedule' => 'This slot is already in the past — edit the time before scheduling.',
            ]);
        }

        if (! $post->social_account_id) {
            return back()->withErrors([
                'schedule' => 'This post has no connected account to publish to — pick one before scheduling it.',
            ]);
        }

        if (! $post->socialAccount?->is_active) {
            return back()->withErrors([
                'schedule' => 'The account this post targets is paused — resume it on the Connect page first.',
            ]);
        }

        $post->update(['status' => ScheduledPost::STATUS_SCHEDULED, 'error' => null]);

        return back()->with('toast', 'Post scheduled — it will publish automatically at its time.');
    }

    /**
     * Move a post back to Draft so it's no longer eligible to auto-publish.
     */
    public function unschedule(Request $request, ScheduledPost $post): RedirectResponse
    {
        abort_unless($post->user_id === $request->user()->id, 403);

        $post->update(['status' => ScheduledPost::STATUS_DRAFT, 'error' => null]);

        return back();
    }

    /**
     * Schedule every remaining draft post in a given week in one go.
     */
    public function scheduleAll(Request $request): RedirectResponse
    {
        $data = $request->validate(['week_start' => ['required', 'date']]);

        $weekStart = $this->resolveWeekStart($data['week_start']);
        $weekEnd = $weekStart->copy()->endOfWeek(Carbon::SUNDAY);

        // "Still in the future" has to account for each post's own timezone
        // (see ScheduledPost::realScheduledAt) rather than comparing the
        // naive wall-clock scheduled_at against the server's now() directly.
        $drafts = $request->user()->scheduledPosts()
            ->whereBetween('scheduled_at', [$weekStart, $weekEnd])
            ->where('status', ScheduledPost::STATUS_DRAFT)
            ->get()
            ->filter(fn (ScheduledPost $post) => $post->realScheduledAt()->isFuture());

        // Posts whose target account was disconnected can never publish, so
        // they're skipped rather than failing the whole batch.
        [$eligible, $skipped] = $drafts->partition(
            fn (ScheduledPost $post) => $post->socialAccount?->is_active === true,
        );

        ScheduledPost::whereIn('id', $eligible->pluck('id'))
            ->update(['status' => ScheduledPost::STATUS_SCHEDULED, 'error' => null]);

        return back()->with('toast', $skipped->isEmpty()
            ? 'All draft posts this week are now scheduled.'
            : $eligible->count().' draft posts scheduled — '.$skipped->count().' skipped because their account is paused or disconnected.');
    }

    /**
     * Delete every post in a given week (draft, scheduled, posted, or
     * failed) so the week is empty and can be regenerated from scratch —
     * "Generate week" is disabled while the week already has any posts.
     */
    public function emptyWeek(Request $request): RedirectResponse
    {
        $data = $request->validate(['week_start' => ['required', 'date']]);

        $weekStart = $this->resolveWeekStart($data['week_start']);
        $weekEnd = $weekStart->copy()->endOfWeek(Carbon::SUNDAY);

        $request->user()->scheduledPosts()
            ->whereBetween('scheduled_at', [$weekStart, $weekEnd])
            ->delete();

        return back()->with('toast', 'Week emptied.');
    }

    private function resolveWeekStart(?string $date): Carbon
    {
        return Carbon::parse($date ?? 'today')->startOfWeek(Carbon::MONDAY);
    }
}
