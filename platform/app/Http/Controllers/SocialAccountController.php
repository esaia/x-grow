<?php

namespace App\Http\Controllers;

use App\Models\SocialAccount;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;

/**
 * Disconnecting a connected destination, whatever network it belongs to.
 * Connecting is per-provider (ConnectXController / ConnectLinkedInController)
 * because each has its own OAuth handshake, but removal is uniform.
 */
class SocialAccountController extends Controller
{
    /**
     * Pause or resume an account. Paused accounts keep their tokens and keep
     * their scheduled posts — they're simply skipped when publishing and not
     * offered as targets — so this is the reversible alternative to
     * disconnecting.
     */
    public function update(Request $request, SocialAccount $account): RedirectResponse
    {
        abort_unless($account->user_id === $request->user()->id, 403);

        $data = $request->validate(['is_active' => ['required', 'boolean']]);

        $account->update(['is_active' => $data['is_active']]);

        return back()->with('toast', $account->label().($data['is_active'] ? ' resumed.' : ' paused — its scheduled posts will not publish until you resume it.'));
    }

    public function destroy(Request $request, SocialAccount $account): RedirectResponse
    {
        abort_unless($account->user_id === $request->user()->id, 403);

        $label = $account->label();

        // Scheduled posts survive with a null account and can be retargeted.
        $account->delete();

        return to_route('connect.show')->with('toast', $label.' disconnected.');
    }
}
