<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\GeneratePostRequest;
use App\Http\Requests\GenerateReplyRequest;
use App\Models\Generation;
use App\Services\ClaudeService;
use App\Services\PromptBuilder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use RuntimeException;

class GenerationController extends Controller
{
    public function __construct(
        private readonly ClaudeService $claude,
        private readonly PromptBuilder $prompts,
    ) {}

    /**
     * Generate reply options for a given tweet.
     */
    public function reply(GenerateReplyRequest $request): JsonResponse
    {
        $data = $request->validated();
        $user = $request->user();
        $count = (int) ($data['count'] ?? 3);

        $system = $this->prompts->systemPrompt($user->voiceProfile);
        $prompt = $this->prompts->replyPrompt(
            $data['tweet'],
            $data['thread_context'] ?? null,
            $data['tone'] ?? null,
        );

        return $this->run($user, Generation::TYPE_REPLY, $data['tweet'], [
            'tone' => $data['tone'] ?? null,
            'has_thread' => filled($data['thread_context'] ?? null),
        ], $system, $prompt, $count);
    }

    /**
     * Generate original post options for a topic.
     */
    public function post(GeneratePostRequest $request): JsonResponse
    {
        $data = $request->validated();
        $user = $request->user();
        $format = $data['format'] ?? 'single';
        $count = (int) ($data['count'] ?? 3);

        $system = $this->prompts->systemPrompt($user->voiceProfile);
        $prompt = $this->prompts->postPrompt($data['topic'], $format, $data['tone'] ?? null);

        // Threads need more room per option.
        $maxTokens = $format === 'thread' ? 2048 : 1024;

        return $this->run($user, Generation::TYPE_POST, $data['topic'], [
            'tone' => $data['tone'] ?? null,
            'format' => $format,
        ], $system, $prompt, $count, $maxTokens);
    }

    /**
     * Return every generation the user has already made for a given
     * tweet/topic, so the extension can re-surface them instead of forcing a
     * fresh (paid) regeneration. Matched on the exact input text, newest first.
     */
    public function recent(Request $request): JsonResponse
    {
        $data = $request->validate([
            'type' => ['required', 'in:reply,post'],
            'input_context' => ['required', 'string'],
        ]);

        $generations = $request->user()->generations()
            ->where('type', $data['type'])
            ->where('input_context', $data['input_context'])
            ->latest()
            ->limit(20)
            ->get()
            ->map(fn ($g) => [
                'id' => $g->id,
                'type' => $g->type,
                'options' => $g->output,
                'meta' => $g->meta,
                'model' => $g->model,
                'created_at' => $g->created_at?->toIso8601String(),
            ]);

        return response()->json(['generations' => $generations]);
    }

    /**
     * Shared: call OpenAI, persist the generation, and shape the JSON response.
     *
     * @param  array<string, mixed>  $meta
     */
    private function run(
        $user,
        string $type,
        string $input,
        array $meta,
        string $system,
        string $prompt,
        int $count,
        int $maxTokens = 1024,
    ): JsonResponse {
        try {
            $result = $this->claude->generateOptions($system, $prompt, $count, $maxTokens);
        } catch (RuntimeException $e) {
            return response()->json(['message' => $e->getMessage()], 502);
        }

        $generation = $user->generations()->create([
            'type' => $type,
            'input_context' => $input,
            'meta' => $meta,
            'output' => $result['options'],
            'model' => $result['model'],
            'tokens_in' => $result['input_tokens'],
            'tokens_out' => $result['output_tokens'],
        ]);

        return response()->json([
            'generation_id' => $generation->id,
            'type' => $type,
            'options' => $result['options'],
            'model' => $result['model'],
        ]);
    }
}
