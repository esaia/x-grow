<?php

namespace Tests\Feature;

use App\Models\SocialAccount;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

class InspirationTest extends TestCase
{
    use RefreshDatabase;

    private function connectX(User $user): SocialAccount
    {
        return SocialAccount::create([
            'user_id' => $user->id,
            'provider' => SocialAccount::PROVIDER_X,
            'kind' => SocialAccount::KIND_PERSON,
            'external_id' => '111',
            'name' => 'owner',
            'handle' => 'owner',
            'access_token' => 'access-token',
            'refresh_token' => 'refresh-token',
            'expires_at' => now()->addHour(),
        ]);
    }

    public function test_guests_are_redirected(): void
    {
        $this->get(route('inspiration.index'))->assertRedirect(route('login'));
    }

    public function test_page_renders_for_authenticated_users(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user)
            ->get(route('inspiration.index'))
            ->assertOk();
    }

    public function test_date_range_filters_posts_by_the_users_calendar_days(): void
    {
        // Frozen so "today" in Asia/Tbilisi (UTC+4) is unambiguous whatever hour
        // the suite happens to run at.
        $this->travelTo('2026-07-27 09:00:00');

        $user = User::factory()->create();
        $creator = $user->trackedCreators()->create([
            'x_user_id' => '999',
            'username' => 'karpathy',
        ]);

        // Times are chosen so the Tbilisi (UTC+4) day boundaries differ from UTC's.
        foreach ([
            'today' => now()->startOfDay()->addHours(6),
            'yesterday' => now()->subDay()->startOfDay()->addHours(6),
            'old' => now()->subDays(10),
        ] as $label => $postedAt) {
            $creator->inspirationPosts()->create([
                'x_tweet_id' => $label,
                'content' => $label,
                'metrics' => ['like' => 100, 'reply' => 10, 'retweet' => 5, 'quote' => 1],
                'baseline_multiplier' => 2,
                'posted_at' => $postedAt,
            ]);
        }

        $contents = fn (string $range): array => collect(
            $this->actingAs($user)
                ->get(route('inspiration.index', ['range' => $range, 'timezone' => 'Asia/Tbilisi']))
                ->assertOk()
                ->viewData('page')['props']['posts']
        )->pluck('content')->sort()->values()->all();

        $this->assertSame(['today'], $contents('today'));
        $this->assertSame(['yesterday'], $contents('yesterday'));
        $this->assertSame(['today', 'yesterday'], $contents('2'));
        $this->assertSame(['old', 'today', 'yesterday'], $contents('30'));
        $this->assertSame(['old', 'today', 'yesterday'], $contents('all'));
    }

    public function test_date_range_rejects_an_unknown_value(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user)
            ->get(route('inspiration.index', ['range' => 'last-week']))
            ->assertSessionHasErrors('range');
    }

    public function test_adding_a_creator_needs_only_a_handle(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user)
            ->post(route('inspiration.creators.store'), ['handle' => '@karpathy'])
            ->assertRedirect()
            ->assertSessionHasNoErrors();

        // No X API call is made — the extension fills in the profile later.
        Http::assertNothingSent();

        $this->assertDatabaseHas('tracked_creators', [
            'user_id' => $user->id,
            'username' => 'karpathy',
        ]);
    }

    public function test_adding_the_same_creator_twice_does_not_duplicate(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user)->post(route('inspiration.creators.store'), ['handle' => 'karpathy']);
        $this->actingAs($user)->post(route('inspiration.creators.store'), ['handle' => '@karpathy']);

        $this->assertDatabaseCount('tracked_creators', 1);
    }

    public function test_adding_a_creator_rejects_a_malformed_handle(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user)
            ->post(route('inspiration.creators.store'), ['handle' => 'not a handle!'])
            ->assertSessionHasErrors('handle');

        $this->assertDatabaseCount('tracked_creators', 0);
    }

    public function test_removing_a_creator(): void
    {
        $user = User::factory()->create();
        $creator = $user->trackedCreators()->create([
            'x_user_id' => '999',
            'username' => 'karpathy',
        ]);

        $post = $creator->inspirationPosts()->create([
            'x_tweet_id' => 'abc',
            'content' => 'A viral post.',
            'baseline_multiplier' => 2.0,
        ]);

        $this->actingAs($user)
            ->delete(route('inspiration.creators.destroy', $creator))
            ->assertRedirect();

        $this->assertDatabaseMissing('tracked_creators', ['id' => $creator->id]);
        $this->assertDatabaseMissing('inspiration_posts', ['id' => $post->id]);
    }

    public function test_cannot_remove_another_users_creator(): void
    {
        $owner = User::factory()->create();
        $other = User::factory()->create();
        $creator = $owner->trackedCreators()->create([
            'x_user_id' => '999',
            'username' => 'karpathy',
        ]);

        $this->actingAs($other)
            ->delete(route('inspiration.creators.destroy', $creator))
            ->assertForbidden();

        $this->assertDatabaseHas('tracked_creators', ['id' => $creator->id]);
    }

    public function test_use_idea_generates_a_draft(): void
    {
        config(['services.openai.key' => 'test-key']);

        $user = User::factory()->create();
        $creator = $user->trackedCreators()->create([
            'x_user_id' => '999',
            'username' => 'karpathy',
        ]);
        $post = $creator->inspirationPosts()->create([
            'x_tweet_id' => 'abc',
            'content' => 'Everyone has AI now.',
            'metrics' => ['like' => 100, 'reply' => 10, 'retweet' => 5, 'quote' => 1],
            'baseline_multiplier' => 2.5,
        ]);

        Http::fake([
            'api.openai.com/*' => Http::response([
                'choices' => [
                    ['message' => ['content' => '{"options":["draft one","draft two","draft three"]}']],
                ],
                'usage' => ['prompt_tokens' => 10, 'completion_tokens' => 20],
                'model' => 'gpt-4o',
            ]),
        ]);

        $this->actingAs($user)
            ->post(route('inspiration.use', $post), [
                'closeness' => 'mine',
                'instructions' => 'Focus on the productivity angle.',
            ])
            ->assertRedirect()
            ->assertSessionHas('generatedDraft');

        $this->assertDatabaseHas('generations', [
            'user_id' => $user->id,
            'input_context' => 'Everyone has AI now.',
        ]);
    }

    public function test_use_idea_rejects_invalid_closeness(): void
    {
        $user = User::factory()->create();
        $creator = $user->trackedCreators()->create([
            'x_user_id' => '999',
            'username' => 'karpathy',
        ]);
        $post = $creator->inspirationPosts()->create([
            'x_tweet_id' => 'abc',
            'content' => 'Everyone has AI now.',
            'baseline_multiplier' => 2.5,
        ]);

        $this->actingAs($user)
            ->post(route('inspiration.use', $post), ['closeness' => 'bogus'])
            ->assertSessionHasErrors('closeness');
    }

    public function test_publish_posts_to_x_now(): void
    {
        $user = User::factory()->create();
        $this->connectX($user);

        Http::fake([
            'api.x.com/2/tweets' => Http::response(['data' => ['id' => '12345']]),
        ]);

        $this->actingAs($user)
            ->post(route('inspiration.publish'), ['content' => 'A brand new post.'])
            ->assertRedirect()
            ->assertSessionHasNoErrors();

        $this->assertDatabaseHas('scheduled_posts', [
            'user_id' => $user->id,
            'content' => 'A brand new post.',
            'status' => 'posted',
            'external_post_id' => '12345',
        ]);
    }

    public function test_publish_requires_a_connected_x_account(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user)
            ->post(route('inspiration.publish'), ['content' => 'A brand new post.'])
            ->assertSessionHasErrors('publish');

        $this->assertDatabaseCount('scheduled_posts', 0);
    }

    public function test_failed_publish_removes_the_row_and_reports_error(): void
    {
        $user = User::factory()->create();
        $this->connectX($user);

        Http::fake([
            'api.x.com/2/tweets' => Http::response('rate limited', 429),
        ]);

        $this->actingAs($user)
            ->post(route('inspiration.publish'), ['content' => 'A brand new post.'])
            ->assertSessionHasErrors('publish');

        $this->assertDatabaseCount('scheduled_posts', 0);
    }

    public function test_schedule_creates_an_approved_post(): void
    {
        $user = User::factory()->create();
        $account = $this->connectX($user);
        $date = now()->addDay()->toDateString();

        $this->actingAs($user)
            ->post(route('inspiration.schedule'), [
                'content' => 'Later post.',
                'date' => $date,
                'time' => '10:30',
                'timezone' => 'UTC',
            ])
            ->assertRedirect()
            ->assertSessionHasNoErrors();

        $this->assertDatabaseHas('scheduled_posts', [
            'user_id' => $user->id,
            'content' => 'Later post.',
            'status' => 'scheduled',
            'social_account_id' => $account->id,
        ]);
    }

    public function test_schedule_requires_a_connected_x_account(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user)
            ->post(route('inspiration.schedule'), [
                'content' => 'Nowhere to post this.',
                'date' => now()->addDay()->toDateString(),
                'time' => '10:30',
                'timezone' => 'UTC',
            ])
            ->assertSessionHasErrors('time');

        $this->assertDatabaseCount('scheduled_posts', 0);
    }

    public function test_schedule_rejects_a_past_time(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user)
            ->post(route('inspiration.schedule'), [
                'content' => 'Too late.',
                'date' => now()->subDay()->toDateString(),
                'time' => '10:30',
                'timezone' => 'UTC',
            ])
            ->assertSessionHasErrors('time');

        $this->assertDatabaseCount('scheduled_posts', 0);
    }
}
