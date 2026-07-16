<?php

namespace App\Http\Controllers;

use App\Http\Requests\UpdateVoiceProfileRequest;
use App\Services\PromptBuilder;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Inertia\Inertia;
use Inertia\Response;

class VoiceController extends Controller
{
    /**
     * Show the voice-profile editor.
     */
    public function edit(Request $request): Response
    {
        $profile = $request->user()->voiceProfile()->firstOrCreate([], ['tone' => 'balanced']);

        return Inertia::render('voice', [
            'profile' => $profile->only([
                'tone', 'sample_posts', 'bio_context', 'facts',
                'links', 'projects', 'topics', 'audience',
                'dos', 'donts',
            ]),
            'learned' => [
                'x_handle' => $profile->x_handle,
                'voice_analysis' => $profile->voice_analysis,
                'learned_at' => $profile->voice_learned_at?->diffForHumans(),
            ],
            'tones' => PromptBuilder::TONES,
        ]);
    }

    /**
     * Persist the voice profile.
     */
    public function update(UpdateVoiceProfileRequest $request): RedirectResponse
    {
        $profile = $request->user()->voiceProfile()->firstOrCreate([], ['tone' => 'balanced']);
        $profile->fill($request->validated())->save();

        Inertia::flash('toast', ['type' => 'success', 'message' => __('Voice profile saved.')]);

        return to_route('voice.edit');
    }
}
