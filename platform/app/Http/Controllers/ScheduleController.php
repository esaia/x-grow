<?php

namespace App\Http\Controllers;

use App\Models\Generation;
use App\Models\ScheduledPost;
use App\Services\ClaudeService;
use App\Services\PromptBuilder;
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
        ]);

        $timezone = $data['timezone'] ?? config('app.timezone');

        $user = $request->user();
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
        $prompt = $this->prompts->weeklyBatchPrompt($categories);

        // A full week's batch (up to 42 posts) can take longer than PHP's
        // default 30s execution limit to generate in one Claude call.
        set_time_limit(180);

        try {
            $result = $this->claude->generateOptions($system, $prompt, $total, min(4096, 200 * $total));
        } catch (RuntimeException $e) {
            return back()->withErrors(['generate' => $e->getMessage()]);
        }

        DB::transaction(function () use (
            $user, $weekStart, $weekEnd, $perDay, $rangeStartMinutes, $rangeEndMinutes, $data, $result, $categories, $timezone
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
                        'status' => ScheduledPost::STATUS_DRAFT,
                        'scheduled_at' => $scheduledAt,
                        'timezone' => $timezone,
                    ]);
                }
            }
        });

        return back()->with('toast', 'Weekly schedule generated.');
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
            'time' => ['required', 'date_format:H:i'],
            'timezone' => ['nullable', 'string', 'timezone'],
        ]);

        $scheduledAt = $post->scheduled_at->copy()->setTimeFromTimeString($data['time']);

        $conflict = $request->user()->scheduledPosts()
            ->where('id', '!=', $post->id)
            ->where('scheduled_at', $scheduledAt)
            ->exists();

        if ($conflict) {
            return back()->withErrors([
                'time' => 'Another post is already scheduled at that time on this day. Pick a different time.',
            ]);
        }

        // Editing content/category/time on an already-approved post requires
        // re-approval before it's eligible to auto-post again — an in-place
        // edit right before the scheduled time should never silently publish
        // unreviewed content. Only revert if something actually changed —
        // otherwise clicking Schedule and then Save with no edits would
        // needlessly bounce the post straight back to Draft.
        $contentChanged = $data['content'] !== $post->content
            || $data['category'] !== $post->category
            || ! $scheduledAt->equalTo($post->scheduled_at);

        $revertedToDraft = $post->status === ScheduledPost::STATUS_SCHEDULED && $contentChanged;

        $post->update([
            'content' => $data['content'],
            'category' => $data['category'],
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
        $system = $this->prompts->systemPrompt($user->voiceProfile);
        $prompt = $this->prompts->weeklyBatchPrompt([$data['category']]);

        try {
            $result = $this->claude->generateOptions($system, $prompt, 1, 512);
        } catch (RuntimeException $e) {
            return back()->withErrors(['regenerate' => $e->getMessage()]);
        }

        $generation = $user->generations()->create([
            'type' => Generation::TYPE_POST,
            'input_context' => null,
            'meta' => ['weekly_schedule' => true, 'regenerate' => true, 'category' => $data['category']],
            'output' => $result['options'],
            'model' => $result['model'],
            'tokens_in' => $result['input_tokens'],
            'tokens_out' => $result['output_tokens'],
        ]);

        $post->update([
            'content' => $result['options'][0] ?? $post->content,
            'category' => $data['category'],
            'generation_id' => $generation->id,
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
        $ids = $request->user()->scheduledPosts()
            ->whereBetween('scheduled_at', [$weekStart, $weekEnd])
            ->where('status', ScheduledPost::STATUS_DRAFT)
            ->get()
            ->filter(fn (ScheduledPost $post) => $post->realScheduledAt()->isFuture())
            ->pluck('id');

        ScheduledPost::whereIn('id', $ids)->update(['status' => ScheduledPost::STATUS_SCHEDULED, 'error' => null]);

        return back()->with('toast', 'All draft posts this week are now scheduled.');
    }

    private function resolveWeekStart(?string $date): Carbon
    {
        return Carbon::parse($date ?? 'today')->startOfWeek(Carbon::MONDAY);
    }
}
