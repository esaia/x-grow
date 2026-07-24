<?php

namespace App\Http\Controllers;

use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Inertia\Inertia;
use Inertia\Response;

class ConnectExtensionController extends Controller
{
    /**
     * Show existing extension tokens and (once) a freshly created one.
     */
    public function show(Request $request): Response
    {
        $tokens = $request->user()->tokens()
            ->latest()
            ->get()
            ->map(fn ($token) => [
                'id' => $token->id,
                'name' => $token->name,
                'last_used_at' => $token->last_used_at?->diffForHumans(),
                'created_at' => $token->created_at?->toDayDateTimeString(),
            ]);

        $accounts = $request->user()->socialAccounts()
            ->orderBy('provider')
            ->orderBy('kind')
            ->orderBy('id')
            ->get()
            ->map(fn ($account) => [
                'id' => $account->id,
                'provider' => $account->provider,
                'kind' => $account->kind,
                'label' => $account->label(),
                'is_active' => $account->is_active,
                'expires_at' => $account->expires_at?->toDayDateTimeString(),
            ]);

        return Inertia::render('connect', [
            'tokens' => $tokens,
            'apiBaseUrl' => rtrim(config('app.url'), '/').'/api',
            // Shown only once, right after creation.
            'newToken' => $request->session()->get('extension_token'),
            'accounts' => $accounts,
            // Whether a second LinkedIn app is configured for company pages
            // (see ConnectLinkedInPagesController) — without it the UI can't
            // offer page connecting at all.
            'linkedinPagesEnabled' => (bool) config('services.linkedin.pages.client_id'),
        ]);
    }

    /**
     * Issue a new personal access token for the extension.
     */
    public function store(Request $request): RedirectResponse
    {
        $validated = $request->validate([
            'name' => ['nullable', 'string', 'max:60'],
        ]);

        $plainText = $request->user()
            ->createToken($validated['name'] ?: 'Chrome extension')
            ->plainTextToken;

        return to_route('connect.show')->with('extension_token', $plainText);
    }

    /**
     * Revoke a token.
     */
    public function destroy(Request $request, string $tokenId): RedirectResponse
    {
        $request->user()->tokens()->whereKey($tokenId)->delete();

        return to_route('connect.show');
    }
}
