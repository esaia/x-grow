<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\UpdateVoiceProfileRequest;
use App\Models\VoiceProfile;
use App\Services\ClaudeService;
use App\Services\PromptBuilder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use RuntimeException;

class VoiceProfileController extends Controller
{
    public function show(Request $request): JsonResponse
    {
        return response()->json([
            'voice_profile' => $this->resolve($request),
        ]);
    }

    public function update(UpdateVoiceProfileRequest $request): JsonResponse
    {
        $profile = $this->resolve($request);
        $profile->fill($request->validated())->save();

        return response()->json([
            'voice_profile' => $profile->fresh(),
        ]);
    }

    /**
     * Learn the user's voice from posts scraped off their X profile.
     */
    public function learn(Request $request, ClaudeService $claude, PromptBuilder $prompts): JsonResponse
    {
        $data = $request->validate([
            'handle' => ['nullable', 'string', 'max:30'],
            'posts' => ['required', 'array', 'min:1', 'max:60'],
            'posts.*' => ['string', 'max:2000'],
        ]);

        // De-duplicate and drop empties.
        $posts = collect($data['posts'])
            ->map(fn ($p) => trim($p))
            ->filter()
            ->unique()
            ->values();

        if ($posts->isEmpty()) {
            return response()->json(['message' => 'No usable posts were found to analyze.'], 422);
        }

        try {
            $result = $claude->message(
                $prompts->analyzeSystemPrompt(),
                $prompts->analyzePrompt($posts->all()),
                maxTokens: 600,
                temperature: 0.4,
            );
        } catch (RuntimeException $e) {
            return response()->json(['message' => $e->getMessage()], 502);
        }

        $profile = $this->resolve($request);
        $profile->fill([
            'x_handle' => $data['handle'] ? ltrim($data['handle'], '@') : $profile->x_handle,
            'voice_analysis' => $result['text'],
            'learned_posts' => $posts->implode("\n"),
            'voice_learned_at' => now(),
        ])->save();

        return response()->json([
            'voice_analysis' => $profile->voice_analysis,
            'x_handle' => $profile->x_handle,
            'count' => $posts->count(),
        ]);
    }

    /**
     * Get the user's voice profile, creating an empty default the first time.
     */
    private function resolve(Request $request): VoiceProfile
    {
        return $request->user()->voiceProfile()->firstOrCreate([], [
            'tone' => 'balanced',
        ]);
    }
}
