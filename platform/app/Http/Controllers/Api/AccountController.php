<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Services\PromptBuilder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class AccountController extends Controller
{
    /**
     * Lightweight bootstrap payload the extension reads on load.
     */
    public function me(Request $request): JsonResponse
    {
        $user = $request->user();

        return response()->json([
            'user' => [
                'id' => $user->id,
                'name' => $user->name,
                'email' => $user->email,
            ],
            'voice_profile' => $user->voiceProfile,
            'usage' => [
                'today' => $user->generations()->whereDate('created_at', today())->count(),
                'total' => $user->generations()->count(),
            ],
            'options' => [
                'tones' => PromptBuilder::TONES,
                'post_formats' => PromptBuilder::POST_FORMATS,
            ],
        ]);
    }
}
