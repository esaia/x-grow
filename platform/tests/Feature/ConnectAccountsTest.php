<?php

namespace Tests\Feature;

use App\Models\ScheduledPost;
use App\Models\SocialAccount;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Http;
use Illuminate\Testing\TestResponse;
use Tests\TestCase;

/**
 * Connecting several accounts per network, connecting LinkedIn company
 * pages, and disconnecting them again.
 */
class ConnectAccountsTest extends TestCase
{
    use RefreshDatabase;

    private function fakeLinkedInHandshake(): void
    {
        Http::fake([
            'www.linkedin.com/oauth/v2/accessToken' => Http::response([
                'access_token' => 'li-token',
                'expires_in' => 5184000,
            ]),
            'api.linkedin.com/v2/userinfo' => Http::response([
                'sub' => 'member-1',
                'name' => 'Owner Name',
            ]),
        ]);
    }

    /** The separate pages app's handshake (Community Management API). */
    private function fakePagesHandshake(): void
    {
        config([
            'services.linkedin.pages.client_id' => 'pages-client',
            'services.linkedin.pages.client_secret' => 'pages-secret',
            'services.linkedin.pages.redirect_uri' => 'http://localhost:8001/connect/linkedin/pages/callback',
        ]);

        Http::fake([
            'www.linkedin.com/oauth/v2/accessToken' => Http::response([
                'access_token' => 'pages-token',
                'expires_in' => 5184000,
            ]),
            'api.linkedin.com/rest/organizationAcls*' => Http::response([
                'elements' => [
                    ['organization' => 'urn:li:organization:135306108'],
                ],
            ]),
            'api.linkedin.com/rest/organizations/*' => Http::response([
                'localizedName' => 'Flatview',
            ]),
        ]);
    }

    private function completePagesCallback(User $user): TestResponse
    {
        return $this->actingAs($user)
            ->withSession(['linkedin_pages_oauth_state' => 'pages-state'])
            ->get(route('connect.linkedin.pages.callback', ['code' => 'code', 'state' => 'pages-state']));
    }

    /** Drives the callback with a state the session already trusts. */
    private function completeLinkedInCallback(User $user): TestResponse
    {
        return $this->actingAs($user)
            ->withSession(['linkedin_oauth_state' => 'state-123'])
            ->get(route('connect.linkedin.callback', ['code' => 'auth-code', 'state' => 'state-123']));
    }

    public function test_the_page_lists_connected_accounts(): void
    {
        $user = User::factory()->create();
        SocialAccount::create([
            'user_id' => $user->id,
            'provider' => SocialAccount::PROVIDER_X,
            'kind' => SocialAccount::KIND_PERSON,
            'external_id' => '111',
            'handle' => 'owner',
            'access_token' => 'token',
            'expires_at' => now()->addHour(),
        ]);

        $this->actingAs($user)
            ->get(route('connect.show'))
            ->assertOk()
            ->assertInertia(fn ($page) => $page
                ->has('accounts', 1)
                ->where('accounts.0.label', '@owner'));
    }

    public function test_connecting_a_second_x_account_adds_a_destination(): void
    {
        $user = User::factory()->create();

        // A second Http::fake() call doesn't replace an existing stub for the
        // same URL, so both handshakes come from one sequence.
        Http::fake([
            'api.x.com/2/oauth2/token' => Http::response([
                'access_token' => 'token',
                'refresh_token' => 'refresh',
                'expires_in' => 7200,
            ]),
            'api.x.com/2/users/me' => Http::sequence()
                ->push(['data' => ['id' => '111', 'username' => 'owner', 'name' => 'owner']])
                ->push(['data' => ['id' => '222', 'username' => 'sidekick', 'name' => 'sidekick']]),
        ]);

        foreach ([['111', 'owner'], ['222', 'sidekick']] as [$id, $handle]) {
            $this->actingAs($user)
                ->withSession(['x_oauth_state' => 'state-'.$id, 'x_oauth_verifier' => 'verifier'])
                ->get(route('connect.x.callback', ['code' => 'code', 'state' => 'state-'.$id]))
                ->assertRedirect(route('connect.show'));
        }

        $this->assertSame(2, $user->socialAccounts()->count());
        $this->assertDatabaseHas('social_accounts', ['handle' => 'owner']);
        $this->assertDatabaseHas('social_accounts', ['handle' => 'sidekick']);
    }

    public function test_reconnecting_the_same_account_refreshes_it_instead_of_duplicating(): void
    {
        $user = User::factory()->create();
        $this->fakeLinkedInHandshake();

        $this->completeLinkedInCallback($user)->assertRedirect(route('connect.show'));
        $this->completeLinkedInCallback($user)->assertRedirect(route('connect.show'));

        $this->assertSame(1, $user->socialAccounts()->count());
    }

    public function test_company_pages_connect_through_the_pages_app(): void
    {
        $user = User::factory()->create();
        $this->fakePagesHandshake();

        $this->completePagesCallback($user)->assertSessionHasNoErrors();

        $page = $user->socialAccounts()->where('kind', SocialAccount::KIND_ORGANIZATION)->first();

        $this->assertNotNull($page);
        $this->assertSame('Flatview', $page->name);
        $this->assertSame('urn:li:organization:135306108', $page->authorUrn());
        // The pages app is its own OAuth client, so the page owns its token.
        $this->assertSame('pages-token', $page->access_token);
        $this->assertNull($page->parent_id);
    }

