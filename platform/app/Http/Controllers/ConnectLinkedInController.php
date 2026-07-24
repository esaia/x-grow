<?php

namespace App\Http\Controllers;

use App\Models\SocialAccount;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;

/**
 * Connects a user's LinkedIn account via OAuth2 so scheduled posts can be
 * published on their behalf (see App\Services\LinkedInPostingService).
 * Mirrors ConnectXController, minus PKCE — LinkedIn's member flow doesn't
 * use it, and sends the client credentials in the token request body rather
 * than as HTTP Basic auth.
 *
 * Company pages are NOT handled here — LinkedIn's Community Management API
 * product cannot share an app with this one's products, so pages go through
 * ConnectLinkedInPagesController and a second LinkedIn app.
 */
class ConnectLinkedInController extends Controller
{
    private const AUTHORIZE_URL = 'https://www.linkedin.com/oauth/v2/authorization';

    private const TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';

    private const ME_URL = 'https://api.linkedin.com/v2/userinfo';

    /** Requires the "Sign In with LinkedIn using OpenID Connect" + "Share on LinkedIn" products. */
    private const MEMBER_SCOPES = 'openid profile w_member_social';

    /**
     * Start the OAuth2 handshake.
     */
    public function redirect(Request $request): RedirectResponse
    {
        $state = Str::random(40);

        $request->session()->put('linkedin_oauth_state', $state);

        $query = http_build_query([
            'response_type' => 'code',
            'client_id' => config('services.linkedin.client_id'),
            'redirect_uri' => config('services.linkedin.redirect_uri'),
            'scope' => self::MEMBER_SCOPES,
            'state' => $state,
        ]);

        return redirect(self::AUTHORIZE_URL.'?'.$query);
    }

    /**
     * Exchange the authorization code for tokens and store the connection.
     */
    public function callback(Request $request): RedirectResponse
    {
        // LinkedIn reports a refused/cancelled authorization on the redirect
        // rather than by failing the request, e.g. when the app is missing a
        // product for one of the scopes we asked for.
        if ($request->filled('error')) {
            return to_route('connect.show')->withErrors([
                'linkedin' => 'LinkedIn refused the connection: '
                    .$request->string('error_description')->toString()
                    .' ('.$request->string('error')->toString().')',
            ]);
        }

        $data = $request->validate([
            'code' => ['required', 'string'],
            'state' => ['required', 'string'],
        ]);

        $expectedState = $request->session()->pull('linkedin_oauth_state');

        if (! $expectedState || $data['state'] !== $expectedState) {
            return to_route('connect.show')->withErrors([
                'linkedin' => 'LinkedIn connection failed: the request could not be verified. Please try connecting again.',
            ]);
        }

        $tokenResponse = Http::asForm()->post(self::TOKEN_URL, [
            'grant_type' => 'authorization_code',
            'code' => $data['code'],
            'redirect_uri' => config('services.linkedin.redirect_uri'),
            'client_id' => config('services.linkedin.client_id'),
            'client_secret' => config('services.linkedin.client_secret'),
        ]);

        if ($tokenResponse->failed()) {
            return to_route('connect.show')->withErrors([
                'linkedin' => 'LinkedIn connection failed ('.$tokenResponse->status().'): '.$tokenResponse->body(),
            ]);
        }

        $tokens = $tokenResponse->json();

        $meResponse = Http::withToken($tokens['access_token'])->get(self::ME_URL);

        if ($meResponse->failed()) {
            return to_route('connect.show')->withErrors([
                'linkedin' => 'Connected to LinkedIn, but could not fetch the account profile.',
            ]);
        }

        $me = $meResponse->json();

        $account = SocialAccount::updateOrCreate(
            [
                'user_id' => $request->user()->id,
                'provider' => SocialAccount::PROVIDER_LINKEDIN,
                // The `sub` claim is the member id the author URN is built from.
                'external_id' => $me['sub'],
            ],
            [
                'kind' => SocialAccount::KIND_PERSON,
                'name' => $me['name'] ?? null,
                'access_token' => $tokens['access_token'],
                // Refresh tokens are only issued to approved apps — without one
                // the connection simply expires and has to be re-made by hand.
                'refresh_token' => $tokens['refresh_token'] ?? null,
                'expires_at' => now()->addSeconds((int) ($tokens['expires_in'] ?? 5184000)),
            ]
        );

        return to_route('connect.show')->with('toast', $account->label().' connected.');
    }
}
