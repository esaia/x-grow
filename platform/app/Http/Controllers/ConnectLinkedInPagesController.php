<?php

namespace App\Http\Controllers;

use App\Models\SocialAccount;
use Illuminate\Http\Client\PendingRequest;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;

/**
 * Connects the LinkedIn company pages a member administers, so scheduled
 * posts can be published as the page.
 *
 * This is deliberately separate from ConnectLinkedInController: LinkedIn's
 * Community Management API product "requires that it be the only product on
 * the application", so it cannot live on the same app as Sign In with
 * LinkedIn / Share on LinkedIn. Page support therefore uses a second
 * LinkedIn app with its own client id and secret (services.linkedin.pages).
 *
 * Because that app is its own OAuth client, the page accounts it creates own
 * their tokens outright, just as member accounts do.
 */
class ConnectLinkedInPagesController extends Controller
{
    private const AUTHORIZE_URL = 'https://www.linkedin.com/oauth/v2/authorization';

    private const TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';

    private const ORG_ACLS_URL = 'https://api.linkedin.com/rest/organizationAcls';

    private const ORGS_URL = 'https://api.linkedin.com/rest/organizations';

    /**
     * Granted by the Community Management API product. `w_organization_social`
     * is what actually publishes; `rw_organization_admin` is only used to
     * discover which pages this member administers.
     *
     * LinkedIn doesn't always grant that exact pair — approvals vary, and
     * asking for a scope the app doesn't hold fails the whole authorization
     * with invalid_scope_error. So the string is overridable via
     * LINKEDIN_PAGES_SCOPES to match whatever the Auth tab actually lists.
     */
    private function scopes(): string
    {
        return config('services.linkedin.pages.scopes');
    }

    /**
     * Start the OAuth2 handshake against the pages app.
     */
    public function redirect(Request $request): RedirectResponse
    {
        if (! $this->configured()) {
            return to_route('connect.show')->withErrors([
                'linkedin' => 'LinkedIn page posting is not configured yet — set LINKEDIN_PAGES_CLIENT_ID and LINKEDIN_PAGES_CLIENT_SECRET.',
            ]);
        }

        $state = Str::random(40);

        $request->session()->put('linkedin_pages_oauth_state', $state);

        $query = http_build_query([
            'response_type' => 'code',
            'client_id' => config('services.linkedin.pages.client_id'),
            'redirect_uri' => config('services.linkedin.pages.redirect_uri'),
            'scope' => $this->scopes(),
            'state' => $state,
        ]);

        return redirect(self::AUTHORIZE_URL.'?'.$query);
    }

    /**
     * Exchange the code for a token, then connect every page this member
     * administers as its own posting destination.
     */
    public function callback(Request $request): RedirectResponse
    {
        if ($request->filled('error')) {
            return to_route('connect.show')->withErrors([
                'linkedin' => 'LinkedIn refused the page connection: '
                    .$request->string('error_description')->toString()
                    .' ('.$request->string('error')->toString().')',
            ]);
        }

        $data = $request->validate([
            'code' => ['required', 'string'],
            'state' => ['required', 'string'],
        ]);

        $expectedState = $request->session()->pull('linkedin_pages_oauth_state');

        if (! $expectedState || $data['state'] !== $expectedState) {
            return to_route('connect.show')->withErrors([
                'linkedin' => 'LinkedIn page connection failed: the request could not be verified. Please try again.',
            ]);
        }

        $tokenResponse = Http::asForm()->post(self::TOKEN_URL, [
            'grant_type' => 'authorization_code',
            'code' => $data['code'],
            'redirect_uri' => config('services.linkedin.pages.redirect_uri'),
            'client_id' => config('services.linkedin.pages.client_id'),
            'client_secret' => config('services.linkedin.pages.client_secret'),
        ]);

        if ($tokenResponse->failed()) {
            return to_route('connect.show')->withErrors([
                'linkedin' => 'LinkedIn page connection failed ('.$tokenResponse->status().'): '.$tokenResponse->body(),
            ]);
        }

        $tokens = $tokenResponse->json();

        $organizations = $this->administeredOrganizations($tokens['access_token']);

        if ($organizations === []) {
            return to_route('connect.show')->withErrors([
                'linkedin' => 'Connected, but LinkedIn reported no company pages you administer. Check that this LinkedIn member is an admin of the page.',
            ]);
        }

        foreach ($organizations as $id => $name) {
            SocialAccount::updateOrCreate(
                [
                    'user_id' => $request->user()->id,
                    'provider' => SocialAccount::PROVIDER_LINKEDIN,
                    'external_id' => (string) $id,
                ],
                [
                    'kind' => SocialAccount::KIND_ORGANIZATION,
                    'name' => $name,
                    'access_token' => $tokens['access_token'],
                    'refresh_token' => $tokens['refresh_token'] ?? null,
                    'expires_at' => now()->addSeconds((int) ($tokens['expires_in'] ?? 5184000)),
                ]
            );
        }

        $count = count($organizations);

        return to_route('connect.show')->with(
            'toast',
            $count.' LinkedIn '.Str::plural('page', $count).' connected.',
        );
    }

    /**
     * The pages this member administers, as [id => display name].
     *
     * @return array<string, string>
     */
    private function administeredOrganizations(string $accessToken): array
    {
        $response = $this->api($accessToken)->get(self::ORG_ACLS_URL, [
            'q' => 'roleAssignee',
            'role' => 'ADMINISTRATOR',
            'state' => 'APPROVED',
        ]);

        if ($response->failed()) {
            return [];
        }

        $organizations = [];

        foreach ($response->json('elements', []) as $element) {
            // e.g. "urn:li:organization:135306108"
            $urn = $element['organization'] ?? null;

            if (! is_string($urn)) {
                continue;
            }

            $id = Str::afterLast($urn, ':');
            $organizations[$id] = $this->organizationName($accessToken, $id) ?? 'LinkedIn page '.$id;
        }

        return $organizations;
    }

    /**
     * The page's display name, so the UI shows "Flatview" rather than an id.
     */
    private function organizationName(string $accessToken, string $id): ?string
    {
        $response = $this->api($accessToken)->get(self::ORGS_URL.'/'.$id);

        return $response->successful()
            ? $response->json('localizedName')
            : null;
    }

    private function api(string $accessToken): PendingRequest
    {
        return Http::withToken($accessToken)->withHeaders([
            'LinkedIn-Version' => config('services.linkedin.version'),
            'X-Restli-Protocol-Version' => '2.0.0',
        ]);
    }

    private function configured(): bool
    {
        return (bool) config('services.linkedin.pages.client_id');
    }
}
