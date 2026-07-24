<?php

namespace Tests\Feature;

use App\Models\ScheduledPost;
use App\Models\SocialAccount;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

/**
 * Covers targeting a scheduled post at one of several connected accounts:
 * one row per selected account, per-account slot conflicts, LinkedIn company
 * pages posting as the organization, and publishing routed to the right
 * network.
 */
class SchedulePlatformTest extends TestCase
{
    use RefreshDatabase;

    private function connectX(User $user, string $handle = 'owner', string $externalId = '111'): SocialAccount
    {
        return SocialAccount::create([
            'user_id' => $user->id,
            'provider' => SocialAccount::PROVIDER_X,
            'kind' => SocialAccount::KIND_PERSON,
            'external_id' => $externalId,
            'name' => $handle,
            'handle' => $handle,
            'access_token' => 'access-token',
            'refresh_token' => 'refresh-token',
            'expires_at' => now()->addHour(),
        ]);
    }

    private function connectLinkedIn(User $user): SocialAccount
    {
        return SocialAccount::create([
            'user_id' => $user->id,
            'provider' => SocialAccount::PROVIDER_LINKEDIN,
            'kind' => SocialAccount::KIND_PERSON,
            'external_id' => 'abc123',
            'name' => 'Owner Name',
            'access_token' => 'li-access-token',
            'expires_at' => now()->addHour(),
        ]);
    }

    /**
     * A company page, connected through the separate pages app and so holding
     * its own token (see ConnectLinkedInPagesController).
     */
    private function connectPage(User $user): SocialAccount
    {
        return SocialAccount::create([
            'user_id' => $user->id,
            'provider' => SocialAccount::PROVIDER_LINKEDIN,
            'kind' => SocialAccount::KIND_ORGANIZATION,
            'external_id' => '135306108',
            'name' => 'Flatview',
            'access_token' => 'page-token',
            'expires_at' => now()->addHour(),
        ]);
    }

    /**
     * @param  array<int, int>  $accountIds
     * @return array<string, mixed>
     */
    private function postPayload(array $accountIds, string $time = '09:00'): array
    {
        return [
            'content' => 'A post for several accounts.',
            'category' => 'tip',
            'accounts' => $accountIds,
            'date' => now()->addDay()->toDateString(),
            'time' => $time,
            'timezone' => 'UTC',
        ];
    }

    public function test_the_page_lists_every_connected_account(): void
    {
        $user = User::factory()->create();
        $this->connectLinkedIn($user);
        $this->connectPage($user);
        $this->connectX($user);

        $this->actingAs($user)
            ->get(route('schedule.index'))
            ->assertOk()
            ->assertInertia(fn ($page) => $page->has('accounts', 3));
    }

    public function test_adding_a_post_creates_one_row_per_selected_account(): void
    {
        $user = User::factory()->create();
        $x = $this->connectX($user);
        $linkedin = $this->connectLinkedIn($user);

        $this->actingAs($user)
            ->post(route('schedule.store'), $this->postPayload([$x->id, $linkedin->id]))
            ->assertRedirect()
            ->assertSessionHasNoErrors();

        $this->assertDatabaseCount('scheduled_posts', 2);
        $this->assertDatabaseHas('scheduled_posts', [
            'social_account_id' => $x->id,
            'platform' => 'x',
            'status' => 'draft',
        ]);
        $this->assertDatabaseHas('scheduled_posts', [
            'social_account_id' => $linkedin->id,
            'platform' => 'linkedin',
            'status' => 'draft',
        ]);
    }

    public function test_one_account_cannot_be_double_booked_in_a_slot(): void
    {
        $user = User::factory()->create();
        $x = $this->connectX($user);

        $this->actingAs($user)->post(route('schedule.store'), $this->postPayload([$x->id]));

        $this->actingAs($user)
            ->post(route('schedule.store'), $this->postPayload([$x->id]))
            ->assertSessionHasErrors('time');

        $this->assertDatabaseCount('scheduled_posts', 1);
    }

    public function test_two_accounts_on_the_same_network_may_share_a_slot(): void
    {
        $user = User::factory()->create();
        $first = $this->connectX($user, 'owner', '111');
        $second = $this->connectX($user, 'sidekick', '222');

        $this->actingAs($user)->post(route('schedule.store'), $this->postPayload([$first->id]));

        $this->actingAs($user)
            ->post(route('schedule.store'), $this->postPayload([$second->id]))
            ->assertSessionHasNoErrors();

        $this->assertDatabaseCount('scheduled_posts', 2);
    }