    public function test_the_member_flow_never_touches_pages(): void
    {
        $user = User::factory()->create();
        $this->fakeLinkedInHandshake();

        $this->completeLinkedInCallback($user)->assertSessionHasNoErrors();

        $this->assertSame(0, $user->socialAccounts()->where('kind', SocialAccount::KIND_ORGANIZATION)->count());
    }

    public function test_connecting_pages_is_refused_until_the_second_app_is_configured(): void
    {
        config(['services.linkedin.pages.client_id' => null]);

        $this->actingAs(User::factory()->create())
            ->get(route('connect.linkedin.pages.redirect'))
            ->assertRedirect(route('connect.show'))
            ->assertSessionHasErrors('linkedin');
    }

    public function test_connecting_pages_reports_when_no_page_is_administered(): void
    {
        $user = User::factory()->create();
        config([
            'services.linkedin.pages.client_id' => 'pages-client',
            'services.linkedin.pages.client_secret' => 'pages-secret',
        ]);

        Http::fake([
            'www.linkedin.com/oauth/v2/accessToken' => Http::response([
                'access_token' => 'pages-token', 'expires_in' => 5184000,
            ]),
            'api.linkedin.com/rest/organizationAcls*' => Http::response(['elements' => []]),
        ]);

        $this->completePagesCallback($user)->assertSessionHasErrors('linkedin');

        $this->assertSame(0, $user->socialAccounts()->count());
    }

    public function test_a_refused_authorization_is_reported(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user)
            ->get(route('connect.linkedin.callback', [
                'error' => 'unauthorized_scope_error',
                'error_description' => 'Scope not authorized',
            ]))
            ->assertSessionHasErrors('linkedin');

        $this->assertSame(0, $user->socialAccounts()->count());
    }

    public function test_disconnecting_keeps_drafts_but_clears_their_target(): void
    {
        $user = User::factory()->create();
        $account = SocialAccount::create([
            'user_id' => $user->id,
            'provider' => SocialAccount::PROVIDER_X,
            'kind' => SocialAccount::KIND_PERSON,
            'external_id' => '111',
            'handle' => 'owner',
            'access_token' => 'token',
            'expires_at' => now()->addHour(),
        ]);

        $post = $user->scheduledPosts()->create([
            'content' => 'A draft.',
            'platform' => ScheduledPost::PLATFORM_X,
            'social_account_id' => $account->id,
            'status' => ScheduledPost::STATUS_DRAFT,
            'scheduled_at' => now()->addDay(),
            'timezone' => 'UTC',
        ]);

        $this->actingAs($user)
            ->delete(route('connect.accounts.destroy', $account))
            ->assertRedirect(route('connect.show'));

        $this->assertDatabaseMissing('social_accounts', ['id' => $account->id]);
        $this->assertDatabaseHas('scheduled_posts', ['id' => $post->id, 'social_account_id' => null]);
    }

    public function test_an_account_can_be_paused_and_resumed(): void
    {
        $user = User::factory()->create();
        $account = SocialAccount::create([
            'user_id' => $user->id,
            'provider' => SocialAccount::PROVIDER_X,
            'kind' => SocialAccount::KIND_PERSON,
            'external_id' => '111',
            'handle' => 'owner',
            'access_token' => 'token',
            'expires_at' => now()->addHour(),
        ]);

        $this->assertTrue($account->is_active);

        $this->actingAs($user)
            ->put(route('connect.accounts.update', $account), ['is_active' => false])
            ->assertRedirect();

        $this->assertFalse($account->fresh()->is_active);

        $this->actingAs($user)
            ->put(route('connect.accounts.update', $account), ['is_active' => true])
            ->assertRedirect();

        $this->assertTrue($account->fresh()->is_active);
    }

    public function test_cannot_pause_another_users_account(): void
    {
        $owner = User::factory()->create();
        $account = SocialAccount::create([
            'user_id' => $owner->id,
            'provider' => SocialAccount::PROVIDER_X,
            'kind' => SocialAccount::KIND_PERSON,
            'external_id' => '111',
            'handle' => 'owner',
            'access_token' => 'token',
            'expires_at' => now()->addHour(),
        ]);

        $this->actingAs(User::factory()->create())
            ->put(route('connect.accounts.update', $account), ['is_active' => false])
            ->assertForbidden();

        $this->assertTrue($account->fresh()->is_active);
    }

    public function test_cannot_disconnect_another_users_account(): void
    {
        $owner = User::factory()->create();
        $account = SocialAccount::create([
            'user_id' => $owner->id,
            'provider' => SocialAccount::PROVIDER_X,
            'kind' => SocialAccount::KIND_PERSON,
            'external_id' => '111',
            'handle' => 'owner',
            'access_token' => 'token',
            'expires_at' => now()->addHour(),
        ]);

        $this->actingAs(User::factory()->create())
            ->delete(route('connect.accounts.destroy', $account))
            ->assertForbidden();

        $this->assertDatabaseHas('social_accounts', ['id' => $account->id]);
    }
}
