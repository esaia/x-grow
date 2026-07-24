<?php

namespace App\Http\Controllers;

use App\Models\SocialAccount;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;

/**
 * Connects a user's X (Twitter) account via OAuth2 + PKCE so scheduled
 * posts can be published on their behalf (see App\Services\XPostingService).
 */
class ConnectXController extends Controller
{
    private const AUTHORIZE_URL = 'https://twitter.com/i/oauth2/authorize';

    private const TOKEN_URL = 'https://api.x.com/2/oauth2/token';

    private const ME_URL = 'https://api.x.com/2/users/me';

    private const SCOPES = 'tweet.read tweet.write users.read offline.access';

    /**
     * Start the OAuth2 + PKCE handshake.
     */
    public function redirect(Request $request): RedirectResponse
    {
        $state = Str::random(40);
        $verifier = Str::random(64);
        $challenge = rtrim(strtr(base64_encode(hash('sha256', $verifier, true)), '+/', '-_'), '=');

        $request->session()->put('x_oauth_state', $state);
        $request->session()->put('x_oauth_verifier', $verifier);

        $query = http_build_query([
            'response_type' => 'code',
            'client_id' => config('services.x.client_id'),
            'redirect_uri' => config('services.x.redirect_uri'),
            'scope' => self::SCOPES,
            'state' => $state,
            'code_challenge' => $challenge,
            'code_challenge_method' => 'S256',
        ]);

        return redirect(self::AUTHORIZE_URL.'?'.$query);
    }

    /**
     * Exchange the authorization code for tokens and store the connection.
     */
    public function callback(Request $request): RedirectResponse
    {
        $data = $request->validate([
            'code' => ['required', 'string'],
            'state' => ['required', 'string'],
        ]);

        $expectedState = $request->session()->pull('x_oauth_state');
        $verifier = $request->session()->pull('x_oauth_verifier');

        if (! $expectedState || $data['state'] !== $expectedState) {
            return to_route('connect.show')->withErrors([
                'x' => 'X connection failed: the request could not be verified. Please try connecting again.',
            ]);
        }

        $tokenResponse = Http::asForm()
            ->withBasicAuth(config('services.x.client_id'), config('services.x.client_secret'))
            ->post(self::TOKEN_URL, [
                'grant_type' => 'authorization_code',
                'code' => $data['code'],
                'redirect_uri' => config('services.x.redirect_uri'),
                'client_id' => config('services.x.client_id'),
                'code_verifier' => $verifier,
            ]);

        if ($tokenResponse->failed()) {
            return to_route('connect.show')->withErrors([
                'x' => 'X connection failed ('.$tokenResponse->status().'): '.$tokenResponse->body(),
            ]);
        }

        $tokens = $tokenResponse->json();

        $meResponse = Http::withToken($tokens['access_token'])->get(self::ME_URL);

        if ($meResponse->failed()) {
            return to_route('connect.show')->withErrors([
                'x' => 'Connected to X, but could not fetch the account profile.',
            ]);
        }

        $me = $meResponse->json('data');

        // Keyed on the X user id, not just the user — connecting a second X
        // account adds a destination, while re-connecting the same one just
        // refreshes its tokens.
        $account = SocialAccount::updateOrCreate(
            [
                'user_id' => $request->user()->id,
                'provider' => SocialAccount::PROVIDER_X,
                'external_id' => $me['id'],
            ],
            [
                'kind' => SocialAccount::KIND_PERSON,
                'name' => $me['name'] ?? $me['username'] ?? null,
                'handle' => $me['username'] ?? null,
                'access_token' => $tokens['access_token'],
                'refresh_token' => $tokens['refresh_token'] ?? null,
                'expires_at' => now()->addSeconds((int) ($tokens['expires_in'] ?? 7200)),
            ]
        );

        return to_route('connect.show')->with('toast', $account->label().' connected.');
    }
}