    public function test_another_users_account_cannot_be_targeted(): void
    {
        $user = User::factory()->create();
        $this->connectX($user);
        $stranger = $this->connectX(User::factory()->create(), 'stranger', '333');

        $this->actingAs($user)
            ->post(route('schedule.store'), $this->postPayload([$stranger->id]))
            ->assertSessionHasErrors('accounts');

        $this->assertDatabaseCount('scheduled_posts', 0);
    }

    public function test_a_post_whose_account_was_disconnected_cannot_be_scheduled(): void
    {
        $user = User::factory()->create();
        $account = $this->connectLinkedIn($user);

        $post = $user->scheduledPosts()->create([
            'content' => 'Hello LinkedIn.',
            'category' => 'tip',
            'platform' => ScheduledPost::PLATFORM_LINKEDIN,
            'social_account_id' => $account->id,
            'status' => ScheduledPost::STATUS_DRAFT,
            'scheduled_at' => now()->addDay(),
            'timezone' => 'UTC',
        ]);

        // Disconnecting nulls the post's target rather than deleting the draft.
        $account->delete();
        $post->refresh();

        $this->assertNull($post->social_account_id);

        $this->actingAs($user)
            ->post(route('schedule.schedule', $post))
            ->assertSessionHasErrors('schedule');

        $this->assertSame(ScheduledPost::STATUS_DRAFT, $post->fresh()->status);
    }

    public function test_retargeting_an_approved_post_sends_it_back_to_draft(): void
    {
        $user = User::factory()->create();
        $x = $this->connectX($user);
        $linkedin = $this->connectLinkedIn($user);

        $post = $user->scheduledPosts()->create([
            'content' => 'Already approved.',
            'category' => 'tip',
            'platform' => ScheduledPost::PLATFORM_X,
            'social_account_id' => $x->id,
            'status' => ScheduledPost::STATUS_SCHEDULED,
            'scheduled_at' => now()->addDay()->setTime(9, 0),
            'timezone' => 'UTC',
        ]);

        $this->actingAs($user)
            ->put(route('schedule.update', $post), [
                'content' => 'Already approved.',
                'category' => 'tip',
                'social_account_id' => $linkedin->id,
                'time' => '09:00',
                'timezone' => 'UTC',
            ])
            ->assertSessionHasNoErrors();

        $post->refresh();

        $this->assertSame($linkedin->id, $post->social_account_id);
        $this->assertSame(ScheduledPost::PLATFORM_LINKEDIN, $post->platform);
        $this->assertSame(ScheduledPost::STATUS_DRAFT, $post->status);
    }

    public function test_a_due_linkedin_post_publishes_to_linkedin(): void
    {
        $user = User::factory()->create();
        $account = $this->connectLinkedIn($user);

        $post = $this->duePost($user, $account, 'Publish me on LinkedIn.');

        Http::fake([
            'api.linkedin.com/rest/posts' => Http::response('', 201, ['x-restli-id' => 'urn:li:share:999']),
        ]);

        $this->artisan('schedule:publish-due-posts')->assertSuccessful();

        $post->refresh();

        $this->assertSame(ScheduledPost::STATUS_POSTED, $post->status);
        $this->assertSame('urn:li:share:999', $post->external_post_id);

        Http::assertSent(fn ($request) => $request->url() === 'https://api.linkedin.com/rest/posts'
            && $request['author'] === 'urn:li:person:abc123');
    }

    public function test_a_company_page_post_publishes_as_the_organization(): void
    {
        $user = User::factory()->create();
        $page = $this->connectPage($user);

        $post = $this->duePost($user, $page, 'Publish me on the page.');

        Http::fake([
            'api.linkedin.com/rest/posts' => Http::response('', 201, ['x-restli-id' => 'urn:li:share:777']),
        ]);

        $this->artisan('schedule:publish-due-posts')->assertSuccessful();

        $this->assertSame(ScheduledPost::STATUS_POSTED, $post->fresh()->status);

        // Posts as the organization, with the pages app's own token.
        Http::assertSent(fn ($request) => $request['author'] === 'urn:li:organization:135306108'
            && $request->hasHeader('Authorization', 'Bearer page-token'));
    }

