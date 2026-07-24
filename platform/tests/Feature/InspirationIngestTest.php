<?php

namespace Tests\Feature;

use App\Models\InspirationPost;
use App\Models\TrackedCreator;
use App\Models\User;
use App\Services\InspirationScorer;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * The extension's harvest endpoint — posts scraped off x.com by the user's own
 * browser, replacing the metered X API reads.
 */
class InspirationIngestTest extends TestCase
{
    use RefreshDatabase;

    /**
     * @param  array<string, mixed>  $overrides
     * @return array<string, mixed>
     */
    private function tweet(string $id, int $likes, array $overrides = []): array
    {
        return array_merge([
            'x_tweet_id' => $id,
            'content' => "Post {$id}",
            'url' => "https://x.com/karpathy/status/{$id}",
            'posted_at' => now()->subDays(1)->toIso8601String(),
            'metrics' => ['like' => $likes, 'reply' => 0, 'retweet' => 0, 'quote' => 0],
        ], $overrides);
    }

    public function test_it_requires_authentication(): void
    {
        $this->postJson('/api/inspiration/ingest', [
            'handle' => 'karpathy',
            'posts' => [$this->tweet('1', 10)],
        ])->assertUnauthorized();
    }

    public function test_it_creates_the_creator_and_scores_the_posts(): void
    {
        $user = User::factory()->create();
        Sanctum::actingAs($user);

        $this->postJson('/api/inspiration/ingest', [
            'handle' => '@karpathy',
            'profile' => [
                'name' => 'Andrej',
                'avatar_url' => 'https://pbs.twimg.com/a.jpg',
                'followers_count' => 1000000,
            ],
            // Mean engagement is 100, so the 300-like post is 3x baseline.
            'posts' => [$this->tweet('1', 300), $this->tweet('2', 0), $this->tweet('3', 0)],
        ])->assertOk()->assertJson(['received' => 3, 'stored' => 3]);

        $creator = TrackedCreator::where('username', 'karpathy')->sole();

        $this->assertSame($user->id, $creator->user_id);
        $this->assertSame('Andrej', $creator->name);
        $this->assertSame(1000000, $creator->followers_count);
        $this->assertNotNull($creator->last_scanned_at);

        $this->assertSame(3.0, $creator->inspirationPosts()->where('x_tweet_id', '1')->sole()->baseline_multiplier);
        $this->assertSame(0.0, $creator->inspirationPosts()->where('x_tweet_id', '2')->sole()->baseline_multiplier);
    }

    public function test_it_reuses_an_already_tracked_creator(): void
    {
        $user = User::factory()->create();
        $creator = $user->trackedCreators()->create(['username' => 'karpathy']);
        Sanctum::actingAs($user);

        $this->postJson('/api/inspiration/ingest', [
            'handle' => 'karpathy',
            'posts' => [$this->tweet('1', 10)],
        ])->assertOk();

        $this->assertDatabaseCount('tracked_creators', 1);
        $this->assertSame(1, $creator->inspirationPosts()->count());
    }

    public function test_a_harvest_adds_to_stored_posts_rather_than_replacing_them(): void
    {
        $user = User::factory()->create();
        Sanctum::actingAs($user);

        $this->postJson('/api/inspiration/ingest', [
            'handle' => 'karpathy',
            'posts' => [$this->tweet('1', 10), $this->tweet('2', 10)],
        ])->assertOk();

        // A second visit only sees what that page had loaded — post 1 must survive.
        $this->postJson('/api/inspiration/ingest', [
            'handle' => 'karpathy',
            'posts' => [$this->tweet('3', 10)],
        ])->assertOk()->assertJson(['received' => 1, 'stored' => 3]);
    }

    public function test_re_harvesting_a_post_updates_its_metrics(): void
    {
        $user = User::factory()->create();
        Sanctum::actingAs($user);

        $this->postJson('/api/inspiration/ingest', [
            'handle' => 'karpathy',
            'posts' => [$this->tweet('1', 10)],
        ])->assertOk();

        $this->postJson('/api/inspiration/ingest', [
            'handle' => 'karpathy',
            'posts' => [$this->tweet('1', 999)],
        ])->assertOk()->assertJson(['stored' => 1]);

        $this->assertSame(999, InspirationPost::sole()->metrics['like']);
    }

    public function test_it_only_ever_touches_the_callers_own_creators(): void
    {
        $owner = User::factory()->create();
        $ownerCreator = $owner->trackedCreators()->create(['username' => 'karpathy']);

        $other = User::factory()->create();
        Sanctum::actingAs($other);

        $this->postJson('/api/inspiration/ingest', [
            'handle' => 'karpathy',
            'posts' => [$this->tweet('1', 10)],
        ])->assertOk();

        $this->assertDatabaseCount('tracked_creators', 2);
        $this->assertSame(0, $ownerCreator->inspirationPosts()->count());
    }

    public function test_it_trims_a_creator_to_the_retention_cap(): void
    {
        $user = User::factory()->create();
        Sanctum::actingAs($user);

        $keep = InspirationScorer::KEEP_PER_CREATOR;
        $posts = [];

        for ($i = 0; $i < $keep + 20; $i++) {
            $posts[] = $this->tweet((string) $i, 10, [
                'posted_at' => now()->subDays($i + 1)->toIso8601String(),
            ]);
        }

        $this->postJson('/api/inspiration/ingest', [
            'handle' => 'karpathy',
            'posts' => $posts,
        ])->assertOk()->assertJson(['stored' => $keep]);

        // The oldest ones are the ones dropped.
        $this->assertDatabaseMissing('inspiration_posts', ['x_tweet_id' => (string) ($keep + 19)]);
        $this->assertDatabaseHas('inspiration_posts', ['x_tweet_id' => '0']);
    }

    public function test_the_creator_list_drives_the_extensions_harvesting(): void
    {
        $user = User::factory()->create();
        $user->trackedCreators()->create(['username' => 'karpathy']);
        $user->trackedCreators()->create(['username' => 'levelsio']);

        // Another user's creators must never leak into this list.
        User::factory()->create()->trackedCreators()->create(['username' => 'someoneelse']);

        Sanctum::actingAs($user);

        $this->getJson('/api/inspiration/creators')
            ->assertOk()
            ->assertJsonCount(2, 'creators')
            ->assertJsonPath('creators.0.username', 'karpathy')
            ->assertJsonPath('creators.0.posts_count', 0);
    }

    public function test_the_creator_list_requires_authentication(): void
    {
        $this->getJson('/api/inspiration/creators')->assertUnauthorized();
    }

    public function test_it_validates_the_payload(): void
    {
        $user = User::factory()->create();
        Sanctum::actingAs($user);

        $this->postJson('/api/inspiration/ingest', [
            'handle' => 'not a handle!',
            'posts' => [],
        ])->assertUnprocessable()->assertJsonValidationErrors(['handle', 'posts']);
    }
}
