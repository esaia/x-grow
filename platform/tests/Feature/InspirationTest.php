<?php

namespace Tests\Feature;

use App\Models\User;
use App\Models\XAccount;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

class InspirationTest extends TestCase
{
    use RefreshDatabase;

    private function connectX(User $user): XAccount
    {
        return XAccount::create([
            'user_id' => $user->id,
            'x_user_id' => '111',
            'username' => 'owner',
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

    public function test_adding_a_creator_resolves_the_handle(): void
    {
        $user = User::factory()->create();
        $this->connectX($user);

        Http::fake([
            'api.x.com/2/users/by/username/*' => Http::response([
                'data' => [
                    'id' => '999',
                    'username' => 'karpathy',
                    'name' => 'Andrej',
                    'profile_image_url' => 'https://x/avatar.jpg',
                    'public_metrics' => ['followers_count' => 1000000],
                ],
            ]),
        ]);

        $this->actingAs($user)
            ->post(route('inspiration.creators.store'), ['handle' => '@karpathy'])
            ->assertRedirect();

        $this->assertDatabaseHas('tracked_creators', [
            'user_id' => $user->id,
            'x_user_id' => '999',
            'username' => 'karpathy',
        ]);
    }

    public function test_adding_a_creator_requires_a_connected_x_account(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user)
            ->post(route('inspiration.creators.store'), ['handle' => 'karpathy'])
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
}