    public function test_a_due_x_post_still_publishes_to_x(): void
    {
        $user = User::factory()->create();
        $account = $this->connectX($user);

        $post = $this->duePost($user, $account, 'Publish me on X.');

        Http::fake([
            'api.x.com/2/tweets' => Http::response(['data' => ['id' => '555']]),
        ]);

        $this->artisan('schedule:publish-due-posts')->assertSuccessful();

        $post->refresh();

        $this->assertSame(ScheduledPost::STATUS_POSTED, $post->status);
        $this->assertSame('555', $post->external_post_id);
    }

    public function test_a_paused_account_cannot_be_targeted_or_scheduled(): void
    {
        $user = User::factory()->create();
        $account = $this->connectX($user);

        $post = $user->scheduledPosts()->create([
            'content' => 'Already drafted.',
            'category' => 'tip',
            'platform' => ScheduledPost::PLATFORM_X,
            'social_account_id' => $account->id,
            'status' => ScheduledPost::STATUS_DRAFT,
            'scheduled_at' => now()->addDay()->setTime(15, 0),
            'timezone' => 'UTC',
        ]);

        $account->update(['is_active' => false]);

        // No new posts may be aimed at it...
        $this->actingAs($user)
            ->post(route('schedule.store'), $this->postPayload([$account->id]))
            ->assertSessionHasErrors('accounts');

        // ...and an existing draft can't be approved for publishing.
        $this->actingAs($user)
            ->post(route('schedule.schedule', $post))
            ->assertSessionHasErrors('schedule');

        $this->assertSame(ScheduledPost::STATUS_DRAFT, $post->fresh()->status);
        // The account and its post both survive — pausing isn't disconnecting.
        $this->assertDatabaseHas('social_accounts', ['id' => $account->id]);
        $this->assertSame($account->id, $post->fresh()->social_account_id);
    }

    public function test_a_paused_account_holds_its_due_posts_instead_of_failing_them(): void
    {
        $user = User::factory()->create();
        $account = $this->connectX($user);
        $post = $this->duePost($user, $account, 'Should wait.');

        $account->update(['is_active' => false]);

        Http::fake(['api.x.com/2/tweets' => Http::response(['data' => ['id' => '999']])]);

        $this->artisan('schedule:publish-due-posts')->assertSuccessful();

        // Still Scheduled, not Failed — it goes out once resumed.
        $this->assertSame(ScheduledPost::STATUS_SCHEDULED, $post->fresh()->status);
        Http::assertNothingSent();

        $account->update(['is_active' => true]);

        $this->artisan('schedule:publish-due-posts')->assertSuccessful();

        $this->assertSame(ScheduledPost::STATUS_POSTED, $post->fresh()->status);
    }

    public function test_schedule_all_skips_paused_accounts(): void
    {
        $user = User::factory()->create();
        $active = $this->connectX($user, 'owner', '111');
        $paused = $this->connectX($user, 'sidekick', '222');
        $paused->update(['is_active' => false]);

        $weekStart = now()->startOfWeek()->toDateString();

        foreach ([$active, $paused] as $i => $account) {
            $user->scheduledPosts()->create([
                'content' => 'Draft '.$i,
                'category' => 'tip',
                'platform' => ScheduledPost::PLATFORM_X,
                'social_account_id' => $account->id,
                'status' => ScheduledPost::STATUS_DRAFT,
                'scheduled_at' => now()->addDay()->setTime(10 + $i, 0),
                'timezone' => 'UTC',
            ]);
        }

        $this->actingAs($user)
            ->post(route('schedule.schedule-all'), ['week_start' => $weekStart]);

        $this->assertSame(1, $user->scheduledPosts()->where('status', ScheduledPost::STATUS_SCHEDULED)->count());
        $this->assertSame(1, $user->scheduledPosts()->where('status', ScheduledPost::STATUS_DRAFT)->count());
    }

    private function duePost(User $user, SocialAccount $account, string $content): ScheduledPost
    {
        return $user->scheduledPosts()->create([
            'content' => $content,
            'category' => 'tip',
            'platform' => $account->provider,
            'social_account_id' => $account->id,
            'status' => ScheduledPost::STATUS_SCHEDULED,
            'scheduled_at' => now()->subMinute(),
            'timezone' => 'UTC',
        ]);
    }
}
